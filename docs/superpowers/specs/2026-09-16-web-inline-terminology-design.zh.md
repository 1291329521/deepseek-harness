# Web 正文术语识别（Inline Terminology）设计规格

[English](2026-09-16-web-inline-terminology-design.md) | 中文

- 日期：2026-09-16
- 状态：待用户终审
- 范围：Web 客户端问答正文里的术语自动识别与手动识别。不改会话协议、不新增模型工具。
- 前置阅读：[docs/subsystems/slots.zh.md](../../subsystems/slots.zh.md)、[docs/subsystems/web-client.zh.md](../../subsystems/web-client.zh.md)、[docs/web-styling.zh.md](../../web-styling.zh.md)、先例 [2026-08-07-web-inline-file-mentions](../../../.agents/notes/implemented/feature/2026-08-07-web-inline-file-mentions.zh.md)、模板包 `packages/client/file-upload`（client 包 + Host 半边 + typert remote 双半边布局）

## 1. 背景与目标

### 1.1 痛点

助手回答里出现的项目黑话、内部代号、领域术语，对不熟悉上下文的读者是黑盒。读者想知道"这个词在这里指什么"，唯一的手段是选中它去搜索引擎或者问模型，而这一步会污染会话、丢失上下文。

### 1.2 一句话定位

**给 DSH Web 客户端的问答正文装一层术语层：术语表里命中的词在正文里直接变成可点击、可聚焦的链接，悬停/聚焦/点击弹出解释；术语表没命中的词，用户选中后右键或按快捷键，就地调模型解释，并可以一键收进术语表。**

### 1.3 三条设计原则

1. **渲染器不拥有词表。** 正文渲染器只负责"标注片段怎么表现"，"哪些片段是术语"由提供方用自己的词汇表决定。这条完全照抄 `MarkdownFileMentions` 的既有分工，也是本功能不会产生"点了没解释"的死链接的原因：只有确实有解释的词才会变成链接。
2. **Web 层是纯表现层。** 术语表、命中结果、悬停状态都不进会话日志。唯一的例外是"调模型解释"这一步 —— 它是一次真实模型请求，按仓库的"模型可见 ⟺ 已记录"规矩必须可重建（见 6.5）。
3. **信息不藏在悬停里。** tooltip 内只有解释文本，不放任何交互控件、错误信息或下载入口；任何失败都以可见、可聚焦的界面呈现（见第 8 节）。

## 2. 范围边界

### 2.1 做什么

- 助手回答的 Markdown 正文（含标题、列表、表格单元格、引用块里的纯文本）中命中术语表的词，变成可点击的术语链接。
- 术语链接：鼠标悬停、键盘聚焦、点击（触屏 tap）都能打开解释气泡；移开、失焦、Esc、点击外部关闭。
- 手动识别：用户选中正文里的文字后，右键菜单或可配置快捷键触发解释浮层；浮层里可把该词写回术语表。
- 两层术语表：全局层（个人词库，存设置文档）优先度低于项目层（团队词库，存仓库文件）。
- 设置卡片：总开关、快捷键、全局术语增删改、项目术语只读列表与文件入口。

### 2.2 明确不做

- **不覆盖用户自己发的提问。** 用户消息不走 Markdown 渲染，走 `projectUserText` 这个纯函数（`packages/client/ui-primitives/src/user-text.tsx`），给它加标注会动到 `@` / `/` 引用匹配那套很细的语义。本期只覆盖助手回答。
- **不让模型自己标注术语。** 不注册 system-prompt 段落、不引入标记语法。词表是唯一词汇来源，`explain` 只在用户手动触发时发生。
- **不改会话事件流、不新增模型工具、不改 agent-loop。**
- **不做 DOM hack。** 不用 MutationObserver、不 append 到 `document.body`、不改宿主 DOM。
- **不内置下载/导出。** 本期没有任何导出功能；见第 8 节关于"以后要加也不许藏"的约束。

### 2.3 与相邻能力的分工

