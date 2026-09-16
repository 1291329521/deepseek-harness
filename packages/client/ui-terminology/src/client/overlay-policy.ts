/**
 * The open manual-lookup surface: which selection the browser holds, where it
 * was made, and how far its explanation got. The state machine — glossary hit,
 * loading, shown, failed — lives here so the component stays presentation.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/client/overlay-policy
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GlossaryLayer, TerminologyErrorCode } from '../types.ts'

/** Viewport position the surface anchors to, as plain data. */
export interface OverlayRect {
  readonly left: number
  readonly top: number
}

/** One selection the surface was opened on. */
export interface OverlaySelection {
  readonly term: string
  /** Surrounding block text; empty when the selection was refused outright. */
  readonly context: string
  readonly rect: OverlayRect
}

/** One open surface: the takeover menu, or the explanation panel it leads to. */
export type OverlayRequest =
  | OverlaySelection & { readonly kind: 'menu' }
  | OverlaySelection & {
    readonly kind: 'panel'
    readonly stage: 'loading' | 'shown' | 'failed'
    readonly explanation?: string | undefined
    /** Failure of the explanation call. */
    readonly error?: TerminologyErrorCode | undefined
    /** Failure of the last write, shown while the explanation stays on screen. */
    readonly writeError?: TerminologyErrorCode | undefined
    readonly layer: GlossaryLayer
    readonly projectLayerAvailable: boolean
  }

/** Outcome of one explanation request. */
export type OverlayExplainResult =
  | { readonly explanation: string }
  | { readonly code: TerminologyErrorCode }

/** The apply-world capabilities the state machine drives. */
export interface OverlayDeps {
  /** Explanation of a term already in the vocabulary, or `undefined` on a miss. */
  glossaryHit(term: string): string | undefined
  /** Whether the project layer can be written right now. */
  projectLayerAvailable(): boolean
  explain(term: string, context: string): Promise<OverlayExplainResult>
  /** `undefined` means the write landed. */
  remember(term: string, explanation: string, layer: GlossaryLayer): Promise<TerminologyErrorCode | undefined>
}

/**
 * Holds the one open lookup surface for the whole browser and runs its state
 * machine. The plugin publishes `request` as the overlay entry's hook source.
 */
export class OverlayPolicy {
  /** The open surface, or `null` while nothing is showing. */
  readonly request: SnapshotStore<OverlayRequest | null> = createSnapshotStore<OverlayRequest | null>(null)

  private readonly deps: OverlayDeps

  /** @param deps - vocabulary lookup, layer availability, and the remote calls. */
  constructor(deps: OverlayDeps) {
    this.deps = deps
  }

  /** Offer the takeover menu for one accepted selection. */
  openMenu(selection: OverlaySelection): void {
    this.request.set({ kind: 'menu', ...selection })
  }

  /** Show the refusal itself: a selection over the term limit gets a reason, not silence. */
  openTooLong(term: string, rect: OverlayRect): void {
    this.openPanel({ term, context: '', rect, stage: 'failed', error: 'TERM_INVALID' })
  }

  /** Take the menu's entry: a vocabulary hit shows at once, anything else asks the model.
   * @returns The failure code to announce, or `undefined` when nothing failed.
   */
  async select(): Promise<TerminologyErrorCode | undefined> {
    const menu = this.request.getSnapshot()
    if (menu === null || menu.kind !== 'menu') return undefined
    const hit = this.deps.glossaryHit(menu.term)
    if (hit !== undefined) {
      this.openPanel({ ...menu, stage: 'shown', explanation: hit })
      return undefined
    }
    this.openPanel({ ...menu, stage: 'loading' })
    return await this.run(menu.term, menu.context)
  }

  /** Ask the model again for the panel's own term.
   * @returns The failure code to announce, or `undefined` when nothing failed.
   */
  async retry(): Promise<TerminologyErrorCode | undefined> {
    const panel = this.panel()
    if (panel === undefined || panel.context === '') return undefined
    this.request.set({ ...panel, stage: 'loading', error: undefined })
    return await this.run(panel.term, panel.context)
  }

  /** Choose which glossary layer a save writes to. */
  setLayer(layer: GlossaryLayer): void {
    const panel = this.panel()
    if (panel === undefined) return
    this.request.set({ ...panel, layer })
  }

  /** Save the shown explanation into the chosen layer.
   * @returns The failure code to announce, or `undefined` when the write landed.
   */
  async remember(): Promise<TerminologyErrorCode | undefined> {
    const panel = this.panel()
    const explanation = panel?.explanation
    if (panel === undefined || explanation === undefined) return undefined
    const code = await this.deps.remember(panel.term, explanation, panel.layer)
    const live = this.livePanel(panel.term)
    if (code === undefined || live === undefined) return code
    this.request.set({ ...live, writeError: code })
    return code
  }

  /** Close the surface and drop its state. */
  close(): void {
    this.request.set(null)
  }

  private openPanel(request: OverlaySelection & {
    readonly stage: 'loading' | 'shown' | 'failed'
    readonly explanation?: string
    readonly error?: TerminologyErrorCode
  }): void {
    this.request.set({
      ...request,
      // Last: the selection a menu carried is tagged as that menu.
      kind: 'panel',
      layer: 'global',
      projectLayerAvailable: this.deps.projectLayerAvailable(),
    })
  }

  /** Run one explanation and publish its outcome, unless the surface moved on. */
  private async run(term: string, context: string): Promise<TerminologyErrorCode | undefined> {
    const result = await this.deps.explain(term, context)
    const live = this.livePanel(term)
    if (live === undefined) return undefined
    if ('code' in result) {
      this.request.set({ ...live, stage: 'failed', error: result.code })
      return result.code
    }
    this.request.set({ ...live, stage: 'shown', explanation: result.explanation })
    return undefined
  }

  private panel(): Extract<OverlayRequest, { kind: 'panel' }> | undefined {
    const request = this.request.getSnapshot()
    return request !== null && request.kind === 'panel' ? request : undefined
  }

  /** The live panel while it still shows the same term; anything else is stale. */
  private livePanel(term: string): Extract<OverlayRequest, { kind: 'panel' }> | undefined {
    const panel = this.panel()
    return panel?.term === term ? panel : undefined
  }
}
