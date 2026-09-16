// @vitest-environment jsdom
/**
 * The browser assembly on a real Cordis fiber: the annotation provider's
 * published identity and its rebuild rule, the glossary refetch triggers
 * (session switch and both `terminology/changed` arities), a rejected Host read
 * folding into no vocabulary, the manual-lookup takeover preconditions on the
 * document, and the whole feature folding up on disposal.
 */
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ChatAnnotations } from '@deepseek-ai/dsh-client-ui-chat/client'
import { SlotTestRuntime, TestRemote, stubSettingsScope, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import type { TerminologyOverlayInjected } from '../src/client/TerminologyOverlay.tsx'
import type { TerminologyCardInjected } from '../src/client/card-policy.ts'
import type { OverlayRequest } from '../src/client/overlay-policy.ts'
import type { TerminologySettings } from '../src/spec.ts'
import type { TerminologyState } from '../src/types.ts'

// The dictionaries answer in the browser's language; the spec pins one.
usePinnedBrowserLanguages('zh-CN')

// jsdom implements no Range geometry, so a keyboard lookup has no measurement
// to anchor on until the test supplies the one a browser would report.
Range.prototype.getBoundingClientRect = () => ({
  top: 40, bottom: 58, left: 40, right: 120, width: 80, height: 18, x: 40, y: 40, toJSON: () => ({}),
})

const sid = (key: string): SessionId => key as SessionId

const STATE: TerminologyState = {
  enabled: true,
  shortcut: 'Alt+Shift+E',
  termMaxChars: 6,
  projectPath: '/repo/.dsh/terminology.yml',
  projectTerms: [{ term: '大模型', explanation: '项目内的解释' }],
  globalTerms: [{ term: 'Transformer', explanation: '全局解释' }],
}

/** A successful remote call over the typert result envelope. */
function carried<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

interface Bench {
  readonly runtime: SlotTestRuntime
  readonly remote: TestRemote
  readonly state: ReturnType<typeof vi.fn>
  readonly explain: ReturnType<typeof vi.fn>
  readonly remember: ReturnType<typeof vi.fn>
  readonly openWorkspacePath: ReturnType<typeof vi.fn>
  readonly annotations: () => ReturnType<ChatAnnotations['annotations']>
  readonly overlay: () => OverlayRequest | null
  readonly card: () => TerminologyCardInjected
  readonly settle: () => Promise<void>
  readonly dispose: () => Promise<void>
}

/** One scripted answer: a vocabulary, a business failure code, or a promise of either. */
type StateAnswer = TerminologyState | { code: string } | Promise<TerminologyState | { code: string }>

/** Mount the plugin over scripted terminology reads and a real slot registry. */
async function bench(options: {
  state?: (sessionId: string, call: number) => StateAnswer
  explain?: () => unknown
  remember?: () => unknown
  openWorkspacePath?: () => unknown
} = {}): Promise<Bench> {
  const runtime = await SlotTestRuntime.create()
  let calls = 0
  const state = vi.fn(async ({ sessionId }: { sessionId: SessionId }) => {
    const answer = await (options.state?.(sessionId, ++calls) ?? STATE)
    // The generated face answers with the typert envelope around the remote's
    // own result, so a rejected read is one envelope inside the other.
    return 'code' in answer
      ? carried({ ok: false, error: { code: answer.code } })
      : carried(carried(answer))
  })
  const explain = vi.fn(options.explain ?? (async () => carried({ ok: true, value: { explanation: '模型解释' } })))
  const remember = vi.fn(options.remember ?? (async () => carried({ ok: true, value: {} })))
  const openWorkspacePath = vi.fn(options.openWorkspacePath ?? (async () => carried({ opened: true })))
  const remote = new TestRemote(runtime.ctx, {
    terminology: { state, explain, remember },
    session: { openWorkspacePath },
  })
  runtime.ctx.provide('locale', new LocaleRuntime(runtime.ctx))
  runtime.ctx.provide('settingsScope', {
    bind: () => stubSettingsScope<TerminologySettings>().scope,
  })
  // The two host surfaces this package registers into, declared the way their
  // real owners declare them: the shell overlay list and the keyed card list.
  await runtime.root.declare({
    'shell.overlay': { kind: 'list', scope: 'root' },
    'settings.plugin.item': { kind: 'keyed', scope: 'root' },
  } as never, (() => null) as never)
  await runtime.sessions.add({ id: 's1' }, { current: true })
  const handle = await runtime.mount({ inject: [...inject], apply })
  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  return {
    runtime,
    remote,
    state,
    explain,
    remember,
    openWorkspacePath,
    annotations: () => (runtime.ctx.get('chatAnnotations') as ChatAnnotations).annotations(),
    overlay: () => overlayFace(runtime).hooks.terminologyOverlay.getSnapshot(),
    card: () => cardFace(runtime),
    settle,
    dispose: () => handle.dispose(),
  }
}

/** The injected face of the registered settings card entry. */
function cardFace(runtime: SlotTestRuntime): TerminologyCardInjected {
  const entry = runtime.slots.entries('settings.plugin.item')[0] as { inject: () => TerminologyCardInjected } | undefined
  if (entry === undefined) throw new Error('the settings card entry is not registered')
  return entry.inject()
}

/** The injected face of the registered overlay entry. */
function overlayFace(runtime: SlotTestRuntime): TerminologyOverlayInjected {
  const entry = runtime.slots.entries('shell.overlay')[0] as { inject: () => TerminologyOverlayInjected } | undefined
  if (entry === undefined) throw new Error('the overlay entry is not registered')
  return entry.inject()
}

/** Put `text` in the live selection inside one block element. */
function select(text: string, wrap: (body: string) => string = body => `<p>${body}</p>`): void {
  document.body.innerHTML = wrap(`关于${text}的段落`)
  const node = document.querySelector('p')?.firstChild
  if (node === null || node === undefined) throw new Error('selection host text is missing')
  const start = node.textContent!.indexOf(text)
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + text.length)
  const selection = document.getSelection()
  if (selection === null) throw new Error('jsdom exposes no selection')
  selection.removeAllRanges()
  selection.addRange(range)
}