| 能力 | 管辖范围 |
|---|---|
| `ui-deliverables` / `chatFileMentions` | inline code 里的**已产出文件**路径 → 打开文件 |
| **本功能** | 正文纯文本里的**术语** → 弹出解释 |
| `session-reference` / `file-reference` | 输入侧的 `@` 引用补全 |
| `ui-message-feedback` | 消息级评价（remote + 独立 UI 包的结构先例） |

两条正文接缝互不重叠：`MarkdownFileMentions` 只处理 `inlineCode` 节点，本接缝只处理 `text` 节点。

## 3. 架构总览

三层，从下到上：

```
Layer 1 — core seam (changes this project's own source)
  ui-primitives : MarkdownAnnotations contract + AnnotatedTerm element
  ui-chat       : optional chatAnnotations service → forwards to MarkdownText

Layer 2 — Host half (new package src/)
  two-layer glossary / settings namespace / LLM explain / typert remote / change event

Layer 3 — browser half (new package src/client/)
  annotation provider / glossary sync / selection + keyboard listeners / explain panel / settings card
```

数据流：

```
glossary files + settings document
        │  Host reads, merges, watches
        ▼
  terminology/state (remote)          terminology/changed (forwarded event)
        │                                      │
        └──────────────┬───────────────────────┘
                       ▼
        client snapshot store (vocabulary)
                       │  rebuild resolver instance (identity change rerenders)
                       ▼
   ctx.provide('chatAnnotations')  ──ctx.get──▶  ui-chat
                       │                              │
                       │                              ▼
                       │                    MarkdownAnnotations.split(text)
                       │                              │
                       ▼                              ▼
              selection → menu/shortcut ──▶ explain panel   AnnotatedTerm (button + tooltip)
                       │
                       └──▶ terminology/explain (remote) ──▶ ctx.llm.stream
```

## 4. 核心接缝规格（改本项目自身源码）

### 4.1 接缝契约

在 `packages/client/ui-primitives/src/markdown/render.tsx` 的 `MarkdownFileMentions` 旁新增：

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

**前置条件（提供方必须履行，渲染器不做运行时校验）**：`split(value)` 各段的 `text` 顺序拼接必须**恰好等于** `value`。仓库规矩「Trust TypeScript at typed same-process boundaries」禁止为静态接口已保证的值加运行时校验，所以这条不变式靠 JSDoc 声明 + 提供方侧的测试守住。违反它会让正文被改写或丢失，因此提供方必须有一个属性测试断言拼接恒等。

### 4.2 渲染器改动

`MarkdownRenderContext` 增加字段：

```ts
/** Prose annotations; absent when no vocabulary is mounted or while streaming. */
readonly annotations: MarkdownAnnotations | undefined
```

`case 'text'`（当前第 217–218 行直接返回字符串）改为分流：

- `context.annotations === undefined` → **原样返回字符串**。这是 DOM 逐字节不变约束（`tests/fixtures/markdown-dom`）不受影响的原因：不装词表时渲染产物与改动前完全一致。
- 否则调用 `renderAnnotatedText(node.value, key, context)`，把每个 segment 映射成 React 节点；annotation 段渲染成 `<AnnotatedTerm>`。
- `context.inLink === true` 时**不调用** `split`。`<button>` 不能嵌在 `<a>` 里，与 `fileMentions` 同一条规则（`render.tsx:256`）。

### 4.3 AnnotatedTerm 元素与可访问性

新文件 `packages/client/ui-primitives/src/markdown/AnnotatedTerm.tsx` + `AnnotatedTerm.module.css`。触发体的形态照抄既有 fileMention 按钮（`render.tsx:258-271`）。

| 事件 | 行为 |
|---|---|
| 鼠标进入 | 延迟 150 毫秒打开（固定交互常量，避免划过正文时闪烁） |
| 键盘聚焦 | 立即打开 |
| 点击 / 触屏 tap | 打开；已打开则关闭 |
| 鼠标离开 | 指针不在气泡内则关闭；进入气泡保持打开（复用 `pointer-grace.ts`） |
| 失焦 | 关闭 |
| Esc | 关闭 |
| 气泡外 pointerdown | 关闭（复用 `useDismissOnOutsidePointer.ts`） |

