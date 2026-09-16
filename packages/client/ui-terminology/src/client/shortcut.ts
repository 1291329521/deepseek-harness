/**
 * The explain chord: parse the settings document's text form and recognize a
 * keyboard event carrying exactly that chord.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/client/shortcut
 */

/** One parsed chord; the key is stored in `KeyboardEvent.key` comparison form. */
export interface ShortcutChord {
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  /** Lower-cased `KeyboardEvent.key` value. */
  readonly key: string
}

/** The key-event facts matching reads; a plain object stands in for the DOM event. */
export interface ShortcutKeyEvent {
  readonly key: string
  readonly altKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly shiftKey?: boolean
}

/** Modifier tokens accepted in the settings text form, per platform typing habit. */
const MODIFIERS: Record<string, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'> = {
  alt: 'altKey', option: 'altKey',
  ctrl: 'ctrlKey', control: 'ctrlKey',
  meta: 'metaKey', cmd: 'metaKey', command: 'metaKey',
  shift: 'shiftKey',
}

/** Named keys whose text form differs from the `KeyboardEvent.key` value. */
const NAMED_KEYS: Record<string, string> = {
  slash: '/', space: ' ', plus: '+',
}

/** The longest chord is three modifiers plus one key. */
const MAX_TOKENS = 4

/**
 * Parse one chord line, e.g. `Alt+Shift+E`.
 * @param text - The settings document's chord text.
 * @returns The parsed chord, or `undefined` when the text names no usable chord
 * (no modifier, an empty token, an unknown token, or more than four tokens).
 */
export function parseShortcut(text: string): ShortcutChord | undefined {
  const tokens = text.split('+')
  if (tokens.length < 2 || tokens.length > MAX_TOKENS) return undefined
  const modifiers = new Set<string>()
  let key: string | undefined
  for (const token of tokens) {
    const normalized = token.trim().toLowerCase()
    if (normalized === '') return undefined
    const modifier = MODIFIERS[normalized]
    if (modifier !== undefined) {
      modifiers.add(modifier)
      continue
    }
    if (key !== undefined) return undefined
    key = NAMED_KEYS[normalized] ?? (normalized.length === 1 ? normalized : undefined)
    if (key === undefined) return undefined
  }
  if (key === undefined) return undefined
  return {
    altKey: modifiers.has('altKey'),
    ctrlKey: modifiers.has('ctrlKey'),
    metaKey: modifiers.has('metaKey'),
    shiftKey: modifiers.has('shiftKey'),
    key,
  }
}

/**
 * Whether one keyboard event carries exactly this chord — extra modifiers miss.
 * @param chord - The parsed chord from the settings document.
 * @param event - The event's modifier state and key.
 * @returns Whether to take the event over for terminology.
 */
export function matchesShortcut(chord: ShortcutChord, event: ShortcutKeyEvent): boolean {
  return (event.altKey ?? false) === chord.altKey
    && (event.ctrlKey ?? false) === chord.ctrlKey
    && (event.metaKey ?? false) === chord.metaKey
    && (event.shiftKey ?? false) === chord.shiftKey
    && event.key.toLowerCase() === chord.key
}
