/**
 * Browser half entry: the assistant-prose annotation provider, the manual
 * lookup takeover, the explanation overlay, and the settings card register
 * here. Export discipline: packages/client/AGENTS.md.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ChatAnnotations } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MarkdownAnnotations } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TERMINOLOGY_NAMESPACE } from '../namespace.ts'
import type { TerminologySettings } from '../spec.ts'
import type { GlossaryLayer, GlossaryTerm, TerminologyState } from '../types.ts'
import { TerminologyCard } from './TerminologyCard.tsx'
import { TerminologyCardPolicy } from './card-policy.ts'
import { TerminologyOverlay } from './TerminologyOverlay.tsx'
import { en, NS, zh } from './locales.ts'
import type { TerminologyKey } from './locales.ts'
import { OverlayPolicy } from './overlay-policy.ts'
import type { OverlayExplainResult, OverlayRect } from './overlay-policy.ts'
import { createTerminologyResolver } from './resolver.ts'
import type { SelectionCandidate } from './selection.ts'
import { evaluateSelection, readSelection } from './selection.ts'
import { matchesShortcut, parseShortcut } from './shortcut.ts'
import type { TerminologyCardProps } from './TerminologyCard.tsx'
import type { TerminologyOverlayProps } from './TerminologyOverlay.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Inline terminology overlay and settings card copy. */
    'ui-terminology': TerminologyKey
  }
}

export type { TerminologyCardProps, TerminologyOverlayProps }

/** Required services for the provider, the lookup takeover, and the card. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.session', 'remote.terminology', 'settingsScope', 'sessions',
]

/** Overlay stacking seat: the lookup surface sits above ordinary app chrome. */
const OVERLAY_ORDER = 100

/**
 * Merge both glossary layers into the render vocabulary: a project entry wins
 * its term against a global one. Entry order is irrelevant — the resolver owns
 * longest-first matching.
 * @param state - one session's glossary projection.
 * @returns the merged vocabulary.
 */
function mergeVocabulary(state: TerminologyState): readonly GlossaryTerm[] {
  const merged = new Map<string, GlossaryTerm>()
  for (const entry of state.globalTerms) merged.set(entry.term, entry)
  for (const entry of state.projectTerms) merged.set(entry.term, entry)
  return [...merged.values()]
}

