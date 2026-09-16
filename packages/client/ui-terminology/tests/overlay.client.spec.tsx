// @vitest-environment jsdom
/**
 * The manual-lookup surface: the single menu entry, the dialog's
 * glossary-hit / loading / shown / failed states with its retry, the Toast
 * announcements, dismissal, the remember layer choice, and the absence of any
 * download or export affordance.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TerminologyErrorCode } from '../src/types.ts'
import { OverlayPolicy, type OverlayRequest } from '../src/client/overlay-policy.ts'
import { TerminologyOverlay, type TerminologyOverlayInjected, type TerminologyOverlayProps } from '../src/client/TerminologyOverlay.tsx'
import { en, zh } from '../src/client/locales.ts'

// The two surfaces are root-scope entries, so their props carry the standing
// global hooks. Nothing here reads them; they satisfy the framework seat.
type SessionsSnapshot = Parameters<Parameters<TerminologyOverlayProps['useSessions']>[0]>[0]
type WorkspacesSnapshot = Parameters<Parameters<TerminologyOverlayProps['useWorkspaces']>[0]>[0]
type AttentionSnapshot = Parameters<Parameters<TerminologyOverlayProps['useSessionPendingInteraction']>[0]>[0]

function globalHooks(): Pick<TerminologyOverlayProps, 'useSessions' | 'useWorkspaces' | 'useSessionPendingInteraction'> {
  const sessions = createSnapshotStore<SessionsSnapshot>({
    ids: [], byId: {}, current: undefined, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const workspaces = createSnapshotStore<WorkspacesSnapshot>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  const attention = createSnapshotStore<AttentionSnapshot>(new Map())
  return {
    useSessions: bindSnapshotSelector(sessions),
    useWorkspaces: bindSnapshotSelector(workspaces),
    useSessionPendingInteraction: bindSnapshotSelector(attention),
  }
}

const RECT = { left: 120, top: 240 }

interface Harness {
  readonly props: TerminologyOverlayProps
  readonly policy: OverlayPolicy
  readonly explain: ReturnType<typeof vi.fn>
  readonly remember: ReturnType<typeof vi.fn>
}

/** A real policy over stubbed remote deps, wired as the component's props. */
function harness(options: {
  glossary?: Record<string, string>
  explain?: (term: string, context: string) => Promise<{ explanation: string } | { code: TerminologyErrorCode }>
  remember?: (layer: string) => Promise<TerminologyErrorCode | undefined>
  projectLayerAvailable?: boolean
} = {}): Harness {
  const explain = vi.fn(options.explain ?? (async () => ({ explanation: '一次模型解释' })))
  const remember = vi.fn(options.remember ?? (async () => undefined))
  const policy = new OverlayPolicy({
    glossaryHit: term => options.glossary?.[term],
    projectLayerAvailable: () => options.projectLayerAvailable ?? true,
    explain,
    remember: (_term, _explanation, layer) => remember(layer),
  })
  const injected: TerminologyOverlayInjected = {
    hooks: { terminologyOverlay: policy.request },
    select: () => policy.select(),
    retry: () => policy.retry(),
    remember: () => policy.remember(),
    setLayer: (layer) => { policy.setLayer(layer) },
    close: () => { policy.close() },
  }
  return {
    props: { ...globalHooks(), ...injected, useTerminologyOverlay: bindSnapshotSelector(policy.request), t: makeTranslate(zh, en) },
    policy,
    explain,
    remember,
  }
}

/** Open the menu the way the document listener does: one selection fact set. */
function openMenu(policy: OverlayPolicy, term = '大模型'): void {
  policy.openMenu({ term, context: `关于${term}的段落`, rect: RECT })
}

/** One mounted overlay per test; a second render would mount a second surface. */
function mount(subject: Harness): Harness {
  render(<TerminologyOverlay {...subject.props} />)
  return subject
}