可访问性契约：

- 触发体是 `<button type="button">`，在无障碍树里就是一个 button —— 这是触屏与读屏用户"仍能识别按钮作用"的机制本身，不依赖任何 hover 视觉线索。
- 可访问名来自提供方的 `label`（如「术语 Transformer，查看解释」），因为 `ui-primitives` 是无 cordis 的通用原语，**不拥有任何产品文案**。
- 打开时触发体 `aria-describedby` 指向气泡；气泡 `role="tooltip"`（WAI-ARIA tooltip 模式），用 `useId()` 生成稳定 id。
- **未聚焦时的可见性也不能只靠 hover**：默认态就有虚线下划线，`cursor: help`。
- 气泡内不含任何可交互元素。
- 满足 WCAG 1.4.13 三条：可 dismiss（Esc）、可 hover（指针可移入）、可持久（不自动消失）。

颜色与排版只用 `--dsw-*` 语义别名，遵循 [docs/web-styling.zh.md](../../web-styling.zh.md)。

### 4.4 MarkdownText 与 ui-chat 的转发

`MarkdownText` 增加可选 prop `annotations?: MarkdownAnnotations | undefined`：

- 只参与**已定稿**渲染。`StreamingRenderer` 构造的两个 context 保持 `annotations: undefined`，与现有 `fileMentions: undefined`（`MarkdownText.tsx:108`、`:126`）完全一致。理由是流式缓存会把 handler 烤进冻结的 React 元素，而词表在正文还在增长时并非定稿。
- 加进 `useMemo` 依赖数组。**新解析器身份会丢弃已定稿消息的缓存解析**，所以提供方必须在词表不变时保持身份稳定（见 7.1）。

`packages/client/ui-chat/src/client/contract/slots.ts` 新增（与 `ChatFileMentions` 并列）：

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

它比 `ChatFileMentions` 简单，是因为 `fileMentions` 的词表是"这一轮产出的文件"所以需要 owner 参数，而术语表是全局的、与轮次无关。

转发链路与 `fileMentions` 逐层对称：`apply.ts` 里 `annotations: () => ctx.get('chatAnnotations')?.annotations()` → `ChatViewInjected` → `ChatView` → `ChatNodeSeat` → `AssistantNodeView`（用 `useMemo(() => annotations(), [annotations])` 取一次，模式同 `AssistantNodeView.tsx:20-23`）→ `AssistantMarkdown` → `MarkdownText`。

**服务的缺席就是功能关**：不装 ui-terminology 时 `ctx.get` 返回 `undefined`，解析器为 `undefined`，渲染器走原样字符串路径，零成本。

### 4.5 核心文件改动清单

| 文件 | 改动 |
|---|---|
| `packages/client/ui-primitives/src/markdown/render.tsx` | 新增两个类型、context 字段、`case 'text'` 分流、`renderAnnotatedText` |
| `packages/client/ui-primitives/src/markdown/AnnotatedTerm.tsx` | 新增 |
| `packages/client/ui-primitives/src/markdown/AnnotatedTerm.module.css` | 新增 |
| `packages/client/ui-primitives/src/markdown/MarkdownText.tsx` | 新 prop、透传、依赖数组 |
| `packages/client/ui-primitives/src/index.ts` | 导出新类型与新组件 |
| `packages/client/ui-chat/src/client/contract/slots.ts` | `ChatAnnotations`、Context 声明、两个 props 字段 |
| `packages/client/ui-chat/src/client/apply.ts` | `annotations` 注入项 |
| `packages/client/ui-chat/src/client/chat/ChatView.tsx` | 透传 |
| `packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx` | 透传 |
| `packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx` | 取解析器 |
| `packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx` | 透传给 `MarkdownText` |

### 4.6 LLM 旁路调用的分类

`GenerateOptions.purpose` 是封闭联合 `'compaction' | 'session-title'`（`packages/llm/llm/src/types.ts:442`），另有一份镜像声明在 `packages/llm/deepseek-llm-api-extensions/src/types.ts:25`。本功能新增成员 `'terminology'`，两处同步。

