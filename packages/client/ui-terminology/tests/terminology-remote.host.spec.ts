/**
 * Host-half behavior of the terminology service: the remote contract, settings
 * ownership, project-file reads/writes against real storage, and the watcher
 * lifecycle. Settings and sessions are scripted services; the glossary file,
 * atomic write, and lock run for real.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
    await h.service.state({ sessionId })
    await sleep(400)
    await writeProjectFile(h, 'terms:\n  - term: external\n    explanation: edit\n')
    await waitUntil(() => { expect(h.changed.length).toBeGreaterThan(0) })
    const state = await h.service.state({ sessionId })
    expect(state.ok && state.value.projectTerms).toEqual([{ term: 'external', explanation: 'edit' }])
  })

  it('records a watcher failure as the project error', async () => {
    const h = await harness()
    await h.service.state({ sessionId })
    // Test-only reach into internals: chokidar has no deterministic way to fail
    // a live watcher, so the error handler is exercised by emitting through it.
    const watchers = Reflect.get(h.service, 'watchers') as Map<string, { emit(event: string, error: unknown): void }>
    watchers.get(h.projectPath)!.emit('error', new Error('watch backend exploded'))
    await waitUntil(() => { expect(h.changed.length).toBeGreaterThan(0) })
    const state = await h.service.state({ sessionId })
    expect(state.ok && state.value.projectError).toContain('watch backend exploded')
  })

  it('stops notifying after the owning fiber is disposed', async () => {
    const h = await harness()
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
