// @vitest-environment jsdom
/**
 * The terminology settings card: master toggle and shortcut written back to the
 * settings document, global-term add/edit/remove through whole-array
 * replacement with a visible conflict, and the read-only project layer with its
 * error bar and editor opener.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { TerminologyCard, type TerminologyCardProps } from '../src/client/TerminologyCard.tsx'
import { TerminologyCardPolicy, type TerminologyCardInjected } from '../src/client/card-policy.ts'
import { en, zh } from '../src/client/locales.ts'
import type { TerminologySettings } from '../src/spec.ts'
import type { GlossaryTerm, TerminologyState } from '../src/types.ts'

// The two surfaces are root-scope entries, so their props carry the standing
// global hooks. Nothing here reads them; they satisfy the framework seat.
type SessionsSnapshot = Parameters<Parameters<TerminologyCardProps['useSessions']>[0]>[0]
type WorkspacesSnapshot = Parameters<Parameters<TerminologyCardProps['useWorkspaces']>[0]>[0]
type AttentionSnapshot = Parameters<Parameters<TerminologyCardProps['useSessionPendingInteraction']>[0]>[0]

function globalHooks(): Pick<TerminologyCardProps, 'useSessions' | 'useWorkspaces' | 'useSessionPendingInteraction'> {
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

const STATE: TerminologyState = {
  enabled: true,
  shortcut: 'Alt+Shift+E',
  termMaxChars: 64,
  projectPath: '/repo/.dsh/terminology.yml',
  projectTerms: [{ term: '分词器', explanation: 'tokenizer' }],
  globalTerms: [{ term: '大模型', explanation: 'LLM' }],
}

interface Harness {
  readonly props: TerminologyCardProps
  readonly settings: ReturnType<typeof stubSettingsScope<TerminologySettings>>
  readonly openProjectFile: ReturnType<typeof vi.fn>
}

/** One card over a stubbed settings scope that accepts what it is given. */
function harness(options: {
  state?: TerminologyState | null
  terms?: readonly GlossaryTerm[]
  openProjectFile?: (path: string) => Promise<boolean>
} = {}): Harness {
  const settings = stubSettingsScope<TerminologySettings>()
  const stored: Record<string, unknown> = {}
  let current: TerminologySettings = {
    enabled: true,
    explainShortcut: 'Alt+Shift+E',
    terms: [...(options.terms ?? [{ term: '大模型', explanation: 'LLM' }])],
  }
  // An accepted write moves both the user layer and the resolved section, the
  // way a Host acceptance does.
  settings.set.mockImplementation((field: string, value: unknown) => {
    stored[field] = value
    current = { ...current, [field]: value }
    settings.publish({ user: { ...stored }, value: current })
  })
  const openProjectFile = vi.fn(options.openProjectFile ?? (async () => true))
  const policy = new TerminologyCardPolicy({
    scope: settings.scope,
    glossary: createSnapshotStore<TerminologyState | null>(options.state === undefined ? STATE : options.state),
    openProjectFile,
  })
  policy.watch()
  const injected: TerminologyCardInjected = policy.inject()
  settings.publish({ status: 'ready', writable: true, value: current, user: {} })
  const props: TerminologyCardProps = {
    ...globalHooks(),
    ...injected,
    useTerminologyCard: bindSnapshotSelector(policy.source),
    t: makeTranslate(zh, en),
  }
  return { props, settings, openProjectFile }
}

function typeEntry(term: string, explanation: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: '新术语' }), { target: { value: term } })
  fireEvent.change(screen.getByRole('textbox', { name: '新解释' }), { target: { value: explanation } })
  fireEvent.click(screen.getByRole('button', { name: '添加术语' }))
}

afterEach(() => { cleanup() })

