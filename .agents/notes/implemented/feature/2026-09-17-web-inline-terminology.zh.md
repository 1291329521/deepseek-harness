# Agent Note: Web 行内术语标注——经由可选的 Markdown 接缝实现

Status: implemented

[English](2026-09-17-web-inline-terminology.md) | 中文

## Problem

Web 助手正文中的术语词条应当变成可点击的词：悬停、键盘聚焦或触屏点按时弹出纯文本解释；词表没命中的词，也可以通过选中加快捷键走该会话的模型路由解释一次。这个功能属于插件，但渲染必须发生在 `ui-primitives` 拥有、每条转写界面共享的定稿 Markdown 渲染器内部。把该渲染器 fork 或复制进插件会复制一条热路径；而一条即便没有安装提供方也会波及每条转写的接缝，会让无关界面付出代价。词表还是一个异步到达、渲染之后还会变化的反应式事实：在渲染期用 plain getter 读取它，定稿转写会错过迟到的首次词表——因为此后没有任何东西会再渲染该节点。

## Decision

### 渲染器接缝

`ui-primitives` 新增 `MarkdownAnnotations`：一次 `split(value)` 调用把一段作者原文切成首尾相接的 text/annotation 段，渲染器把每个 annotation 段经 `AnnotatedTerm` 画成可点击词。渲染 context 携带 `annotations: MarkdownAnnotations | undefined`；没有提供方时 `text` 分支原样返回作者字符串，定稿 DOM 与录制的 DOM 逐字节一致。标注只在定稿渲染里运行（流式 context 钉死 `annotations: undefined`），且永不进入 `<a>`——按钮不能嵌在链接里。

### 反应式通道

词表以名为 `chatAnnotations` 的 Cordis 服务传输，其接口是 `vocabulary(): ObservableSnapshot<MarkdownAnnotations | undefined>`——一个 bare observable 源，不是 getter。`ui-chat` 把它绑定为 `useAnnotations` hook，走的是已有的 keyed `conversation.chat.node` hooks compartment——与 `useTurnData` 同一条通道——`AssistantNodeView` 经由该 hook 读取解析器。提供方保持源的两种身份稳定：只有某个术语或释义真正变动时快照引用才更换，因此未变动的重拉不通知任何消费者，被 memo 的 Markdown 得以存活。没有挂载提供方时 hook 读出 `undefined`，正文保持纯文本。

### 词表分层与文件监听

`ui-terminology` 拥有 settings 命名空间 `terminology`（全局层：`enabled`、`explainShortcut`、`terms`）以及会话工作区下的项目文件 `.dsh/terminology.yml`，项目层逐词覆盖全局层。`state`/`remember`/`explain` 以类型化结果跨越 Remote 边界；项目层写入走 `withFileLock` 加原子写。每个项目路径一个 chokidar watcher，由 `[Service.init]` 持有的 effect 统一释放——若在请求路径内惰性登记，watcher 会在 fiber 销毁后存活。读取与监听永不创建工作区结构：目录不存在就没有可监听的东西，父目录的创建属于真正写入它的那次 `remember`。

### 解释管线

手动取词把 `{ term, context }` 框成一个 JSON 对象嵌入固定指令，在派发前以与 `session/title-llm-request` 相同的二参 log-only 形态追加 `terminology/explain-request` 到会话日志，然后消费一条 `purpose: 'terminology'` 流，整体受单一 `explainTimeoutMs` 期限约束。路由优先用配置的 `explainProvider`/`explainModel` 对——只给一半在装载时抛错——否则用该会话上次选择的模型，两者皆无返回 `NO_MODEL_ROUTE`；不存在静默默认。只有纯文本答案算成功：超时、截断、工具请求、空文本都是类型化失败，由浮层用人话陈述。

### 交互契约

悬停经 150 ms 驻留后打开（钉死的常量）；键盘聚焦立即打开；点按在 click 模式下开合、对指针移出免疫——因为按压会先送 `focus` 再送 `click`，被 focus 打开的标注不能紧接着被这一下 click 关掉。tooltip 只承载解释文本——没有按钮、动作或错误面——所有动作归设置卡片与手动取词浮层，用可见的散文式报错、重试按钮表达，且没有导出或下载入口。手动取词只在选区非折叠非空、且不在可编辑区域内时，才认领 document 捕获阶段的 `contextmenu` 与配置的和弦。被拒绝的读取（业务失败或传输失败）折叠为「没有词表」，而不是伪装成一个能用的功能。

## Consequences

- 可选接缝是「以自有词表驱动正文渲染」这类功能的钦定路线：`ui-primitives` 保持零文案、零词表知识，`ui-chat` 只转发 observable，词表留在自己的插件里。
- 定稿转写的首屏现在可能赶不上首次词表到达；hook 会在词表落地时通知已定稿的节点，而不是等一次无关重渲染，代价是每次词表变动多一次重绘。
- 解析器不区分会话：一个浏览器会话一份词表。多工作区并存的产品需要按会话 keyed 的提供方；当前单一全局 settings 的产品形态不需要，该缺口已在包 README 中点名。
- `terminology/explain-request` 新增了一个持久事件类型：早于它的构建按既有版本机制拒读该日志，这与 `session/title-llm-request` 引入时已接受的姿态一致。一方写者无法设置信封上的 `ignorable`，因此不承诺旧构建可读。
- 浏览器半侧与 Host 半侧只共享常量（独立的 `namespace.ts`、私有合并实现），settings schema 的运行时永不进入 `lib/client.js`。
- `test:web` golden 现在包含术语界面；两条点击路径修复（hooks 通道、按压先于 click 的标注）各自带一条先复现失败序列的回归 spec。

## Alternatives considered

- 把 keyed chat-node 转写渲染器 fork 进插件，或把 `ui-primitives` 的 Markdown 渲染器整体复制：两者能让核心不掺标注逻辑，但复制了热路径，且每次转写变更都会漂移；实测复制路线要背数千行。
- 经提供方穿下来的 plain getter prop 读取词表：被真实浏览器组装场景否决——打开既有定稿会话时，渲染先于异步词表读取落地，此后再无渲染带出词表，标注只有 remount 后才出现。
- 经 `uiSession.provide` 交付词表：per-session provide hook 能否到达 keyed chat-node 渲染器未经证实，而 keyed hooks compartment 已经为 `useTurnData` 绑定可用；实现只用已证实的通道。
- 复用 `chatFileMentions` 接缝：文件提及作用于 inline-code、打开的是文件，不是能开解释的正文词。
- 让模型在输出里标注术语：纯展示词表就此变成模型可见输入，逼着逐消息记日志，还把词表演化写进了已提交的转写。
- 所有工作区共用一份 `$DSH_HOME` 词表文件：随着项目层一起被否决——项目术语属于读者正在工作的那个仓库。
- 给 `terminology/explain-request` 设 `ignorable` 信封位让旧构建跳过它：`Session.append` 对非 surface 事件类型不接受任何选项，一方写者也不经 append 设置 `ignorable`（见[会话日志版本机制](../architecture/2026-08-10-session-log-version-mechanism.zh.md)）；按辅助请求先例用二参 append 才是诚实形态。
