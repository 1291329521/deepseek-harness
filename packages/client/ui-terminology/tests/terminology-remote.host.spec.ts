/**
 * Host-half behavior of the terminology service: the remote contract, settings
 * ownership, project-file reads/writes against real storage, and the watcher
 * lifecycle. Settings and sessions are scripted services; the glossary file,
 * atomic write, and lock run for real.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { SessionId } from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import TerminologyService from '../src/index.ts'
import { TerminologySettingsSchema, type TerminologyConfig, type TerminologySettings } from '../src/spec.ts'

const sessionId = SessionId('terminology-test-session')

/** Full Host configuration with production defaults; tests spread overrides. */
function hostConfig(overrides: Partial<TerminologyConfig> = {}): TerminologyConfig {
  return {
    enabled: true,
    terms: [],
    explainShortcut: 'Alt+Shift+E',
    projectGlossaryPath: '.dsh/terminology.yml',
    explainMaxTokens: 256,
    explainMaxSentences: 3,
    explainTimeoutMs: 30_000,
    explainTermMaxChars: 64,
    explainContextMaxBytes: 2_048,
    ...overrides,
  }
}

/** Complete settings section used as the stub's validation input. */
const SETTINGS_FLOOR: TerminologySettings = { enabled: true, explainShortcut: 'Alt+Shift+E', terms: [] }

/** Scripted owner scope: validates through the real schema, fires watchers on commit. */
function createStubScope(initial: Partial<TerminologySettings> = {}) {
  let doc = TerminologySettingsSchema({ ...SETTINGS_FLOOR, ...initial })
  const watchers = new Set<(next: TerminologySettings, prev: TerminologySettings) => void>()
  let nextWriteFailure: { error: unknown } | undefined
  return {
    get(): TerminologySettings {
      return doc
    },
    watch(callback: (next: TerminologySettings, prev: TerminologySettings) => void): () => void {
      watchers.add(callback)
      return () => {
        watchers.delete(callback)
      }
    },
    async update(patch: object): Promise<void> {
      if (nextWriteFailure !== undefined) {
        const thrown = nextWriteFailure.error
        nextWriteFailure = undefined
        throw thrown
      }
      const previous = doc
      doc = TerminologySettingsSchema({ ...doc, ...(patch as Partial<TerminologySettings>) })
      for (const callback of [...watchers]) callback(doc, previous)
    },
    failNextWrite(error: unknown): void {
      nextWriteFailure = { error }
    },
  }
}

type StubScope = ReturnType<typeof createStubScope>

/** Settings service stub exposing exactly the owner scope the service consumes. */
class StubSettingsService extends Service {
  readonly scope: StubScope

  constructor(ctx: Context, initial: Partial<TerminologySettings>) {
    super(ctx, 'settings')
    this.scope = createStubScope(initial)
  }

  register(): SettingsScope<TerminologySettings> {
    // The stub implements get/watch/update only; the service consumes nothing else.
    return this.scope as unknown as SettingsScope<TerminologySettings>
  }
}

/** Session store stub: one known session whose workspace is `cwd`. */
class StubSessionsService extends Service {
  private readonly session: { cwd: string } | 'no-cwd' | 'missing'

  constructor(ctx: Context, session: { cwd: string } | 'no-cwd' | 'missing') {
    super(ctx, 'sessions')
    this.session = session
  }

  get(id: string): { header: { cwd?: string } } | undefined {
    if (id !== sessionId || this.session === 'missing') return undefined
    return { header: this.session === 'no-cwd' ? {} : { cwd: this.session.cwd } }
  }
}

/** Placeholder for injected services this task's methods never read. */
class UnusedService extends Service {}

interface Harness {
  ctx: Context
  service: TerminologyService
  scope: StubScope
  root: string
  projectPath: string
  changed: Array<SessionId | undefined>
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  const steps = cleanup.splice(0)
  for (const step of steps) await step()
})

async function harness(options: {
  session?: { cwd: string } | 'no-cwd' | 'missing'
  settings?: Partial<TerminologySettings>
  config?: Partial<TerminologyConfig>
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-terminology-'))
  const ctx = new Context()
  const stubSettings = new StubSettingsService(ctx, options.settings ?? {})
  new StubSessionsService(ctx, options.session ?? { cwd: root })
  new UnusedService(ctx, 'llm')
  new UnusedService(ctx, 'sessionProjections')
  const fiber = await ctx.plugin(TerminologyService, hostConfig(options.config))
  const changed: Array<SessionId | undefined> = []
  ctx.on('terminology/changed', (sessionId) => {
    changed.push(sessionId)
  })
  cleanup.push(() => fiber.dispose(), () => rm(root, { recursive: true, force: true }))
  return {
    ctx,
    service: ctx.terminology,
    scope: stubSettings.scope,
    root,
    projectPath: join(root, '.dsh', 'terminology.yml'),
    changed,
  }
}

/** Write the project glossary through ordinary file APIs (the "external" path). */
async function writeProjectFile(h: Harness, body: string): Promise<void> {
  await mkdir(join(h.root, '.dsh'), { recursive: true })
  await writeFile(h.projectPath, body)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Poll an assertion within a generous budget for watcher-driven facts. */
async function waitUntil(assertion: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(50)
    }
  }
}

