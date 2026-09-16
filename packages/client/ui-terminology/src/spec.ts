/**
 * Runtime schemas: Host Config (deployment defaults), the user settings
 * section, and the project glossary file format.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/spec
 */
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { GlossaryTerm } from './types.ts'

/** Default manual-explain chord. */
export const DEFAULT_EXPLAIN_SHORTCUT = 'Alt+Shift+E'

/** Default project glossary file, relative to the session workspace. */
export const DEFAULT_PROJECT_GLOSSARY_PATH = '.dsh/terminology.yml'

/** Shared length bounds so the settings layer and the project file never disagree. */
const TERM_MAX_CHARS = 200
const EXPLANATION_MAX_CHARS = 4_000

/** One glossary entry at the settings and Host-Config boundary. */
export const glossaryTermSchema: z<GlossaryTerm> = z.object({
  term: z.string().min(1).max(TERM_MAX_CHARS).required(),
  explanation: z.string().min(1).max(EXPLANATION_MAX_CHARS).required(),
})

/** Upper bound a remembered explanation may occupy at every durable boundary. */
export const GLOSSARY_EXPLANATION_MAX_CHARS = EXPLANATION_MAX_CHARS

/** User-editable section stored in the settings document. */
export interface TerminologySettings {
  readonly enabled: boolean
  readonly explainShortcut: string
  /** Schemastery array fields stay mutable; entries are readonly values. */
  terms: GlossaryTerm[]
}

/** Settings section; Host Config supplies the composition base for all three. */
export const TerminologySettingsSchema: z<TerminologySettings> = z.object({
  enabled: z.boolean().default(true),
  explainShortcut: z.string().default(DEFAULT_EXPLAIN_SHORTCUT),
  terms: z.array(glossaryTermSchema).default([]),
})

/** Validated Host configuration (all fields, no hardcoded tunables). */
export interface TerminologyConfig {
  readonly enabled: boolean
  /** Schemastery array fields stay mutable; entries are readonly values. */
  terms: GlossaryTerm[]
  readonly explainShortcut: string
  /** Project glossary file, workspace-relative; absolute or escaping paths never resolve. */
  readonly projectGlossaryPath: string
  readonly explainProvider?: string
  readonly explainModel?: string
  readonly explainMaxTokens: number
  readonly explainMaxSentences: number
  readonly explainTimeoutMs: number
  readonly explainTermMaxChars: number
  readonly explainContextMaxBytes: number
}

/** Host configuration of the terminology plugin; every field carries its default. */
export const TerminologyConfigSchema: z<TerminologyConfig> = z.object({
  enabled: z.boolean().default(true),
  terms: z.array(glossaryTermSchema).default([]),
  explainShortcut: z.string().default(DEFAULT_EXPLAIN_SHORTCUT),
  projectGlossaryPath: z.string().default(DEFAULT_PROJECT_GLOSSARY_PATH),
  explainProvider: z.string(),
  explainModel: z.string(),
  explainMaxTokens: z.number().min(1).default(256),
  explainMaxSentences: z.number().min(1).default(3),
  explainTimeoutMs: z.number().min(1).default(30_000),
  explainTermMaxChars: z.number().min(1).default(64),
  explainContextMaxBytes: z.number().min(1).default(2_048),
})

/** Project glossary file body: `{ terms: [...] }`, duplicate terms rejected. */
export const projectGlossaryFileSchema = zod.object({
  terms: zod.array(zod.object({
    term: zod.string().min(1).max(TERM_MAX_CHARS),
    explanation: zod.string().min(1).max(EXPLANATION_MAX_CHARS),
  })),
}).transform((doc) => {
  const seen = new Set<string>()
  for (const entry of doc.terms) {
    if (seen.has(entry.term)) throw new Error(`terminology: duplicate project term "${entry.term}"`)
    seen.add(entry.term)
  }
  return doc.terms
})
