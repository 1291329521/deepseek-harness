/**
 * Selection takeover decisions: which browser selection may open the
 * terminology panel, and which stays with the browser.
 */
import { describe, expect, it } from 'vitest'
import type { SelectionAnchor } from '../src/client/selection.ts'
import { evaluateSelection } from '../src/client/selection.ts'

/**
 * An anchor element that answers `closest()` by kind: `editor` matches a
 * selector asking for an editable host, `block` one asking for a block.
 */
/** The point every candidate in this suite carries; the decision ignores it. */
const POINT = { left: 10, top: 20 }

function anchor(options: { editor?: boolean; block?: boolean; text?: string | null } = {}): SelectionAnchor {
  return {
    textContent: 'text' in options ? options.text ?? null : '',
    closest: (selector: string): SelectionAnchor | null => {
      if (options.editor === true && /input|textarea|contenteditable/.test(selector)) return anchor({ text: '编辑中的文字' })
      if (options.block === true && /(^|,)\s*p\s*(,|$)|blockquote/.test(selector)) return anchor({ text: '整段上下文文本' })
      return null
    },
  }
}

describe('evaluateSelection', () => {
  it('rejects a document with no selection at all', () => {
    expect(evaluateSelection(null, 64)).toEqual({ kind: 'rejected' })
  })

  it('keeps a collapsed selection with the browser', () => {
    expect(evaluateSelection({ collapsed: true, text: '模型', anchor: anchor(), point: POINT }, 64))
      .toEqual({ kind: 'rejected' })
  })

  it('rejects a blank selection', () => {
    expect(evaluateSelection({ collapsed: false, text: '   \n  ', anchor: anchor(), point: POINT }, 64))
      .toEqual({ kind: 'rejected' })
  })

  it('rejects a selection with no element anchor', () => {
    expect(evaluateSelection({ collapsed: false, text: '模型', anchor: null, point: POINT }, 64))
      .toEqual({ kind: 'rejected' })
  })

  it('rejects a selection whose ancestor is an editable host', () => {
    expect(evaluateSelection({ collapsed: false, text: '模型', anchor: anchor({ editor: true }), point: POINT }, 64))
      .toEqual({ kind: 'rejected' })
  })

  it('reports a selection over the term limit with the text it rejected', () => {
    expect(evaluateSelection({ collapsed: false, text: 'a very long selected phrase', anchor: anchor(), point: POINT }, 8))
      .toEqual({ kind: 'too-long', text: 'a very long selected phrase' })
  })

  it('accepts a selection at the term limit and carries the block text as context', () => {
    expect(evaluateSelection({ collapsed: false, text: '模型', anchor: anchor({ block: true, text: '模型' }), point: POINT }, 8))
      .toEqual({ kind: 'ok', text: '模型', context: '整段上下文文本' })
  })

  it('falls back to the anchor element when no block ancestor matches', () => {
    expect(evaluateSelection({ collapsed: false, text: '模型', anchor: anchor({ text: '上下文里的模型' }), point: POINT }, 8))
      .toEqual({ kind: 'ok', text: '模型', context: '上下文里的模型' })
  })

  it('treats an anchor without text content as empty context', () => {
    expect(evaluateSelection({ collapsed: false, text: '模型', anchor: anchor({ text: null }), point: POINT }, 8))
      .toEqual({ kind: 'ok', text: '模型', context: '' })
  })

  it('trims the selection into the term it explains', () => {
    expect(evaluateSelection({ collapsed: false, text: '  模型  ', anchor: anchor({ text: '  模型  ' }), point: POINT }, 8))
      .toEqual({ kind: 'ok', text: '模型', context: '  模型  ' })
  })
})
