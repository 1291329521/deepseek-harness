---
description: "为助手正文提供行内术语标注：两层术语表、悬停/聚焦/点按解释，以及用户手动触发的模型解释查询。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-terminology

[English](README.md) | 中文

## 概述

本包把 Web 客户端助手正文里命中术语表的词变成可标注的词。词汇来自两层——用户在设置里自持的全局词条，以及工作区内可覆盖它的项目文件——命中的词在悬停、键盘聚焦或点按时弹出纯文本解释。词汇没命中的词仍可解释：选中后按快捷键，就向该会话当前模型路由发一次请求，解释结果可存回任意一层，下次再见即为纯标注。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 profile 里挂载本包；浏览器功能经 Web client 插件行激活。

```yaml
- id: ui-terminology
  name: '@deepseek-ai/dsh-client-ui-terminology'
```

Host 服务是 `ctx.terminology`（以 `terminology` 为键的 `TypertRemoteService`），浏览器侧通过生成的 `terminology` Remote 消费它。它拥有设置命名空间 `terminology`（`enabled`、`explainShortcut`、`terms`），以下 Host 配置作为其组合 base，并在任一层词汇变化时发布 `terminology/changed`。配置：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `terminology` 设置命名空间的默认开关。 |
| `terms` | `[]` | 全局词条的组合 base。 |
| `explainShortcut` | `"Alt+Shift+E"` | 设置卡片展示的默认手动解释快捷键。 |
| `projectGlossaryPath` | `".dsh/terminology.yml"` | 项目术语表文件，相对工作区；绝对路径或逃逸路径不产生项目层。 |
| `explainProvider` | 未设置 | 手动解释的固定提供方；需与 `explainModel` 同时给出。 |
| `explainModel` | 未设置 | 手动解释的固定模型；需与 `explainProvider` 同时给出。 |
| `explainMaxTokens` | `2048` | 单次解释请求的生成预算；具备推理能力的模型会把其中一部分花在不会展示的推理上。 |
| `explainMaxSentences` | `3` | 单条解释的句数上限。 |
| `explainTimeoutMs` | `30000` | 单次解释请求的墙钟预算。 |
| `explainTermMaxChars` | `64` | 解释或存词请求允许携带的最长词。 |
| `explainContextMaxBytes` | `2048` | 随解释请求发送的选区上下文字节预算。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`state` 返回单个会话的全部渲染输入：开关、生效快捷键、按词长降序合并的两层词汇、解析出的项目文件路径，以及项目文件读取/解析出错时的错误（此时项目层被忽略，调用仍然成功）。`remember` 把一条词条写入所选层：全局层经设置 scope，项目层经 `withFileLock` 加整文档原子写。读取和 `remember` 维护按路径的缓存；chokidar 在目录存在后、项目文件被外部改动时重读，读取与监听都不创建工作区结构。每次设置写入、项目文件变动和成功的 `remember` 都会扇出 `terminology/changed`，观察方失败不能否决已提交的写入。`explain` 经模型路线解释一个选中的词：配置了固定的 `explainProvider`/`explainModel` 对时用该对，否则用会话上次的模型选择，两个来源都没有就拒绝调用。每次调用先约束词与上下文的边界、把它们框成一个 JSON 对象、在派发前把 `terminology/explain-request` 追加进 Session 日志，再在单个 `explainTimeoutMs` 截止时间下消费一次 `purpose: 'terminology'` 流；只返回纯文本答案，其他任何结果都是类型化错误：触到输出上限为 `LLM_TRUNCATED`，超时、请求工具、空文本与提供方失败为 `LLM_FAILED`。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务生命周期、设置所有权、项目文件缓存与 watcher，以及 `state`/`remember`/`explain` remote 方法 |
| [`src/explain.ts`](src/explain.ts) | explain 的输入框定、派发前日志、截止时间与输出规则 |
| [`src/namespace.ts`](src/namespace.ts) | 两个半边共同衔接的 `terminology` 键，不携带 schema 运行时 |
| [`src/spec.ts`](src/spec.ts) | Host Config、设置 schema 与项目文件 schema |
| [`src/types.ts`](src/types.ts) | Remote 载荷、封闭错误目录与声明合并的事件 |
| [`src/glossary.ts`](src/glossary.ts) | 项目文件解析与两层合并 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器半边装配：词表、手动取词接管与两个 slot 注册 |
| [`src/client/resolver.ts`](src/client/resolver.ts) | 长词优先、大小写敏感、不重叠的标注扫描器 |
| [`src/client/selection.ts`](src/client/selection.ts) | 接管可以认领哪个活动选区，以及锚在哪里 |
| [`src/client/shortcut.ts`](src/client/shortcut.ts) | 和弦文本解析与精确匹配的按键比较 |
| [`src/client/overlay-policy.ts`](src/client/overlay-policy.ts) | 手动取词状态机：菜单、加载、展示、失败、保存 |
| [`src/client/card-policy.ts`](src/client/card-policy.ts) | 设置卡片快照与经 owner scope 的整数组词条写入 |
| [`src/client/TerminologyOverlay.tsx`](src/client/TerminologyOverlay.tsx) | 接管菜单与解释对话框 |
| [`src/client/TerminologyCard.tsx`](src/client/TerminologyCard.tsx) | 设置页的术语卡片 |
| [`src/client/locales.ts`](src/client/locales.ts) | `ui-terminology` 词典（zh 与 en） |

