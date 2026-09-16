/**
 * Real-composition guard: the terminology Host service boots from a test-only
 * cordis.yml through the actual Loader, so every dependency in its `inject`
 * declaration resolves the production way and the remote answers through the
 * service face.
 * The only stub is the external model boundary: a scripted `LlmAdapter` yields
 * a fixed text response, mirroring how `llm-retry/tests/loader-composition`
 * registers a scripted provider into the real `dsh-llm` service.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import type { SessionId as SessionIdBrand } from '@deepseek-ai/dsh-session/types'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import TerminologyService, { mergeGlossary } from '../src/index.ts'

/** Fixed explanation the stub adapter streams for every dispatch. */
const EXPLANATION = 'A Transformer is a neural network architecture built on attention.'

const STUB_CHUNKS: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: EXPLANATION },
  { type: 'block-end', index: 0, block: { type: 'text', text: EXPLANATION } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Scripted provider for the 'stub' route; records every dispatched request. */
class StubAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * STUB_CHUNKS
  }
}

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

interface Composition {
  readonly ctx: Context
  readonly adapter: StubAdapter
  readonly settingsPath: string
  readonly workspace: string
  readonly projectPath: string
}

/** Boot the terminology composition from a test-only cordis.yml through the real Loader. */
async function loadComposition(): Promise<Composition> {
  root = await mkdtemp(join(tmpdir(), 'dsh-terminology-loader-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, [
    'terminology:',
    '  enabled: true',
    '  terms:',
    '    - term: tokenizer',
    '      explanation: Global-layer tokenizer entry.',
    '    - term: attention',
    '      explanation: Global-layer attention entry.',
    '',
  ].join('\n'))
  const workspace = join(root, 'workspace')
  const projectPath = join(workspace, '.dsh', 'terminology.yml')
  await mkdir(join(workspace, '.dsh'), { recursive: true })
  await writeFile(projectPath, [
    'terms:',
    '  - term: Transformer',
    '    explanation: Project-layer Transformer entry.',
    '  - term: attention',
    '    explanation: Project-layer attention entry wins.',
    '',
  ].join('\n'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'sessions'))}`,
    '    compression: none',
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-client-ui-terminology'",
    '  config:',
    '    enabled: true',
    "    explainProvider: 'stub'",
    "    explainModel: 'stub-model'",
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-client-ui-terminology', TerminologyService],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const entry = modules.get(specifier)
      if (entry === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return entry
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  const adapter = new StubAdapter()
  ctx.llm.registerAdapter(['stub'], adapter)
  return { ctx, adapter, settingsPath, workspace, projectPath }
}

// Real-Loader composition resolves workspace packages at test time; first
// resolution is slow enough to trip the default budget on cold caches.
const BOOT = { timeout: 60_000 }

describe('terminology through a real Loader composition', () => {
  it('serves both glossary layers, explains through the stub route, and records the durable request', BOOT, async () => {
    const { ctx, adapter, workspace } = await loadComposition()
    expect(ctx.terminology.typertRemote.namespace).toBe('terminology')
    expect(remoteMethods(ctx.terminology).map(marker => marker.method))
      .toEqual(['state', 'remember', 'explain'])

    const session = ctx.sessions.create(SessionId('terminology-loader-state'), { meta: { cwd: workspace } })
    // The mounted persistence routes this session's published event batches
    // into its active write handle, so the explain record lands on disk.
    const writeHandle = await ctx.sessionPersistence.create(session.header)

    const state = await ctx.terminology.state({ sessionId: session.id })
    if (!state.ok) throw new Error(`expected state success, got ${state.error.code}: ${state.error.message}`)
    expect(state.value.enabled).toBe(true)
    expect(state.value.projectTerms).toEqual([
      { term: 'Transformer', explanation: 'Project-layer Transformer entry.' },
      { term: 'attention', explanation: 'Project-layer attention entry wins.' },
    ])
    expect(state.value.globalTerms).toEqual([
      { term: 'tokenizer', explanation: 'Global-layer tokenizer entry.' },
      { term: 'attention', explanation: 'Global-layer attention entry.' },
    ])
    expect(typeof state.value.termMaxChars).toBe('number')
    // Project entries win their term and the merged vocabulary is longest-first.
    const merged = mergeGlossary(state.value.globalTerms, state.value.projectTerms)
    expect(merged.find(entry => entry.term === 'attention')?.explanation)
      .toBe('Project-layer attention entry wins.')
    // Length descending, then locale order: 11, 9, 9 with `attention` first.
    expect(merged.map(entry => entry.term)).toEqual(['Transformer', 'attention', 'tokenizer'])

    const result = await ctx.terminology.explain({
      sessionId: session.id,
      term: 'Transformer',
      context: 'The Transformer layer processes each token once.',
    })
    if (!result.ok) throw new Error(`expected explain success, got ${result.error.code}: ${result.error.message}`)
    expect(result.value.explanation).toBe(EXPLANATION)
    expect(adapter.requests).toHaveLength(1)
    const dispatched = adapter.requests[0]
    expect(dispatched?.provider).toBe('stub')
    expect(dispatched?.model).toBe('stub-model')
    expect(dispatched?.purpose).toBe('terminology')
    expect(dispatched?.sessionId).toBe(session.id)

    const request = session.snapshotEvents().find(event => event.type === 'terminology/explain-request')
    if (request === undefined || request.type !== 'terminology/explain-request') {
      throw new Error('expected one terminology/explain-request event in the session log')
    }
    expect(request.data.term).toBe('Transformer')
    expect(JSON.stringify(request.data.system) + JSON.stringify(request.data.messages)).toContain('Transformer')

    // Drain the persistence queue through the documented durability barrier.
    expect(await ctx.sessions.flush(session)).toBe(true)
    const readHandle = await ctx.sessionPersistence.open(session.id, 'read')
    const durable = await readHandle.read()
    await readHandle.close()
    expect(durable.some(event => event.type === 'terminology/explain-request')).toBe(true)
    await writeHandle.close()
    expect(KNOWN_SESSION_EVENT_TYPES.has('terminology/explain-request')).toBe(true)
  })

  it('reports an unreadable project file as a string projectError through the service face', BOOT, async () => {
    const { ctx } = await loadComposition()
    const brokenWorkspace = join(root as string, 'workspace-broken')
    await mkdir(join(brokenWorkspace, '.dsh'), { recursive: true })
    await writeFile(join(brokenWorkspace, '.dsh', 'terminology.yml'), 'terms: [\n  {term: broken\n')
    const session = ctx.sessions.create(SessionId('terminology-loader-broken'), { meta: { cwd: brokenWorkspace } })
    const state = await ctx.terminology.state({ sessionId: session.id })
    if (!state.ok) throw new Error(`expected state success, got ${state.error.code}`)
    expect(state.value.projectTerms).toEqual([])
    expect(typeof state.value.projectError).toBe('string')
    expect(state.value.projectError).not.toBe('')
    // The global layer stays available while the project layer is rejected.
    expect(state.value.globalTerms.length).toBeGreaterThan(0)
  })

  it('publishes terminology/changed after a global remember and commits it to settings.yaml', BOOT, async () => {
    const { ctx, adapter, settingsPath, workspace } = await loadComposition()
    const changes: Array<SessionIdBrand | undefined> = []
    ctx.on('terminology/changed', (sessionId) => { changes.push(sessionId) })
    const session = ctx.sessions.create(SessionId('terminology-loader-remember'), { meta: { cwd: workspace } })
    const remembered = await ctx.terminology.remember({
      sessionId: session.id,
      term: 'Embedding',
      explanation: 'Vector form of a token.',
      layer: 'global',
    })
    if (!remembered.ok) throw new Error(`expected remember success, got ${remembered.error.code}`)
    // A global change dispatches without the session argument.
    await vi.waitFor(() => {
      expect(changes).toEqual([undefined])
    })
    await vi.waitFor(async () => {
      expect(await readFile(settingsPath, 'utf8')).toContain('Embedding')
    })
    const state = await ctx.terminology.state({ sessionId: session.id })
    if (!state.ok) throw new Error('expected state success after remember')
    expect(state.value.globalTerms.some(entry => entry.term === 'Embedding')).toBe(true)
    expect(adapter.requests).toHaveLength(0)
  })

  it('closes project watchers with the plugin fiber and keeps the remote unreachable after dispose', BOOT, async () => {
    const { ctx, projectPath, workspace } = await loadComposition()
    const changes: Array<SessionIdBrand | undefined> = []
    ctx.on('terminology/changed', (sessionId) => { changes.push(sessionId) })
    const session = ctx.sessions.create(SessionId('terminology-loader-watch'), { meta: { cwd: workspace } })
    // The first state read starts the per-workspace watcher.
    const before = await ctx.terminology.state({ sessionId: session.id })
    if (!before.ok) throw new Error('expected state success before the watcher edit')
    await writeFile(projectPath, [
      'terms:',
      '  - term: Attention',
      '    explanation: Renamed after the external edit.',
      '',
    ].join('\n'))
    // Control: while the fiber is live, the watcher refresh publishes the move.
    await vi.waitFor(() => {
      expect(changes.length).toBeGreaterThan(0)
    }, { timeout: 5_000 })
    const refreshed = await ctx.terminology.state({ sessionId: session.id })
    if (!refreshed.ok) throw new Error('expected state success after the watcher refresh')
    expect(refreshed.value.projectTerms).toEqual([
      { term: 'Attention', explanation: 'Renamed after the external edit.' },
    ])

    // HMR: disposing only this plugin's entry fiber models a hot reload.
    const entry = [...ctx.loader.entries()]
      .find(candidate => candidate.options.name === '@deepseek-ai/dsh-client-ui-terminology')
    if (entry?.fiber === undefined) throw new Error('terminology entry did not load a fiber')
    await entry.fiber.dispose()
    expect(ctx.get('terminology')).toBeUndefined()

    // The watcher is gone: a further project-file edit publishes nothing.
    const seen = changes.length
    await writeFile(projectPath, [
      'terms:',
      '  - term: Attention',
      '    explanation: Edited after the fiber was disposed.',
      '',
    ].join('\n'))
    // Past the 300 ms write-stability window with margin for chokidar timing.
    await new Promise<void>((resolve) => { setTimeout(resolve, 2_000) })
    expect(changes).toHaveLength(seen)
  })
})
