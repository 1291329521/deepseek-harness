# Web 正文术语识别实现计划

[English](2026-09-16-web-inline-terminology.md) | 中文

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 DSH Web 客户端里，把助手回答 Markdown 中命中术语表的词变成可悬停、可聚焦、可点击的解释入口，并提供"选中即解释"的手动识别与一键收录术语表浮层。

**架构：** 在 `ui-primitives` 加一条核心渲染接缝（`text` 节点上的 `MarkdownAnnotations.split` + 新元素 `AnnotatedTerm`），由 `ui-chat` 通过可选的 `chatAnnotations` 服务转发，交给一个新包 `packages/client/ui-terminology` 双半边消费：Host 半边拥有两层术语表（项目文件 + 设置文档）、typert remote 与 LLM 解释管线；浏览器半边拥有解析器 provider、选区/快捷键监听、解释浮层与设置卡片。

**技术栈：** TypeScript ESM、Cordis 插件模型、React 19 + CSS Modules（`--dsw-*` 令牌）、Schemastery + Zod、typert Remote、vitest（按需 jsdom）、`vitest.web.config.ts` 驱动的 Playwright。

**规格：** `docs/superpowers/specs/2026-09-16-web-inline-terminology-design.md` / `...design.zh.md` —— 论证依据在规格里，本计划只承载执行步骤；计划对规格某一细节的收窄都就地标注并给出理由。

## 全局约束

- 覆盖范围：仅助手回答的 Markdown 正文；用户自己发的提问不在范围内（规格 §2.2）。
- No DOM hacks: no MutationObserver, no appending into `document.body`, no host-DOM mutation. The only direct DOM reads are `window.getSelection()` and the selection's `target`, both read-only (spec §7.3).
- Information never hidden in a tooltip: the automatic tooltip contains explanation text only — no button, link, error, or download inside `role="tooltip"`; failures surface as visible focusable UI (spec §8). No download/export ships in this phase.
- 解析器身份稳定是契约的一部分：`MarkdownAnnotations` 实例只在词表变化时重建；`MarkdownText` 的已定稿渲染按 props 身份 memo。
- 不装 `chatAnnotations` 提供方时，渲染产物与今天逐字节一致（`case 'text'` 原样返回字符串；`tests/fixtures/markdown-dom` 的 fixture 必须原样通过）。
- 标注只作用于已定稿渲染；两个 `StreamingRenderer` context 都保持 `annotations: undefined`，与 `fileMentions: undefined` 同款。
- 插件内没有硬编码可调项：所有跨部署可能不同的值都是校验过的 `Config` 字段；固定交互常量（悬停 150 毫秒打开）按规格 §4.3 钉死为常量。
- 客户端文案归 locale 所有：所有产品文案走本包字典（`verify-client-ui-i18n`）；`ui-primitives` 不拥有任何文案，只接收完整的 label props。
- 每个文档对都是双语三件套（`.md` + `.zh.md` + `.i18n.yaml`），一段一个物理行；配对记录用 `pnpm run verify-translation-pairing --write <anchor>`。
- 客户端包在逐文件 100% 覆盖率门禁内（`pnpm run test:coverage`）；`/* v8 ignore -- <reason> */` 只允许配真实理由。
- 在任务标注的位置运行的门禁：`pnpm run test:gui`、`DSH_SNAPSHOT=replay pnpm run test:web`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run duplication`、`pnpm run doc-sync`、`pnpm run gen-persistence-catalog`。
- 不要动 `docs/superpowers/plans/2026-09-08-task-protocol-p1.md` 与 `docs/superpowers/specs/2026-09-08-task-protocol-p1-design.md` 里的既有 red。
- 注释与 JSDoc 用英文；代码注释陈述契约，不叙述过程。
- 计划相对规格的偏离都是收窄，且都发生在标注处：(1) 规格 §6.1 写 `node:fs.watch`，本计划改用 `chokidar` 的 `awaitWriteFinish` 去抖，即 `packages/settings/settings-file` 已在用的维护中依赖；(2) 规格 §4.4 写 `AssistantNodeView` 用 `useMemo(() => annotations(), [annotations])`，本计划改为在渲染体内直接调用 `annotations()`——转发来的提供方函数身份在插件生命周期内恒定，memo 它会把首个解析器永久冻结、再也拿不到词表变化。

## 文件结构

PR 1 — `ui-primitives` seam:

- Modify `packages/client/ui-primitives/src/markdown/render.tsx` — `MarkdownAnnotations`/`MarkdownSegment` contract, context field, `case 'text'` fork, `renderAnnotatedText`.
- Create `packages/client/ui-primitives/src/markdown/AnnotatedTerm.tsx` + `AnnotatedTerm.module.css` — the interactive term span.
- Modify `packages/client/ui-primitives/src/markdown/MarkdownText.tsx` — optional `annotations` prop on settled renders.
- Modify `packages/client/ui-primitives/src/index.ts` — export contract types + element.
- Create `packages/client/ui-primitives/tests/markdown-annotations.client.spec.tsx`, `packages/client/ui-primitives/tests/annotated-term.client.spec.tsx`.

PR 2 — `ui-chat` 转发：

- Modify `packages/client/ui-chat/src/client/contract/slots.ts`, `apply.ts`, `chat/ChatView.tsx`, `chat/ChatNodeSeat.tsx`, `chat/AssistantNodeView.tsx`, `chat/AssistantMarkdown.tsx`.
- Create `packages/client/ui-chat/tests/annotations-threading.client.spec.tsx`.

PR 3 — `ui-terminology` Host 半边：

- Create `packages/client/ui-terminology/{package.json,tsconfig.json,tsconfig.host.json,tsconfig.client.json,tsdown.config.ts,README.md,README.zh.md}`.
- Create `packages/client/ui-terminology/src/{spec.ts,types.ts,index.ts,glossary.ts}`.
- Modify registration surfaces: `tsconfig.client.json`, `packages/bundle/web-app/cordis.patch.yml`, `packages/bundle/web-app/package.json`.
- Create `packages/client/ui-terminology/tests/{glossary.host.spec.ts,terminology-remote.host.spec.ts,annotations-composition.host.spec.ts}`.

PR 4 — LLM explain 与持久事件：

- Modify `packages/llm/llm/src/types.ts` and `packages/llm/deepseek-llm-api-extensions/src/types.ts` — extend `purpose` with `'terminology'`.
- Modify `packages/api/remotes/src/client/index.ts` + `packages/api/remotes/package.json` — remote assembly.
- Modify `packages/api/remotes/src/remote-events.ts` — forwarded-event allowlist row.
- Modify `packages/client/ui-terminology/src/{index.ts,spec.ts,types.ts}` — `explain`, session event.
- Create `packages/client/ui-terminology/tests/explain.host.spec.ts`.

PR 5 — 浏览器半边：

- Create `packages/client/ui-terminology/src/client/{index.ts,locales.ts,resolver.ts,selection.ts,shortcut.ts,overlay-policy.ts,TerminologyOverlay.tsx,TerminologyOverlay.module.css,TerminologyCard.tsx,TerminologyCard.module.css,css-modules.d.ts}`.
- Create `packages/client/ui-terminology/tests/{resolver.client.spec.ts,selection.client.spec.ts,shortcut.client.spec.ts,overlay.client.spec.tsx,card.client.spec.tsx}`.

PR 6 — 组装验证：

- Create `packages/client/ui-terminology/tests/annotations-composition.host.spec.ts`, `apps/web/tests/terminology-inline.e2e.ts` (+ overlay yml + `expected/` goldens).
- Update TypeScript and Python SDK expected outputs for the new `SessionEventMap` member.

PR 7 — 文档：README 终审、子系统文档补记、双语 Agent Note。

---

### 任务 1：`ui-primitives` seam + `AnnotatedTerm`

**文件：**
- 修改：`packages/client/ui-primitives/src/markdown/render.tsx`
- 创建：`packages/client/ui-primitives/src/markdown/AnnotatedTerm.tsx`、`packages/client/ui-primitives/src/markdown/AnnotatedTerm.module.css`
- 修改：`packages/client/ui-primitives/src/markdown/MarkdownText.tsx`、`packages/client/ui-primitives/src/index.ts`
- 测试：`packages/client/ui-primitives/tests/markdown-annotations.client.spec.tsx`、`packages/client/ui-primitives/tests/annotated-term.client.spec.tsx`

- [ ] **步骤 1：编写失败的接缝测试**

创建 `packages/client/ui-primitives/tests/markdown-annotations.client.spec.tsx`。测试从 `./markdown-test-components.tsx` 引入 `MarkdownText`（它注入 labels），resolver 用 vi.fn 记录每个被请求的 text run。jsdom 环境来自 spec 首行 pragma（仓库规矩，见 `packages/client/AGENTS.md`）。

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MarkdownText } from './markdown-test-components.tsx'
import type { MarkdownAnnotations, MarkdownSegment } from '../src/index.ts'

function constant(value: string, segments: readonly MarkdownSegment[]): MarkdownAnnotations {
  const split = vi.fn((run: string) => (run === value ? segments : [{ kind: 'text', text: run } as MarkdownSegment]))
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

  it('never splits runs inside links', () => {
    const annotations = constant('Transformer', [])
    const { container } = render(<MarkdownText text="[Transformer](https://example.test)" annotations={annotations} />)
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('a')).not.toBeNull()
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
```

- [ ] **步骤 2：运行确认失败**

运行：`npx vitest run packages/client/ui-primitives/tests/markdown-annotations.client.spec.tsx`

预期：FAIL（`annotations` 不是已知 prop，且没有 button）。

- [ ] **步骤 3：在 `render.tsx` 声明接缝契约**

在 `MarkdownFileMentions`（当前 `:115` 附近）之后加入。JSDoc 的拼接不变式是提供方义务，渲染器按「Trust TypeScript」不做运行时校验：

```ts
/**
 * Prose annotation affordance: the owner decides which authored spans carry an
 * explanation, using its own vocabulary — the renderer never guesses at what
 * looks like a term.
 */
export interface MarkdownAnnotations {
  /**
   * Split one authored text run into its renderable segments.
   * @param value - The text node's literal value, exactly as authored.
   * @returns Contiguous segments whose concatenated text is exactly `value`.
   */
  split(value: string): readonly MarkdownSegment[]
}

/** One contiguous piece of an authored text run. */
export type MarkdownSegment =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'annotation'
      /** The exact authored substring this annotation covers. */
      readonly text: string
      /** Accessible name for the interactive span; locale-owned by the provider. */
      readonly label: string
      /** Explanation shown while the span is hovered, focused, or activated. */
      readonly explanation: string
    }
```

`MarkdownRenderContext` 在 `fileMentions` 字段旁加：

```ts ignore-check
  /** Prose annotations; absent wherever no vocabulary is mounted or while streaming. */
  readonly annotations: MarkdownAnnotations | undefined
```

- [ ] **步骤 4：分流 `case 'text'`**

`render.tsx` 顶部 `import { AnnotatedTerm } from './AnnotatedTerm.tsx'`。当前 `case 'text': return node.value`（`:217-218`）改为——`annotations === undefined` 必须走原样字符串，这是 DOM fixture 逐字节不变的原因；`inLink === true` 不调用 `split`（`<button>` 不能嵌进 `<a>`，与 `fileMentions` 同规则）：

```tsx
    case 'text':
      return context.annotations === undefined || context.inLink === true
        ? node.value
        : renderAnnotatedText(node.value, key, context.annotations)
```

在 `renderChildren` 附近加入：

```tsx
function renderAnnotatedText(value: string, key: Key, annotations: MarkdownAnnotations): ReactNode {
  const segments = annotations.split(value)
  if (segments.length === 1 && segments[0]?.kind === 'text') return segments[0].text
  return segments.map((segment, index) => segment.kind === 'text'
    ? segment.text
    : <AnnotatedTerm key={`${String(key)}:${index}`} text={segment.text} label={segment.label} explanation={segment.explanation} />)
}
```