</details>

**运行时不变量：** 不发布 companion。设置命名空间恰有一个 owner scope，项目文件缓存由发布其变更的同一组 watcher 与写入刷新。

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-primitives](../ui-primitives/README.zh.md) —— 浏览器半边经由渲染的 `MarkdownAnnotations` 接缝。
- [ui-chat](../ui-chat/README.zh.md) —— 转发可选标注提供方的助手正文界面。
- [Settings](../../settings/settings/README.zh.md) —— 命名空间注册与 `base` 字段流入的组合 base 层。
- [LLM](../../llm/llm/README.zh.md) —— 手动解释发出的已路由辅助请求。
- [Client 分组地图](../README.zh.md) —— 浏览器服务与 UI 特性包。

-----

<a id="model-experience"></a>
## 模型体验

### 自动标注

#### 模型看到什么

无：自动标注在浏览器内从两层词汇表读取命中的词，词表内容、标注结果与悬停状态都不进入模型请求或会话日志。

#### Token 影响

对任何请求都没有影响：自动路径不会向会话或辅助请求添加任何文本。

#### KV Cache 影响

无；词汇表是转写之外的渲染输入，会话内容与前缀保持不变。

### 手动解释请求

#### 模型看到什么

一次用户触发的查询发送一次辅助请求：一段固定纯文本输出契约的 system prompt，和一条携带选中词及其上下文句子（按 `explainContextMaxBytes` 截断）的 user message。该请求不属于任何 turn 或 step，以 `purpose: 'terminology'` 运行，且在派发前以 `terminology/explain-request` 追加进会话日志，事件携带精确的组帧消息、路由与 `maxTokens`，请求可从日志重建。

#### Token 影响

每次手动查询一次短交互：固定 system prompt、有上下文预算的 user message，以及受 `explainMaxSentences` 与 `explainMaxTokens` 限制的解答。存下的词条只在下次渲染读取设置或项目文件后进入后续轮次。

#### KV Cache 影响

对会话无影响；辅助请求与会话不共享前缀，会话历史不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制针对渲染出的标注行为与项目文件监听。

- **匹配在单个文本节点内进行** —— 跨 Markdown 节点拆开的词不会被标注。
- **强调语法会劈开词** —— 源码里写成 `Trans**former**` 的词不会命中的词表词条。
- **中文没有词边界** —— 词表含 `模型` 时，`大模型` 内的 `模型` 也会被标注；长词优先排序与用户自维护词表是缓解手段。
- **正文解释经标注 hook 刷新** —— 词汇变化经由标注所在的同一通道重绘已定稿正文；重绘是代价，每次词面真实变动至多一次是上限。
- **每个浏览器解析一份词表** —— 解析出的词表跟随浏览器拉取时所对的会话；并排打开的多个会话共用这一份词表，直到下一次拉取解析出别的。
- **不提供下载或导出** —— 本功能没有导出；将来若新增，其格式选择必须是设置界面里与卡片同级的显式控件，绝不能放进 tooltip。
- **外部删除的项目术语表保留最后一次读取** —— watcher 只在 `add` 和 `change` 时重读，缓存的词会生效到下一次写入或重启刷新它为止。
- **项目文件监听只在目录存在后武装** —— 在从未有过 `.dsh/` 的工作区里外部创建的术语表，要经重启或一次项目层 `remember` 才能进入词表，因为读取从不创建目录，而缺失的目录没有可武装的 watcher。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
