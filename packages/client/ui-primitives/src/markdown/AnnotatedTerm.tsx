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
 * `role="tooltip"` body opens on hover (delayed), keyboard focus (immediate), or
 * click/tap (toggle) and closes on pointer-leave, blur, Escape, or an outside
 * pointerdown (WCAG 1.4.13: dismissible, hoverable, persistent). A mouse or touch
 * press brings focus before its click lands, so focus opened by a press defers
 * to the click's toggle rather than being closed by it.
 * @param props - The authored span, its accessible name, and its explanation.
 * @returns The interactive span.
 */
export function AnnotatedTerm({ text, label, explanation }: AnnotatedTermProps) {
  const [open, setOpen] = useState(false)
  const modeRef = useRef<OpenMode>('hover')
  // A mouse or touch press focuses the button before its click arrives; focus
  // from a press must not open, or the click's toggle would close it again.
  const pressRef = useRef(false)
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
        onPointerDown={() => { pressRef.current = true }}
        onFocus={() => {
          clearOpenTimer()
          grace.cancel()
          if (pressRef.current) return
          modeRef.current = 'focus'
          setOpen(true)
        }}
        onBlur={() => {
          pressRef.current = false
          if (modeRef.current === 'focus') close()
        }}
        onClick={() => {
          clearOpenTimer()
          grace.cancel()
          pressRef.current = false
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
