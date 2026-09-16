// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MarkdownText } from './markdown-test-components.tsx'
import type { MarkdownAnnotations, MarkdownSegment } from '../src/index.ts'

afterEach(cleanup)

function constant(value: string, segments: readonly MarkdownSegment[]): MarkdownAnnotations {
  const split = vi.fn((run: string): readonly MarkdownSegment[] => (
    run === value ? segments : [{ kind: 'text', text: run }]
  ))
  return { split }
}

describe('MarkdownText annotations', () => {
  it('annotates plain text runs and preserves the surrounding text', () => {
    const annotations = constant('what is a Transformer', [
      { kind: 'text', text: 'what is a ' },
      { kind: 'annotation', text: 'Transformer', label: '术语 Transformer，查看解释', explanation: '一种神经网络架构。' },
    ])
    const { container } = render(<MarkdownText text="what is a Transformer" annotations={annotations} />)
    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('Transformer')
    expect(button?.getAttribute('aria-label')).toBe('术语 Transformer，查看解释')
    expect(container.textContent).toContain('what is a ')
    expect(container.querySelector('button')).toBe(container.querySelector('[aria-label="术语 Transformer，查看解释"]'))
  })

  it('renders a run the vocabulary leaves alone exactly as unannotated', () => {
    const source = 'plain **prose** here\n\nand a second paragraph\n'
    const annotations: MarkdownAnnotations = { split: run => [{ kind: 'text', text: run }] }
    const annotated = render(<MarkdownText text={source} annotations={annotations} />)
    const plain = render(<MarkdownText text={source} />)
    expect(annotated.container.querySelector('button')).toBeNull()
    expect(annotated.container.innerHTML).toBe(plain.container.innerHTML)
  })

  it('never splits runs inside links', () => {
    // Every run answers with an annotation, so a resolver called inside the
    // anchor would put a button in it; the link's run must never reach split.
    const split = vi.fn((run: string): readonly MarkdownSegment[] => [
      { kind: 'annotation', text: run, label: '术语', explanation: 'E' },
    ])
    const { container } = render(<MarkdownText text="[Transformer](https://example.test)" annotations={{ split }} />)
    expect(split).not.toHaveBeenCalled()
    expect(container.querySelector('a')).not.toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })

  it('does not annotate while streaming', () => {
    const annotations = constant('Transformer', [{ kind: 'annotation', text: 'Transformer', label: 'T', explanation: 'E' }])
    const { container } = render(<MarkdownText text="Transformer" streaming annotations={annotations} />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('leaves inline code and math untouched', () => {
    const seen: string[] = []
    const annotations: MarkdownAnnotations = {
      split(run) { seen.push(run); return [{ kind: 'text', text: run }] },
    }
    render(<MarkdownText text={'`Transformer`\n\n$$Transformer$$\n'} annotations={annotations} />)
    expect(seen.filter(run => run.includes('Transformer') && !run.includes('`'))).toEqual([])
  })
})
