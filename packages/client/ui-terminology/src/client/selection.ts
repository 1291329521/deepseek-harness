/**
 * Which browser selection the terminology feature may take over for a manual
 * lookup, decided from the selection's own facts — the caller reads them off
 * the live DOM.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/client/selection
 */

/** The element facts the decision reads; a real `Element` satisfies it. */
export interface SelectionAnchor {
  /** Nearest ancestor (or self) matching the selector list. */
  closest(selector: string): SelectionAnchor | null
  readonly textContent: string | null
}

/** One candidate selection. */
export interface SelectionCandidate {
  readonly collapsed: boolean
  /** The selection's raw text, untrimmed. */
  readonly text: string
  /** The element the selection starts in, or `null` when it has none. */
  readonly anchor: SelectionAnchor | null
  /** Viewport point just below the selection, measured in the same read. */
  readonly point: SelectionPoint
}

/** The viewport point a takeover anchors to. */
export interface SelectionPoint {
  readonly left: number
  readonly top: number
}

/**
 * Takeover outcome: `ok` opens the menu with the surrounding block as explain
 * context; `too-long` opens the panel on the refusal itself; `rejected` leaves
 * the gesture to the browser.
 */
export type SelectionVerdict =
  | { readonly kind: 'ok'; readonly text: string; readonly context: string }
  | { readonly kind: 'too-long'; readonly text: string }
  | { readonly kind: 'rejected' }

/** Hosts where a selection belongs to text entry, not to lookup. */
const EDITABLE_ANCESTORS = 'input, textarea, [contenteditable="true"], [contenteditable=""]'

/** The prose block a lookup is explained against. */
const BLOCK_ANCESTORS = 'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote'

/**
 * Decide whether a selection may open the terminology panel.
 * @param candidate - The live selection's facts, or `null` when the document
 *   holds no range at all.
 * @param maxChars - Longest selection the explain route accepts as a term.
 * @returns The takeover outcome.
 */
export function evaluateSelection(candidate: SelectionCandidate | null, maxChars: number): SelectionVerdict {
  if (candidate === null) return { kind: 'rejected' }
  const text = candidate.text.trim()
  if (candidate.collapsed || text === '' || candidate.anchor === null) return { kind: 'rejected' }
  if (candidate.anchor.closest(EDITABLE_ANCESTORS) !== null) return { kind: 'rejected' }
  if (text.length > maxChars) return { kind: 'too-long', text }
  const block = candidate.anchor.closest(BLOCK_ANCESTORS) ?? candidate.anchor
  return { kind: 'ok', text, context: block.textContent ?? '' }
}

/** The viewport point a takeover anchors to. */
export interface SelectionPoint {
  readonly left: number
  readonly top: number
}

/**
 * Read the live document selection into the decision's inputs. The anchor point
 * comes from the same range, so a gesture can never anchor to a selection other
 * than the one it was decided on.
 * @returns the candidate, or `null` while the document holds no range.
 */
export function readSelection(): SelectionCandidate | null {
  const selection = document.getSelection()
  /* v8 ignore next -- the DOM returns a null Selection only for a detached document */
  if (selection === null) return null
  if (selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  return {
    collapsed: selection.isCollapsed,
    text: selection.toString(),
    anchor: range.startContainer.parentElement,
    point: { left: rect.left, top: rect.bottom },
  }
}
