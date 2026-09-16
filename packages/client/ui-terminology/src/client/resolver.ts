/**
 * Literal glossary matching over one rendered text run: the resolver turns a
 * vocabulary into the annotation segments the Markdown renderer draws.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/client/resolver
 */
import type { MarkdownAnnotations, MarkdownSegment } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GlossaryTerm } from '../types.ts'

/**
 * Build a resolver for one vocabulary snapshot.
 * @param terms - Vocabulary in any order; longest-first matching order and
 * term identity are owned here.
 * @param label - Accessible-name builder; locale copy is owned by the caller.
 * @returns A fresh resolver identity — the provider calls this only when the
 * vocabulary changed, because settled renders memoize on this identity.
 */
export function createTerminologyResolver(
  terms: readonly GlossaryTerm[],
  label: (term: string) => string,
): MarkdownAnnotations {
  const sorted = [...terms].sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term))
  const byTerm = new Map(sorted.map(entry => [entry.term, entry]))
  const maxLen = sorted[0]?.term.length ?? 0
  return {
    split(value: string): readonly MarkdownSegment[] {
      if (maxLen === 0) return [{ kind: 'text', text: value }]
      const out: MarkdownSegment[] = []
      let plainFrom = 0
      let index = 0
      while (index < value.length) {
        let hit: GlossaryTerm | undefined
        const limit = Math.min(maxLen, value.length - index)
        for (let size = limit; size >= 1; size--) {
          const entry = byTerm.get(value.slice(index, index + size))
          if (entry !== undefined) { hit = entry; break }
        }
        if (hit === undefined) { index += 1; continue }
        if (index > plainFrom) out.push({ kind: 'text', text: value.slice(plainFrom, index) })
        out.push({ kind: 'annotation', text: hit.term, label: label(hit.term), explanation: hit.explanation })
        index += hit.term.length
        plainFrom = index
      }
      if (plainFrom < value.length) out.push({ kind: 'text', text: value.slice(plainFrom) })
      return out.length === 0 ? [{ kind: 'text', text: value }] : out
    },
  }
}