- [ ] **步骤 5：实现 `AnnotatedTerm`**

创建 `packages/client/ui-primitives/src/markdown/AnnotatedTerm.tsx`。打开语义按 spec §4.3 的表；`click` 模式（触屏 tap 等价）不受 pointer-leave 影响，键盘模式失焦即关：

```tsx
/** Interactive annotated-term span: a button trigger with a hover/focus/click tooltip. */
import { useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useDismissOnOutsidePointer } from '../useDismissOnOutsidePointer.ts'
import { usePointerGrace } from '../pointer-grace.ts'
import css from './AnnotatedTerm.module.css'

/** Fixed interaction constant: opening instantly would flash while the pointer travels across prose. */
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
 * find a button in the a11y tree, independent of any hover styling) whose
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
  const grace = usePointerGrace(() => setOpen(false))
  useDismissOnOutsidePointer(rootRef, open, setOpen)
  const clearOpenTimer = (): void => {
    if (openTimerRef.current !== undefined) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = undefined
    }
  }
  const close = (): void => {
    clearOpenTimer()
    setOpen(false)
  }
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
          onPointerEnter={() => grace.cancel()}
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
```

创建 `AnnotatedTerm.module.css`（只用既有 `--dsw-*` 别名，参照 `Menu`/`HoverCard` 的 elevation 与 tip 背景；虚线下划线保证非 hover 态也有可见可交互线索）：

```css
.root {
  position: relative;
  display: inline;
}

.term {
  appearance: none;
  background: none;
  border: 0;
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  cursor: help;
  text-decoration: underline dotted;
  text-decoration-color: var(--dsw-alias-label-tertiary);
  text-underline-offset: 3px;
}

.term:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}

.tooltip {
  position: absolute;
  left: 0;
  top: calc(100% + 6px);
  z-index: 100;
  display: block;
  box-sizing: border-box;
  max-width: 280px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--dsw-specific-menu);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: var(--dsw-font-xs-13);
  font-family: var(--dsw-font-family);
  line-height: 1.5;
  white-space: pre-wrap;
}
```

- [ ] **步骤 6：`MarkdownText` 透传**

`MarkdownText.tsx`：`renderSettled` 增加第三参数 `annotations: MarkdownAnnotations | undefined` 并放进 settled context；两个 `StreamingRenderer` context 保持 `annotations: undefined`（与 `fileMentions: undefined` 并列，`:108`、`:126`）。组件签名与依赖数组：

```tsx
export const MarkdownText = memo(function MarkdownText({ text, streaming = false, labels, fileMentions, annotations }: {
  text: string
  streaming?: boolean
  labels: MarkdownLabels
  fileMentions?: MarkdownFileMentions | undefined
  annotations?: MarkdownAnnotations | undefined
}) {
  const streamRef = useRef<StreamingRenderer | null>(null)
  const streamLabelsRef = useRef<MarkdownLabels>(labels)
  const children = useMemo(() => {
    if (!streaming) {
      streamRef.current = null
      return renderSettled(text, labels, fileMentions, annotations)
    }
    if (streamRef.current === null || streamLabelsRef.current !== labels) {
      streamRef.current = new StreamingRenderer(labels)
      streamLabelsRef.current = labels
    }
    return streamRef.current.render(text)
  }, [text, streaming, labels, fileMentions, annotations])
  return <div className={css.markdown}>{children}</div>
})
```

`:26` 的类型再导出行改为 `export type { MarkdownAnnotations, MarkdownCodeLabels, MarkdownFileMentions, MarkdownLabels, MarkdownSegment } from './render.tsx'`；`:22` 的 import type 同步加 `MarkdownAnnotations`。JSDoc 给 `annotations` 补一句：settled-only，理由与 `fileMentions` 相同（冻结缓存不得烤进 handler），且新身份会丢弃已定稿缓存解析、提供方须保持词表不变时身份稳定。

- [ ] **步骤 7：`src/index.ts` 导出**

在现有 `MarkdownFileMentions` 导出旁加 `AnnotatedTerm`（value）与 `MarkdownAnnotations`、`MarkdownSegment`（type）。

- [ ] **步骤 8：编写并跑红→绿的 `AnnotatedTerm` 行为测试**

创建 `packages/client/ui-primitives/tests/annotated-term.client.spec.tsx`：

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { AnnotatedTerm } from '../src/index.ts'

const PROPS = { text: 'Transformer', label: '术语 Transformer，查看解释', explanation: '一种神经网络架构。' } as const

function tooltip(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="tooltip"]')
}

describe('AnnotatedTerm', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('opens on hover after 150ms, not before', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    fireEvent.pointerEnter(container.querySelector('button') as Element)
    expect(tooltip(container)).toBeNull()
    vi.advanceTimersByTime(150)
    expect(tooltip(container)?.textContent).toBe('一种神经网络架构。')
  })

  it('opens immediately on keyboard focus and wires aria-describedby', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    const trigger = container.querySelector('button') as HTMLButtonElement
    expect(trigger.getAttribute('aria-describedby')).toBeNull()
    fireEvent.focus(trigger)
    expect(tooltip(container)).not.toBeNull()
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip(container)?.id)
  })

  it('toggles on click and stays open across pointer-leave (touch semantics)', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    const trigger = container.querySelector('button') as HTMLButtonElement
    fireEvent.click(trigger)
    expect(tooltip(container)).not.toBeNull()
    fireEvent.pointerLeave(trigger)
    vi.advanceTimersByTime(500)
    expect(tooltip(container)).not.toBeNull()
    fireEvent.click(trigger)
    expect(tooltip(container)).toBeNull()
  })

  it('closes on Escape, on blur after focus-open, and on an outside pointerdown', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    const trigger = container.querySelector('button') as HTMLButtonElement
    fireEvent.focus(trigger)
    fireEvent.keyDown(container.querySelector('span') as Element, { key: 'Escape' })
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
    const trigger = container.querySelector('button') as HTMLButtonElement
    fireEvent.pointerEnter(trigger)
    vi.advanceTimersByTime(150)
    fireEvent.pointerLeave(trigger)
    fireEvent.pointerEnter(tooltip(container) as Element)
    vi.advanceTimersByTime(500)
    expect(tooltip(container)).not.toBeNull()
    fireEvent.pointerLeave(tooltip(container) as Element)
    vi.advanceTimersByTime(500)
    expect(tooltip(container)).toBeNull()
  })

  it('keeps the tooltip free of interactive content', () => {
    const { container } = render(<AnnotatedTerm {...PROPS} />)
    fireEvent.focus(container.querySelector('button') as HTMLButtonElement)
    const tip = tooltip(container) as HTMLElement
    expect(tip.querySelector('button, a, input, select, textarea')).toBeNull()
  })
})
```

运行：`npx vitest run packages/client/ui-primitives/tests/annotated-term.client.spec.tsx` → PASS。

- [ ] **步骤 9：跑本包全量与 DOM 奇偶校验**

运行：`npx vitest run packages/client/ui-primitives`

预期：全绿，特别是 `markdown-dom-parity.client.spec.tsx`（无 annotations 时逐字节不变）与 `markdown.client.spec.tsx` 不需改动。

- [ ] **步骤 10：typecheck + commit**

```bash
pnpm run typecheck
git add packages/client/ui-primitives
git commit -m "feat(ui-primitives): add MarkdownAnnotations seam and AnnotatedTerm"
```

---

### 任务 2：`ui-chat` 转发 `chatAnnotations`

**文件：**
- 修改：`packages/client/ui-chat/src/client/contract/slots.ts`、`packages/client/ui-chat/src/client/apply.ts`、`chat/ChatView.tsx`、`chat/ChatNodeSeat.tsx`、`chat/AssistantNodeView.tsx`、`chat/AssistantMarkdown.tsx`
- 测试：`packages/client/ui-chat/tests/annotations-threading.client.spec.tsx`

- [ ] **步骤 1：声明可选服务与 owner prop**

`slots.ts`：`import type { MarkdownAnnotations, MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'`（合并进既有 type import）。在 `ChatFileMentions` 之后加：

```ts
/** Optional prose-annotation provider consumed by Chat. */
export interface ChatAnnotations {
  /**
   * Current annotation resolver.
   * @returns The resolver for the live vocabulary, or undefined while the feature is off.
   */
  annotations(): MarkdownAnnotations | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional prose-annotation provider. */
    chatAnnotations: ChatAnnotations
  }
}
```

`ChatNodeOwnerProps`（`:87` 的 `fileMentions` 行后）与 `ChatViewInjected`（`:152` 同行区）各加一行，两处形状相同：

```ts
  annotations: () => MarkdownAnnotations | undefined
```

- [ ] **步骤 2：`apply.ts` 注入项**

在 `:121` 的 `fileMentions:` 行后加：

```ts ignore-check
          annotations: () => ctx.get('chatAnnotations')?.annotations(),
```

- [ ] **步骤 3：链路透传**

- `ChatView.tsx`：`:219` 解构加 `annotations`；`:792` `fileMentions={fileMentions}` 旁加 `annotations={annotations}`。
- `ChatNodeSeat.tsx`：`:41` 解构加 `annotations`；`:113` owner 对象字面量加 `annotations,`；`:117` memo 依赖数组加 `annotations`。
- `AssistantNodeView.tsx`：解构加 `annotations`；渲染体内直接调用（不加 memo——转发来的函数身份终身稳定，memo 会把首个 resolver 冻结住）：

```tsx
  const resolver = annotations()
```

并给 `<AssistantMarkdown ... mentions={mentions} annotations={resolver} />`。

- `AssistantMarkdown.tsx`：`AssistantMarkdownProps` 在 `mentions` 旁加 `/** Resolved prose annotations for this Node's settled renders. */ annotations?: MarkdownAnnotations | undefined`（type import 同步加），解构默认 `annotations`，`<MarkdownText ... fileMentions={mentions} annotations={annotations} />`。

- [ ] **步骤 4：编写组件级证据测试**

创建 `packages/client/ui-chat/tests/annotations-threading.client.spec.tsx`——按新组件清单第 3 条，直接喂 props 断言可见行为，不搭渲染机制：

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import type { MarkdownAnnotations } from '@deepseek-ai/dsh-client-ui-primitives'
import { chatLabels } from './labels.client.ts'

const annotations: MarkdownAnnotations = {
  split: run => run === 'a Transformer'
    ? [{ kind: 'text', text: 'a ' }, { kind: 'annotation', text: 'Transformer', label: '术语 Transformer，查看解释', explanation: 'E' }]
    : [{ kind: 'text', text: run }],
}

describe('AssistantMarkdown annotations', () => {
  it('renders the resolver-backed annotation inside settled text blocks', () => {
    const { container } = render(<AssistantMarkdown
      blocks={[{ kind: 'text', text: 'a Transformer' }]}
      streaming={false}
      renderMessageImages={() => null}
      annotations={annotations}
      t={chatLabels.t}
    />)
    expect(container.querySelector('[aria-label="术语 Transformer，查看解释"]')).not.toBeNull()
  })
})
```

`renderMessageImages` 返回 null 即满足 owner 类型（它只在 image block 被调用）。构造 `t` 用本包既有测试的 locale 桩（与相邻 spec 同法；若相邻 spec 用别的构造器，沿用其构造器，保持一个 home）。若 `blocks` 里文本块的判别字段/形状与此处不符，以 `contract/snapshot.ts` 的 `AssistantBlock` 为准调整本测试（不改组件）。

- [ ] **步骤 5：运行确认通过**

运行：`npx vitest run packages/client/ui-chat packages/client/ui-primitives` → PASS（既有 suites 兜底回归）。

- [ ] **步骤 6：typecheck + commit**

```bash
pnpm run typecheck
git add packages/client/ui-chat
git commit -m "feat(ui-chat): forward the optional chatAnnotations service to assistant Markdown"
```

---

### 任务 3：`ui-terminology` 包骨架 + Host 半边（词表/设置/state/remember/变更事件）

模板包：`packages/client/file-upload`（双半边布局）、`packages/feedback/message-feedback`（typert remote 形态）。开工前读 `.agents/skills/create-dsh-plugin` 与 `packages/client/AGENTS.md` 的 New plugin package checklist。

**文件：**
- 创建：`packages/client/ui-terminology/` 全部骨架 + `src/spec.ts`、`src/types.ts`、`src/glossary.ts`、`src/index.ts` + `README.md`/`README.zh.md`
- 修改：`tsconfig.client.json`、`packages/bundle/web-app/cordis.patch.yml`、`packages/bundle/web-app/package.json`
- 测试：`tests/glossary.host.spec.ts`、`tests/terminology-remote.host.spec.ts`、`tests/annotations-composition.host.spec.ts`

- [ ] **步骤 1：package.json**

创建 `packages/client/ui-terminology/package.json`（exports/files/`dsh.client` 与 file-upload 同构；本包 remote 供浏览器装配，`inject` 边只列真实读的服务）：

```json
{
  "name": "@deepseek-ai/dsh-client-ui-terminology",
  "description": "Inline terminology annotations for assistant prose: two-layer glossary, hover/focus/tap explanations, and model-backed lookup",
  "version": "0.1.3-alpha.1",
  "publishConfig": { "access": "public" },
  "repository": { "type": "git", "url": "git+https://github.com/deepseek-ai/deepseek-harness.git", "directory": "packages/client/ui-terminology" },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./types": { "types": "./lib/types/types.d.ts", "default": "./lib/types/types.js" },
    "./typert": { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
    "./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": ["@deepseek-ai/dsh-api-remotes"],
      "platform": "web"
    }
  },
  "scripts": { "bundle": "tsdown", "watch": "tsdown --watch" },
  "license": "MIT",
  "files": [
    "lib/index.js",
    "lib/client.js",
    "lib/types/**/*.js",
    "lib/types/**/*.d.ts",
    "lib/typert.host.js",
    "lib/typert.host.d.ts",
    "lib/typert.remote-client.js",
    "lib/typert.remote-client.d.ts"
  ],
  "dependencies": {
    "yaml": "^2.9.0",
    "chokidar": "^4.0.3",
    "@deepseek-ai/dsh-typert-protocol": "workspace:^",
    "@deepseek-ai/dsh-atomic-write": "workspace:^",
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/schemastery": "workspace:^",
    "@deepseek-ai/dsh-api-remotes": "workspace:^",
    "@deepseek-ai/dsh-client-connection": "workspace:^",
    "@deepseek-ai/dsh-client-ui-primitives": "workspace:^",
    "@deepseek-ai/dsh-llm": "workspace:^",
    "@deepseek-ai/dsh-session": "workspace:^",
    "@deepseek-ai/dsh-settings": "workspace:^",
    "@deepseek-ai/dsh-timeout": "workspace:^",
    "@deepseek-ai/dsh-util-values": "workspace:^"
  }
}
```

版本号以当轮 `git rev-parse` 的仓库根 package.json 版本为准；chokidar 主版本以 `packages/settings/settings-file/package.json` 实测为准；依赖分区最后由 `pnpm run hygiene --fix` 属主校验收敛（`verify-package-dependencies` 是唯一裁判，Host value import 必须命中 `safeHostDependencyExports` 分类）。

- [ ] **步骤 2：tsconfig 三面 + tsdown + css 声明**

创建 solution-only 根 `tsconfig.json`：

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.host.json" },
    { "path": "./tsconfig.client.json" }
  ]
}
```

