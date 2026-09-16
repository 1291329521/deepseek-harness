/**
 * Two-layer glossary: project file parsing and the merged render vocabulary.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/glossary
 */
import { parseDocument } from 'yaml'
import type { ZodError } from 'zod'
import { projectGlossaryFileSchema } from './spec.ts'
import type { GlossaryTerm } from './types.ts'

/** Renders zod issues as `path: message` pairs; a root issue names `terms`. */
function formatIssues(error: ZodError): string {
  return error.issues
    .map(issue => `${issue.path.length > 0 ? issue.path.join('.') : 'terms'}: ${issue.message}`)
    .join('; ')
}

/**
 * Parse the project glossary YAML body into validated terms.
 * @param body - Raw YAML text of the project glossary file.
 * @returns The validated terms in document order.
 * @throws {Error} when the document is not `{ terms: [...] }`, an entry fails
 * validation, or a term repeats (an ambiguous vocabulary is never half-applied).
 */
export function parseProjectGlossary(body: string): readonly GlossaryTerm[] {
  const document = parseDocument(body, { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`terminology: project glossary terms file is invalid YAML: ${document.errors.map(error => error.message).join('; ')}`)
  }
  const result = projectGlossaryFileSchema.safeParse(document.toJS())
  if (!result.success) {
    throw new Error(`terminology: project glossary must be { terms: [...] } — ${formatIssues(result.error)}`)
  }
  return result.data
}

/**
 * Merge the two layers into the render vocabulary.
 * Project entries win on the same term; the result is ordered by term length
 * descending (longest term first so `Transformer 架构` beats `Transformer`).
 * @param globalTerms - The user-level layer.
 * @param projectTerms - The workspace layer, winning conflicts.
 * @returns The merged, deduplicated, length-sorted vocabulary.
 */
export function mergeGlossary(
  globalTerms: readonly GlossaryTerm[],
  projectTerms: readonly GlossaryTerm[],
): readonly GlossaryTerm[] {
  const merged = new Map<string, GlossaryTerm>()
  for (const entry of globalTerms) merged.set(entry.term, entry)
  for (const entry of projectTerms) merged.set(entry.term, entry)
  return [...merged.values()].sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term))
}