理由是必要的而非装饰性的：解释调用是**用户界面触发的旁路模型请求**，不归属任何 turn/step。不声明 purpose 时，适配器与遥测无法把它和 agent 的正常调用区分开。两处消费点都是等值判断（`llm-deepseek/src/adapter.ts:540`、`llm-deepseek/src/serialize.ts:84`），没有穷尽 switch，加成员不会破坏它们。

`serialize.ts` 是否对 `'terminology'` 关闭 thinking 由实现阶段按实测延迟决定，本规格不预先规定。

## 5. 包布局与注册面

### 5.1 包结构

一个新包、两个半边，模板是 `packages/client/file-upload`（client 命名的包 + Host 半边 + typert remote + host/client 双 tsconfig 面）：

```
packages/client/ui-terminology/                     @deepseek-ai/dsh-client-ui-terminology
  package.json          exports: . / ./client / ./types / ./typert / ./remote / ./src/* / ./package.json
                        dsh.client: { platform: 'web', inject: [...] }
  tsconfig.json         solution-only root
  tsconfig.host.json    Host compiler face
  tsconfig.client.json  Client compiler face
  tsdown.config.ts      clientBundle(...)
  src/index.ts          Host-half apply
  src/types.ts          types only: remote contract and glossary types
  src/spec.ts           zod schemas (settings fields, project file, session event)
  src/client/index.ts   browser-half apply
  src/client/…          provider, panel, menu, card, locale
  README.md / README.zh.md
```

### 5.2 注册面清单

少任何一条都会在更晚的地方失败，且失败点各不相同：

1. `tsconfig.client.json` 聚合的 `references` 条目。
2. `packages/bundle/web-app/cordis.patch.yml` 的一行 `dsh.client` row。
3. `packages/bundle/web-app/package.json` 的依赖项（profile 启动通过 `$DSH_HOME/profiles/node_modules` 回退解析裸行名，没有任何 manifest 声明的行会 import 失败）。
4. `packages/api/remotes/src/client/index.ts` 的 remote 装配 import 与 `type {}` 声明，及其 `package.json` 依赖。
5. `packages/api/remotes/src/remote-events.ts` 的转发事件 allowlist 条目。
6. typert 生成器跑一遍，产出 `lib/typert.host.*` 与 `lib/typert.remote-client.*`。
7. `gen-persistence-catalog` 生成器（`terminology/explain-request` 是新的 `SessionEventMap` 成员）。

## 6. Host 半边规格

### 6.1 术语表两层

| 层 | 存储 | 优先级 | 维护方式 |
|---|---|---|---|
| 项目层 | `<cwd>/.dsh/terminology.yml` | 高（同名词以项目层为准） | 随仓库提交、团队共享 |
| 全局层 | 设置 namespace `terminology` 的 `terms` 字段 | 低 | 个人词库，设置卡片编辑 |

项目层是为"可提交、可 review 的团队资产"存在的，所以必须是工作区内的文件而不是设置文档。全局层放设置文档，是为了白拿修订号栅栏、变更事件、可编辑文档路径与卡片读写 —— 自己再手搓一份 yml 读写加监听是重复造轮子，撞仓库「优先用维护中的依赖而非手搓」。

项目文件的读写走 `node:fs/promises` 加 `@deepseek-ai/dsh-atomic-write`（与 `packages/settings/settings-file` 同款），并用 `node:fs.watch` 去抖监听外部改动。文件缺失是正常态，不是错误。文件格式非法时**响亮失败**：设置卡片里显示该项目的解析错误，且项目层整体作废（回退到只用全局层），绝不静默跳过。

合并规则：按术语做大小写敏感的字面匹配；同名词项目层覆盖全局层。匹配在**单个 text 节点内**进行（跨节点的词，例如被 `**加粗**` 从中间劈开的词，本期不识别）。

### 6.2 设置 namespace

namespace 名 `terminology`。`Config`（cordis.yml）提供部署默认值并经 `base` 作为组合层，用户文档层覆盖其上：