`tsconfig.host.json`：

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types",
    "tsBuildInfoFile": "lib/tsconfig.host.tsbuildinfo"
  },
  "files": ["src/index.ts", "src/spec.ts", "src/types.ts", "src/glossary.ts"],
  "references": [
    { "path": "../../../vendor/cordis" },
    { "path": "../../core/session" },
    { "path": "../../llm/llm" },
    { "path": "../../settings/settings" },
    { "path": "../../typert/protocol" },
    { "path": "../../util/values" }
  ]
}
```

`tsconfig.client.json`（client 面引用 `../ui-primitives` 与 `../connection` 的 host leaf 时用 file-upload 同款相对路径写法；执行时按实际需要的引用面增删，保持"每个 workspace 依赖一条 references"）：

```json
{
  "extends": "../../../tsconfig.base.client.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types",
    "tsBuildInfoFile": "lib/tsconfig.client.tsbuildinfo"
  },
  "files": [
    "src/client/index.ts",
    "src/client/locales.ts",
    "src/client/resolver.ts",
    "src/client/selection.ts",
    "src/client/shortcut.ts",
    "src/client/overlay-policy.ts",
    "src/spec.ts",
    "src/types.ts"
  ],
  "references": [
    { "path": "../../../vendor/cordis" },
    { "path": "../../core/session" },
    { "path": "../../typert/protocol" },
    { "path": "../ui-primitives/tsconfig.client.json" }
  ]
}
```

任务 5 会向 `files` 追加 `.tsx` 与其余 client 文件。`tsdown.config.ts`：

```ts
import { clientBundle } from '../tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-client-ui-terminology', ['lib/types/index.js'])
```

`src/css-modules.d.ts`（照抄任一 client 包同名文件）。

- [ ] **步骤 3：三个注册面（缺一不可，失败点各不相同）**

1. 根 `tsconfig.client.json` 的 `references` 加 `{ "path": "packages/client/ui-terminology/tsconfig.client.json" }`。
2. `packages/bundle/web-app/cordis.patch.yml` 在其它 client 行旁加：

```yaml
    - id: ui-terminology
      name: '@deepseek-ai/dsh-client-ui-terminology'
```

3. `packages/bundle/web-app/package.json` 的 `dependencies` 加 `"@deepseek-ai/dsh-client-ui-terminology": "workspace:^"`。

随后任务 4 再补 remotes 装配、事件 allowlist、typert、catalog 四个面。

- [ ] **步骤 4：编写失败的词表合并测试**

创建 `packages/client/ui-terminology/tests/glossary.host.spec.ts`（纯 node 环境）：

```ts
import { describe, expect, it } from 'vitest'
import { mergeGlossary, parseProjectGlossary } from '../src/glossary.ts'
import type { GlossaryTerm } from '../src/types.ts'

const global_: readonly GlossaryTerm[] = [
  { term: 'Transformer', explanation: 'global one' },
  { term: '模型', explanation: 'global model' },
]
const project: readonly GlossaryTerm[] = [
  { term: 'Transformer', explanation: 'project one' },
  { term: 'Transformer 架构', explanation: 'project arch' },
]

describe('mergeGlossary', () => {
  it('keeps project entries winning over global ones, longest-first by code-unit length', () => {
    expect(mergeGlossary(global_, project)).toEqual([
      { term: 'Transformer 架构', explanation: 'project arch' },
      { term: 'Transformer', explanation: 'project one' },
      { term: '模型', explanation: 'global model' },
    ])
  })
})

describe('parseProjectGlossary', () => {
  it('accepts the documented shape', () => {
    expect(parseProjectGlossary('terms:\n  - term: 模型\n    explanation: 解释\n')).toEqual([
      { term: '模型', explanation: '解释' },
    ])
  })
  it('rejects a non-object document', () => {
    expect(() => parseProjectGlossary('- just\n- a\n- list\n')).toThrow(/terms/)
  })
  it('rejects an entry missing the explanation', () => {
    expect(() => parseProjectGlossary('terms:\n  - term: a\n')).toThrow(/explanation/)
  })
  it('rejects a duplicate term', () => {
    expect(() => parseProjectGlossary('terms:\n  - term: a\n    explanation: x\n  - term: a\n    explanation: y\n')).toThrow(/duplicate/)
  })
})
```

运行 `npx vitest run packages/client/ui-terminology/tests/glossary.host.spec.ts` → FAIL（模块不存在）。

- [ ] **步骤 5：实现 `src/types.ts`（纯类型）与 `src/spec.ts`（运行时 schema）**

`src/types.ts`——remote 契约、错误目录、事件声明合并（types.ts 无运行时代码，`@mode emit` 注释按 `packages/interaction/commands/src/types.ts:80` 的 Events 先例）：

```ts
/**
 * Browser<->Host contract of the terminology feature: remote payloads, the
 * two-layer glossary vocabulary, and the durable explain-request record.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/types
 */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One glossary entry shared by both layers and every boundary. */
export interface GlossaryTerm {
  readonly term: string
  readonly explanation: string
}

/** Which glossary layer a write targets. */
export type GlossaryLayer = 'global' | 'project'

/** Everything one client fetch needs; the client round-trips this in one call. */
export interface TerminologyState {
  readonly enabled: boolean
  /** Effective keyboard shortcut, as resolved from the user settings layer. */
  readonly shortcut: string
  /** Absolute path of the project glossary file resolved from the session workspace. */
  readonly projectPath: string
  readonly projectTerms: readonly GlossaryTerm[]
  /** Read/parse failure of the project file; the project layer is then ignored. */
  readonly projectError: string | undefined
  readonly globalTerms: readonly GlossaryTerm[]
}

/** Session-scoped request for the full render inputs. */
export interface TerminologyStateRequest { readonly sessionId: SessionId }

/** Manual-lookup request: `context` is the block text around the selection. */
export interface TerminologyExplainRequest {
  readonly sessionId: SessionId
  readonly term: string
  readonly context: string
}

/** Successful explanation: plain prose, markdown-free by prompt contract. */
export interface TerminologyExplainValue { readonly explanation: string }

/** Write one entry back; `layer` names the target store. */
export interface TerminologyRememberRequest {
  readonly sessionId: SessionId
  readonly term: string
  readonly explanation: string
  readonly layer: GlossaryLayer
}

/** Closed failure vocabulary; every member is user-explainable at the surface. */
export type TerminologyErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'GLOSSARY_INVALID'
  | 'TERM_INVALID'
  | 'CONTEXT_TOO_LARGE'
  | 'NO_MODEL_ROUTE'
  | 'LLM_FAILED'
  | 'TIMEOUT'
  | 'GLOSSARY_WRITE_FAILED'
  | 'NO_WORKSPACE'
  | 'SETTINGS_CONFLICT'

/** Typed failure: code plus a message safe to show. */
export interface TerminologyError {
  readonly code: TerminologyErrorCode
  readonly message: string
}

/** Result envelope; the remote returns business failures, never thrown RPC. */
export type TerminologyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TerminologyError }

/** Remote result kinds of `state`, `explain`, and `remember`. */
export type TerminologyStateResult = TerminologyResult<TerminologyState>
export type TerminologyExplainResult = TerminologyResult<TerminologyExplainValue>
export type TerminologyRememberResult = TerminologyResult<Record<string, never>>

/** Framed model-visible input of one explain call, reconstructable from the log. */
export interface TerminologyExplainRequestEventData {
  readonly term: string
  readonly context: string
  readonly system: string
  readonly messages: readonly Message[]
  readonly route: { readonly provider: string; readonly model: string }
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Pre-dispatch record of one user-triggered terminology explanation
     * request: the exact framed model input, appended in the same two-argument
     * log-only form as `session/title-llm-request`, so the request is
     * reconstructable from the Session log.
     */
    'terminology/explain-request': TerminologyExplainRequestEventData
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The rendered vocabulary changed: a settings write, an external edit of
     * the project glossary file, or a successful remember. The payload carries
     * the affected session for session-scoped changes and undefined for global
     * ones. Observer failures cannot veto the write that produced it.
     * @mode emit
     */
    'terminology/changed'(sessionId: SessionId | undefined): void
  }
}
```

`src/spec.ts`——schemastery 配置与设置 schema（对齐 `ui-chat/src/chat-settings.ts` 风格），durable/文件层用 zod（对齐 `message-feedback/src/spec.ts`）：

```ts
/**
 * Runtime schemas: Host Config (deployment defaults), the user settings
 * section, and the project glossary file format.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/spec
 */
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { GlossaryTerm } from './types.ts'

