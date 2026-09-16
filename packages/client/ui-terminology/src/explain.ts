/**
 * Model-backed explain pipeline: input bounds, JSON framing, the durable
 * pre-dispatch record, one per-call deadline, and the output rules. Route,
 * policy, stream, and log sink arrive as injectable collaborators, so the
 * pipeline runs without a container. The pipeline mirrors
 * `packages/session/session-title-llm`: log the exact framed request first,
 * then dispatch.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/explain
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  TerminologyError,
  TerminologyErrorCode,
  TerminologyExplainRequestEventData,
  TerminologyExplainResult,
} from './types.ts'

/** Exact model route one explain call uses. */
export interface ExplainRoute {
  readonly provider: string
  readonly model: string
}

/** Deployment policy for one explain call, sourced from Host Config. */
export interface ExplainPolicy {
  /** Output-token cap for the explanation request. */
  readonly maxTokens: number
  /** Sentence cap stated in the system instruction. */
  readonly maxSentences: number
  /** End-to-end deadline in milliseconds. */
  readonly timeoutMs: number
  /** Maximum characters in the selected term. */
  readonly termMaxChars: number
  /** Maximum UTF-8 bytes in the surrounding context. */
  readonly contextMaxBytes: number
}

/** Collaborators of one explain call; every one is stubbable in tests. */
export interface ExplainDeps {
  readonly route: ExplainRoute
  readonly policy: ExplainPolicy
  /** Session attribution carried on the model request. */
  readonly sessionId: SessionId
  /** Dispatches one assembled request; production supplies `ctx.llm.stream`. */
  readonly stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  /** Records the durable request; production supplies `session.append`. */
  readonly append: (
    type: 'terminology/explain-request',
    payload: TerminologyExplainRequestEventData,
  ) => void
}

/** Validated user input of one explain call. */
export interface ExplainInput {
  readonly term: string
  readonly context: string
}

/** Capability-owned timeout reason code for explanation requests. */
export const TERMINOLOGY_TIMEOUT_CODE = 'TERMINOLOGY_TIMEOUT'

/** Plugin attribution carried by every framed explain message. */
const PLUGIN_SOURCE = 'dsh-client-ui-terminology'

/**
 * Stable task-facing system instruction: it states the answer language, the
 * plain-text requirement, and the sentence cap, using only explanation-task
 * vocabulary.
 * @param maxSentences - maximum sentence count the answer may use.
 * @returns the exact system prompt text sent to the model.
 */
export function systemPrompt(maxSentences: number): string {
  return [
    'You explain one term from a reader\'s document.',
    'Answer directly with the meaning of the term in this context, in the language of the surrounding text.',
    `Reply in plain text of natural language with no Markdown, no code block, no preamble, and at most ${maxSentences} sentences.`,
  ].join('\n')
}

/**
 * Frame the term and context as one JSON object, so user text cannot break
 * structural delimiters.
 * @param term - selected term to explain.
 * @param context - text surrounding the selection.
 * @returns the exact user-message text sent to the model.
 */
export function frameInput(term: string, context: string): string {
  return `Explain this glossary term. JSON input:\n${JSON.stringify({ term, context })}`
}

/** Build one typed failure envelope. */
function rejected(code: TerminologyErrorCode, message: string): TerminologyExplainResult {
  return { ok: false, error: { code, message } satisfies TerminologyError }
}

/** Message of any thrown value, non-Error throws included. */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Translate one non-`stop` terminal finish reason into a failure message.
 * Any finish other than `stop` means the explanation is not trustworthy:
 * truncation, a tool request, or a provider-side failure.
 */
function finishFailure(finish: FinishReason): string {
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    return `the explanation request failed: ${finish.failure.message}`
  }
  return 'the explanation model stopped before completing the explanation'
}

/**
 * Run one explain call: bound the input, frame it, append the durable request
 * before dispatch, consume the stream under one deadline, and keep only plain
 * text from the assembled blocks.
 * @param deps - route, policy, stream collaborator, and log sink.
 * @param input - selected term and its surrounding context.
 * @returns the explanation text, or `TERM_INVALID` / `CONTEXT_TOO_LARGE` /
 * `LLM_FAILED` / `TIMEOUT`; the appended record makes every dispatched request
 * reconstructable from the Session log.
 */
export async function explainTerm(deps: ExplainDeps, input: ExplainInput): Promise<TerminologyExplainResult> {
  if (input.term.length === 0 || input.term.length > deps.policy.termMaxChars) {
    return rejected('TERM_INVALID', `the selected text must be non-empty and fit within ${deps.policy.termMaxChars} characters`)
  }
  if (Buffer.byteLength(input.context, 'utf8') > deps.policy.contextMaxBytes) {
    return rejected('CONTEXT_TOO_LARGE', `the surrounding text exceeds the ${deps.policy.contextMaxBytes}-byte context limit`)
  }
  const system = systemPrompt(deps.policy.maxSentences)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: frameInput(input.term, input.context) }],
    source: { kind: 'plugin', plugin: PLUGIN_SOURCE },
  })]
  using callDeadline = deadline(undefined, deps.policy.timeoutMs, TERMINOLOGY_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: deps.route.provider,
    model: deps.route.model,
    messages,
    system,
    maxTokens: deps.policy.maxTokens,
    sessionId: deps.sessionId,
    purpose: 'terminology',
    signal: callDeadline.signal,
  })
  deps.append('terminology/explain-request', {
    term: input.term,
    context: input.context,
    system,
    messages,
    route: deps.route,
    maxTokens: deps.policy.maxTokens,
  })
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of deps.stream(options)) {
      assembler.push(chunk)
      callDeadline.signal.throwIfAborted()
    }
  } catch (error) {
    // The deadline is the only abort source (no caller signal), so an aborted
    // signal always attributes to the timeout.
    if (callDeadline.signal.aborted) return rejected('TIMEOUT', 'the explanation request timed out')
    return rejected('LLM_FAILED', failureMessage(error))
  }
  if (callDeadline.signal.aborted) return rejected('TIMEOUT', 'the explanation request timed out')
  const finish = assembler.finish
  if (finish.kind !== 'stop') return rejected('LLM_FAILED', finishFailure(finish))
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    return rejected('LLM_FAILED', 'the explanation model requested a tool instead of answering')
  }
  const text = blocks
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join(' ')
    .trim()
  if (text.length === 0) return rejected('LLM_FAILED', 'the explanation model produced no text')
  return { ok: true, value: { explanation: text } }
}
