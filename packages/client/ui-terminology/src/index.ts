/**
 * Host half: settings namespace, two-layer glossary with file watching, and
 * the typert remote the Web client reads (`state`, `explain`, `remember`).
 * @module @deepseek-ai/dsh-client-ui-terminology
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
// Type-only: activates the `ctx.sessionProjections` Context declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: activates the `modelSelection` key of `SessionProjectionStateMap`.
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { watch, type FSWatcher } from 'chokidar'
import { stringify } from 'yaml'
import { explainTerm, type ExplainRoute } from './explain.ts'
import { TERMINOLOGY_NAMESPACE } from './namespace.ts'
import {
  DEFAULT_EXPLAIN_SHORTCUT,
  DEFAULT_PROJECT_GLOSSARY_PATH,
  GLOSSARY_EXPLANATION_MAX_CHARS,
  glossaryTermSchema,
  TerminologySettingsSchema,
  type TerminologyConfig,
  type TerminologySettings,
} from './spec.ts'
import { parseProjectGlossary } from './glossary.ts'
import type {
  GlossaryTerm,
  TerminologyErrorCode,
  TerminologyExplainRequest,
  TerminologyExplainResult,
  TerminologyRememberRequest,
  TerminologyRememberResult,
  TerminologyResult,
  TerminologyState,
  TerminologyStateRequest,
  TerminologyStateResult,
} from './types.ts'

export { mergeGlossary } from './glossary.ts'
export type * from './types.ts'

/** Empty immutable term list shared by every no-vocabulary outcome. */
const EMPTY_TERMS: readonly GlossaryTerm[] = Object.freeze([])

/** Shared success envelope for remote results. */
function ok<T>(value: T): TerminologyResult<T> {
  return { ok: true, value }
}

/** Shared typed-failure envelope; the message must be safe to show. */
function rejected(code: TerminologyErrorCode, message: string): { ok: false; error: { code: TerminologyErrorCode; message: string } } {
  return { ok: false, error: { code, message } }
}

/** Message of any thrown value, non-Error throws included. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One project-file outcome: parsed terms, absence, or the read/parse failure. */
interface ProjectGlossary {
  readonly terms: readonly GlossaryTerm[]
  readonly error: string | undefined
}

/** Carries a project-file parse failure out of the write lock to fail the write. */
class ProjectGlossaryInvalidError extends Error {}

/** Whether two project-file outcomes state the same vocabulary and error. */
function sameGlossary(left: ProjectGlossary, right: ProjectGlossary): boolean {
  if (left.error !== right.error) return false
  if (left.terms.length !== right.terms.length) return false
  return left.terms.every((entry, index) => {
    const other = right.terms[index]
    return other !== undefined && other.term === entry.term && other.explanation === entry.explanation
  })
}

/** chokidar write-stability window: a burst settles before the file is re-read. */
const PROJECT_WATCH_STABILITY_MS = 300

/** Document modes of the personal glossary file, mirroring the settings-file decision. */
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700

declare module '@deepseek-ai/cordis' {
  interface Context {
    terminology: TerminologyService
  }
}

/** The terminology Host service: vocabulary owner and remote surface. */
export default class TerminologyService extends TypertRemoteService {
  static inject = ['settings', 'sessions', 'llm', 'sessionProjections']
  static Config: z<TerminologyConfig> = z.object({
    enabled: z.boolean().default(true),
    terms: z.array(glossaryTermSchema).default([]),
    explainShortcut: z.string().default(DEFAULT_EXPLAIN_SHORTCUT),
    projectGlossaryPath: z.string().default(DEFAULT_PROJECT_GLOSSARY_PATH),
    explainProvider: z.string(),
    explainModel: z.string(),
    explainMaxTokens: z.number().min(1).default(2048),
    explainMaxSentences: z.number().min(1).default(3),
    explainTimeoutMs: z.number().min(1).default(30_000),
    explainTermMaxChars: z.number().min(1).default(64),
    explainContextMaxBytes: z.number().min(1).default(2_048),
  })

  private readonly config: TerminologyConfig
  /** Composition base for the settings layer: the user-visible Config fields. */
  private readonly base: { enabled: boolean; explainShortcut: string; terms: GlossaryTerm[] }
  /** Project-file cache per absolute path, refreshed by reads and the watcher. */
  private readonly projectFiles = new Map<string, ProjectGlossary>()
  private readonly watchers = new Map<string, FSWatcher>()
  /** Owner scope over the durable `terminology` section. */
  private scope!: SettingsScope<TerminologySettings>