/** Settings namespace owned by terminology; the browser card joins on this key. */
export const TERMINOLOGY_NAMESPACE = 'terminology'

/** Default manual-explain chord. */
export const DEFAULT_EXPLAIN_SHORTCUT = 'Alt+Shift+E'

/** Default project glossary file, relative to the session workspace. */
export const DEFAULT_PROJECT_GLOSSARY_PATH = '.dsh/terminology.yml'

/** One glossary entry at every settings and file boundary. */
export const glossaryTermSchema: zod.ZodType<GlossaryTerm> = zod.object({
  term: zod.string().min(1).max(200),
  explanation: zod.string().min(1).max(4000),
})

/** User-editable section stored in the settings document. */
export interface TerminologySettings {
  readonly enabled: boolean
  readonly explainShortcut: string
  readonly terms: readonly GlossaryTerm[]
}

/** Settings section; Host Config supplies the composition base for all three. */
export const TerminologySettingsSchema: z<TerminologySettings> = z.object({
  enabled: z.boolean().default(true),
  explainShortcut: z.string().default(DEFAULT_EXPLAIN_SHORTCUT),
  terms: z.array(glossaryTermSchema).default([]),
})

/** Validated Host configuration (all fields, no hardcoded tunables). */
export interface TerminologyConfig {
  readonly enabled: boolean
  readonly terms: readonly GlossaryTerm[]
  readonly explainShortcut: string
  readonly projectGlossaryPath: string
  readonly explainProvider?: string | undefined
  readonly explainModel?: string | undefined
  readonly explainMaxTokens: number
  readonly explainMaxSentences: number
  readonly explainTimeoutMs: number
  readonly explainTermMaxChars: number
  readonly explainContextMaxBytes: number
}

/** Host Config schema; `explainProvider`/`explainModel` are both-or-neither, enforced by {@link resolveRoute}. */
export const TerminologyConfigSchema: z<TerminologyConfig> = z.object({
  enabled: z.boolean().default(true),
  terms: z.array(glossaryTermSchema).default([]),
  explainShortcut: z.string().default(DEFAULT_EXPLAIN_SHORTCUT),
  projectGlossaryPath: z.string().default(DEFAULT_PROJECT_GLOSSARY_PATH),
  explainProvider: z.string().optional(),
  explainModel: z.string().optional(),
  explainMaxTokens: z.number().default(256),
  explainMaxSentences: z.number().default(3),
  explainTimeoutMs: z.number().default(30_000),
  explainTermMaxChars: z.number().default(64),
  explainContextMaxBytes: z.number().default(2048),
}).required()

/** Project glossary file body: `{ terms: [...] }`, duplicate terms rejected. */
export const projectGlossaryFileSchema = zod.object({
  terms: zod.array(glossaryTermSchema),
}).transform(doc => {
  const seen = new Set<string>()
  for (const entry of doc.terms) {
    if (seen.has(entry.term)) throw new Error(`terminology: duplicate project term "${entry.term}"`)
    seen.add(entry.term)
  }
  return doc.terms
})
```

`schemastery` 数组/optional 的确切方法名以 `packages/client/ui-chat/src/chat-settings.ts` 与 settings 包内其它 schema 为准；若 `.required()` 顶层写法不兼容，改为逐字段显式声明，不改变字段集。

- [ ] **步骤 6：实现 `src/glossary.ts`**

```ts
/**
 * Two-layer glossary: project file parsing and the merged render vocabulary.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/glossary
 */
import { parseDocument } from 'yaml'
import { projectGlossaryFileSchema } from './spec.ts'
import type { GlossaryTerm } from './types.ts'

/**
 * Parse the project glossary YAML body into validated terms.
 * @param body - Raw YAML text of the project glossary file.
 * @returns The validated terms in document order.
 * @throws {Error} when the document is not `{ terms: [...] }`, an entry fails
 * validation, or a term repeats (an ambiguous vocabulary is never half-applied).
 */
export function parseProjectGlossary(body: string): readonly GlossaryTerm[] {
  const document = parseDocument(body, { uniqueKeys: true })
  if (document.errors.length > 0) throw new Error(`terminology: ${document.errors[0]?.message ?? 'invalid YAML'}`)
  return projectGlossaryFileSchema.parse(document.toJS())
}

/**
 * Merge the two layers into the render vocabulary.
 * Project entries win on the same term; the result is ordered by term length
 * descending (longest term first so `Transformer 架构` beats `Transformer`).
 * @param globalTerms - The user-level layer.
 * @param projectTerms - The workspace layer, winning conflicts.
 * @returns The merged, deduplicated, length-sorted vocabulary.
 */
export function mergeGlossary(
  globalTerms: readonly GlossaryTerm[],
  projectTerms: readonly GlossaryTerm[],
): readonly GlossaryTerm[] {
  const merged = new Map<string, GlossaryTerm>()
  for (const entry of globalTerms) merged.set(entry.term, entry)
  for (const entry of projectTerms) merged.set(entry.term, entry)
  return [...merged.values()].sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term))
}
```

- [ ] **步骤 7：实现 Host 半边 `src/index.ts`（本任务不含 explain）**

默认导出 `TypertRemoteService` 子类（message-feedback 形态）。settings 注册在 init 期，`base` 用 Config 的三个用户可见字段；项目文件读取用 `node:fs/promises`，外部改动监听用 chokidar（`awaitWriteFinish` 去抖——偏离规格 §6.1 的 `node:fs.watch`，选择 settings-file 同款维护中依赖）。`explain` 方法本任务先不写，任务 4 落地：

```ts
/**
 * Host half: settings namespace, two-layer glossary with file watching, and
 * the typert remote the Web client reads. The explain pipeline lands beside
 * `explain` below.
 * @module @deepseek-ai/dsh-client-ui-terminology
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { watch } from 'chokidar'
import { stringify } from 'yaml'
import type {} from '@deepseek-ai/dsh-settings'
import { TERMINOLOGY_NAMESPACE, TerminologyConfigSchema, TerminologySettingsSchema } from './spec.ts'
import { mergeGlossary, parseProjectGlossary } from './glossary.ts'
import type {
  GlossaryTerm, TerminologyError, TerminologyErrorCode, TerminologyExplainRequest,
  TerminologyExplainResult, TerminologyRememberRequest, TerminologyRememberResult,
  TerminologyState, TerminologyStateRequest, TerminologyStateResult,
} from './types.ts'

const EMPTY_TERMS: readonly GlossaryTerm[] = Object.freeze([])

/** One project-file outcome: parsed terms, absence, or the parse failure. */
interface ProjectGlossary {
  readonly terms: readonly GlossaryTerm[]
  readonly error: string | undefined
}

/** Write one project file under the workspace lock. */
async function writeProjectGlossary(filePath: string, terms: readonly GlossaryTerm[]): Promise<void> {
  await writeFileAtomic(filePath, stringify({ terms: [...terms] }), { lock: withFileLock })
}

/** The terminology Host service: vocabulary owner and remote surface. */
export default class TerminologyService extends TypertRemoteService {
  static inject = ['settings', 'sessions'] as const
  static Config = TerminologyConfigSchema

  private readonly base: { enabled: boolean; explainShortcut: string; terms: readonly GlossaryTerm[] }
  /** Project-file cache per absolute path, refreshed by reads and the watcher. */
  private readonly projectFiles = new Map<string, ProjectGlossary>()
  private readonly watchers = new Map<string, ReturnType<typeof watch>>()

  /** @param ctx - Host context carrying settings and the session store. */
  constructor(ctx: Context) {
    super(ctx, 'terminology')
    const config = ctx.config
    this.base = { enabled: config.enabled, explainShortcut: config.explainShortcut, terms: config.terms }
  }

  /** Register the settings namespace and adopt its owner scope. */
  protected async [Service.init](): Promise<void> {
    this.scope = this.ctx.settings.register(TERMINOLOGY_NAMESPACE, TerminologySettingsSchema, { base: this.base })
    this.ctx.effect(() => this.scope.watch(() => this.notifyChanged(undefined)), 'terminology:settings-watch')
  }

  /** Owner scope over the durable `terminology` section. */
  private scope!: {
    get(): { enabled: boolean; explainShortcut: string; terms: readonly GlossaryTerm[] }
    watch(callback: (value: unknown) => void): () => void
    update(patch: Record<string, unknown>): Promise<void>
  }

  /** Effective user-visible settings (document layer over the Config base). */
  private settings(): { enabled: boolean; explainShortcut: string; terms: readonly GlossaryTerm[] } {
    return this.scope.get()
  }

  /**
   * Read one session's full render inputs.
   * @param request - Session identity.
   * @returns Enabled flag, shortcut, project path, both layers, and any
   * project-file parse error; `SESSION_NOT_FOUND` / `NO_WORKSPACE` otherwise.
   */
  @Remote('state')
  async state(request: TerminologyStateRequest): Promise<TerminologyStateResult> {
    const session = this.ctx.sessions.get(request.sessionId)
    const cwd = session?.header.cwd
    if (session === undefined) return rejected('SESSION_NOT_FOUND', `session ${request.sessionId} not found`)
    if (typeof cwd !== 'string' || cwd.length === 0) return rejected('NO_WORKSPACE', 'session has no workspace directory')
    const projectPath = path.resolve(cwd, this.projectGlossaryPath())
    const project = await this.readProjectFile(projectPath)
    const settings = this.settings()
    const value: TerminologyState = {
      enabled: settings.enabled,
      shortcut: settings.explainShortcut,
      projectPath,
      projectTerms: project.error === undefined ? project.terms : EMPTY_TERMS,
      projectError: project.error,
      globalTerms: settings.terms,
    }
    return { ok: true, value }
  }

  /**
   * Append one entry to the chosen layer.
   * @param request - Term, explanation, and target layer.
   * @returns `{}` on success; `TERM_INVALID`, `GLOSSARY_INVALID`,
   * `GLOSSARY_WRITE_FAILED`, `SETTINGS_CONFLICT`, `NO_WORKSPACE`, or
   * `SESSION_NOT_FOUND` otherwise.
   */
  @Remote('remember')
  async remember(request: TerminologyRememberRequest): Promise<TerminologyRememberResult> {
    const term = request.term.trim()
    const explanation = request.explanation.trim()
    if (term.length === 0 || explanation.length === 0
      || term.length > this.ctx.config.explainTermMaxChars) {
      return rejected('TERM_INVALID', 'term and explanation must be non-empty and within the configured term limit')
    }
    if (request.layer === 'global') {
      const next = upsert(this.settings().terms, term, explanation)
      try {
        await this.scope.update({ terms: next })
      } catch (error) {
        return rejected('SETTINGS_CONFLICT', error instanceof Error ? error.message : String(error))
      }
      return { ok: true, value: {} }
    }
    const session = this.ctx.sessions.get(request.sessionId)
    const cwd = session?.header.cwd
    if (session === undefined) return rejected('SESSION_NOT_FOUND', `session ${request.sessionId} not found`)
    if (typeof cwd !== 'string' || cwd.length === 0) return rejected('NO_WORKSPACE', 'session has no workspace directory')
    const projectPath = path.resolve(cwd, this.projectGlossaryPath())
    const current = await this.readProjectFile(projectPath)
    if (current.error !== undefined) {
      return rejected('GLOSSARY_INVALID', `fix the project glossary before writing: ${current.error}`)
    }
    try {
      await fs.mkdir(path.dirname(projectPath), { recursive: true })
      await writeProjectGlossary(projectPath, upsert(current.terms, term, explanation))
    } catch (error) {
      return rejected('GLOSSARY_WRITE_FAILED', error instanceof Error ? error.message : String(error))
    }
    this.projectFiles.set(projectPath, { terms: upsert(current.terms, term, explanation), error: undefined })
    this.notifyChanged(request.sessionId)
    return { ok: true, value: {} }
  }

