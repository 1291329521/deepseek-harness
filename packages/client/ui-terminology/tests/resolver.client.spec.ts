/**
 * The client annotation resolver: literal, case-sensitive, longest-term-first,
 * non-overlapping matching whose segments always concatenate back to the input.
 */
import { describe, expect, it } from 'vitest'
import type { MarkdownSegment } from '@deepseek-ai/dsh-client-ui-primitives'
import { createTerminologyResolver } from '../src/client/resolver.ts'
import type { GlossaryTerm } from '../src/types.ts'

const TERMS: readonly GlossaryTerm[] = [
  { term: 'Transformer 架构', explanation: 'arch' },
  { term: 'Transformer', explanation: 'one' },
  { term: '模型', explanation: 'model' },
]

const label = (term: string): string => `术语 ${term}，查看解释`

/** Segments carry their text on every kind, so the concatenation is the input. */
function joined(segments: readonly MarkdownSegment[]): string {
  return segments.map(segment => segment.text).join('')
}

describe('createTerminologyResolver', () => {
  it('annotates the longest term and keeps the surrounding text intact', () => {
    const segments = createTerminologyResolver(TERMS, label).split('解释 Transformer 架构 的原理')
    expect(segments).toEqual([
      { kind: 'text', text: '解释 ' },
      { kind: 'annotation', text: 'Transformer 架构', label: '术语 Transformer 架构，查看解释', explanation: 'arch' },
      { kind: 'text', text: ' 的原理' },
    ])
  })

  it('never loses a character: segments concatenate back to the input', () => {
    const resolver = createTerminologyResolver(TERMS, label)
    for (const value of ['无术语', 'Transformer', '模型和Transformer混排模型', '尾部模型']) {
      expect(joined(resolver.split(value))).toBe(value)
    }
  })

  it('annotates every non-overlapping occurrence', () => {
    const segments = createTerminologyResolver(TERMS, label).split('模型 模型 模型')
    expect(segments.filter(segment => segment.kind === 'annotation')).toHaveLength(3)
  })

  it('matches case-sensitively', () => {
    expect(createTerminologyResolver(TERMS, label).split('the transformer model'))
      .toEqual([{ kind: 'text', text: 'the transformer model' }])
  })

  it('annotates inside an unsegmented Chinese run, matching the literal term', () => {
    const resolver = createTerminologyResolver([{ term: '模型', explanation: 'model' }], label)
    expect(resolver.split('大模型')).toEqual([
      { kind: 'text', text: '大' },
      { kind: 'annotation', text: '模型', label: '术语 模型，查看解释', explanation: 'model' },
    ])
  })

  it('returns the whole input as one text segment for an empty vocabulary', () => {
    expect(createTerminologyResolver([], label).split('任意文本')).toEqual([{ kind: 'text', text: '任意文本' }])
  })

  it('publishes a fresh identity per build so settled renders can memoize on it', () => {
    expect(createTerminologyResolver(TERMS, label)).not.toBe(createTerminologyResolver(TERMS, label))
  })

  it('orders two terms of the same length deterministically', () => {
    const resolver = createTerminologyResolver(
      [{ term: '词元', explanation: 'token' }, { term: '字符', explanation: 'character' }],
      label,
    )
    expect(resolver.split('字符和词元')).toEqual([
      { kind: 'annotation', text: '字符', label: '术语 字符，查看解释', explanation: 'character' },
      { kind: 'text', text: '和' },
      { kind: 'annotation', text: '词元', label: '术语 词元，查看解释', explanation: 'token' },
    ])
  })

  it('returns the empty input as one empty text segment', () => {
    expect(createTerminologyResolver([{ term: '模型', explanation: 'model' }], label).split(''))
      .toEqual([{ kind: 'text', text: '' }])
  })
})