describe('TerminologyCard', () => {
  it('writes the master toggle back to the settings document', () => {
    const { props, settings } = harness()
    render(<TerminologyCard {...props} />)
    fireEvent.click(screen.getByRole('checkbox', { name: '在助手回复中标注术语' }))
    expect(settings.set).toHaveBeenCalledWith('enabled', false)
  })

  it('commits the shortcut when the field is left', () => {
    const { props, settings } = harness()
    render(<TerminologyCard {...props} />)
    const field = screen.getByRole('textbox', { name: '手动解释快捷键' })
    fireEvent.change(field, { target: { value: ' Ctrl+K ' } })
    fireEvent.blur(field)
    expect(settings.set).toHaveBeenCalledWith('explainShortcut', 'Ctrl+K')
  })

  it('refuses an invalid shortcut visibly and writes nothing', () => {
    const { props, settings } = harness()
    render(<TerminologyCard {...props} />)
    const field = screen.getByRole('textbox', { name: '手动解释快捷键' })
    fireEvent.change(field, { target: { value: 'K' } })
    fireEvent.blur(field)
    expect(screen.getByRole('alert').textContent).toContain('快捷键无效')
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('adds a trimmed global term through whole-array replacement', () => {
    const { props, settings } = harness()
    render(<TerminologyCard {...props} />)
    typeEntry('  分词器  ', '  tokenizer  ')
    expect(settings.set).toHaveBeenCalledWith('terms', [
      { term: '大模型', explanation: 'LLM' },
      { term: '分词器', explanation: 'tokenizer' },
    ])
  })

  it('offers no add action while the new entry is blank', () => {
    render(<TerminologyCard {...harness().props} />)
    expect(screen.getByRole('button', { name: '添加术语' })).toHaveProperty('disabled', true)
  })

  it('edits and removes existing terms', () => {
    const { props, settings } = harness({
      terms: [{ term: '大模型', explanation: 'LLM' }, { term: '词元', explanation: 'token' }],
    })
    render(<TerminologyCard {...props} />)
    const term = screen.getAllByRole('textbox', { name: '术语' })[0]!
    fireEvent.change(term, { target: { value: '大语言模型' } })
    fireEvent.blur(term)
    expect(settings.set).toHaveBeenLastCalledWith('terms', [
      { term: '大语言模型', explanation: 'LLM' },
      { term: '词元', explanation: 'token' },
    ])
    fireEvent.click(screen.getAllByRole('button', { name: '删除术语' })[1]!)
    expect(settings.set).toHaveBeenLastCalledWith('terms', [{ term: '大语言模型', explanation: 'LLM' }])
  })

  it('shows a rejected write as a visible conflict instead of a silently unchanged list', async () => {
    const { props, settings } = harness()
    render(<TerminologyCard {...props} />)
    // The Host holds a different document than the card asked for.
    settings.set.mockImplementation(() => {
      settings.publish({ user: { terms: [{ term: '别人的术语', explanation: 'other' }] } })
    })
    typeEntry('分词器', 'tokenizer')
    await vi.waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('术语表已被其他改动更新')
    })
  })

  it('lists the project layer read-only and opens it in the editor', async () => {
    const { props, openProjectFile } = harness()
    render(<TerminologyCard {...props} />)
    const project = screen.getByRole('group', { name: '本项目术语表' })
    expect(project.textContent).toContain('分词器')
    expect(project.textContent).toContain('项目术语表由工作区文件维护')
    expect(project.querySelectorAll('input, textarea')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '在编辑器中打开' }))
    await vi.waitFor(() => {
      expect(openProjectFile).toHaveBeenCalledWith('/repo/.dsh/terminology.yml')
    })
  })

  it('reports a project glossary that cannot be read', () => {
    render(<TerminologyCard {...harness({ state: { ...STATE, projectError: 'bad indent on line 3' } }).props} />)
    expect(screen.getByRole('group', { name: '本项目术语表' }).textContent).toContain('bad indent on line 3')
  })

  it('reports an editor that refused to open the project glossary', async () => {
    const { props } = harness({ openProjectFile: async () => false })
    render(<TerminologyCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '在编辑器中打开' }))
    await vi.waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('无法在编辑器中打开')
    })
  })

  it('renders nothing while the settings namespace is not served', () => {
    const settings = stubSettingsScope<TerminologySettings>()
    const policy = new TerminologyCardPolicy({
      scope: settings.scope,
      glossary: createSnapshotStore<TerminologyState | null>(STATE),
      openProjectFile: async () => true,
    })
    policy.watch()
    const props: TerminologyCardProps = {
      ...globalHooks(),
      ...policy.inject(),
      useTerminologyCard: bindSnapshotSelector(policy.source),
      t: makeTranslate(zh, en),
    }
    render(<TerminologyCard {...props} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('leaves a term row alone when the edit is unchanged or blank', () => {
    const { props, settings } = harness({ terms: [{ term: '大模型', explanation: 'LLM' }] })
    render(<TerminologyCard {...props} />)
    const term = screen.getByRole('textbox', { name: '术语' })
    fireEvent.keyDown(term, { key: 'a' })
    fireEvent.blur(term)
    fireEvent.change(term, { target: { value: '   ' } })
    fireEvent.blur(term)
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('commits an explanation edit when Enter leaves the field', () => {
    const { props, settings } = harness()
    render(<TerminologyCard {...props} />)
    const explanation = screen.getByRole('textbox', { name: '解释' })
    explanation.focus()
    fireEvent.change(explanation, { target: { value: 'large language model' } })
    fireEvent.keyDown(explanation, { key: 'Enter' })
    expect(document.activeElement).not.toBe(explanation)
    expect(settings.set).toHaveBeenCalledWith('terms', [{ term: '大模型', explanation: 'large language model' }])
  })

  it('says the global layer holds no terms yet', () => {
    render(<TerminologyCard {...harness({ terms: [] }).props} />)
    expect(screen.getByRole('group', { name: '全局术语表' }).textContent).toContain('还没有全局术语')
  })

  it('says the project glossary is empty', () => {
    render(<TerminologyCard {...harness({ state: { ...STATE, projectTerms: [] } }).props} />)
    expect(screen.getByRole('group', { name: '本项目术语表' }).textContent).toContain('项目术语表为空')
  })

  it('edits the vocabulary the Host pushed while the settings section is still absent', async () => {
    const settings = stubSettingsScope<TerminologySettings>()
    const policy = new TerminologyCardPolicy({
      scope: settings.scope,
      glossary: createSnapshotStore<TerminologyState | null>(STATE),
      openProjectFile: async () => true,
    })
    policy.watch()
    // Ready and writable, but the resolved section has not arrived: the term
    // list the card shows comes from the vocabulary the Host pushed.
    settings.publish({ status: 'ready', writable: true })
    render(<TerminologyCard {...{
      ...globalHooks(),
      ...policy.inject(),
      useTerminologyCard: bindSnapshotSelector(policy.source),
      t: makeTranslate(zh, en),
    }} />)
    expect(screen.getByRole('textbox', { name: '术语' })).toHaveProperty('value', '大模型')
    fireEvent.click(screen.getByRole('button', { name: '删除术语' }))
    await vi.waitFor(() => {
      // Nothing landed on the user layer, so the card says so instead of
      // pretending the list is now empty.
      expect(screen.getByRole('alert').textContent).toContain('术语表已被其他改动更新')
    })
  })
})