  /** Configured project glossary path; kept relative by schema validation. */
  private projectGlossaryPath(): string {
    return this.ctx.config.projectGlossaryPath
  }

  /** Read one project file, caching absence and parse failures alike. */
  private async readProjectFile(projectPath: string): Promise<ProjectGlossary> {
    const cached = this.projectFiles.get(projectPath)
    if (cached !== undefined) return cached
    const result = await this.loadProjectFile(projectPath)
    this.projectFiles.set(projectPath, result)
    this.ensureWatcher(projectPath)
    return result
  }

  /** Load from disk: missing is a normal empty layer, invalid fails loud but non-fatal. */
  private async loadProjectFile(projectPath: string): Promise<ProjectGlossary> {
    try {
      return { terms: parseProjectGlossary(await fs.readFile(projectPath, 'utf8')), error: undefined }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { terms: EMPTY_TERMS, error: undefined }
      return {
        terms: EMPTY_TERMS,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** Watch one project file with debounce; disposing the fiber closes every watcher. */
  private ensureWatcher(projectPath: string): void {
    if (this.watchers.has(projectPath)) return
    const watcher = watch(projectPath, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300 } })
    watcher.on('all', () => {
      void this.loadProjectFile(projectPath).then((result) => {
        this.projectFiles.set(projectPath, result)
        this.notifyChanged(undefined)
      })
    })
    this.watchers.set(projectPath, watcher)
    this.ctx.effect(() => () => { void watcher.close() }, `terminology:watch(${projectPath})`)
  }

  /** Publish the change so browsers refetch `state`; observer failures are contained. */
  private notifyChanged(sessionId: TerminologyStateRequest['sessionId'] | undefined): void {
    for (const callback of this.ctx.events.dispatch('emit', ['terminology/changed', sessionId])) {
      try {
        void Promise.resolve(callback() as unknown).catch(() => {})
      } catch {
        // Observer failure cannot veto the committed vocabulary change.
      }
    }
  }
}

/** Insert or replace one term, preserving document order of survivors. */
function upsert(terms: readonly GlossaryTerm[], term: string, explanation: string): readonly GlossaryTerm[] {
  return [...terms.filter(entry => entry.term !== term), { term, explanation }]
}

/** Build one typed failure. */
function rejected<T>(code: TerminologyErrorCode, message: string): { ok: false; error: TerminologyError } {
  return { ok: false, error: { code, message } }
}

/** Re-export the merged vocabulary builder for consumers that import the Host face. */
export { mergeGlossary }
```

落地时的三处事实核对（不允许凭猜测收尾）：(a) `TypertRemoteService` 子类的 `static Config` 在 message-feedback 用 `s<Config>` 显式类型注解，若需要则 `static Config: TerminologyConfigSchema 类型` 写法照抄；(b) `ctx.sessions.get(id)?.header.cwd` 的实际属性名（message-feedback 的 `header` 即会话头，`cwd` 字段见其 `messageFeedbackSessionIdentitySchema`）；(c) `writeFileAtomic` 的 options 参数按 `@deepseek-ai/dsh-atomic-write` 导出签名为准——如签名为 `(filename, content, { lock })` 之外的形态，以包源码为准调整调用与 `lock` 用法。`ctx.config` 在类内不可用（config 走 constructor 参数），构造函数签名改为 `(ctx: Context, config: TerminologyConfig)` 并删除 `ctx.config` 读取——message-feedback constructor 即此形态。`explain` 也将在任务 4 需要 `llm`、`sessionProjections` 注入，本任务 `static inject` 就写成 `['settings', 'sessions', 'llm', 'sessionProjections']` 以免二改。

- [ ] **步骤 8：跑词表测试转绿 + remote 行为测试**

运行：`npx vitest run packages/client/ui-terminology/tests/glossary.host.spec.ts` → PASS。

创建 `packages/client/ui-terminology/tests/terminology-remote.host.spec.ts`：用 `Context` + 手工 stub `settings`（返回一个 scripted owner scope）与 `sessions`（`{ get: () => ({ header: { cwd } }) }` 形状）构造服务实例（remote 方法直接 `new TerminologyService(ctx)` 或按 Loader 注入的等价构造），用 `mkdtemp` 真实文件断言：`state` 合并两层与 `projectError`；`remember` global 层写 `scope.update`；`remember` project 层写出 YAML 且重复 term 覆盖；外部改动（直接 `writeFile`）后 watcher 触发 `terminology/changed`（await 一个 `waitFor` 轮询 `notifyChanged` 计数，chokidar 在 CI 上的去抖窗口按 `awaitWriteFinish` 上限放宽）。断言 `remoteMethods(service)` 暴露 `state/remember`（import 自 `@deepseek-ai/dsh-typert-protocol`，同 message-feedback spec）。

运行：`npx vitest run packages/client/ui-terminology/tests/terminology-remote.host.spec.ts` → PASS。

- [ ] **步骤 9：README 双语对（包规则先决条件）**

创建 `packages/client/ui-terminology/README.md` 与 `README.zh.md`：一句话定位、安装行（cordis.patch.yml 行）、`## Model Experience`（说明本包只发起用户手动触发的旁路模型请求，`purpose: 'terminology'`，逐次入会话日志 `terminology/explain-request`；自动标注零模型参与）、`## Known Limitations and Deferred Work`（至少四条：单个 text 节点内匹配、被强调语法劈开的词不命中、中文无词边界（词表含 `模型` 也会标「大模型」内的 `模型`）、正文解释在节点下一次自然重渲染时反映词表变化；外加一条约束：本功能不提供导出，将来若加导出，格式选择必须是设置卡片级的显式控件，不得进入 tooltip）。任务 7 只做终审不新建。

- [ ] **步骤 10：注册面自检 + typecheck + commit**

运行：`pnpm run typecheck`（新包进聚合面后必须干净）。若 `pnpm run hygiene` 的依赖分区裁判报差异，按其 `--fix` 输出修 package.json。

```bash
git add packages/client/ui-terminology tsconfig.client.json packages/bundle/web-app
git commit -m "feat(ui-terminology): add the package and its Host glossary/settings/remote half"
```

---

### 任务 4：LLM explain 管线 + 持久事件 + remote 装配

**文件：**
- 修改：`packages/llm/llm/src/types.ts:442`、`packages/llm/deepseek-llm-api-extensions/src/types.ts:25`
- 修改：`packages/client/ui-terminology/src/{types.ts,spec.ts,index.ts}`
- 修改：`packages/api/remotes/src/client/index.ts`、`packages/api/remotes/package.json`、`packages/api/remotes/src/remote-events.ts`
- 测试：`packages/client/ui-terminology/tests/explain.host.spec.ts`

- [ ] **步骤 1：扩展 `purpose` 封闭联合**

两处镜像声明同步加 `'terminology'`：`packages/llm/llm/src/types.ts` 的 `purpose?: 'compaction' | 'session-title'` 与 `packages/llm/deepseek-llm-api-extensions/src/types.ts` 的同名成员，各改为 `purpose?: 'compaction' | 'session-title' | 'terminology'`，JSDoc 注明「user-interface-triggered auxiliary request outside any turn/step」。两个消费点（`llm-deepseek/src/adapter.ts:540`、`serialize.ts:84`）是等值判断，无穷尽 switch，无需改动；`serialize.ts` 是否为该 purpose 关闭 thinking 不在本计划预设，保持现状。

运行：`npx vitest run packages/llm` → PASS（回归即可，行为不变）。

- [ ] **步骤 2：编写失败的 explain 管线测试**

创建 `packages/client/ui-terminology/tests/explain.host.spec.ts`。stub `ctx.llm.stream` 为可注入的 async 迭代器（吐 text 块 / tool-call 块 / 抛错），stub `sessionProjections.stateOf` 返回 `{ lastUsed: { provider, model } }` 或 undefined，用真实 `Session`（memory persistence，参照 message-feedback `tests/helpers.ts` 的 append fixture）断言事件：

```ts ignore-check
import { describe, expect, it, vi } from 'vitest'
import { explainTerm } from '../src/explain.ts'
import type { ExplainDeps, ExplainInput } from '../src/explain.ts'

function okStream(...text: string[]): ExplainDeps['stream'] {
  return async function * () {
    for (const chunk of text) yield { type: 'text', text: chunk } as never
    yield { type: 'finish', finish: { kind: 'stop' } } as never
  }
}

const BASE: ExplainDeps = {
  route: { provider: 'deepseek', model: 'test-model' },
  config: { maxTokens: 256, maxSentences: 3, timeoutMs: 30_000, termMaxChars: 64, contextMaxBytes: 2048 },
  stream: okStream('一种神经网络架构。'),
  append: vi.fn(),
}

const INPUT: ExplainInput = { term: 'Transformer', context: 'what is a Transformer' }

describe('explainTerm', () => {
  it('returns assembled text and logs the framed request', async () => {
    const result = await explainTerm(BASE, INPUT)
    expect(result).toEqual({ ok: true, value: { explanation: '一种神经网络架构。' } })
    expect(BASE.append).toHaveBeenCalledTimes(1)
    const [type, payload] = (BASE.append as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>]
    expect(type).toBe('terminology/explain-request')
    expect(JSON.stringify(payload.messages)).toContain('Transformer')
    expect(typeof payload.system).toBe('string')
  })
  it('frames user text as JSON so it cannot break the structure', async () => {
    await explainTerm(BASE, { term: 'x", "evil': 1', context: 'a\n"term": injection' })
    const payload = (BASE.append as ReturnType<typeof vi.fn>).mock.calls[0][1] as { messages: { content: { text: string }[] }[] }
    expect(payload.messages[0]?.content[0]?.text.startsWith('Explain this glossary term...')).toBe(true)
  })
  it('rejects an oversized context before any stream', async () => {
    const deps = { ...BASE, stream: vi.fn(() => { throw new Error('must not stream') }) }
    const result = await explainTerm(deps, { term: 'a', context: '字'.repeat(2048) })
    expect(result.ok).toBe(false)
  })
  it('fails TERM_INVALID on an over-long term', async () => {
    const result = await explainTerm(BASE, { term: 'a'.repeat(65), context: '' })
    expect(result.ok === false && result.error.code === 'TERM_INVALID').toBe(true)
  })
})
```

块类型/finish 形状与 `GenerateOptions` 字段以 `packages/session/session-title-llm` 的调用与 `BlockAssembler` 消费为准；stub 的 `as never` 只允许出现在测试边界。`frame` 前缀字符串（`'Explain this glossary term...'`）必须与步骤 3 的 system/frame 实现一致——先写实现字符串常量，再回填断言，两处逐字一致。

- [ ] **步骤 3：实现 `src/explain.ts` 并接入 `@Remote('explain')`**

`src/explain.ts`（依赖注入式，类方法只做装配——测试无需起容器）：

```ts
/**
 * The manual-lookup LLM pipeline: framing, bounds, deadline, output rules,
 * and the durable pre-dispatch record. Shape follows
 * packages/session/session-title-llm.
 * @module @deepseek-ai/dsh-client-ui-terminology/src/explain
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { TerminologyError, TerminologyErrorCode, TerminologyExplainRequestEventData, TerminologyExplainResult } from './types.ts'

/** One model route. */
export interface ExplainRoute { readonly provider: string; readonly model: string }

/** Validated policy for one explain call (from Host Config). */
export interface ExplainPolicy {
  readonly maxTokens: number
  readonly maxSentences: number
  readonly timeoutMs: number
  readonly termMaxChars: number
  readonly contextMaxBytes: number
}

/** Collaborators of one explain call, injectable for tests. */
export interface ExplainDeps {
  readonly route: ExplainRoute
  readonly config: ExplainPolicy
  readonly stream: (options: GenerateOptions) => AsyncIterable<unknown>
  readonly append: (event: 'terminology/explain-request', payload: TerminologyExplainRequestEventData) => void
  readonly sessionId?: ExplainSessionRef
}

/** Session handle the event append needs. */
export interface ExplainSessionRef { readonly id: string }

/** Validated user input of one explain call. */
export interface ExplainInput { readonly term: string; readonly context: string }

/** Timeout reason code owned by this capability. */
export const TERMINOLOGY_TIMEOUT_CODE = 'TERMINOLOGY_TIMEOUT'

/** Stable task-facing system instruction; contains no UI/transport vocabulary. */
export function systemPrompt(maxSentences: number): string {
  return [
    'You explain one term from a reader\'s document.',
    'Answer directly with the meaning of the term in this context, in the language of the surrounding text.',
    `Reply in plain text of natural language with no Markdown, no code block, no preamble, and at most ${maxSentences} sentences.`,
  ].join('\n')
}

/** Frame term and context as JSON so user text cannot break structural delimiters. */
export function frameInput(term: string, context: string): string {
  return `Explain this glossary term. JSON input:\n${JSON.stringify({ term, context })}`
}

/** Build one typed failure. */
function rejected(code: TerminologyErrorCode, message: string): TerminologyExplainResult {
  return { ok: false, error: { code, message } satisfies TerminologyError }
}

/**
 * Run one explain call.
 * @param deps - Route, policy, stream collaborator, and log sink.
 * @param input - The selected term and its surrounding context.
 * @returns The explanation text or a typed failure; the request is appended
 * before dispatch so the model-visible input is reconstructable from the log.
 */
export async function explainTerm(deps: ExplainDeps, input: ExplainInput): Promise<TerminologyExplainResult> {
  if (input.term.length === 0 || input.term.length > deps.config.termMaxChars) {
    return rejected('TERM_INVALID', 'the selected text is empty or longer than the configured term limit')
  }
  if (Buffer.byteLength(input.context, 'utf8') > deps.config.contextMaxBytes) {
    return rejected('CONTEXT_TOO_LARGE', 'the surrounding text exceeds the configured context limit')
  }
  const system = systemPrompt(deps.config.maxSentences)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: frameInput(input.term, input.context) }],
    source: { kind: 'plugin', plugin: 'dsh-client-ui-terminology' },
  })]
  using callDeadline = deadline(AbortSignal.timeout ? AbortSignal.timeout(deps.config.timeoutMs) : new AbortController().signal, deps.config.timeoutMs, TERMINOLOGY_TIMEOUT_CODE)
  const options = deepFreeze({
    provider: deps.route.provider,
    model: deps.route.model,
    messages,
    system,
    maxTokens: deps.config.maxTokens,
    purpose: 'terminology',
    signal: callDeadline.signal,
  }) satisfies GenerateOptions
  deps.append('terminology/explain-request', {
    term: input.term,
    context: input.context,
    system,
    messages,
    route: deps.route,
    maxTokens: deps.config.maxTokens,
  })
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of deps.stream(options)) {
      assembler.push(chunk as never)
      callDeadline.signal.throwIfAborted()
    }
  } catch (error) {
    if (callDeadline.signal.aborted) return rejected('TIMEOUT', 'the explanation request timed out')
    return rejected('LLM_FAILED', error instanceof Error ? error.message : String(error))
  }
  if (callDeadline.signal.aborted) return rejected('TIMEOUT', 'the explanation request timed out')
  const blocks = assembler.blocks()
  if (blocks.some(block => (block as { type?: string }).type === 'tool-call')) {
    return rejected('LLM_FAILED', 'the explanation model returned a tool request')
  }
  const text = blocks
    .flatMap(block => (block as { type?: string; text?: string }).type === 'text'
      ? [(block as { text: string }).text]
      : [])
    .join(' ')
    .trim()
  if (text.length === 0) return rejected('LLM_FAILED', 'the explanation model produced no text')
  return { ok: true, value: { explanation: text } }
}
```

`deadline()` 的实际入参以 `packages/session/session-title-llm/src/index.ts:253` 为准（它传 `request.signal`）：这里没有 caller signal，构造 `new AbortController()` 并 `setTimeout(() => controller.abort(), timeoutMs).unref()` 的写法替换上面那行 `AbortSignal.timeout` 三元——两形选一，禁止保留未定形。`session.append('terminology/explain-request', payload)` 用与 `session/title-llm-request` 相同的二参 log-only 形态：`Session.append` 对非 surface 类型不接受第三个实参，`ignorable` 是读取侧信封字段、一方写者不经 append 设置（`session-title-llm` 即此先例）。

类内接入（`src/index.ts`）：`static inject` 已含 `llm`、`sessionProjections`；加方法：

```ts ignore-check
  /**
   * Explain one manually selected term through the session's model route.
   * @param request - Session, term, and surrounding context.
   * @returns The explanation or `TERM_INVALID` / `CONTEXT_TOO_LARGE` /
   * `NO_MODEL_ROUTE` / `LLM_FAILED` / `TIMEOUT` / `SESSION_NOT_FOUND`.
   */
  @Remote('explain')
  async explain(request: TerminologyExplainRequest): Promise<TerminologyExplainResult> {
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      return { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `session ${request.sessionId} not found` } }
    }
    const route = this.resolveRoute(session)
    if (route === undefined) {
      return { ok: false, error: { code: 'NO_MODEL_ROUTE', message: 'no model route is available; configure explainProvider and explainModel together, or select a model in this session' } }
    }
    const config = this.ctx.config
    return await explainTerm({
      route,
      config: {
        maxTokens: config.explainMaxTokens,
        maxSentences: config.explainMaxSentences,
        timeoutMs: config.explainTimeoutMs,
        termMaxChars: config.explainTermMaxChars,
        contextMaxBytes: config.explainContextMaxBytes,
      },
      stream: options => this.ctx.llm.stream(options),
      append: (event, payload, options) => session.append(event, payload, options),
    }, { term: request.term, context: request.context })
  }

  /** Explicit provider+model pair wins; otherwise the session's current selection. */
  private resolveRoute(session: { id: string }): { provider: string; model: string } | undefined {
    const { explainProvider, explainModel } = this.ctx.config
    if (explainProvider !== undefined && explainModel !== undefined) return { provider: explainProvider, model: explainModel }
    if (explainProvider !== undefined || explainModel !== undefined) return undefined
    const state = this.ctx.sessionProjections.stateOf(session, 'modelSelection')
    return state?.lastUsed
  }
```

`this.ctx.config` 替换为 constructor 注入的 config（同步骤 7 的注记）；`sessionProjections.stateOf` 的返回字段名以 `packages/api/session-controller/src/agent.ts:279` 用法实测为准。若 pair 半给（only one defined），补一条构造期响亮失败：`Config` 的 `validate` 或 init 期抛错（「misconfiguration fails loud」），不是静默降级——写进 init：

```ts
    const { explainProvider, explainModel } = this.config
    if ((explainProvider === undefined) !== (explainModel === undefined)) {
      throw new Error('terminology: explainProvider and explainModel must be configured together')
    }
```

- [ ] **步骤 4：remote 装配 + 事件 allowlist + 生成器**

1. `packages/api/remotes/src/client/index.ts`：`import terminologyRemote from '@deepseek-ai/dsh-client-ui-terminology/remote'`、`export type {} from '@deepseek-ai/dsh-client-ui-terminology/remote'`，加入 `:150` 的装配清单；`packages/api/remotes/package.json` 加依赖 `"@deepseek-ai/dsh-client-ui-terminology": "workspace:^"`。
2. `packages/api/remotes/src/remote-events.ts` 的 `API_REMOTE_FORWARDED_EVENTS` 按字母序加 `{ event: 'terminology/changed', mode: 'emit' }`。
3. 运行 `pnpm run build:lib:host` 触发 typert 生成，确认 `packages/client/ui-terminology/lib/typert.host.js` 与 `lib/typert.remote-client.js` 存在。
4. 运行 `pnpm run gen-persistence-catalog`，确认 `terminology/explain-request` 进目录。

- [ ] **步骤 5：跑 explain 测试与 SDK 期望输出**

运行：`npx vitest run packages/client/ui-terminology` → PASS。

`SessionEventMap` 新增成员要求两个 SDK 的期望输出同步（仓库硬规矩）：`grep -rn "title-llm-request" packages/sdk python/ | grep -v lib` 找到 fixture/expected 落点，按同形状加入 `terminology/explain-request`，并跑各自 SDK 的本地校验（TS：`npx vitest run packages/sdk`；Python：按其 README 的测试入口）。若某 SDK 的期望文件由生成器产出，用该生成器刷新而非手改。

- [ ] **步骤 6：typecheck + commit**

```bash
pnpm run typecheck
git add packages/llm packages/api/remotes packages/client/ui-terminology packages/sdk python
git commit -m "feat(ui-terminology): add the model-backed explain pipeline with its durable request record"
```

---

### 任务 5：浏览器半边（provider/同步/手动识别/浮层/卡片）

**文件：**
- 创建：`packages/client/ui-terminology/src/client/` 全部（见文件结构）
- 测试：`tests/resolver.client.spec.ts`、`tests/selection.client.spec.ts`、`tests/shortcut.client.spec.ts`、`tests/overlay.client.spec.tsx`、`tests/card.client.spec.tsx`

模板：`packages/client/ui-deliverables/src/client/`（locales.ts 形态、`ctx.locale.register(NS, { zh, en })`、`ctx.provide`）、`packages/client/ui-settings-plugins/src/client/index.ts`（卡片注册）、`packages/client/ui-chat/src/client/transcript-view.ts`（scope→store 政策类）。

- [ ] **步骤 1：编写失败的 resolver 测试**

`tests/resolver.client.spec.ts`（node 环境即可）：

```ts
import { describe, expect, it } from 'vitest'
import { createTerminologyResolver } from '../src/client/resolver.ts'
import type { GlossaryTerm } from '../src/types.ts'

const TERMS: readonly GlossaryTerm[] = [
  { term: 'Transformer 架构', explanation: 'arch' },
  { term: 'Transformer', explanation: 'one' },
  { term: '模型', explanation: 'model' },
]

describe('createTerminologyResolver', () => {
  it('splits the longest term first', () => {
    const out = createTerminologyResolver(TERMS, '术语 Transformer 架构 很关键', term => `术语 ${term}，查看解释`).split('解释 Transformer 架构 的原理')
    expect(out).toEqual([
      { kind: 'text', text: '解释 ' },
      { kind: 'annotation', text: 'Transformer 架构', label: '术语 Transformer 架构，查看解释', explanation: 'arch' },
      { kind: 'text', text: ' 的原理' },
    ])
  })
  it('concatenates back to the input exactly (provider-side identity)', () => {
    const resolver = createTerminologyResolver(TERMS, term => term)
    for (const run of ['无术语', 'Transformer', '模型和Transformer混排模型', '尾部模型']) {
      expect(resolver.split(run).map(s => s.text).join('')).toBe(run)
    }
  })
  it('marks every occurrence and never overlaps', () => {
    const out = createTerminologyResolver(TERMS, t => t).split('模型 模型 模型')
    expect(out.filter(s => s.kind === 'annotation')).toHaveLength(3)
  })
  it('matches case-sensitively', () => {
    const out = createTerminologyResolver(TERMS, t => t).split('transformer TRANSFORMER')
    expect(out.every(s => s.kind === 'text')).toBe(true)
  })
  it('returns a new instance only when the vocabulary changes', () => {
    const a = createTerminologyResolver(TERMS, t => t)
    expect(a).not.toBe(createTerminologyResolver(TERMS, t => t))
  })
})
```

最后一条断言的是调用方形态（新实例=新词表才重建），身份稳定规则写在 provider（步骤 6），测试在 `tests/apply.client.spec.ts` 里覆盖——见步骤 7。

- [ ] **步骤 2：实现 `src/client/resolver.ts`**

```ts
/**
 * Client-side vocabulary resolver: literal, case-sensitive, single-pass,
 * longest-term-first matching inside one authored text run. A term split by
 * markdown emphasis across nodes is out of scope by design.
 * @module src/client/resolver
 */
import type { GlossaryTerm } from '../types.ts'
import type { MarkdownAnnotations, MarkdownSegment } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Build a resolver for one vocabulary snapshot.
 * @param terms - Terms sorted longest-first (Host `mergeGlossary` order; the
 * resolver also re-sorts defensively against callers that pass raw layers).
 * @param label - Accessible-name builder; locale copy is owned by the caller.
 * @returns A fresh resolver identity — the provider calls this only when the
 * vocabulary changed, because settled renders memoize on this identity.
 */
export function createTerminologyResolver(
  terms: readonly GlossaryTerm[],
  label: (term: string) => string,
): MarkdownAnnotations {
  const sorted = [...terms].sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term))
  const byTerm = new Map(sorted.map(entry => [entry.term, entry]))
  const maxLen = sorted[0]?.term.length ?? 0
  return {
    split(value: string): readonly MarkdownSegment[] {
      if (maxLen === 0) return [{ kind: 'text', text: value }]
      const out: MarkdownSegment[] = []
      let plainFrom = 0
      let index = 0
      while (index < value.length) {
        let hit: GlossaryTerm | undefined
        const limit = Math.min(maxLen, value.length - index)
        for (let size = limit; size >= 1; size--) {
          const candidate = value.slice(index, index + size)
          const entry = byTerm.get(candidate)
          if (entry !== undefined) { hit = entry; break }
        }
        if (hit === undefined) { index += 1; continue }
        if (index > plainFrom) out.push({ kind: 'text', text: value.slice(plainFrom, index) })
        out.push({ kind: 'annotation', text: hit.term, label: label(hit.term), explanation: hit.explanation })
        index += hit.term.length
        plainFrom = index
      }
      if (plainFrom < value.length) out.push({ kind: 'text', text: value.slice(plainFrom) })
      return out.length === 0 ? [{ kind: 'text', text: value }] : out
    },
  }
}
```

- [ ] **步骤 3：`shortcut.ts` 与 `selection.ts`（纯函数，先测后写）**

`tests/shortcut.client.spec.ts`：`parseShortcut('Alt+Shift+E')` → `{ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, key: 'e' }`；`parseShortcut('Ctrl+K')`；非法串（`'E'` 无修饰键、`'Alt+'`、`'Alt+Shift+Ctrl+Meta+E'` 超四键、未知 token）返回 `undefined`；`matchesShortcut(parsed, { key: 'E', altKey: true, shiftKey: true }) === true`（大小写不敏感比较 `event.key.toLowerCase()`）。

`tests/selection.client.spec.ts`：`evaluateSelection` 的接管判断——折叠选区拒绝；纯空白拒绝；target 位于 `input`/`textarea`/`[contenteditable="true"]` 祖先内拒绝（`closest()` 检查）；长度超 `maxChars` 返回 `{ kind: 'too-long', text }`；正常返回 `{ kind: 'ok', text, context }`，`context` = `blockText(anchorNode)`（最近块级祖先 `parentElement?.closest('p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote') ?? parentElement` 的 `textContent`）。`src/client/shortcut.ts` 与 `src/client/selection.ts` 按上述契约实现（各 ≤60 行，导出 `parseShortcut`、`matchesShortcut`、`evaluateSelection`、`SelectionVerdict`）。

运行两个 spec → 先红后绿。

- [ ] **步骤 4：`locales.ts` 全量文案**

仿 `packages/client/ui-deliverables/src/client/locales.ts`：`export const NS = 'ui-terminology'`，`zh`/`en` 字典覆盖：`term.label`（`'术语 {term}，查看解释'` / `'Term {term}: show explanation'`）、`menu.explain`（`'解释「{term}」'`）、`panel.title`、`panel.loading`、`panel.add`（`'加入术语表'`）、`panel.close`、`panel.retry`、`panel.error.{NO_MODEL_ROUTE,LLM_FAILED,TIMEOUT,TERM_INVALID,CONTEXT_TOO_LARGE,GLOSSARY_INVALID,NO_WORKSPACE,SETTINGS_CONFLICT}`（每个失败种类一句可见中文/英文）、`panel.added`（Toast 文案）、`panel.layer.global`/`panel.layer.project` + `panel.layer.project.unavailable`、`card.title`、`card.enabled`、`card.shortcut`、`card.terms.*`（增删改各动作）、`card.project.title`、`card.project.open`、`card.project.error`、`card.project.readonly`。key 集与组件用法逐一对应（`verify-client-ui-i18n` 硬门槛），类型 `TerminologyKey = keyof typeof zh`。

- [ ] **步骤 5：overlay 政策类 + 组件**

`src/client/overlay-policy.ts`——导出 `class OverlayPolicy`，`readonly request: SnapshotStore<OverlayRequest | null>`（`createSnapshotStore<OverlayRequest | null>(null)`）+ `type OverlayRequest = { kind: 'menu'; term: string; rect: { left: number; top: number } } | { kind: 'panel'; term: string; rect: ...; stage: 'from-glossary' | 'loading' | 'shown' | 'failed'; explanation?: string; error?: TerminologyErrorCode }` + `openMenu/close/openPanel/setStage` 方法（全部 `store.update`）。注册时以 `hooks: { terminologyOverlay: policy.request }` 暴露。

`src/client/TerminologyOverlay.tsx`——root-scope 组件，props：`useTerminologyOverlay`（框架绑定）+ `t` + inject 面 `{ explain(term, context): Promise<...>; remember(term, explanation, layer): Promise<...>; glossaryHit(term): string | undefined; projectLayerAvailable: boolean }`。渲染：`menu` 态用 `ui-primitives` 的 `Menu`（`getAnchorRect` 返回存下的 rect；`items=[{ id:'explain', label: t('menu.explain', { term }) }]`；`onSelect` 切到 panel 态：先查 `glossaryHit`，命中直接 `shown`，否则 `loading` 并调 `explain`）；`panel` 态渲染 `role="dialog"` 浮层：一个 fixed 定位的 0×0 锚点 span + `useAnchoredPosition({ open, anchorRef, panelRef, gap: 8, margin: 8 })` 定位；`loading` 显示 `panel.loading`；`failed` 显示 `t(\`panel.error.${error}\`)` + `panel.retry` 按钮（重跑 explain）；`shown` 显示解释文本；底部「加入术语表」（默认 layer `'global'`；卡片提供切换，切换项在 `projectLayerAvailable === false` 时禁用并显示理由）+「关闭」；打开时 `useEffect` 聚焦 dialog，`onKeyDown` Esc 关闭，`useDismissOnOutsidePointer` 外点关闭。**断言可见性约束：tooltip 语义不在这出现（本浮层是 dialog）；浮层里绝不渲染任何下载/导出入口。**

`src/client/TerminologyOverlay.module.css`：dialog 卡面（`--dsw-specific-menu` 背景、`--dsw-elevation-prominent`、圆角 12、max-width 320、padding 12/16），按钮行右对齐。

- [ ] **步骤 6：设置卡片**

`src/client/TerminologyCard.tsx` + `.module.css`：props 为 inject 面 + `t`。inject 面由政策类提供：`hooks: { terminologyCard: cardPolicy.source }`（内容 `{ enabled, shortcut, globalTerms, projectPath, projectTerms, projectError }`）+ 回调 `{ setEnabled(boolean), setShortcut(string), addTerm(term, explanation), updateTerm(index, next), removeTerm(index), openProjectFile() }`——实现类 `card-policy.ts`：`ctx.settingsScope.bind<TerminologySettings>({ namespace: TERMINOLOGY_NAMESPACE })` 写侧（`set(field, value)`，冲突 rejection 显示为卡内可见错误条），读侧合并 `terminology/state` 的投影（同一 state store，步骤 7 建）。`openProjectFile` 调 `ctx.remote.session.openWorkspacePath({ path: state.projectPath })`（provider 闭包里做，卡片只拿回调——组件永远不见 ctx）。项目术语在卡片里只读列出 + `card.project.error` 可见错误条。

- [ ] **步骤 7：`src/client/index.ts` 装配**

```ts ignore-check
/** Browser half: annotation provider, glossary sync, manual lookup, settings card. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MarkdownAnnotations } from '@deepseek-ai/dsh-client-ui-primitives'
import { TERMINOLOGY_NAMESPACE } from '../spec.ts'
import type { TerminologyState } from '../types.ts'
import { en, NS, zh } from './locales.ts'
import { createTerminologyResolver } from './resolver.ts'
import { evaluateSelection } from './selection.ts'
import { parseShortcut, matchesShortcut } from './shortcut.ts'
import { OverlayPolicy } from './overlay-policy.ts'
import { TerminologyOverlay } from './TerminologyOverlay.tsx'
// ...card policy + card imports

export const inject = ['slots', 'locale', 'remote', 'remote.session', 'settingsScope', 'sessions']

/** Browser apply. @param ctx - client context with the declared services. */
export function apply(ctx: ReturnType<...> /* 本包 client 面的 Context 类型，同 ui-deliverables 写法：Context from '@deepseek-ai/cordis' */): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-terminology: dictionaries')
  const t = ctx.locale.bind(NS)

  const state = createSnapshotStore<TerminologyState | null>(null)
  let resolver: MarkdownAnnotations | undefined
  let resolverKey = ''
  function refreshResolver(): void {
    const snapshot = state.getSnapshot()
    if (snapshot === null || !snapshot.enabled) { resolver = undefined; resolverKey = ''; return }
    const key = vocabularyKey(snapshot)
    if (key === resolverKey) return
    resolverKey = key
    resolver = createTerminologyResolver(
      mergeVocabulary(snapshot),
      term => t('term.label', { term }),
    )
  }
  ctx.effect(() => state.subscribe(refreshResolver), 'ui-terminology:resolver-rebuild')
  ctx.provide('chatAnnotations', { annotations: () => resolver })
```

续写（同文件内）：

- **state 同步**：`const load = () => { for (const session of ctx.sessions.list.getSnapshot().ids) ... }` —— 实际形态：进入会话时与收到 `terminology/changed` 时重拉。写法照 `ui-commands/src/client/service.ts:96`：`ctx.effect(() => ctx.remote.$on('terminology/changed', () => { void refetch() }), ...)`；`refetch` 以当前活动会话（`ctx.sessions` 的当前绑定，取 `activeSessionId()` 若无则对每个已知会话 last-write-wins）调 `ctx.remote.terminology.state({ sessionId })` 并 `state.update(() => result.ok ? result.value : state.getSnapshot())`。会话集合变化同理订阅 `ctx.sessions.list`。
- **手动识别**：`ctx.effect(() => { ...document.addEventListener('contextmenu', onContextMenu, true); document.addEventListener('keydown', onKeyDown); return () => { ...removeEventListener... } }, 'ui-terminology:selection')` —— `onContextMenu/onKeyDown` 内先 `evaluateSelection`（输入框/超长/空 → 放行或弹可见拒绝），命中则 `event.preventDefault()` 并 `overlay.openMenu({ term: verdict.text, rect: selectionRangeRect() })`；`onKeyDown` 用 `parseShortcut(settings().shortcut)` 结果匹配。`settings()` 从 `state` snapshot 读 `enabled/shortcut`。
- **overlay 注册**：`ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'terminology-overlay', hooks: { terminologyOverlay: overlay.request }, inject: () => overlayInject() }, TerminologyOverlay)), 'ui-terminology:overlay')`（`ctx.slots.inject` 等待声明的规则见 `packages/client/AGENTS.md` 第 4 条）。
- **卡片注册**：

```ts
  ctx.effect(() => ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: TERMINOLOGY_NAMESPACE,
    locale: NS,
    hooks: { terminologyCard: card.source },
    inject: () => card.inject(),
  }, TerminologyCard)), 'ui-terminology:card')
```

- **overlayInject**：`glossaryHit` 从 state snapshot 双层查找；`explain/remember` 包 `ctx.remote.terminology.explain/remember`（失败返回 error code 给 policy 置 `failed` 态，`remember` 成功后额外 `ctx.toast`——Toast 用法照 `ui-primitives` 的 `Toast` 既有调用点，`grep -rn "Toast" packages/client/ui-settings-plugins/src` 选实际服务面）并把面板置 `shown`；`projectLayerAvailable = state?.projectError == null`。

`vocabularyKey(snapshot)`：`[...project, ...global].map(e => \`${e.term} ${e.explanation}\`).join('\n')`——词表逐字相同则身份不重建（身份稳定即测试点）。

- [ ] **步骤 8：`files` 与 client tsconfig 对齐**

`tsconfig.client.json` 的 `files` 补齐全部 `.tsx/.ts` client 文件；`package.json` `files` 已覆盖 `lib/client.js`；运行 `pnpm --filter @deepseek-ai/dsh-client-ui-terminology bundle` 确认 `lib/client.js` 产出、无未声明 workspace value import（`ui-primitives`、`client/store` 是基线免声明；`remote`/`settingsScope`/`locale` 走 services 注入，不是模块请求）。

- [ ] **步骤 9：组件行为测试**

`tests/overlay.client.spec.tsx`（jsdom）：直接喂 `TerminologyOverlay` props（`create`-less：store 用 `createSnapshotStore(request)` 造，hooks 以 `useStore`-替代——按框架实际 hook 形态写桩：直接传 `(callback) => { callback(current); return () => {} }` 形状的 hook 函数需与 ui-slots hook 类型一致，执行时以 `PropsRuntime` 定义为准调整桩类型，**不改组件签名**）。断言：`menu` 态渲染出含「解释「Transformer」」的条目且无「加入术语表」；选择条目后 `glossaryHit` 命中路径直接 `shown`、未命中路径经历 `loading`→`shown`；`explain` reject 时出现错误文案 + `panel.retry` 按钮且点重试再次调用 `explain`；dialog 有 `role="dialog"`；Esc 关闭；「加入术语表」默认调 `remember(layer:'global')`；`projectLayerAvailable=false` 时 project 选项禁用并可见理由。

`tests/card.client.spec.tsx`：开关切换调用 `setEnabled`；新增/编辑/删除词条调用对应回调且值修剪；`projectError` 时渲染错误条；项目术语只读（无输入框渲染在项目区）。

运行：`npx vitest run packages/client/ui-terminology` → 全绿（含新 spec）。

- [ ] **步骤 10：typecheck + GUI lane + commit**

```bash
pnpm run typecheck
pnpm run test:gui
git add packages/client/ui-terminology
git commit -m "feat(ui-terminology): add the browser annotation provider, manual lookup panel, and settings card"
```

---

### 任务 6：组装验证（REAL-composition + 触屏 e2e + 快照）

**文件：**
- 创建：`packages/client/ui-terminology/tests/annotations-composition.host.spec.ts`
- 创建：`apps/web/tests/terminology-inline.e2e.ts`、`apps/web/tests/terminology-inline.overlay.yml`、`apps/web/tests/expected/terminology-inline/`
- 更新：TypeScript/Python SDK 期望输出（若任务 4 步骤 5 未竟）。

- [ ] **步骤 1：REAL-composition 测试（仓库强制，不许手搭 `ctx.plugin`）**

创建 `tests/annotations-composition.host.spec.ts`，结构逐段照抄 `packages/feedback/message-feedback/tests/loader-composition.spec.ts`（Loader + `cordis:include` + modules map；把 `terminology` 行、`settings`（内存 provider 或 file provider + tmpdir）、stub `llm` provider 写进 test-only cordis.yml 字符串），断言经服务面而非构造器：

- `state`：tmpdir 会话 workspace 下写 `.dsh/terminology.yml`，settings 文档写全局层，断言返回两层与合并路径、`projectError` 非法时为字符串；
- `explain`：stub llm 固定吐文本，断言返回文本 + **会话日志里存在 `terminology/explain-request` 事件**（`session.snapshotEvents()`），其 payload 的 `system`/`messages` 含 term，事件类型经 `gen-persistence-catalog` 进入目录（断言目录含该类型）；
- `remember` → 发出 `terminology/changed`（监听后 await）。
- HMR 规矩：dispose fiber 后 remote 方法不可再达、watcher 关闭（对 tmpdir 文件再改动不再触发事件）。

运行：`npx vitest run packages/client/ui-terminology/tests/annotations-composition.host.spec.ts` → PASS。

- [ ] **步骤 2：浏览器 e2e（触屏为主证据）**

创建 `apps/web/tests/terminology-inline.overlay.yml`：在 web-app profile overlay 的 `ui-terminology` 行给 `config: { enabled: true }` 且不配置 `explainProvider`/`explainModel`——无模型路由时手动解释返回 `NO_MODEL_ROUTE`，e2e 因此只断言术语表命中路径，不触达真实模型。

创建 `terminology-inline.e2e.ts`，骨架逐段照 `clickable-links-gallery.e2e.ts`（`launchWebScaffold`、`seedSession`、`newEnglishPage`、`captureStableAria`、`compareOrRefreshGolden`、`watchConsole`）：

```ts
const context = await browser.newContext({ hasTouch: true, viewport: { width: 1280, height: 900 } })
```

fixture 一轮 settled 助手文本包含 `Transformer` 与 `模型` 两个词条（seed 前把项目 glossary yml 写进 scaffold 的 workspace tmpdir）。断言：

- `page.tap` 命中 `Transformer` 后出现 `role=tooltip`（`page.getByRole('tooltip')` 可见），解释文本正确；
- 触发体 `page.getByRole('button', { name: /Transformer/ })` 在 a11y 树里 role 是 button；
- tooltip 内 `getByRole('button')` 计数为 0（信息不藏在 tooltip 里）；
- 下划线线索不依赖 hover：`page.getByRole('button', { name: /Transformer/ })` 的 `text-decoration-line` 计算值为 `underline` 且 `text-decoration-style` 为 `dotted`（不先 hover）；
- Esc 关闭后 tooltip 消失；
- `captureStableAria` 产出 golden 存 `expected/terminology-inline/ui.expected.md`。

运行：`pnpm run build && DSH_SNAPSHOT=replay npx vitest run apps/web/tests/terminology-inline.e2e.ts --config vitest.web.config.ts`（首跑 `record` 生成 golden，复核输出后把 golden 连同 spec 一起提交；此后一律 `replay`）。

- [ ] **步骤 3：全量组装回归**

运行：`DSH_SNAPSHOT=replay pnpm run test:web` → PASS（新行不改既有 goldens；若 conversation 可见输出因装配变化，先确认为预期再 `refresh` 并在 PR 描述说明）。

- [ ] **步骤 4：commit**

```bash
git add packages/client/ui-terminology/tests apps/web/tests
git commit -m "test(ui-terminology): cover the assembled feature through the loader and a touch browser scenario"
```

---

### 任务 7：文档收口（README 终审、子系统文档、Agent Note）

**文件：**
- 终审：`packages/client/ui-terminology/README.md`、`README.zh.md`
- 修改：`docs/subsystems/slots.md`/`slots.zh.md`（如该页收录 Chat 消费的可选项——收录标准以该页现状为准，若它只列 slot 不列 service，则改在 `docs/subsystems/conversation.md(.zh.md)` 加一段）
- 创建：`.agents/notes/implemented/feature/2026-09-16-web-inline-terminology.md` + `.zh.md`

- [ ] **步骤 1：README 终审**

对照实现校验 README 每个事实（配置字段名、注册行、快捷键默认值、事件名）；确认 `Model Experience` 写明：自动标注零模型参与；每次手动解释=一次 `purpose: 'terminology'` 旁路调用并逐条记入 `terminology/explain-request`；`Known Limitations` 含四条已知限制 + 「无导出；将来加导出时格式选择必须是卡片级显式控件」约束。跑 `pnpm run doc-sync` 中与 README 相关的门（`verify-package-readme-limitations`、pairing）。

- [ ] **步骤 2：子系统文档**

若 `docs/subsystems/conversation.md` 记 Chat 消费的可选项（`chatFileMentions` 的先例位置），平行加 `chatAnnotations` 一段（一段=一物理行）；同 PR 更新 `conversation.zh.md`。跑 `pnpm run doc-sync`。

- [ ] **步骤 3：Agent Note 双语对**

创建 `.agents/notes/implemented/feature/2026-09-16-web-inline-terminology.md`/`.zh.md`：记录三个决策及其被否备选——(1) 核心接缝 vs 接管 `conversation.chat.node`（≈300 行 fork）/复制进插件（≈4,238 行，实测闭包）/`shell.overlay` 降级版；(2) 术语表全局层放设置文档（白拿修订栅栏/变更事件/卡片读写）vs 独立 yml；(3) tooltip 内容极简约束的来源诉求。链接 spec。按 `.agents/notes/README.md` 的归档/形态规则命名落位。

- [ ] **步骤 4：记录配对 + 全量文档门 + commit**

```bash
pnpm run verify-translation-pairing --write packages/client/ui-terminology/README.md docs/subsystems/conversation .agents/notes/implemented/feature/2026-09-16-web-inline-terminology
pnpm run doc-sync
git add packages/client/ui-terminology/README.md packages/client/ui-terminology/README.zh.md docs/subsystems .agents/notes
git commit -m "docs(ui-terminology): document the terminology feature and record its decisions"
```

注意：`docs/subsystems/slots` 若实际未被改动就不要把它的 anchor 传进 `--write`；`verify-translation-pairing` 只对实际存在的三件套写记录。已知 red（`docs/superpowers/plans/2026-09-08-task-protocol-p1.md` 与 `docs/superpowers/specs/2026-09-08-task-protocol-p1-design.md` 的 wrap/links/pairing 旧账）不属于本计划，不修不忽略，写入交接说明。

---

## 自检记录（作者自查，非执行步骤）

- 规格覆盖度：spec §4（任务 1、2）、§5（任务 3 步骤 1-3、任务 4 步骤 4）、§6.1/6.2/6.3（任务 3）、§6.4/6.5（任务 4）、§7.1-7.5（任务 5）、§8 四约束（任务 1 组件测试 + 任务 5 断言 + README 约束 + e2e tooltip 零按钮）、§9 每行（任务 1/2/3/4/5/6 对应步骤）、§10 PR 拆分（任务即 PR，注册面按「每任务可独立绿」重排并在头部声明）。
- 占位符扫描：所有代码步骤含可编译代码；对无法在计划期钉死的仓库 API（`writeFileAtomic` options、`append` 形态、`stateOf.lastUsed`、hook 桩类型）已写明"以某文件实测为准"的核对步骤，属执行期的一次读文件动作，不是待定设计。
- 类型一致性：`MarkdownAnnotations/MarkdownSegment/AnnotatedTerm`（任务 1 定义，任务 2/5 引用）；`ChatAnnotations.annotations()`（任务 2 定义，任务 5 provide）；`GlossaryTerm/TerminologyState/TerminologyResult`（任务 3 定义，任务 4/5 引用）；`TERMINOLOGY_NAMESPACE`（任务 3 spec.ts，任务 5 卡片 key）；remote 方法名 `state/explain/remember` 与客户端 `ctx.remote.terminology.*` 调用一致。