describe('TerminologyService remote contract', () => {
  it('publishes the terminology namespace and exactly the state/remember/explain remotes', async () => {
    const h = await harness()
    expect(h.service.typertRemote.serviceKey).toBe('terminology')
    expect(h.service.typertRemote.namespace).toBe('terminology')
    expect(remoteMethods(h.service)).toEqual([
      { method: 'state', invocation: { kind: 'direct' } },
      { method: 'remember', invocation: { kind: 'direct' } },
      { method: 'explain', invocation: { kind: 'direct' } },
    ])
  })

  it('state merges both layers from real files and reports no error', async () => {
    const h = await harness({ settings: { terms: [{ term: 'g1', explanation: 'global one' }] } })
    await writeProjectFile(h, 'terms:\n  - term: p1\n    explanation: project one\n')
    const result = await h.service.state({ sessionId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      enabled: true,
      shortcut: 'Alt+Shift+E',
      termMaxChars: 64,
      projectPath: h.projectPath,
      projectTerms: [{ term: 'p1', explanation: 'project one' }],
      projectError: undefined,
      globalTerms: [{ term: 'g1', explanation: 'global one' }],
    })
  })

  it('state surfaces a broken project file as projectError on a successful call', async () => {
    const h = await harness()
    await writeProjectFile(h, 'terms: [\n')
    const result = await h.service.state({ sessionId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.projectError).toContain('terms')
    expect(result.value.projectTerms).toEqual([])
  })

  it('state rejects a missing session and a session without a workspace', async () => {
    const missing = await harness({ session: 'missing' })
    await expect(missing.service.state({ sessionId })).resolves.toMatchObject({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND' },
    })
    const noWorkspace = await harness({ session: 'no-cwd' })
    await expect(noWorkspace.service.state({ sessionId })).resolves.toMatchObject({
      ok: false,
      error: { code: 'NO_WORKSPACE' },
    })
  })

  it('state rejects a configured project path that escapes the workspace', async () => {
    const h = await harness({ config: { projectGlossaryPath: '../outside.yml' } })
    await expect(h.service.state({ sessionId })).resolves.toMatchObject({
      ok: false,
      error: { code: 'NO_WORKSPACE' },
    })
  })

  it('state reports a project glossary whose home directory cannot be prepared', async () => {
    const h = await harness()
    await writeFile(join(h.root, '.dsh'), 'a file where the directory belongs')
    const result = await h.service.state({ sessionId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.projectTerms).toEqual([])
    expect(result.value.projectError).toContain('cannot prepare project glossary directory')
  })

  it('state leaves the workspace untouched when no project glossary home exists', async () => {
    const h = await harness()
    await expect(h.service.state({ sessionId })).resolves.toMatchObject({
      ok: true,
      value: { projectTerms: [] },
    })
    await expect(readdir(join(h.root, '.dsh'))).rejects.toThrow(/ENOENT/)
  })
})

describe('TerminologyService remember', () => {
  it('writes the global layer through the settings scope and notifies', async () => {
    const h = await harness()
    const result = await h.service.remember({ sessionId, term: 'g1', explanation: 'because', layer: 'global' })
    expect(result.ok).toBe(true)
    expect(h.scope.get().terms).toEqual([{ term: 'g1', explanation: 'because' }])
    expect(h.changed).toEqual([undefined])
    await expect(readFile(h.projectPath, 'utf8')).rejects.toThrow()
  })

  it('replaces a same-term global entry instead of duplicating it', async () => {
    const h = await harness({ settings: { terms: [{ term: 'g1', explanation: 'old' }, { term: 'g2', explanation: 'keep' }] } })
    await h.service.remember({ sessionId, term: 'g1', explanation: 'new', layer: 'global' })
    expect(h.scope.get().terms).toEqual([
      { term: 'g2', explanation: 'keep' },
      { term: 'g1', explanation: 'new' },
    ])
  })

  it('rejects invalid entries before touching either store', async () => {
    const h = await harness()
    const cases: Array<{ term: string; explanation: string }> = [
      { term: '   ', explanation: 'x' },
      { term: 'a', explanation: '  ' },
      { term: 'x'.repeat(65), explanation: 'x' },
      { term: 'ok', explanation: 'y'.repeat(4_001) },
    ]
    for (const entry of cases) {
      await expect(h.service.remember({ ...entry, sessionId, layer: 'global' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'TERM_INVALID' },
      })
    }
    expect(h.scope.get().terms).toEqual([])
  })

  it('maps a settings write failure to SETTINGS_CONFLICT', async () => {
    const h = await harness()
    h.scope.failNextWrite('revision moved')
    await expect(h.service.remember({ sessionId, term: 'a', explanation: 'b', layer: 'global' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'SETTINGS_CONFLICT', message: 'revision moved' },
    })
  })

  it('writes the project layer as YAML and upserts without clobbering others', async () => {
    const h = await harness()
    await writeProjectFile(h, 'terms:\n  - term: keep\n    explanation: untouched\n  - term: p1\n    explanation: old\n')
    const result = await h.service.remember({ sessionId, term: 'p1', explanation: 'new', layer: 'project' })
    expect(result.ok).toBe(true)
    const written = await readFile(h.projectPath, 'utf8')
    expect(written).toContain('keep')
    expect(written).toContain('untouched')
    expect(written).toContain('new')
    expect(written.match(/term: p1/g)).toHaveLength(1)
    expect(h.changed).toEqual([sessionId])
    const state = await h.service.state({ sessionId })
    expect(state.ok && state.value.projectTerms).toEqual([
      { term: 'keep', explanation: 'untouched' },
      { term: 'p1', explanation: 'new' },
    ])
  })

  it('rejects project writes while the project file is invalid', async () => {
    const h = await harness()
    await writeProjectFile(h, '- not\n- an\n- object\n')
    await expect(h.service.remember({ sessionId, term: 'a', explanation: 'b', layer: 'project' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'GLOSSARY_INVALID' },
    })
  })

  it('maps filesystem write failures to GLOSSARY_WRITE_FAILED', async () => {
    const h = await harness()
    await writeFile(join(h.root, '.dsh'), 'a file where the directory belongs')
    await expect(h.service.remember({ sessionId, term: 'a', explanation: 'b', layer: 'project' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'GLOSSARY_WRITE_FAILED' },
    })
  })

  it('rejects a write whose session is gone', async () => {
    const h = await harness({ session: 'missing' })
    await expect(h.service.remember({ sessionId, term: 'a', explanation: 'b', layer: 'global' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND' },
    })
  })

  it('rejects a project-layer write for a session with no workspace', async () => {
    const h = await harness({ session: 'no-cwd' })
    await expect(h.service.remember({ sessionId, term: 'a', explanation: 'b', layer: 'project' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'NO_WORKSPACE' },
    })
  })

  it('rejects a project-layer write whose configured path leaves the workspace', async () => {
    const h = await harness({ config: { projectGlossaryPath: '../outside.yml' } })
    await expect(h.service.remember({ sessionId, term: 'a', explanation: 'b', layer: 'project' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'NO_WORKSPACE', message: 'project glossary path "../outside.yml" must stay inside the workspace' },
    })
  })

  it('refuses a configured project glossary path that is absolute', async () => {
    const h = await harness({ config: { projectGlossaryPath: '/etc/terminology.yml' } })
    await expect(h.service.state({ sessionId })).resolves.toMatchObject({
      ok: false,
      error: { code: 'NO_WORKSPACE' },
    })
  })

  it('keeps one watcher across project writes, however they arrive', async () => {
    const h = await harness()
    await Promise.all([
      h.service.remember({ sessionId, term: 'a', explanation: 'one', layer: 'project' }),
      h.service.remember({ sessionId, term: 'b', explanation: 'two', layer: 'project' }),
    ])
    await h.service.remember({ sessionId, term: 'c', explanation: 'three', layer: 'project' })
    const watchers = Reflect.get(h.service, 'watchers') as Map<string, unknown>
    expect(watchers.size).toBe(1)
    const state = await h.service.state({ sessionId })
    // Whichever concurrent write takes the lock first lands first; every one
    // of them survives.
    const terms = state.ok ? state.value.projectTerms : []
    expect([...terms].sort((left, right) => left.term.localeCompare(right.term))).toEqual([
      { term: 'a', explanation: 'one' },
      { term: 'b', explanation: 'two' },
      { term: 'c', explanation: 'three' },
    ])
  })

  it('lets neither a throwing nor a rejecting observer veto a committed write', async () => {
    const h = await harness()
    h.ctx.on('terminology/changed', () => {
      throw new Error('observer refused')
    })
    // `(): unknown` keeps the rejected promise observable to the notification
    // containment while satisfying the void-returning listener signature.
    h.ctx.on('terminology/changed', (): unknown => Promise.reject(new Error('observer rejected')))
    const result = await h.service.remember({ sessionId, term: 'a', explanation: 'b', layer: 'global' })
    expect(result.ok).toBe(true)
    expect(h.scope.get().terms).toEqual([{ term: 'a', explanation: 'b' }])
  })
})

describe('TerminologyService project watcher', () => {
  it('re-reads an externally edited project file within the settle budget', async () => {
    const h = await harness()
    await writeProjectFile(h, 'terms:\n  - term: seed\n    explanation: none\n')
    await h.service.state({ sessionId })
    await sleep(400)
    await writeProjectFile(h, 'terms:\n  - term: external\n    explanation: edit\n')
    await waitUntil(() => { expect(h.changed.length).toBeGreaterThan(0) })
    const state = await h.service.state({ sessionId })
    expect(state.ok && state.value.projectTerms).toEqual([{ term: 'external', explanation: 'edit' }])
  })

  it('records a watcher failure as the project error', async () => {
    const h = await harness()
    await writeProjectFile(h, 'terms:\n  - term: seed\n    explanation: none\n')
    await h.service.state({ sessionId })
    // Test-only reach into internals: chokidar has no deterministic way to fail
    // a live watcher, so the error handler is exercised by emitting through it.
    const watchers = Reflect.get(h.service, 'watchers') as Map<string, { emit(event: string, error: unknown): void }>
    watchers.get(h.projectPath)!.emit('error', new Error('watch backend exploded'))
    await waitUntil(() => { expect(h.changed.length).toBeGreaterThan(0) })
    const state = await h.service.state({ sessionId })
    expect(state.ok && state.value.projectError).toContain('watch backend exploded')
  })

  it('stays silent on a re-read that states the same vocabulary and error', async () => {
    const h = await harness()
    await writeProjectFile(h, 'terms:\n  - term: keep\n    explanation: same\n')
    await h.service.state({ sessionId })
    await sleep(400)
    // Same bytes through the write path: the watcher re-reads and finds nothing
    // a client needs to hear about.
    await writeProjectFile(h, 'terms:\n  - term: keep\n    explanation: same\n')
    await sleep(900)
    expect(h.changed).toEqual([])
  })

  it('ignores a watcher event that states no content change', async () => {
    const h = await harness()
    await writeProjectFile(h, 'terms:\n  - term: seed\n    explanation: none\n')
    await h.service.state({ sessionId })
    await sleep(400)
    // Test-only reach into internals: chokidar offers no way to make a watched
    // single file report a directory event, so the filter is driven directly.
    const watchers = Reflect.get(h.service, 'watchers') as Map<string, { emit(event: string, ...args: unknown[]): void }>
    watchers.get(h.projectPath)!.emit('all', 'addDir', h.projectPath)
    await sleep(200)
    expect(h.changed).toEqual([])
  })

  it('closes the project watcher when the owning fiber is disposed', async () => {
    const h = await harness()
    await writeProjectFile(h, 'terms:\n  - term: seed\n    explanation: none\n')
    await h.service.state({ sessionId })
    // Test-only reach into internals: chokidar exposes no observable close
    // event, so the release is proven through the watcher's own `close`.
    const watchers = Reflect.get(h.service, 'watchers') as Map<string, { close(): unknown }>
    const close = vi.fn(() => Promise.resolve())
    Reflect.set(watchers.get(h.projectPath)!, 'close', close)
    const steps = cleanup.splice(0, 1)
    for (const step of steps) await step()
    await waitUntil(() => { expect(close).toHaveBeenCalledTimes(1) })
    expect(watchers.size).toBe(0)
  })

  it('stops notifying after the owning fiber is disposed', async () => {
    const h = await harness()
    await writeProjectFile(h, 'terms:\n  - term: seed\n    explanation: none\n')
    await h.service.state({ sessionId })
    await sleep(400)
    await writeProjectFile(h, 'terms:\n  - term: first\n    explanation: one\n')
    await waitUntil(() => { expect(h.changed.length).toBeGreaterThan(0) })
    const steps = cleanup.splice(0)
    for (const step of steps) await step()
    const seen = h.changed.length
    await writeProjectFile(h, 'terms:\n  - term: second\n    explanation: two\n')
    await sleep(900)
    expect(h.changed.length).toBe(seen)
  })
})
