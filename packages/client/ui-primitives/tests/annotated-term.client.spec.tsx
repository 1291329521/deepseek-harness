// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { AnnotatedTerm } from '../src/index.ts'

const PROPS = { text: 'Transformer', label: '术语 Transformer，查看解释', explanation: '一种神经网络架构。' } as const

function tooltip(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="tooltip"]')
}

function triggerOf(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('button') as HTMLButtonElement
}

afterEach(cleanup)
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('AnnotatedTerm', () => {
  it('opens on hover after 150ms, not before', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    fireEvent.pointerEnter(triggerOf(container))
    expect(tooltip(container)).toBeNull()
    act(() => { vi.advanceTimersByTime(149) })
    expect(tooltip(container)).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(tooltip(container)?.textContent).toBe('一种神经网络架构。')
  })

  it('never opens when the pointer leaves before the dwell ends', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    fireEvent.pointerEnter(triggerOf(container))
    fireEvent.pointerLeave(triggerOf(container))
    act(() => { vi.advanceTimersByTime(500) })
    expect(tooltip(container)).toBeNull()
  })

  it('opens immediately on keyboard focus and wires aria-describedby', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    const trigger = triggerOf(container)
    expect(trigger.getAttribute('aria-describedby')).toBeNull()
    fireEvent.focus(trigger)
    expect(tooltip(container)).not.toBeNull()
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip(container)?.id)
  })

  it('toggles on click and stays open across pointer-leave (touch semantics)', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    const trigger = triggerOf(container)
    fireEvent.click(trigger)
    expect(tooltip(container)).not.toBeNull()
    fireEvent.pointerLeave(trigger)
    act(() => { vi.advanceTimersByTime(500) })
    expect(tooltip(container)).not.toBeNull()
    fireEvent.click(trigger)
    expect(tooltip(container)).toBeNull()
  })

  it('keeps a tap-opened explanation across re-hover, blur, and leaving the bubble', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    const trigger = triggerOf(container)
    fireEvent.click(trigger)
    fireEvent.pointerEnter(trigger)
    act(() => { vi.advanceTimersByTime(500) })
    fireEvent.blur(trigger)
    fireEvent.pointerEnter(tooltip(container) as Element)
    fireEvent.pointerLeave(tooltip(container) as Element)
    act(() => { vi.advanceTimersByTime(500) })
    expect(tooltip(container)).not.toBeNull()
  })

  it('closes on Escape, on blur after focus-open, and on an outside pointerdown', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    const trigger = triggerOf(container)
    const root = container.querySelector('span') as Element
    fireEvent.focus(trigger)
    fireEvent.keyDown(root, { key: 'Enter' })
    expect(tooltip(container)).not.toBeNull()
    fireEvent.keyDown(root, { key: 'Escape' })
    expect(tooltip(container)).toBeNull()
    fireEvent.focus(trigger)
    fireEvent.blur(trigger)
    expect(tooltip(container)).toBeNull()
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(tooltip(container)).toBeNull()
  })

  it('stays open while the pointer moves from trigger into the tooltip, then closes after leaving it', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    const trigger = triggerOf(container)
    fireEvent.pointerEnter(trigger)
    act(() => { vi.advanceTimersByTime(150) })
    fireEvent.pointerLeave(trigger)
    fireEvent.pointerEnter(tooltip(container) as Element)
    act(() => { vi.advanceTimersByTime(500) })
    expect(tooltip(container)).not.toBeNull()
    fireEvent.pointerLeave(tooltip(container) as Element)
    act(() => { vi.advanceTimersByTime(500) })
    expect(tooltip(container)).toBeNull()
  })

  it('keeps the tooltip free of interactive content', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    fireEvent.focus(triggerOf(container))
    const tip = tooltip(container) as HTMLElement
    expect(tip.querySelector('button, a, input, select, textarea')).toBeNull()
  })
})
