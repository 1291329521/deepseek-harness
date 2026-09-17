/**
 * Browser<->Host contract of the terminology feature: remote payloads, the
 * two-layer glossary vocabulary, and the durable explain-request record.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/types
 */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One glossary entry shared by both layers and every boundary. */
export interface GlossaryTerm {
  /** The term text, matched verbatim and case-sensitively. */
  readonly term: string
  /** Plain-prose explanation shown in the tooltip; no markup or actions. */
  readonly explanation: string
}

/** Which glossary layer a write targets. */
export type GlossaryLayer = 'global' | 'project'

/** Everything one client fetch needs; the client round-trips this in one call. */
export interface TerminologyState {
  readonly enabled: boolean
  /** Effective keyboard shortcut, as resolved from the user settings layer. */
  readonly shortcut: string
  /** Longest selection the manual lookup accepts, from the Host's own config. */
  readonly termMaxChars: number
  /** Absolute path of the project glossary file resolved from the session workspace. */
  readonly projectPath: string
  readonly projectTerms: readonly GlossaryTerm[]
  /** Read/parse failure of the project file; the project layer is then ignored. */
  readonly projectError?: string
  readonly globalTerms: readonly GlossaryTerm[]
}

/** Session-scoped request for the full render inputs. */
export interface TerminologyStateRequest { readonly sessionId: SessionId }

/** Manual-lookup request: `context` is the block text around the selection. */
export interface TerminologyExplainRequest {
  readonly sessionId: SessionId
  readonly term: string
  readonly context: string
}

/** Successful explanation: plain prose, markdown-free by prompt contract. */
export interface TerminologyExplainValue { readonly explanation: string }

/** Write one entry back; `layer` names the target store. */
export interface TerminologyRememberRequest {
  readonly sessionId: SessionId
  readonly term: string
  readonly explanation: string
  readonly layer: GlossaryLayer
}

/** Closed failure vocabulary; every member is user-explainable at the surface. */
export type TerminologyErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'GLOSSARY_INVALID'
  | 'TERM_INVALID'
  | 'CONTEXT_TOO_LARGE'
  | 'NO_MODEL_ROUTE'
  | 'LLM_FAILED'
  | 'LLM_TRUNCATED'
  | 'TIMEOUT'
  | 'GLOSSARY_WRITE_FAILED'
  | 'NO_WORKSPACE'
  | 'SETTINGS_CONFLICT'

/** Typed failure: code plus a message safe to show. */
export interface TerminologyError {
  readonly code: TerminologyErrorCode
  readonly message: string
}

/** Result envelope; the remote returns business failures, never thrown RPC. */
export type TerminologyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TerminologyError }

/** Remote result of `state`: the full per-session render inputs. */
export type TerminologyStateResult = TerminologyResult<TerminologyState>
/** Remote result of `explain`: a single plain-prose explanation. */
export type TerminologyExplainResult = TerminologyResult<TerminologyExplainValue>
/** Remote result of `remember`: success carries no payload. */
export type TerminologyRememberResult = TerminologyResult<Record<string, never>>

/** Framed model-visible input of one explain call, reconstructable from the log. */
export interface TerminologyExplainRequestEventData {
  readonly term: string
  readonly context: string
  readonly system: string
  readonly messages: readonly Message[]
  readonly route: { readonly provider: string; readonly model: string }
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Pre-dispatch record of one user-triggered terminology explanation request.
     * Log-only: it mirrors the exact framed model input so the request is
     * reconstructable from the Session log. First-party `Session.append` carries
     * no `ignorable` marker: builds that generate the persistence catalog from
     * this repository read the log through `KNOWN_SESSION_EVENT_TYPES`, while a
     * build predating this type refuses the log per the session-log versioning
     * mechanism until the vocabulary catches up.
     */
    'terminology/explain-request': TerminologyExplainRequestEventData
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The rendered vocabulary changed: a settings write, an external edit of
     * the project glossary file, or a successful remember. Observer failures
     * cannot veto the write that produced it. A global change dispatches with
     * no argument, so forwarded listeners see an empty argument list while
     * local listeners read the missing argument as `undefined`.
     * @mode emit
     * @param sessionId - session whose project vocabulary changed, or
     * `undefined` when the global layer or an unattributed change moved.
     */
    'terminology/changed'(sessionId: SessionId | undefined): void
  }
}
