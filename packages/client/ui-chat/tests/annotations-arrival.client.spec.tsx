// @vitest-environment jsdom
/**
 * Reactive-read guard for the keyed Chat renderer: the annotation vocabulary
 * arrives as an observable, so a settled Assistant render that first saw no
 * vocabulary re-renders when the vocabulary lands — no remount — while a
 * republished identical resolver identity notifies nobody and churns nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  SlotTestRuntime, TestRemote, stubSettingsScope, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MarkdownAnnotations } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  apply as applyConversation, inject as injectConversation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  apply as applyChat, inject as injectChat,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ChatNodeTurnDataInjected, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { AssistantNodeView } from '../src/client/chat/AssistantNodeView.tsx'
import { zh } from '../src/client/locale.ts'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../src/chat-settings.ts'

usePinnedBrowserLanguages('zh-CN')

const SID = 'session-annotations' as SessionId
const TERM_LABEL = '术语 Transformer，查看解释'

/** Settled single-text-block Assistant Node in one closed Step. */
function settledAssistantNode(text: string): ChatNodeViewProps<'assistant-step'>['node'] {
  return {
    kind: 'assistant-step',
    seq: 2,
    anchorSeq: 2,
    target: 'chat',
    visibility: 'visible',
    location: { kind: 'step', turn: { turn: 1, step: 1 }, anchorSeq: 2 },
    data: {
      status: 'settled',
      turn: 1,
      step: 1,
      time: 2_000,
      blocks: [{ kind: 'text', text }],
      finalNode: {
        kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1,
        blocks: [{ kind: 'text', text }],
      },
    },
  } as unknown as ChatNodeViewProps<'assistant-step'>['node']
}

/** Vocabulary that annotates the word `Transformer` with the given explanation. */
function resolverFor(explanation: string): MarkdownAnnotations {
  return {
    split: run => run === 'a Transformer'
      ? [
        { kind: 'text', text: 'a ' },
        { kind: 'annotation', text: 'Transformer', label: TERM_LABEL, explanation },
      ]
      : [{ kind: 'text', text: run }],
  }
}

async function bench(options: { withAnnotations?: boolean } = {}) {
  const runtime = await SlotTestRuntime.create()
  const chatSettings = stubSettingsScope<ChatSettings>()
  runtime.ctx.provide('settingsScope', {
    bind: ({ namespace }: { namespace: string }) => namespace === CHAT_SETTINGS_NAMESPACE
      ? chatSettings.scope
      : stubSettingsScope().scope,
  } as never)
  runtime.ctx.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() } as never)
  runtime.ctx.provide('uiWorkspace', {
    connectWorkspace: vi.fn(async () => SID),
  } as never)
  new TestRemote(runtime.ctx, {
    session: { openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })) },
  })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({
    'conversation': { kind: 'single', scope: 'session-maybe' },
    'details': { kind: 'single', scope: 'session' },
    'conversation.approval.detail': { kind: 'single', scope: 'session' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  }, (_props: { renderSlot?: unknown }) => null)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  // The vocabulary store stands in for the terminology provider's published
  // observable; the provider's own rebuild semantics live in its apply spec.
  const vocabulary = createSnapshotStore<MarkdownAnnotations | undefined>(undefined)
  if (options.withAnnotations !== false) {
    runtime.ctx.provide('chatAnnotations', { vocabulary: () => vocabulary })
  }
  await runtime.mount({ inject: [...injectChat], apply: applyChat })
  const spec = runtime.slots.spec('conversation.chat.node') as unknown as {
    inject: ChatNodeTurnDataInjected
  }
  const useAnnotations = spec.inject.hooks.annotations(
    undefined as never, undefined as never,
  )
  return { runtime, vocabulary, useAnnotations }
}

function renderAssistant(useAnnotations: () => MarkdownAnnotations | undefined) {
  const props = {
    node: settledAssistantNode('a Transformer'),
    useTurnData: () => undefined,
    useAnnotations,
    openFile: vi.fn(),
    renderMessageImages: () => null,
    fileMentions: () => undefined,
    t: makeTranslate(zh, commonZh),
  } as unknown as ChatNodeViewProps<'assistant-step'>
  return render(<AssistantNodeView {...props} />)
}

afterEach(() => {
  cleanup()
})

describe('settled Assistant observes the vocabulary observable', () => {
  it('annotates a settled render when the vocabulary lands after first paint, with no remount', async () => {
    const { vocabulary, useAnnotations } = await bench()
    const view = renderAssistant(useAnnotations)
    // First paint: vocabulary absent, prose renders plain.
    expect(view.container.querySelector('[aria-label]')).toBeNull()
    expect(view.container.textContent).toBe('a Transformer')

    // The refetch resolves after the settled render: the subscription re-renders.
    const resolver = resolverFor('A model.')
    act(() => {
      vocabulary.set(resolver)
    })
    const term = view.container.querySelector(`[aria-label="${TERM_LABEL}"]`)
    expect(term).not.toBeNull()
    expect(term?.textContent).toBe('Transformer')
    await Promise.resolve()
  })

  it('churns nothing on a republished identical resolver and re-renders on a new vocabulary', async () => {
    const { vocabulary, useAnnotations } = await bench()
    const resolver = resolverFor('A model.')
    act(() => {
      vocabulary.set(resolver)
    })
    const view = renderAssistant(useAnnotations)
    const term = view.container.querySelector(`[aria-label="${TERM_LABEL}"]`)
    expect(term).not.toBeNull()

    let notifications = 0
    const off = vocabulary.subscribe(() => { notifications += 1 })
    // The same identity republished (a refetch of unchanged vocabulary)
    // notifies nobody and replaces nothing.
    act(() => {
      vocabulary.set(resolver)
    })
    expect(notifications).toBe(0)
    expect(view.container.querySelector(`[aria-label="${TERM_LABEL}"]`)).toBe(term)

    // A moved vocabulary is a new identity: the render updates in place and
    // the opened tooltip carries the new explanation.
    act(() => {
      vocabulary.set(resolverFor('A newer model.'))
    })
    expect(notifications).toBe(1)
    expect(term?.isConnected).toBe(true)
    fireEvent.click(term!)
    expect(view.container.textContent).toContain('A newer model.')
    off()
  })

  it('renders plain prose while no provider mounted the service', async () => {
    const { useAnnotations } = await bench({ withAnnotations: false })
    const view = renderAssistant(useAnnotations)
    expect(view.container.querySelector('[aria-label]')).toBeNull()
    expect(view.container.textContent).toBe('a Transformer')
  })
})
