/**
 * Explain-shortcut parsing and matching: the settings document holds one
 * human-readable chord string, and the browser decides whether a key event
 * carries exactly that chord.
 */
import { describe, expect, it } from 'vitest'
import { matchesShortcut, parseShortcut } from '../src/client/shortcut.ts'

describe('parseShortcut', () => {
  it('rejects a chord that names only modifiers', () => {
    expect(parseShortcut('Alt+Shift')).toBeUndefined()
  })

  it('rejects a chord that names two keys', () => {
    expect(parseShortcut('Alt+E+K')).toBeUndefined()
  })

  it('parses a two-modifier chord with a lower-cased key', () => {
    expect(parseShortcut('Alt+Shift+E')).toEqual({
      altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, key: 'e',
    })
  })

  it('parses a single-modifier chord', () => {
    expect(parseShortcut('Ctrl+K')).toEqual({
      ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, key: 'k',
    })
  })

  it('accepts the modifier aliases and named keys one platform types', () => {
    expect(parseShortcut('Command+Shift+Slash')).toEqual({
      metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, key: '/',
    })
  })

  it('rejects a key with no modifier', () => {
    expect(parseShortcut('E')).toBeUndefined()
  })

  it('rejects a trailing separator', () => {
    expect(parseShortcut('Alt+')).toBeUndefined()
  })

  it('rejects more than four tokens', () => {
    expect(parseShortcut('Alt+Shift+Ctrl+Meta+E')).toBeUndefined()
  })

  it('rejects an unknown token', () => {
    expect(parseShortcut('Alt+Banana+E')).toBeUndefined()
  })

  it('rejects an empty chord', () => {
    expect(parseShortcut('')).toBeUndefined()
  })
})

describe('matchesShortcut', () => {
  const parsed = parseShortcut('Alt+Shift+E')
  if (parsed === undefined) throw new Error('Alt+Shift+E must parse')
  const chord = parsed

  it('matches the chord case-insensitively', () => {
    expect(matchesShortcut(chord, { key: 'E', altKey: true, shiftKey: true })).toBe(true)
  })

  it('rejects an event missing one required modifier', () => {
    expect(matchesShortcut(chord, { key: 'e', altKey: true })).toBe(false)
  })

  it('rejects an event carrying an extra modifier', () => {
    expect(matchesShortcut(chord, { key: 'e', altKey: true, shiftKey: true, ctrlKey: true })).toBe(false)
  })

  it('rejects a different key', () => {
    expect(matchesShortcut(chord, { key: 'f', altKey: true, shiftKey: true })).toBe(false)
  })
})
