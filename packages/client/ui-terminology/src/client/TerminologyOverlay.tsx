/**
 * The manual-lookup surface: the takeover menu at the pointer or selection,
 * then the anchored explanation dialog that carries it to a saved term. The
 * published request alone decides what shows; this component adds dismissal,
 * focus, and the transient announcement and nothing else.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, Menu, Toast, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { OverlayRequest } from './overlay-policy.ts'
import { NS } from './locales.ts'
import type { GlossaryLayer, TerminologyErrorCode } from '../types.ts'
import css from './TerminologyOverlay.module.css'

/** Injected face: the published request plus the policy's verbs. */
export interface TerminologyOverlayInjected {
  hooks: { terminologyOverlay: SnapshotStore<OverlayRequest | null> }
  /** Take the menu's entry; resolves to the code worth announcing. */
  select(): Promise<TerminologyErrorCode | undefined>
  /** Ask the model again for what the dialog shows. */
  retry(): Promise<TerminologyErrorCode | undefined>
  /** Save the shown explanation to the selected layer. */
  remember(): Promise<TerminologyErrorCode | undefined>
  /** Choose which glossary layer the save targets. */
  setLayer(layer: GlossaryLayer): void
  close(): void
}

/** Composed props of the `shell.overlay` terminology entry. */
export type TerminologyOverlayProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<TerminologyOverlayInjected>

/**
 * Render the open terminology surface, if any.
 * @param props - the published request, the policy's verbs, and the dictionary.
 * @returns the takeover menu or the explanation dialog, plus any announcement.
 */
export function TerminologyOverlay(props: TerminologyOverlayProps) {
  const request = props.useTerminologyOverlay(value => value)
  const panel = request?.kind === 'panel' ? request : undefined
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open: panel !== undefined, anchorRef, panelRef, gap: 8, margin: 8 })
  useDismissOnOutsidePointer(panelRef, panel !== undefined, () => { props.close() })
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const shown = useRef(0)

  // The dialog takes keyboard focus as it appears, so Escape and Tab land
  // inside it; the menu dismisses through the primitive's own listener.
  const surface = request?.kind
  useEffect(() => {
    if (surface === 'panel') panelRef.current?.focus()
  }, [surface])

  const announce = (text: string): void => {
    shown.current += 1
    setToast({ seq: shown.current, text })
  }
  const choose = async (): Promise<void> => {
    const code = await props.select()
    if (code !== undefined) announce(props.t(`panel.error.${code}`))
  }
  const retry = async (): Promise<void> => {
    const code = await props.retry()
    if (code !== undefined) announce(props.t(`panel.error.${code}`))
  }
  const remember = async (): Promise<void> => {
    const code = await props.remember()
    announce(code === undefined ? props.t('panel.added') : props.t(`panel.error.${code}`))
  }

  return (
    <>
      {request?.kind === 'menu' && (
        <Menu
          open
          anchor={null}
          portal
          items={[{ id: 'explain', label: props.t('menu.explain', { term: request.term }) }]}
          getAnchorRect={() => new DOMRect(request.rect.left, request.rect.top, 0, 0)}
          onSelect={() => { void choose() }}
          onClose={props.close}
        />
      )}
      {panel !== undefined && (
        <>
          <span ref={anchorRef} className={css.anchor} style={{ left: panel.rect.left, top: panel.rect.top }} />
          <div
            ref={panelRef}
            role="dialog"
            aria-label={props.t('panel.title')}
            tabIndex={-1}
            className={css.panel}
            style={position ?? undefined}
            onKeyDown={(event) => { if (event.key === 'Escape') props.close() }}
          >
            {panel.stage === 'loading' && <p className={css.loading}>{props.t('panel.loading')}</p>}
            {panel.stage === 'failed' && panel.error !== undefined && (
              <p className={css.error}>{props.t(`panel.error.${panel.error}`)}</p>
            )}
            {panel.explanation !== undefined && <p className={css.explanation}>{panel.explanation}</p>}
            {panel.writeError !== undefined && <p className={css.error}>{props.t(`panel.error.${panel.writeError}`)}</p>}
            {panel.stage === 'shown' && (
              <div className={css.layers}>
                {(['global', 'project'] as const).map(layer => (
                  <label
                    key={layer}
                    className={clsx(css.layer, panel.layer === layer && css.layerActive)}
                  >
                    <input
                      type="radio"
                      name="terminology-layer"
                      disabled={layer === 'project' && !panel.projectLayerAvailable}
                      checked={panel.layer === layer}
                      onChange={() => { props.setLayer(layer) }}
                    />
                    {props.t(layer === 'global' ? 'panel.layer.global' : 'panel.layer.project')}
                  </label>
                ))}
                {!panel.projectLayerAvailable && <p className={css.reason}>{props.t('panel.layer.project.unavailable')}</p>}
              </div>
            )}
            <div className={css.actions}>
              {panel.stage === 'failed' && panel.context !== '' && (
                <Button variant="outline" size="sm" onClick={() => { void retry() }}>{props.t('panel.retry')}</Button>
              )}
              {panel.stage === 'shown' && (
                <Button variant="primary" size="sm" onClick={() => { void remember() }}>{props.t('panel.add')}</Button>
              )}
              <Button variant="ghost" size="sm" onClick={props.close}>{props.t('panel.close')}</Button>
            </div>
          </div>
        </>
      )}
      {toast !== null && <Toast key={toast.seq} text={toast.text} onDone={() => { setToast(null) }} />}
    </>
  )
}