```ts
export interface GlossaryTerm {
  readonly term: string
  readonly explanation: string
}

export interface Config {
  readonly enabled: boolean
  readonly terms: readonly GlossaryTerm[]
  readonly explainShortcut: string
  readonly projectGlossaryPath: string
  readonly explainProvider?: string
  readonly explainModel?: string
  readonly explainMaxTokens: number
  readonly explainMaxSentences: number
  readonly explainTimeoutMs: number
  readonly explainTermMaxChars: number
  readonly explainContextMaxBytes: number
}
```

全部是 schema 字段，没有硬编码的可调常量（仓库硬规矩：任何跨部署可能不同的值都进配置）。`explainShortcut` 需要 `validate` 拒绝无法解析的组合键；`projectGlossaryPath` 必须是相对工作区的路径，绝对路径与逃逸路径在写入时被拒绝。

### 6.3 typert remote，namespace `terminology`

沿用 `packages/feedback/message-feedback` 的形态：`class TerminologyService extends TypertRemoteService` + `@Remote(...)`，失败用类型化结果（`{ ok: true, value } | { ok: false, error }`）而不是抛异常。

| 方法 | 请求 | 成功值 | 失败种类 |
|---|---|---|---|
| `state` | `{ sessionId }` | `{ enabled, shortcut, projectPath, projectTerms, globalTerms }` | `SESSION_NOT_FOUND`、`GLOSSARY_INVALID` |
| `explain` | `{ sessionId, term, context }` | `{ explanation }` | `TERM_INVALID`、`CONTEXT_TOO_LARGE`、`NO_MODEL_ROUTE`、`LLM_FAILED`、`TIMEOUT` |
| `remember` | `{ sessionId, term, explanation, layer }` | `{}` | `TERM_INVALID`、`GLOSSARY_WRITE_FAILED`、`NO_WORKSPACE` |

客户端一次 `state` 拿全所需数据，避免多次往返与竞态。

**转发事件** `terminology/changed`（`{ sessionId }` 或全局载荷）：项目文件被外部改动、设置被写入、`remember` 成功时由 Host 发出；客户端收到即重拉 `state`。走 `API_REMOTE_FORWARDED_EVENTS` 的既有转发机制，事件签名在包的 `./types` 导出里声明。

### 6.4 LLM 解释管线

形态照抄 `packages/session/session-title-llm/src/index.ts`：

- **路由解析**：优先用 `explainProvider` + `explainModel`（两者必须同时给）；否则读该会话当前选中的模型路由 —— 通过 `ctx.sessionProjections.stateOf(session, 'modelSelection')` 的 `lastUsed`（先例：`packages/api/session-controller/src/agent.ts:279`）。两者都拿不到就返回 `NO_MODEL_ROUTE`，**不静默退回默认模型**。
- **输入**：system 是固定指令（要求"只输出纯文本、不含 Markdown、直接给解释、用提问者的语言、不超过 `explainMaxSentences` 句"），user 消息是 `{ term, context }` 的 JSON 框架 —— 照抄 `frameMessages` 的做法，让用户文本无法破坏结构分隔符。
- **边界**：`explainMaxTokens`、`explainMaxSentences`、`explainTimeoutMs`、`explainTermMaxChars`、`explainContextMaxBytes` 全部来自配置；每次调用带独立 deadline（用 `deadline()` 工具，与 session-title 同款）。
- **输出**：只取 text 块，拒绝 tool-call 块；空结果算失败。
- **模型可见面写作规则**：prompt 与错误诊断只含任务相关概念（术语、上下文、语言），不出现 UI、传输或实现词汇。

### 6.5 会话事件

按仓库规矩「模型可见 ⟺ 已记录」，`explain` 的模型请求必须能从会话日志重建。通过 declaration merging 往 `SessionEventMap` 加一个成员：

```
'terminology/explain-request'
```

载荷携带框架输入：`{ term, context, system, messages, route, maxTokens }`。追加采用与 `session/title-llm-request` 相同的二参 log-only 形态：类型经 `gen-persistence-catalog` 进入 KNOWN 目录后当前构建读取无碍；不认识该类型的更早构建拒读该日志，与该先例已接受的姿态一致。事件类型与载荷 schema 由本包拥有，声明在 `packages/client/ui-terminology/src/types.ts`，并由 `gen-persistence-catalog` 生成/校验目录。