  /**
   * @param ctx - Host context carrying settings and the session store.
   * @param config - Validated Host configuration supplied by the Loader.
   */
  constructor(ctx: Context, config: TerminologyConfig) {
    super(ctx, 'terminology')
    this.config = config
    this.base = { enabled: config.enabled, explainShortcut: config.explainShortcut, terms: config.terms }
  }

  /** Register the settings namespace and adopt its owner scope. */
  protected [Service.init](): void {
    const { explainProvider, explainModel } = this.config
    if ((explainProvider === undefined) !== (explainModel === undefined)) {
      throw new Error('terminology: explainProvider and explainModel must be configured together')
    }
    this.scope = this.ctx.settings.register(TERMINOLOGY_NAMESPACE, TerminologySettingsSchema, { base: this.base })
    this.ctx.effect(() => this.scope.watch(() => { this.notifyChanged(undefined) }), 'terminology:settings-watch')
    // Project watchers start lazily, one per workspace, from reads and writes.
    // Their release is owned here so one fiber disposal closes every live one.
    this.ctx.effect(() => () => { this.closeWatchers() }, 'terminology:project-watch')
  }

  /**
   * Read one session's full render inputs.
   * @param request - Session identity.
   * @returns Enabled flag, shortcut, selection length limit, project path,
   * both layers, and any project-file read/parse error; `SESSION_NOT_FOUND` /
   * `NO_WORKSPACE` otherwise.
   */
  @Remote('state')
  async state(request: TerminologyStateRequest): Promise<TerminologyStateResult> {
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      return rejected('SESSION_NOT_FOUND', `session ${request.sessionId} not found`)
    }
    const cwd = session.header.cwd
    if (cwd === undefined) return rejected('NO_WORKSPACE', 'session has no workspace; the project glossary needs one')
    const projectPath = this.resolveProjectPath(cwd)
    if (projectPath === null) {
      return rejected('NO_WORKSPACE', `project glossary path "${this.config.projectGlossaryPath}" must stay inside the workspace`)
    }
    const settings = this.scope.get()
    const project = await this.readProjectFile(projectPath)
    return ok<TerminologyState>({
      enabled: settings.enabled,
      shortcut: settings.explainShortcut,
      termMaxChars: this.config.explainTermMaxChars,
      projectPath,
      projectTerms: project.terms,
      ...(project.error === undefined ? {} : { projectError: project.error }),
      globalTerms: settings.terms,
    })
  }

  /**
   * Persist one entry into the chosen layer.
   * @param request - Term, explanation, target layer, and owning session.
   * @returns Empty success, or `TERM_INVALID` / `SESSION_NOT_FOUND` /
   * `NO_WORKSPACE` / `GLOSSARY_INVALID` / `GLOSSARY_WRITE_FAILED` /
   * `SETTINGS_CONFLICT`.
   */
  @Remote('remember')
  async remember(request: TerminologyRememberRequest): Promise<TerminologyRememberResult> {
    const term = request.term.trim()
    const explanation = request.explanation.trim()
    if (term.length === 0 || explanation.length === 0) {
      return rejected('TERM_INVALID', 'term and explanation must both be non-empty')
    }
    if (term.length > this.config.explainTermMaxChars) {
      return rejected('TERM_INVALID', `term exceeds the ${this.config.explainTermMaxChars}-character limit`)
    }
    if (explanation.length > GLOSSARY_EXPLANATION_MAX_CHARS) {
      return rejected('TERM_INVALID', `explanation exceeds the ${GLOSSARY_EXPLANATION_MAX_CHARS}-character limit`)
    }
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      return rejected('SESSION_NOT_FOUND', `session ${request.sessionId} not found`)
    }
    if (request.layer === 'global') {
      const current = this.scope.get()
      const terms: readonly GlossaryTerm[] = [...current.terms.filter(entry => entry.term !== term), { term, explanation }]
      try {
        await this.scope.update({ terms })
      } catch (error) {
        return rejected('SETTINGS_CONFLICT', errorMessage(error))
      }
      return ok({})
    }
    const cwd = session.header.cwd
    if (cwd === undefined) return rejected('NO_WORKSPACE', 'session has no workspace; the project glossary needs one')
    const projectPath = this.resolveProjectPath(cwd)
    if (projectPath === null) {
      return rejected('NO_WORKSPACE', `project glossary path "${this.config.projectGlossaryPath}" must stay inside the workspace`)
    }
    let merged: readonly GlossaryTerm[]
    try {
      // The project glossary's home is created by the write that fills it; reads and
      // watchers never touch workspace structure. The directory must exist before the
      // writer lock file is created beside the glossary.
      await fs.mkdir(path.dirname(projectPath), { recursive: true, mode: PRIVATE_DIR_MODE })
      await this.ensureWatcher(projectPath)
      merged = await withFileLock(projectPath, async () => {
        const current = await this.loadProjectFile(projectPath)
        if (current.error !== undefined) throw new ProjectGlossaryInvalidError(current.error)
        const next: readonly GlossaryTerm[] = [...current.terms.filter(entry => entry.term !== term), { term, explanation }]
        await writeFileAtomic(projectPath, stringify({ terms: [...next] }), { mode: PRIVATE_FILE_MODE, dirMode: PRIVATE_DIR_MODE })
        return next
      })
    } catch (error) {
      if (error instanceof ProjectGlossaryInvalidError) {
        return rejected('GLOSSARY_INVALID', `fix the project glossary before writing: ${error.message}`)
      }
      return rejected('GLOSSARY_WRITE_FAILED', errorMessage(error))
    }
    this.projectFiles.set(projectPath, { terms: merged, error: undefined })
    this.notifyChanged(request.sessionId)
    return ok({})
  }

  /**
   * Explain one manually selected term through the session's model route.
   * @param request - Session, selected term, and surrounding context.
   * @returns The plain-prose explanation, or `SESSION_NOT_FOUND` /
   * `TERM_INVALID` / `CONTEXT_TOO_LARGE` / `NO_MODEL_ROUTE` / `LLM_FAILED` /
   * `TIMEOUT`.
   */
  @Remote('explain')
  async explain(request: TerminologyExplainRequest): Promise<TerminologyExplainResult> {
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      return rejected('SESSION_NOT_FOUND', `session ${request.sessionId} not found`)
    }
    const route = this.resolveExplainRoute(session)
    if (route === undefined) {
      return rejected('NO_MODEL_ROUTE', 'no model route is available; configure explainProvider and explainModel together, or select a model in this session')
    }
    const config = this.config
    return await explainTerm({
      route,
      policy: {
        maxTokens: config.explainMaxTokens,
        maxSentences: config.explainMaxSentences,
        timeoutMs: config.explainTimeoutMs,
        termMaxChars: config.explainTermMaxChars,
        contextMaxBytes: config.explainContextMaxBytes,
      },
      sessionId: session.id,
      stream: options => this.ctx.llm.stream(options),
      append: (type, payload) => {
        session.append(type, payload)
      },
    }, { term: request.term, context: request.context })
  }

  /** Explicit configured pair wins; otherwise the session's current selection. No third fallback: neither source means no route. */
  private resolveExplainRoute(session: Session): ExplainRoute | undefined {
    const { explainProvider, explainModel } = this.config
    // The half pair is rejected at init, so a missing member means no explicit pair.
    if (explainProvider === undefined || explainModel === undefined) {
      const lastUsed = this.ctx.sessionProjections.stateOf(session, 'modelSelection')?.lastUsed
      return lastUsed === null || lastUsed === undefined
        ? undefined
        : { provider: lastUsed.provider, model: lastUsed.model }
    }
    return { provider: explainProvider, model: explainModel }
  }

  /**
   * Resolve the configured project glossary path against the workspace.
   * @param cwd - Session workspace root.
   * @returns Absolute file path, or `null` when the configured path is
   * absolute or escapes the workspace (rejected use, never resolved).
   */
  private resolveProjectPath(cwd: string): string | null {
    const configured = this.config.projectGlossaryPath
    if (path.isAbsolute(configured)) return null
    const resolved = path.resolve(cwd, configured)
    const relative = path.relative(cwd, resolved)
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
    return resolved
  }

  /** Cached project-file outcome; first read loads the file and starts the watcher. */
  private async readProjectFile(projectPath: string): Promise<ProjectGlossary> {
    const cached = this.projectFiles.get(projectPath)
    if (cached !== undefined) return cached
    const result = await this.loadProjectFile(projectPath)
    this.projectFiles.set(projectPath, result)
    try {
      await this.ensureWatcher(projectPath)
    } catch (error) {
      // The containing directory cannot be prepared (a file sits in its place).
      // The read above stays as read; edits simply go unnoticed while that holds.
      const failed: ProjectGlossary = { terms: result.terms, error: `terminology: cannot prepare project glossary directory: ${errorMessage(error)}` }
      this.projectFiles.set(projectPath, failed)
      return failed
    }
    return result
  }

  /** Read and parse the project file once; total — every failure is data. */
  private async loadProjectFile(projectPath: string): Promise<ProjectGlossary> {
    let body: string
    try {
      body = await fs.readFile(projectPath, 'utf8')
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return { terms: EMPTY_TERMS, error: undefined }
      return { terms: EMPTY_TERMS, error: `terminology: cannot read project glossary: ${errorMessage(error)}` }
    }
    try {
      return { terms: parseProjectGlossary(body), error: undefined }
    } catch (error) {
      return { terms: EMPTY_TERMS, error: errorMessage(error) }
    }
  }

  /** Start (once per path) the watcher that re-reads externally edited files. */
  private async ensureWatcher(projectPath: string): Promise<void> {
    if (this.watchers.has(projectPath)) return
    // Reading never creates workspace structure: a missing containing directory has
    // no glossary to watch, and the watcher starts when the directory first exists —
    // through the write that fills it or through the user's own file. chokidar closes
    // a watcher whose containing directory is missing at setup, so the directory's
    // presence is checked, never created.
    const directory = await fs.stat(path.dirname(projectPath)).catch(
      // ENOENT is the ordinary absence; every stat failure just means "nothing to
      // watch yet", and a later write or read retries the arming.
      () => undefined,
    )
    if (directory === undefined) return
    if (!directory.isDirectory()) throw new Error(`"${path.dirname(projectPath)}" is not a directory`)
    if (this.watchers.has(projectPath)) return
    const watcher = watch(projectPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: PROJECT_WATCH_STABILITY_MS, pollInterval: 10 },
    })
    watcher.on('all', (event) => {
      if (event !== 'add' && event !== 'change') return
      void this.refreshProjectFile(projectPath)
    })
    watcher.on('ready', () => {
      // The first read raced watcher setup: reconcile once at ready so a change
      // written between that read and the watcher going live is not lost.
      void this.refreshProjectFile(projectPath)
    })
    watcher.on('error', (error) => {
      this.setProjectFile(projectPath, { terms: EMPTY_TERMS, error: `terminology: glossary watcher failed: ${errorMessage(error)}` })
    })
    this.watchers.set(projectPath, watcher)
  }

  /** Close every project watcher started so far and forget them. */
  private closeWatchers(): void {
    const watchers = [...this.watchers.values()]
    this.watchers.clear()
    for (const watcher of watchers) void watcher.close()
  }

  /** Re-read after a watcher event and publish the moved vocabulary. */
  private async refreshProjectFile(projectPath: string): Promise<void> {
    this.setProjectFile(projectPath, await this.loadProjectFile(projectPath))
  }

  /** Commit one project-file outcome to the cache; notify only when the facts moved. */
  private setProjectFile(projectPath: string, result: ProjectGlossary): void {
    const previous = this.projectFiles.get(projectPath)
    this.projectFiles.set(projectPath, result)
    // A first observation only fills the cache: no consumer has seen a prior
    // state to be told goodbye to. Later outcomes notify only on real moves.
    if (previous === undefined || sameGlossary(previous, result)) return
    this.notifyChanged(undefined)
  }

  /**
   * Fan out `terminology/changed`. Mirrors the settings commit: an observer
   * that throws or rejects cannot veto the vocabulary change that produced it.
   */
  private notifyChanged(sessionId: SessionId | undefined): void {
    // A global change dispatches without the argument: the Remote forwarder
    // only admits lossless JSON arguments, and `undefined` is none. Local
    // listeners read the missing argument as `undefined`.
    const args: unknown[] = sessionId === undefined
      ? ['terminology/changed']
      : ['terminology/changed', sessionId]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = sessionId === undefined ? listener() : listener(sessionId)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, () => {
            // Rejection containment: the write already committed.
          })
        }
      } catch {
        // Sync-throw containment: the write already committed.
      }
    }
  }
}
