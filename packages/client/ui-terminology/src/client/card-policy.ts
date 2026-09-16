/**
 * The settings card's model: one store over the terminology settings section
 * and the per-session glossary projection, plus the writes the card offers.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/client/card-policy
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TerminologySettings } from '../spec.ts'
import type { GlossaryTerm, TerminologyState } from '../types.ts'
import { parseShortcut } from './shortcut.ts'

/** Why the card is showing an error line, as a discriminant. */
export type TerminologyCardError =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'shortcut' }
  | { readonly kind: 'open' }

/** Everything the card renders. */
export interface TerminologyCardState {
  /** The settings namespace is served; without it the card renders nothing. */
  readonly ready: boolean
  readonly writable: boolean
  readonly enabled: boolean
  readonly shortcut: string
  readonly globalTerms: readonly GlossaryTerm[]
  readonly projectPath: string
  readonly projectTerms: readonly GlossaryTerm[]
  /** Project-file read or parse failure, safe to show. */
  readonly projectError?: string
  readonly error?: TerminologyCardError
}

/** The card's write face; every value arrives already trimmed. */
export interface TerminologyCardInjected {
  hooks: { terminologyCard: SnapshotStore<TerminologyCardState> }
  setEnabled(enabled: boolean): void
  setShortcut(text: string): void
  addTerm(term: string, explanation: string): void
  updateTerm(index: number, term: string, explanation: string): void
  removeTerm(index: number): void
  openProjectFile(): void
}

/** What the policy needs from the apply world. */
export interface TerminologyCardDeps {
  scope: SettingsScope<TerminologySettings>
  /** The same per-session state store the annotation provider reads. */
  glossary: ObservableSnapshot<TerminologyState | null>
  /** Ask the shell to open the project glossary file; resolves to whether it opened. */
  openProjectFile(path: string): Promise<boolean>
}

/** One settings field the card writes. */
type CardField = keyof TerminologySettings

/** The text one term list states, so two lists compare without indexing. */
function termsKey(entries: readonly GlossaryTerm[]): string {
  return entries.map(entry => `${entry.term}\u0000${entry.explanation}`).join('\n')
}

function sameTerms(left: readonly GlossaryTerm[], right: readonly GlossaryTerm[]): boolean {
  return termsKey(left) === termsKey(right)
}

function sameState(left: TerminologyCardState, right: TerminologyCardState): boolean {
  return left.ready === right.ready && left.writable === right.writable
    && left.enabled === right.enabled && left.shortcut === right.shortcut
    && left.projectPath === right.projectPath && left.projectError === right.projectError
    && sameTerms(left.globalTerms, right.globalTerms)
    && sameTerms(left.projectTerms, right.projectTerms)
    && left.error?.kind === right.error?.kind
}

/**
 * Fold the settings section and the glossary projection into one card
 * snapshot, and perform the card's writes through the settings scope. The card
 * replaces the whole `terms` array on every edit; a write the Host did not
 * take lands as a visible conflict rather than a silently unchanged list.
 */
export class TerminologyCardPolicy {
  /** The card's render input. */
  readonly source: SnapshotStore<TerminologyCardState>

  private readonly deps: TerminologyCardDeps

  /** @param deps - settings scope, glossary projection, and project-file opener. */
  constructor(deps: TerminologyCardDeps) {
    this.deps = deps
    this.source = createSnapshotStore<TerminologyCardState>(this.read())
  }

  /** Follow both sources into the card snapshot; @returns the disposer. */
  watch(): () => void {
    const follow = (): void => { this.adopt() }
    const off = [this.deps.scope.subscribe(follow), this.deps.glossary.subscribe(follow)]
    this.adopt()
    return () => {
      for (const dispose of off) dispose()
    }
  }

  /** The card's injected face: the published snapshot plus the write verbs. */
  inject(): TerminologyCardInjected {
    return {
      hooks: { terminologyCard: this.source },
      setEnabled: (enabled) => { void this.commit('enabled', enabled) },
      setShortcut: (text) => {
        const shortcut = text.trim()
        if (parseShortcut(shortcut) === undefined) {
          this.publish({ ...this.read(), error: { kind: 'shortcut' } })
          return
        }
        void this.commit('explainShortcut', shortcut)
      },
      addTerm: (term, explanation) => {
        void this.commit('terms', [...this.currentTerms(), { term, explanation }])
      },
      updateTerm: (index, term, explanation) => {
        const next = [...this.currentTerms()]
        next[index] = { term, explanation }
        void this.commit('terms', next)
      },
      removeTerm: (index) => {
        const next = [...this.currentTerms()]
        next.splice(index, 1)
        void this.commit('terms', next)
      },
      openProjectFile: () => {
        void this.deps.openProjectFile(this.source.getSnapshot().projectPath).then((opened) => {
          if (opened) return
          this.publish({ ...this.read(), error: { kind: 'open' } })
        })
      },
    }
  }

  /** Replace the published snapshot when the facts moved. */
  private adopt(): void {
    const next = this.read()
    if (sameState(this.source.getSnapshot(), next)) return
    this.source.set(next)
  }

  private publish(next: TerminologyCardState): void {
    this.source.set(next)
  }

  private read(): TerminologyCardState {
    const settings = this.deps.scope.getSnapshot()
    const glossary = this.deps.glossary.getSnapshot()
    return {
      ready: settings.status === 'ready',
      writable: settings.writable,
      enabled: settings.value?.enabled ?? glossary?.enabled ?? false,
      shortcut: settings.value?.explainShortcut ?? glossary?.shortcut ?? '',
      globalTerms: settings.value?.terms ?? glossary?.globalTerms ?? [],
      projectPath: glossary?.projectPath ?? '',
      projectTerms: glossary?.projectTerms ?? [],
      ...(glossary?.projectError === undefined ? {} : { projectError: glossary.projectError }),
    }
  }

  private currentTerms(): readonly GlossaryTerm[] {
    return this.deps.scope.getSnapshot().value?.terms ?? []
  }

  /** Write one field, then report whether the Host took the value it was given. */
  private async commit(field: CardField, value: unknown): Promise<void> {
    try {
      await this.deps.scope.set(field, value)
    } catch {
      // Scope settlement is the only failure channel; a rejected write leaves
      // the mirror on Host state, which the landed check below reads.
    }
    const user = this.deps.scope.getSnapshot().user as Partial<TerminologySettings> | undefined
    const landed = JSON.stringify(user?.[field] ?? null) === JSON.stringify(value)
    this.publish({
      ...this.read(),
      ...(landed ? {} : { error: { kind: 'conflict' as const } }),
    })
  }
}