/**
 * Client plugin body: publish the annotation provider, keep the vocabulary in
 * step with the Host, take over manual lookup, and register both surfaces.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-terminology: dictionaries')
  const t = ctx.locale.bind(NS)

  // The vocabulary the browser may use. null means "nothing to render": no
  // session, no workspace, the feature off, or a read the client cannot use.
  const state = createSnapshotStore<TerminologyState | null>(null)
  let vocabulary: readonly GlossaryTerm[] = []
  let vocabularyKey = ''
  // The published vocabulary observable: one source for the plugin lifetime;
  // its snapshot keeps one identity while the vocabulary is unchanged.
  const annotations = createSnapshotStore<MarkdownAnnotations | undefined>(undefined)

  const rebuild = (): void => {
    const current = state.getSnapshot()
    if (current === null || !current.enabled) {
      vocabulary = []
      vocabularyKey = ''
      annotations.set(undefined)
      return
    }
    const merged = mergeVocabulary(current)
    // A refetch that changes no term and no explanation keeps the published
    // resolver, so Chat's memoized Markdown survives a settings round trip.
    const key = merged.map(entry => `${entry.term}\u0000${entry.explanation}`).join('\n')
    if (key === vocabularyKey && annotations.getSnapshot() !== undefined) return
    vocabularyKey = key
    vocabulary = merged
    annotations.set(createTerminologyResolver(merged, term => t('term.label', { term })))
  }
  ctx.effect(() => state.subscribe(rebuild), 'ui-terminology: vocabulary rebuild')
  ctx.provide('chatAnnotations', { vocabulary: () => annotations } satisfies ChatAnnotations)

  let fetches = 0
  const refetch = async (): Promise<void> => {
    const watched = ++fetches
    const { current, ids } = ctx.sessions.list.getSnapshot()
    // Without a bound session every known session answers and the last wins.
    for (const sessionId of current === undefined ? [...ids] : [current]) {
      const carried = await ctx.remote.terminology.state({ sessionId })
      if (watched !== fetches) return
      // A rejected read — unknown session, no workspace, transport failure —
      // publishes no vocabulary rather than keeping another session's.
      state.set(carried.ok && carried.value.ok ? carried.value.value : null)
    }
  }
  ctx.effect(() => {
    void refetch()
    return ctx.sessions.list.subscribe(() => { void refetch() })
  }, 'ui-terminology: glossary state')
  // A project-file change carries its session id and a settings change carries
  // none; both paths refetch, so the argument is not read.
  ctx.effect(
    () => ctx.remote.$on('terminology/changed', () => { void refetch() }),
    'ui-terminology: glossary changed',
  )

  const activeSession = (): SessionId | undefined => ctx.sessions.list.getSnapshot().current
  const overlay = new OverlayPolicy({
    glossaryHit: term => vocabulary.find(entry => entry.term === term)?.explanation,
    projectLayerAvailable: () => {
      const current = state.getSnapshot()
      return current !== null && current.projectError === undefined
    },
    explain: async (term, context): Promise<OverlayExplainResult> => {
      const sessionId = activeSession()
      if (sessionId === undefined) return { code: 'SESSION_NOT_FOUND' }
      const carried = await ctx.remote.terminology.explain({ sessionId, term, context })
      // A carrier failure means no explanation arrived, which is what the
      // model-failure copy describes; the client cannot name the broken stage.
      if (!carried.ok) return { code: 'LLM_FAILED' }
      return carried.value.ok
        ? { explanation: carried.value.value.explanation }
        : { code: carried.value.error.code }
    },
    remember: async (term, explanation, layer) => {
      const sessionId = activeSession()
      if (sessionId === undefined) return 'SESSION_NOT_FOUND'
      const carried = await ctx.remote.terminology.remember({ sessionId, term, explanation, layer })
      if (!carried.ok) return 'GLOSSARY_WRITE_FAILED'
      return carried.value.ok ? undefined : carried.value.error.code
    },
  })

  /** Open the takeover for one selection, replacing the browser's own menu. */
  const takeOver = (event: MouseEvent | KeyboardEvent, candidate: SelectionCandidate, point: OverlayRect): void => {
    const current = state.getSnapshot()
    if (current === null || !current.enabled) return
    const verdict = evaluateSelection(candidate, current.termMaxChars)
    if (verdict.kind === 'rejected') return
    event.preventDefault()
    if (verdict.kind === 'too-long') {
      overlay.openTooLong(verdict.text, point)
      return
    }
    overlay.openMenu({ term: verdict.text, context: verdict.context, rect: point })
  }
  ctx.effect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      const candidate = readSelection()
      if (candidate === null) return
      takeOver(event, candidate, { left: event.clientX, top: event.clientY })
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const current = state.getSnapshot()
      if (current === null || !current.enabled) return
      const chord = parseShortcut(current.shortcut)
      if (chord === undefined || !matchesShortcut(chord, event)) return
      const candidate = readSelection()
      if (candidate === null) return
      takeOver(event, candidate, candidate.point)
    }
    // Capture phase: the takeover decides before the app's own handlers run.
    document.addEventListener('contextmenu', onContextMenu, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('contextmenu', onContextMenu, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, 'ui-terminology: manual lookup')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: TERMINOLOGY_NAMESPACE,
    order: OVERLAY_ORDER,
    locale: NS,
    inject: () => ({
      hooks: { terminologyOverlay: overlay.request },
      select: () => overlay.select(),
      retry: () => overlay.retry(),
      remember: () => overlay.remember(),
      setLayer: (layer: GlossaryLayer) => { overlay.setLayer(layer) },
      close: () => { overlay.close() },
    }),
  }, TerminologyOverlay))

  const card = new TerminologyCardPolicy({
    scope: ctx.settingsScope.bind<TerminologySettings>({ namespace: TERMINOLOGY_NAMESPACE }),
    glossary: state,
    openProjectFile: async (path) => {
      const result = await ctx.remote.session.openWorkspacePath({ path })
      return result.ok && result.value.opened
    },
  })
  ctx.effect(() => card.watch(), 'ui-terminology: settings card')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: TERMINOLOGY_NAMESPACE,
    locale: NS,
    inject: () => card.inject(),
  }, TerminologyCard))
}