/** Publish the selection, then take the entry it offers. */
async function openDialog(subject: Harness, term = '大模型'): Promise<void> {
  await act(async () => { openMenu(subject.policy, term) })
  await act(async () => { fireEvent.click(screen.getByRole('menuitem')) })
}

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('TerminologyOverlay menu', () => {
  it('offers exactly one action for the selected text: explain it', () => {
    const { policy, props } = harness()
    openMenu(policy)
    render(<TerminologyOverlay {...props} />)
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent).toContain('解释「大模型」')
    expect(screen.queryByText('加入术语表')).toBeNull()
  })

  it('shows a glossary hit immediately and never calls the model', async () => {
    const { policy, props, explain } = harness({ glossary: { 大模型: '术语表里的解释' } })
    openMenu(policy)
    render(<TerminologyOverlay {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('menuitem')) })
    expect(explain).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').textContent).toContain('术语表里的解释')
  })

  it('closes the menu on Escape', () => {
    const { policy, props } = harness()
    openMenu(policy)
    render(<TerminologyOverlay {...props} />)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(policy.request.getSnapshot()).toBeNull()
  })
})

describe('TerminologyOverlay dialog', () => {
  it('shows the loading state, then the model answer', async () => {
    let resolveExplain: ((value: { explanation: string }) => void) | undefined
    const subject = harness({ explain: () => new Promise((resolve) => { resolveExplain = resolve }) })
    openMenu(subject.policy)
    render(<TerminologyOverlay {...subject.props} />)
    await act(async () => { fireEvent.click(screen.getByRole('menuitem')) })
    expect(screen.getByRole('dialog').textContent).toContain('正在请求解释')
    await act(async () => { resolveExplain?.({ explanation: '模型给出的解释' }) })
    expect(screen.getByRole('dialog').textContent).toContain('模型给出的解释')
  })

  it('is a dialog that owns focus as soon as it opens', async () => {
    const subject = mount(harness())
    await openDialog(subject)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBe(document.activeElement)
  })

  it('passes the selected block text as the explain context', async () => {
    const subject = mount(harness())
    await openDialog(subject)
    expect(subject.explain).toHaveBeenCalledWith('大模型', '关于大模型的段落')
  })

  it('shows the failure copy for the error code, announces it once, and retries', async () => {
    const explain = vi.fn()
      .mockResolvedValueOnce({ code: 'NO_MODEL_ROUTE' satisfies TerminologyErrorCode })
      .mockResolvedValueOnce({ explanation: '重试之后的解释' })
    const subject = mount(harness({ explain: explain as never }))
    await openDialog(subject)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('当前会话没有可用的模型路由')
    expect(screen.getByRole('alert').textContent).toContain('当前会话没有可用的模型路由')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '重试' })) })
    expect(explain).toHaveBeenCalledTimes(2)
    expect(dialog.textContent).toContain('重试之后的解释')
  })

  it('refuses an over-long selection visibly, with no retry to repeat the same refusal', async () => {
    const subject = harness()
    subject.policy.openTooLong('一段远远超过长度上限的选中文本', RECT)
    render(<TerminologyOverlay {...subject.props} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('这段文字太短或太长')
    expect(within(dialog).queryByRole('button', { name: '重试' })).toBeNull()
    expect(subject.explain).not.toHaveBeenCalled()
  })

  it('leaves the dialog alone for any other key', async () => {
    const subject = mount(harness())
    await openDialog(subject)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' })
    expect(subject.policy.request.getSnapshot()).toMatchObject({ kind: 'panel' })
  })

  it('announces a retry that fails again', async () => {
    const explain = vi.fn()
      .mockResolvedValueOnce({ code: 'LLM_FAILED' satisfies TerminologyErrorCode })
      .mockResolvedValueOnce({ code: 'TIMEOUT' satisfies TerminologyErrorCode })
    const subject = mount(harness({ explain: explain as never }))
    await openDialog(subject)
    const dialog = screen.getByRole('dialog')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '重试' })) })
    expect(dialog.textContent).toContain('解释请求超时')
    expect(screen.getByRole('alert').textContent).toContain('解释请求超时')
  })

  it('announcement disappears on its own', async () => {
    vi.useFakeTimers()
    const subject = mount(harness())
    await openDialog(subject)
    const dialog = screen.getByRole('dialog')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '加入术语表' })) })
    expect(screen.getByRole('alert').textContent).toContain('已加入术语表')
    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes on Escape and on a pointer outside it', async () => {
    const subject = mount(harness())
    await openDialog(subject)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(subject.policy.request.getSnapshot()).toBeNull()
    await openDialog(subject)
    act(() => { fireEvent.pointerDown(document.body) })
    expect(subject.policy.request.getSnapshot()).toBeNull()
  })

  it('drops a model answer that arrives after the dialog was closed', async () => {
    let resolveExplain: ((value: { explanation: string }) => void) | undefined
    const subject = harness({ explain: () => new Promise((resolve) => { resolveExplain = resolve }) })
    openMenu(subject.policy)
    render(<TerminologyOverlay {...subject.props} />)
    await act(async () => { fireEvent.click(screen.getByRole('menuitem')) })
    act(() => { subject.policy.close() })
    await act(async () => { resolveExplain?.({ explanation: '迟到的解释' }) })
    expect(subject.policy.request.getSnapshot()).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('TerminologyOverlay remember', () => {
  /** Drive one harness's panel into the shown state with a model answer. */
  async function shownDialog(subject: Harness = harness()): Promise<Harness> {
    mount(subject)
    await openDialog(subject)
    return subject
  }

  it('saves to the global layer by default and confirms with a Toast', async () => {
    const subject = await shownDialog()
    const dialog = screen.getByRole('dialog')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '加入术语表' })) })
    expect(subject.remember).toHaveBeenCalledWith('global')
    expect(screen.getByRole('alert').textContent).toContain('已加入术语表')
  })

  it('switches the target layer from the dialog', async () => {
    const subject = await shownDialog()
    const dialog = screen.getByRole('dialog')
    await act(async () => { fireEvent.click(within(dialog).getByRole('radio', { name: '本项目术语表' })) })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '加入术语表' })) })
    expect(subject.remember).toHaveBeenCalledWith('project')
  })

  it('disables the unavailable project layer and says why', async () => {
    await shownDialog(harness({ projectLayerAvailable: false }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: '本项目术语表' })).toHaveProperty('disabled', true)
    expect(dialog.textContent).toContain('当前会话没有可用的项目术语表')
  })

  it('surfaces a rejected write visibly instead of swallowing it', async () => {
    await shownDialog(harness({ remember: async () => 'GLOSSARY_WRITE_FAILED' satisfies TerminologyErrorCode }))
    const dialog = screen.getByRole('dialog')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '加入术语表' })) })
    expect(dialog.textContent).toContain('写入术语表失败')
    expect(screen.getByRole('alert').textContent).toContain('写入术语表失败')
    // The explanation stays on screen: only the write failed.
    expect(dialog.textContent).toContain('一次模型解释')
    expect(within(dialog).getByRole('button', { name: '加入术语表' })).toBeTruthy()
  })

  it('offers no download or export affordance anywhere in the surface', async () => {
    const subject = await shownDialog()
    const names = Array.from(screen.getAllByRole('button')).map(node => node.textContent ?? '')
    expect(names.some(name => /下载|导出|download|export/i.test(name))).toBe(false)
    expect(subject.policy.request.getSnapshot()).toMatchObject({ kind: 'panel' } satisfies Partial<OverlayRequest>)
  })
})

describe('OverlayPolicy verbs on a closed surface', () => {
  it('does nothing when a stale verb arrives with nothing open', async () => {
    const { policy, explain, remember } = harness()
    expect(await policy.select()).toBeUndefined()
    expect(await policy.retry()).toBeUndefined()
    expect(await policy.remember()).toBeUndefined()
    policy.setLayer('project')
    policy.close()
    expect(policy.request.getSnapshot()).toBeNull()
    expect(explain).not.toHaveBeenCalled()
    expect(remember).not.toHaveBeenCalled()
  })

  it('will not re-ask the model about a selection it refused for length', async () => {
    const { policy, explain } = harness()
    policy.openTooLong('一段远远超过长度上限的选中文本', RECT)
    expect(await policy.retry()).toBeUndefined()
    expect(explain).not.toHaveBeenCalled()
    expect(policy.request.getSnapshot()).toMatchObject({ kind: 'panel', stage: 'failed', error: 'TERM_INVALID' })
  })
})