术语表本身、命中结果、浮层状态**不进日志**（第 1.3 节原则二）。

## 7. 客户端半边规格

### 7.1 标注提供方

`apply` 里 `ctx.provide('chatAnnotations', { annotations })`。`annotations()` 返回当前解析器，或功能关闭时返回 `undefined`。

**身份稳定性是契约的一部分**：解析器实例只在词表真的变化时重建。`MarkdownText` 的已定稿渲染按 props 身份 memo，每次渲染返回新实例会让整段正文每帧重新解析。

解析器内部：把术语表按长度降序预排序（保证"长词优先"，例如同时有 `Transformer` 和 `Transformer 架构` 时取长的），对每个 text 节点做单遍扫描切分。关闭状态下返回 `undefined`，渲染器走原样字符串路径。

### 7.2 术语表同步

- `apply` 启动时、会话切换时拉 `ctx.remote.terminology.state(sessionId)`。
- 收到转发的 `terminology/changed` 重拉。
- 结果写进 `createSnapshotStore()`（`@deepseek-ai/dsh-client-store`，已在 `PLATFORM_MODULES` 基线里）。
- 词表快照变化 → 重建解析器实例。
- 这是纯展示状态，**不进会话日志**。

### 7.3 手动识别

**选区监听**：在 `apply` 里用 `ctx.effect()` 挂 `document` 上的 `contextmenu`（capture）与 `keydown` 监听，卸载时自动拆（注册即 effect，不手写 `removeEventListener`）。

接管条件（任一不满足就放行原生行为）：

- `window.getSelection()` 非折叠且去空白后非空；
- 选区祖先**不在** `input` / `textarea` / `[contenteditable]` 内 —— 不抢输入框自己的右键与快捷键；
- 选中文本长度不超过 `explainTermMaxChars`（超长时浮层直接给可见的拒绝理由，而不是静默不弹）。

触发时记录 `{ text, rect, context }`，然后 `preventDefault()`。`context` 取选区最近块级祖先的文本，按配置上限截断。这是本设计里唯一直接读 DOM 的地方：只读、不改宿主 DOM、不用 MutationObserver，且用 `window.getSelection()` 是仓库既有做法（`ui-conversation/src/client/skeleton/InputBar.tsx:159`、`ui-primitives/src/HoverCard.tsx:149`）。

**右键菜单**：用 `ui-primitives` 的 `Menu` 原语锚在指针位置，注册进 `shell.overlay`。**只有一个条目**：「解释「xxx」」。这里不提供"加入术语表" —— 用户还没看到解释，不应该先被问要不要存。

**快捷键**：`explainShortcut` 配置字段，默认 `Alt+Shift+E`，同一套选区规则。

### 7.4 解释浮层

注册进 `shell.overlay`（list 槽，纯追加，不碰任何原生区域），用 `useAnchoredPosition` 锚定选区矩形。

**它是 `role="dialog"` 而不是 tooltip**：浮层内有可交互控件（加入术语表、重试、关闭），按 ARIA 模式这必须是 dialog。这也正是它不受 tooltip 内容限制、可以正当地承载按钮和错误态的原因。

状态机：

```
open → (glossary hit?) ──yes──▶ show explanation
                       └─no──▶ loading ──ok──▶ show explanation
                                    └──fail──▶ visible error state + retry button (plus a Toast)
```

打开时把焦点移入浮层，Esc 关闭。底部固定两个按钮：「加入术语表」「关闭」。

**加入哪一层**：默认写**全局层**（个人词库），因为默认写项目文件会弄脏用户的工作区、制造意外 diff。设置卡片里可以显式选择"加入项目术语表"；项目层不可用时（没有工作区）该选项禁用并给出理由。

### 7.5 设置卡片

