// @vitest-environment jsdom
/** Forwarded prose annotations reach the settled Assistant Markdown text blocks. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { MarkdownAnnotations } from '@deepseek-ai/dsh-client-ui-primitives'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'

afterEach(() => {
  cleanup()
})

const t = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

const TERMS_LABEL = '术语 Transformer，查看解释'

const hitAnnotations: MarkdownAnnotations = {
  split: run => run === 'a Transformer'
    ? [
      { kind: 'text', text: 'a ' },
      { kind: 'annotation', text: 'Transformer', label: TERMS_LABEL, explanation: 'A model.' },
    ]
    : [{ kind: 'text', text: run }],
}

const missAnnotations: MarkdownAnnotations = {
  split: run => [{ kind: 'text', text: run }],
}

describe('AssistantMarkdown annotations', () => {
  it('renders the resolver-backed annotation inside settled text blocks', () => {
    const { container } = render(<AssistantMarkdown
      blocks={[{ kind: 'text', text: 'a Transformer' }]}
      streaming={false}
      renderMessageImages={renderMessageImages}
      annotations={hitAnnotations}
      t={t}
    />)
    const term = container.querySelector(`[aria-label="${TERMS_LABEL}"]`)
    expect(term).not.toBeNull()
    expect(term?.textContent).toBe('Transformer')
  })

  it('renders plain prose when the resolver matches nothing', () => {
    const { container } = render(<AssistantMarkdown
      blocks={[{ kind: 'text', text: 'a Transformer' }]}
      streaming={false}
      renderMessageImages={renderMessageImages}
      annotations={missAnnotations}
      t={t}
    />)
    expect(container.querySelector('[aria-label]')).toBeNull()
    expect(container.textContent).toBe('a Transformer')
  })
})