/** Right-click where the selection is, reporting whether the app took it over. */
function rightClick(): boolean {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 240 })
  act(() => { document.body.dispatchEvent(event) })
  return event.defaultPrevented
}

/** Press one chord, reporting whether the app took it over. */
function press(chord: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...chord })
  act(() => { document.dispatchEvent(event) })
  return event.defaultPrevented
}

let open: Bench | undefined
afterEach(async () => {
  const subject = open
  open = undefined
  if (subject !== undefined) await subject.dispose()
  document.body.innerHTML = ''
})

describe('ui-terminology browser assembly', () => {
  it('binds only the services it uses', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'remote', 'remote.session', 'remote.terminology', 'settingsScope', 'sessions',
    ])
  })

  it('annotates assistant prose with the current session vocabulary', async () => {
    const subject = open = await bench()
    await subject.settle()
    const resolver = subject.annotations()
    if (resolver === undefined) throw new Error('the provider published no resolver')
    expect(resolver.split('解释 Transformer 架构 的原理')).toEqual([
      { kind: 'text', text: '解释 ' },
      { kind: 'annotation', text: 'Transformer', label: '术语 Transformer，查看解释', explanation: '全局解释' },
      { kind: 'text', text: ' 架构 的原理' },
    ])
    // The project layer wins its own term.
    expect(resolver.split('大模型')).toEqual([
      { kind: 'annotation', text: '大模型', label: '术语 大模型，查看解释', explanation: '项目内的解释' },
    ])
  })

  it('keeps one resolver identity across a refetch of the same vocabulary', async () => {
    const subject = open = await bench()
    await subject.settle()
    const before = subject.annotations()
    subject.remote.emit('terminology/changed', [sid('s1')])
    await subject.settle()
    expect(subject.state).toHaveBeenCalledTimes(2)
    expect(subject.annotations()).toBe(before)
  })

  it('publishes a new resolver when a term or explanation moves', async () => {
    let current = STATE
    const subject = open = await bench({ state: () => current })
    await subject.settle()
    const before = subject.annotations()
    current = { ...STATE, globalTerms: [{ term: 'Transformer', explanation: '改写后的全局解释' }] }
    subject.remote.emit('terminology/changed', [sid('s1')])
    await subject.settle()
    const after = subject.annotations()
    expect(after).not.toBe(before)
    expect(after?.split('Transformer')[0]).toMatchObject({ explanation: '改写后的全局解释' })
  })

  it('publishes no annotations while the master switch is off', async () => {
    const subject = open = await bench({ state: () => ({ ...STATE, enabled: false }) })
    await subject.settle()
    expect(subject.annotations()).toBeUndefined()
    select('大模型')
    expect(rightClick()).toBe(false)
    expect(press({ key: 'E', altKey: true, shiftKey: true })).toBe(false)
  })

  it('folds a rejected state read into no vocabulary instead of a usable feature', async () => {
    const subject = open = await bench({ state: () => ({ code: 'NO_WORKSPACE' }) })
    await subject.settle()
    expect(subject.annotations()).toBeUndefined()
    select('大模型')
    expect(rightClick()).toBe(false)
  })

  it('refetches on a global change that carries no session', async () => {
    const subject = open = await bench()
    await subject.settle()
    expect(subject.state).toHaveBeenCalledTimes(1)
    subject.remote.emit('terminology/changed', [])
    await subject.settle()
    expect(subject.state).toHaveBeenCalledTimes(2)
  })

  it('follows the session the user switches to', async () => {
    const subject = open = await bench({
      state: sessionId => sessionId === 's1'
        ? STATE
        : { ...STATE, projectTerms: [], globalTerms: [{ term: '词元', explanation: '另一会话的解释' }] },
    })
    await subject.settle()
    await subject.runtime.sessions.add({ id: 's2' }, { current: false })
    const before = subject.annotations()
    await act(async () => { await subject.runtime.sessions.setCurrent('s2') })
    await subject.settle()
    const after = subject.annotations()
    expect(after).not.toBe(before)
    expect(after?.split('词元')[0]).toMatchObject({ kind: 'annotation', explanation: '另一会话的解释' })
  })

  it('takes the right-click away for a term-shaped selection and offers it in context', async () => {
    const subject = open = await bench()
    await subject.settle()
    select('大模型')
    expect(rightClick()).toBe(true)
    expect(subject.overlay()).toMatchObject({
      kind: 'menu', term: '大模型', context: '关于大模型的段落', rect: { left: 120, top: 240 },
    })
  })

  it('leaves the browser menu alone for a selection it cannot explain', async () => {
    const subject = open = await bench()
    await subject.settle()
    // Collapsed: nothing was selected.
    select('大模型')
    const selection = document.getSelection()
    selection?.collapse(document.body)
    expect(rightClick()).toBe(false)
    expect(subject.overlay()).toBeNull()
    // Inside a text field: the selection belongs to the editor.
    select('大模型', body => `<div contenteditable="true"><p>${body}</p></div>`)
    expect(rightClick()).toBe(false)
    expect(subject.overlay()).toBeNull()
  })

  it('refuses a selection past the Host length limit visibly, without asking the model', async () => {
    const subject = open = await bench()
    await subject.settle()
    select('一段远远超过六个字符的选中文本')
    expect(rightClick()).toBe(true)
    expect(subject.overlay()).toMatchObject({ kind: 'panel', stage: 'failed', error: 'TERM_INVALID' })
    expect(subject.explain).not.toHaveBeenCalled()
  })

  it('opens the same lookup on the configured chord', async () => {
    const subject = open = await bench()
    await subject.settle()
    select('大模型')
    expect(press({ key: 'E', altKey: true, shiftKey: true })).toBe(true)
    expect(subject.overlay()).toMatchObject({ kind: 'menu', term: '大模型', rect: { left: 40, top: 58 } })
  })

  it('ignores a chord that is not the configured one', async () => {
    const subject = open = await bench()
    await subject.settle()
    select('大模型')
    expect(press({ key: 'E', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(subject.overlay()).toBeNull()
  })

  it('asks the model with the selected block as context', async () => {
    const subject = open = await bench()
    await subject.settle()
    select('分词器')
    expect(rightClick()).toBe(true)
    await act(async () => { await overlayFace(subject.runtime).select() })
    expect(subject.explain).toHaveBeenCalledWith({ sessionId: sid('s1'), term: '分词器', context: '关于分词器的段落' })
  })

  it('keeps prose plain while the vocabulary is empty, and keeps that answer', async () => {
    const subject = open = await bench({ state: () => ({ ...STATE, globalTerms: [], projectTerms: [] }) })
    await subject.settle()
    const first = subject.annotations()
    expect(first?.split('普通文本')).toEqual([{ kind: 'text', text: '普通文本' }])
    subject.remote.emit('terminology/changed', [])
    await subject.settle()
    expect(subject.annotations()).toBe(first)
  })

  it('folds a read the transport rejected into no vocabulary', async () => {
    const subject = open = await bench()
    await subject.settle()
    expect(subject.annotations()).toBeDefined()
    subject.state.mockResolvedValue({ ok: false, error: { code: 'UNAVAILABLE' } })
    subject.remote.emit('terminology/changed', [])
    await subject.settle()
    expect(subject.annotations()).toBeUndefined()
  })

  it('keeps the newer vocabulary when an older read answers last', async () => {
    const first: { resolve: (value: TerminologyState) => void } = { resolve: () => {} }
    const second: { resolve: (value: TerminologyState) => void } = { resolve: () => {} }
    const subject = open = await bench({
      state: (_sessionId, call) => call === 1
        ? new Promise<TerminologyState>((resolve) => { first.resolve = resolve })
        : new Promise<TerminologyState>((resolve) => { second.resolve = resolve }),
    })
    subject.remote.emit('terminology/changed', [sid('s1')])
    await act(async () => { await Promise.resolve() })
    await act(async () => { second.resolve({ ...STATE, globalTerms: [{ term: '新术语', explanation: '较新的读回' }] }) })
    await subject.settle()
    await act(async () => { first.resolve(STATE) })
    await subject.settle()
    expect(subject.annotations()?.split('新术语')[0]).toMatchObject({ kind: 'annotation', explanation: '较新的读回' })
  })

  it('asks every known session when none is bound', async () => {
    const subject = open = await bench({
      state: sessionId => sessionId === 's1'
        ? STATE
        : { ...STATE, projectTerms: [], globalTerms: [{ term: '词元', explanation: '第二个会话的解释' }] },
    })
    await subject.settle()
    await subject.runtime.sessions.add({ id: 's2' }, { current: false })
    await act(async () => { await subject.runtime.sessions.setCurrent(undefined) })
    await subject.settle()
    expect(subject.state).toHaveBeenLastCalledWith({ sessionId: sid('s2') })
    expect(subject.annotations()?.split('词元')[0]).toMatchObject({ explanation: '第二个会话的解释' })
  })

  it('drives the whole lookup through the face the shell holds', async () => {
    const subject = open = await bench()
    await subject.settle()
    const face = overlayFace(subject.runtime)
    select('分词器')
    expect(rightClick()).toBe(true)
    await act(async () => { await face.select() })
    expect(subject.overlay()).toMatchObject({ kind: 'panel', stage: 'shown', explanation: '模型解释', layer: 'global' })
    await act(async () => { face.setLayer('project') })
    expect(subject.overlay()).toMatchObject({ layer: 'project' })
    await act(async () => { await face.remember() })
    expect(subject.remember).toHaveBeenCalledWith({
      sessionId: sid('s1'), term: '分词器', explanation: '模型解释', layer: 'project',
    })
    await act(async () => { await face.retry() })
    expect(subject.explain).toHaveBeenCalledTimes(2)
    await act(async () => { face.close() })
    expect(subject.overlay()).toBeNull()
  })

  it('says a lookup cannot run once its session is gone', async () => {
    const subject = open = await bench()
    await subject.settle()
    select('分词器')
    expect(rightClick()).toBe(true)
    await act(async () => { await subject.runtime.sessions.setCurrent(undefined) })
    expect(await overlayFace(subject.runtime).select()).toBe('SESSION_NOT_FOUND')
    expect(subject.explain).not.toHaveBeenCalled()
  })

  it('folds an explanation the transport never delivered into the model-failure copy', async () => {
    const subject = open = await bench({ explain: () => ({ ok: false, error: { code: 'UNAVAILABLE' } }) })
    await subject.settle()
    select('分词器')
    rightClick()
    await act(async () => { await overlayFace(subject.runtime).select() })
    expect(subject.overlay()).toMatchObject({ kind: 'panel', stage: 'failed', error: 'LLM_FAILED' })
  })

  it('shows the project layer as unavailable while its file could not be read', async () => {
    const subject = open = await bench({ state: () => ({ ...STATE, projectError: 'bad indent on line 3' }) })
    await subject.settle()
    select('分词器')
    rightClick()
    await act(async () => { await overlayFace(subject.runtime).select() })
    expect(subject.overlay()).toMatchObject({ kind: 'panel', stage: 'shown', projectLayerAvailable: false })
  })

  it('reports a glossary write the transport never delivered', async () => {
    const subject = open = await bench({ remember: () => ({ ok: false, error: { code: 'UNAVAILABLE' } }) })
    await subject.settle()
    select('分词器')
    rightClick()
    const face = overlayFace(subject.runtime)
    await act(async () => { await face.select() })
    expect(await face.remember()).toBe('GLOSSARY_WRITE_FAILED')
    expect(subject.overlay()).toMatchObject({ stage: 'shown', writeError: 'GLOSSARY_WRITE_FAILED' })
  })

  it('reports a save whose session closed while the explanation was on screen', async () => {
    const subject = open = await bench()
    await subject.settle()
    select('分词器')
    rightClick()
    const face = overlayFace(subject.runtime)
    await act(async () => { await face.select() })
    await act(async () => { await subject.runtime.sessions.setCurrent(undefined) })
    expect(await face.remember()).toBe('SESSION_NOT_FOUND')
    expect(subject.remember).not.toHaveBeenCalled()
    expect(subject.overlay()).toMatchObject({ stage: 'shown', writeError: 'SESSION_NOT_FOUND' })
  })

  it('opens nothing for a chord the Host state cannot describe', async () => {
    const subject = open = await bench({ state: () => ({ ...STATE, shortcut: 'not-a-chord' }) })
    await subject.settle()
    select('大模型')
    expect(press({ key: 'E', altKey: true, shiftKey: true })).toBe(false)
    expect(subject.overlay()).toBeNull()
  })

  it('opens the project glossary file through the card the settings page holds', async () => {
    const subject = open = await bench()
    await subject.settle()
    const face = subject.card()
    await act(async () => { face.openProjectFile() })
    await subject.settle()
    expect(subject.openWorkspacePath).toHaveBeenCalledWith({ path: '/repo/.dsh/terminology.yml' })
    expect(face.hooks.terminologyCard.getSnapshot().error).toBeUndefined()
  })

  it('says so when the editor refuses the project glossary path', async () => {
    const subject = open = await bench({ openWorkspacePath: () => ({ ok: false, error: { code: 'UNAVAILABLE' } }) })
    await subject.settle()
    await act(async () => { subject.card().openProjectFile() })
    await subject.settle()
    expect(subject.card().hooks.terminologyCard.getSnapshot()).toMatchObject({ error: { kind: 'open' } })
  })

  it('carries the Host failure code through to the dialog', async () => {
    const subject = open = await bench({ explain: () => ({ ok: true, value: { ok: false, error: { code: 'CONTEXT_TOO_LARGE', message: 'too large' } } }) })
    await subject.settle()
    select('分词器')
    rightClick()
    await act(async () => { await overlayFace(subject.runtime).select() })
    expect(subject.overlay()).toMatchObject({ kind: 'panel', stage: 'failed', error: 'CONTEXT_TOO_LARGE' })
  })

  it('carries a rejected glossary write through to the dialog', async () => {
    const subject = open = await bench({ remember: () => ({ ok: true, value: { ok: false, error: { code: 'GLOSSARY_INVALID', message: 'bad file' } } }) })
    await subject.settle()
    select('分词器')
    rightClick()
    const face = overlayFace(subject.runtime)
    await act(async () => { await face.select() })
    expect(await face.remember()).toBe('GLOSSARY_INVALID')
    expect(subject.overlay()).toMatchObject({ stage: 'shown', writeError: 'GLOSSARY_INVALID' })
  })

  it('leaves a gesture alone when nothing is selected', async () => {
    const subject = open = await bench()
    await subject.settle()
    document.body.innerHTML = '<p>关于大模型的段落</p>'
    document.getSelection()?.removeAllRanges()
    expect(rightClick()).toBe(false)
    expect(press({ key: 'E', altKey: true, shiftKey: true })).toBe(false)
    expect(subject.overlay()).toBeNull()
  })

  it('registers both surfaces and removes everything the fiber owned on disposal', async () => {
    const subject = open = await bench()
    await subject.settle()
    expect(subject.runtime.slots.entries('shell.overlay').map(entry => entry.options.id)).toEqual(['terminology'])
    const cards = subject.runtime.slots.entries('settings.plugin.item')
    expect(cards.map(entry => entry.options.key)).toEqual(['terminology'])
    await subject.dispose()
    open = undefined
    expect(subject.runtime.slots.entries('shell.overlay')).toEqual([])
    expect(subject.runtime.slots.entries('settings.plugin.item')).toEqual([])
    select('大模型')
    expect(rightClick()).toBe(false)
    expect(press({ key: 'E', altKey: true, shiftKey: true })).toBe(false)
  })
})