- Host：`ctx.settings.register('terminology', Config, { base: config })` 拿到 scope。
- 浏览器：`ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name: 'settings.plugin.item', key: 'terminology', locale: NS, inject }, TerminologyCard))`，key 与 Host namespace 相同（这是两半配对的 join key）。
- 卡片内容：总开关、快捷键、全局术语增删改、项目术语只读列表 + 文件路径 + 「在编辑器中打开项目术语表」、项目文件解析错误时的可见错误条。
- 读写走 `ctx.settingsScope.bind({ namespace: 'terminology' })`，写操作带 revision 栅栏。

## 8. 错误与信息可见性策略

针对"不要把下载格式或错误信息藏进提示里"，落地为四条可测的约束：

1. **自动术语 tooltip 内只有解释文本。** 没有 button、没有链接、没有错误、没有下载入口。它是 `role="tooltip"`，ARIA 模式本身就不允许交互内容。
2. **手动解释浮层是 dialog，错误以可见的错误态加重试按钮呈现**，并同时发一条 `Toast`。失败信息不依赖 hover、不需要用户去猜。
3. **术语表文件的解析错误显示在设置卡片里**，不是只在悬停时出现。
4. **本功能不提供下载**。将来若要加导出，格式选择必须是与卡片同级的显式控件，不得塞进 tooltip —— 这条作为约束写进包 README 的 Known Limitations，并由下面第 9 节的断言守住。

## 9. 测试与验证计划

| 面 | 证据 |
|---|---|
| 渲染接缝 | `ui-primitives` 单测：无 annotations 时现有 DOM fixture 逐字节不变；有 annotations 时只切分 `text` 节点、其余节点不动；`inLink` 内不标注；`streaming` 下不标注；提供方的拼接恒等属性测试 |
| 可访问性 | `AnnotatedTerm` 组件测试：hover / focus / click / Esc / 失焦 / 点外部 / 指针移入气泡不关闭；`aria-describedby` + `role="tooltip"`；气泡内无交互元素（断言 `role="tooltip"` 子树里没有 button/a/input） |
| 触屏 | Playwright e2e，`hasTouch: true` 的 context，`page.tap(term)` 打开气泡；断言触发体在无障碍树里 role 为 button，且未 hover 时下划线可见（非 `:hover` 依赖） |
| 客户端行为 | 右键菜单、快捷键、选区边界（输入框内不接管、超长拒绝）、长词优先匹配、浮层状态机、卡片读写与 revision 冲突 |
| Host | 两层合并优先级（含同名词覆盖）、项目文件读写与缺失/非法处理、`explain` 的 prompt/route/超时/空输出、`remember` 两层 |
| 真实组装 | **REAL-composition 测试**（仓库强制）：把包挂进 test-only `cordis.yml` 走 Loader 与 app/process，断言模型可见 / 持久 / 用户可见输出，不手搭 `ctx.plugin(...)` |
| 快照 | keyless recorded-session 快照：`terminology/explain-request` 进日志且可重放；Web 组装快照钉住可见输出 |
| 门禁 | `pnpm run test:gui`、`DSH_SNAPSHOT=replay pnpm run test:web`、`typecheck`、`lint`、`duplication`、`doc-sync`、`gen-persistence-catalog` |

## 10. 交付拆分

仓库用 stacked PR，所以"一次做完"= 一个设计、一串 PR：

1. `ui-primitives` 接缝与 `AnnotatedTerm`（含接缝单测与组件测试）—— 可独立评审、独立回滚，不装插件时零行为变化。
2. `ui-chat` 转发 `chatAnnotations`。
3. `ui-terminology` Host 半边：设置 namespace、两层术语表、typert remote、LLM 解释、会话事件、变更事件。
4. 客户端半边：标注提供方、术语表同步、手动识别、解释浮层、设置卡片。
5. 注册面（5.2 全部七条）、组装测试、e2e、快照。
6. 文档：包 README 双语（含 Model Experience 段与 Known Limitations）、必要的子系统文档更新、Agent Note 双语。

## 11. 已知风险与取舍

