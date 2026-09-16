/**
 * Interactive annotated-term span: a button trigger with a hover, focus, and tap
 * tooltip. All user-facing copy arrives complete through props; the package owns
 * no vocabulary and no locale text.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useDismissOnOutsidePointer } from '../useDismissOnOutsidePointer.ts'
import { usePointerGrace } from '../pointer-grace.ts'
import css from './AnnotatedTerm.module.css'

/** Fixed interaction constant: an instant open would flash while the pointer travels across prose. */
const HOVER_OPEN_DELAY_MS = 150

/** Which gesture opened the tooltip; it decides what may close it. */
type OpenMode = 'hover' | 'focus' | 'click'

/** Props of one annotated span. */
export interface AnnotatedTermProps {
  /** The authored substring, rendered verbatim as the trigger's content. */
  readonly text: string
  /** Accessible name for the trigger; locale-owned by the annotations provider. */
  readonly label: string
  /** Tooltip body: explanation text only — no interactive content ships here. */
  readonly explanation: string
}

/**
 * Render one annotation: a `<button>` trigger (so assistive tech and touch users
 * find a button in the accessibility tree, independent of any hover styling) whose
 * `role="tooltip"` body opens on hover (delayed), focus (immediate), or
 * click/tap (toggle) and closes on pointer-leave, blur, Escape, or an outside
 * pointerdown (WCAG 1.4.13: dismissible, hoverable, persistent).
 * @param props - The authored span, its accessible name, and its explanation.
 * @returns The interactive span.
 */
export function AnnotatedTerm({ text, label, explanation }: AnnotatedTermProps) {
  const [open, setOpen] = useState(false)
  const modeRef = useRef<OpenMode>('hover')
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tooltipId = useId()
  const clearOpenTimer = useCallback((): void => {
    if (openTimerRef.current !== undefined) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = undefined
    }
  }, [])
  const close = (): void => {
    clearOpenTimer()
    setOpen(false)
  }
  const grace = usePointerGrace(close)
  useDismissOnOutsidePointer(rootRef, open, setOpen)
  // A pending open dies with the span, exactly as the pending grace close does.
  useEffect(() => clearOpenTimer, [clearOpenTimer])
  const armHoverOpen = (): void => {
    clearOpenTimer()
    grace.cancel()
    if (open) return
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = undefined
      modeRef.current = 'hover'
      setOpen(true)
    }, HOVER_OPEN_DELAY_MS)
  }
  const leave = (): void => {
    clearOpenTimer()
    if (modeRef.current === 'click') return
    grace.arm()
  }
  return (
    <span
      ref={rootRef}
      className={css.root}
      onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
        if (event.key === 'Escape') close()
      }}
    >
      <button
        type="button"
        className={css.term}
        aria-label={label}
        aria-describedby={open ? tooltipId : undefined}
        onPointerEnter={armHoverOpen}
        onPointerLeave={leave}
        onFocus={() => {
          clearOpenTimer()
          grace.cancel()
          modeRef.current = 'focus'
          setOpen(true)
        }}
        onBlur={() => {
          if (modeRef.current === 'focus') close()
        }}
        onClick={() => {
          clearOpenTimer()
          if (open) setOpen(false)
          else {
            modeRef.current = 'click'
            setOpen(true)
          }
        }}
      >
        {text}
      </button>
      {open && (
        <span
          role="tooltip"
          id={tooltipId}
          className={css.tooltip}
          onPointerEnter={() => { grace.cancel() }}
          onPointerLeave={() => {
            if (modeRef.current !== 'click') grace.arm()
          }}
        >
          {explanation}
        </span>
      )}
    </span>
  )
}
