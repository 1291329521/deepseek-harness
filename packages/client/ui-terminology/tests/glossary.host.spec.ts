import { describe, expect, it } from 'vitest'
import { mergeGlossary, parseProjectGlossary } from '../src/glossary.ts'
import type { GlossaryTerm } from '../src/types.ts'

const global_: readonly GlossaryTerm[] = [
  { term: 'Transformer', explanation: 'global one' },
  { term: '模型', explanation: 'global model' },
]
const project: readonly GlossaryTerm[] = [
  { term: 'Transformer', explanation: 'project one' },
  { term: 'Transformer 架构', explanation: 'project arch' },
]

describe('mergeGlossary', () => {
  it('keeps project entries winning over global ones, longest-first by code-unit length', () => {
    expect(mergeGlossary(global_, project)).toEqual([
      { term: 'Transformer 架构', explanation: 'project arch' },
      { term: 'Transformer', explanation: 'project one' },
      { term: '模型', explanation: 'global model' },
    ])
  })

  it('orders two terms of the same length by their text', () => {
    expect(mergeGlossary([{ term: 'bb', explanation: 'global' }], [{ term: 'aa', explanation: 'project' }])).toEqual([
      { term: 'aa', explanation: 'project' },
      { term: 'bb', explanation: 'global' },
    ])
  })
})

describe('parseProjectGlossary', () => {
  it('accepts the documented shape', () => {
    expect(parseProjectGlossary('terms:\n  - term: 模型\n    explanation: 解释\n')).toEqual([
      { term: '模型', explanation: '解释' },
    ])
  })
  it('rejects a non-object document', () => {
    expect(() => parseProjectGlossary('- just\n- a\n- list\n')).toThrow(/terms/)
  })
  it('rejects an entry missing the explanation', () => {
    expect(() => parseProjectGlossary('terms:\n  - term: a\n')).toThrow(/explanation/)
  })
  it('rejects a duplicate term', () => {
    expect(() => parseProjectGlossary('terms:\n  - term: a\n    explanation: x\n  - term: a\n    explanation: y\n')).toThrow(/duplicate/)
  })
})