1. **改 3 个核心包共 11 个文件是这件事最重的部分。** 它是必需的：仓库里没有任何 slot 能装饰消息正文，`conversation.chat.node` 是整行 keyed 替换，会强迫插件 fork 约 300 行内置渲染。备选方案的实测代价见附录 A。
2. **跨节点的词不识别。** 被 markdown 强调语法从中间劈开的术语（如 `Trans*former*`）不会命中。这是"在单个 text 节点内匹配"的直接后果，换取的是实现简单与零误伤。
3. **正文里的匹配是字面匹配，没有词边界与分词。** 中文没有天然词边界，术语表里放 `模型` 会把"模型化""大模型"里的 `模型` 也标上。缓解手段是长词优先排序 + 词表由用户维护；本期不引入分词器。这条要写进包 README 的 Known Limitations。
4. **手动识别读 DOM 选区。** 这是设计里唯一直接读 DOM 的地方，边界已在 7.3 写明：只读、不改、不用观察器、放行输入框。若将来仓库提供官方的选区/上下文菜单接缝，应迁移过去。
5. **`terminology/explain-request` 是新的持久化事件类型**，会让会话日志多一种事件。早于它的构建按既有版本机制拒读该日志，与 `session/title-llm-request` 引入时的姿态一致。
6. **触屏没有 hover。** 因此术语链接默认态必须有可见的可交互线索，行为测试必须在 `hasTouch` context 下跑，不能只在桌面鼠标环境验证。

## 附录 A：备选方案与否决理由

- **纯插件接管 `conversation.chat.node` 的 `assistant-step` key（零核心改动）。** 否决。`ui-chat` 的 `/client` 只导出 `apply` / `inject` / 类型，而客户端规矩禁止插件 value-import 另一个特性插件的值，所以接管者必须重写 `AssistantNodeView` + `AssistantMarkdown` + `ReasoningRow` + `searchable-hidden` + 两份 CSS ≈ 300 行，且 DSH 每次改消息渲染都会漂移。
- **把要改的核心文件复制进插件再注册。** 否决。实测复制闭包共 ≈ 4,238 行（`MarkdownText` 闭包 15 文件 / 3,107 行，`AssistantNodeView` 闭包 15 文件 / 1,131 行）。除漂移外还有三个更贵的后果：markdown 安全策略（协议白名单、raw HTML 不进 DOM、KaTeX 不开 trusted）被复制成两份；`ui-primitives` 是 `PLATFORM_MODULES` 共享单例，副本会成为第二个私有实例（CSS Module 类名、KaTeX 实例、高亮缓存全部分裂）；`pnpm run duplication` 的 jscpd 克隆检测必然命中。
- **零核心改动的降级版：`shell.overlay` 里只做"选中→解释"。** 保留为退路。它完整覆盖"手动识别"，但"正文里自动变链接"拿不到，因此不作为主方案。
- **让模型自己在回答里标注术语（注册 system-prompt 段落 + 标记语法）。** 否决。会给正文引入需要每个渲染面（trajectory、导出、复制）都理解的私有标记语法，且词表不再由用户掌握。
- **复用 `chatFileMentions` 接缝。** 否决。它只认 `inlineCode` 节点，返回值是 `{ open, label, title }`，tooltip 走原生 `title` 属性 —— 不支持键盘聚焦打开、不支持点击/触屏、样式与行为都不可控。
- **全局术语表单独存 `$DSH_HOME/terminology.yml`。** 否决。设置文档已经提供修订号栅栏、变更事件、可编辑文档路径与卡片读写，另起一份文件是重复造轮子。

## 附录 B：实测数据

`MarkdownText` 复制闭包（`packages/client/ui-primitives/src/markdown/MarkdownText.tsx` 起）：15 文件 / 3,107 行，最大者为 `render.tsx` 629、`highlight.ts` 487、`incremental.ts` 360、`mathCompatibility.ts` 349、`MarkdownText.module.css` 321。

`AssistantNodeView` 复制闭包（`packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx` 起）：15 文件 / 1,131 行，最大者为 `contract/slots.ts` 235、`contract/snapshot.ts` 142、`AssistantMarkdown.tsx` 129、`contract/chat-nodes.ts` 129。

本方案的核心改动：11 个文件，其中 9 个是几行到几十行的接缝改动，2 个是新文件。
