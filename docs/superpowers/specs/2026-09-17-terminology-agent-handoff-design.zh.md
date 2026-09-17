# 术语项目交接设计规格

[English](2026-09-17-terminology-agent-handoff-design.md) | 中文

- 日期：2026-09-17
- 状态：等待用户最终签字
- 范围：当一段正文不足以确定某个术语时，手动查询面板该怎么做，以及会话 Agent 如何接手探索。不新增模型工具、不改会话协议、不做宿主侧仓库检索。
- 前置阅读：[2026-09-16-web-inline-terminology-design.zh.md](2026-09-16-web-inline-terminology-design.zh.md)、[packages/client/ui-terminology/README.zh.md](../../../packages/client/ui-terminology/README.zh.md)、[docs/subsystems/slots.zh.md](../../subsystems/slots.zh.md)

## 1. 背景与目标

### 1.1 问题

explain 侧信道调用只能看到一段正文：选区所在的那个段落。这对通用模型认识的词汇够用，对项目行话、内部代号、或含义藏在代码里的词就不够。当这段正文无法确定术语时，模型照样会回答：面板把一个流畅的猜测以与有依据的答案完全相同的自信呈现出来，读者无从分辨两者。

### 1.2 一句话定位

**当正文无法确定某个术语时，面板直接说明这一点而不是猜测，并提供把问题交给会话 Agent 的入口：Agent 先用它已经持有的上下文解释，只有在该上下文不够时才去读仓库；结论随后可以折进项目术语表。**

### 1.3 设计原则

- 由模型自报其无能为力。备选方案——用本地规则猜测某个术语「看起来像项目专有」——已被用户否决，信号应当来自产出解释的同一次阅读。
- 交接复用会话自己的 turn 通道。不新增推理路径、不注册插件自有工具、不开第二段对话：指令变成一条普通的排队 turn，于是探索与前文的任何一轮一样被记录、可见、可重建。
- Agent 只为正文给不出的东西付费。指令要求先用手上已有的上下文，因此 Agent 已经能看到的术语不需要读任何仓库文件。
- 未经用户确认，任何内容都不进术语表。Agent 只提出一条条目，用户同意后才写入；项目文件受版本控制，因此这次写入可复核。

## 2. 范围

### 2.1 范围内

- explain 调用的「未确定」结果：其 prompt 指令、解析规则，以及它在远程结果中的位置。
- 渲染原因行、交接入口与成本提示的面板状态。
- 面板排入当前会话的那条预制指令。
- Agent 结论的术语表写入路径及其之后的刷新。
- 两侧 locale 字典的文案、包 README 对、以及归属方 Agent Note 对。

### 2.2 明确不做

- explain 调用之前的宿主侧仓库检索。否决理由：它会把仓库内容发给会话所选的任何路由，并把一次两秒的查询变成一条检索流水线。
- 把 Agent 的回答读回面板以便在那里提供保存按钮。暂缓理由：它迫使面板把「一个术语」绑定到「某一轮」，还要跨流式中、多轮与会话切换处理。
- 解释结果缓存。用户已为本次变更否决。
- 本包自有的任何面向模型工具。
- composer 预填或消息来源标注扩展点。

### 2.3 与相邻能力的分工

- 命令能力承担不了这件事：`CommandResult` 只把文本返回给派发它的界面，且刻意永不触达模型，因此命令无法注入指令。
- 客户端会话服务本来就拥有进入对话的通道：`binding(id).session.prompt(content, 'queue')` 与输入框调用的是同一个方法，而 `SessionBinding.session` 正是功能代码被允许持有的 outward 会话面。
- 项目术语表本来就有一个 watcher：外部编辑后会重读并扇出 `terminology/changed`，因此 Agent 用它自己的工具写入的文件无需新代码即可出现在面板与行内 Tooltip 中。
- 设置卡片与两层术语表均不变。

## 3. 「未确定」信号

### 3.1 prompt 指令

explain 的 system prompt 增加一条指令：当这段正文无法确定该术语在本项目中的含义时，只输出一行、以 `NEEDS_PROJECT:` 开头并后接一句简短原因，不要输出其他内容；否则照今天的方式回答。该指令与 prompt 其余部分一样是面向模型的英文，并且仍在既有的 `explainMaxSentences` 框架内。

### 3.2 解析规则

- 由第一行决定。忽略前导空白，标记按大小写不敏感匹配。
- 标记行被剥离；该行剩余部分即为原因，去除首尾空白，允许为空。
- 出现在正文后面的标记不算数：那时答案是解释，标记只是正文。
- 只有标记、没有原因时仍然产出未确定结果；面板此时改显示字典里的通用原因行。标记识别在下面的空内容规则之前就把结果定下来。
- 未识别出标记、且组装出的答案为空时，保持今天的 `LLM_FAILED`，因为没有任何文本的解释没有可展示的内容。

### 3.3 契约变更

`TerminologyExplainResult` 的成功值改为判别联合：`{ kind: 'explained'; explanation: string }` 或 `{ kind: 'undetermined'; reason: string }`。每个消费方都按 `kind` 分支，而消费方只有本包自己的客户端半边。持久化的 `terminology/explain-request` 记录不变：它记录请求，不记录结果。

### 3.4 不变的部分

- `LLM_TRUNCATED`、`LLM_FAILED`、`TIMEOUT`、`TERM_INVALID`、`CONTEXT_TOO_LARGE`、`NO_MODEL_ROUTE` 的含义与文案都不变。
- Tooltip 契约仍是「只有解释文本」：标记永远不会到达 Tooltip，因为它被流水线消费掉了。
- 路由不变：优先配置的固定对，否则用会话上次的模型选择，两者皆无则 `NO_MODEL_ROUTE`。

## 4. 面板表面

### 4.1 新状态及其渲染

- overlay 的请求状态新增 `undetermined`，携带原因。它渲染原因行、交接入口与关闭动作。
- 该状态下不出现「加入术语表」动作：没有可保存的解释，而保存一句原因等于把模型明确表示无法背书的文案写进词表。
- 客户端策略的 explain 动词从远程结果映射出该状态；面板既有的关闭、聚焦与播报行为不变。

### 4.2 成本提示

交接入口在自己的标签旁说明它会发起一轮 Agent。一轮 turn 比它所替代的侧信道调用贵若干个数量级，因此读者是在看到成本的前提下做决定，而不是事后才发现。

### 4.3 文案归属

原因行按用户数据原样渲染模型文本。面板自己拥有的每一句话——通用原因、交接标签、成本提示——都放在两侧 locale 字典里，经既有的 `t` 席位读取。

## 5. Agent 交接

### 5.1 传输

面板的交接动作经客户端会话服务解析出当前会话，并用 `prompt(content, 'queue')` 排入一条用户 turn。准入被拒时返回远程的业务错误，面板经既有的瞬时播报说明它，并保持打开以便重试。

### 5.2 预制指令

该指令是面向模型的英文，写明术语、它来自的段落，以及什么样的回答算好。其确切文本固定在此，使面向模型的契约不会悄悄漂移：

```text
Explain the term below for the reader of a DSH session.

Term and its passage (JSON):
<the same JSON object the explain call frames>

Use the context you already hold in this conversation first. Read repository files, documentation, or configuration only when that context does not determine what the term means in this project. Then answer in at most three sentences of plain text, in the language of the passage.

Finish by proposing exactly one project glossary entry as "term: <term>" and "explanation: <your explanation>", and write it into the project glossary file only after the reader confirms.
```

### 5.3 来源的诚实性

`prompt()` 不带来源标注，因此这条排入的指令在对话记录里显示为一条用户消息。包 README 把它记为已知限制：复核会话的读者会看到这条指令以自己的口吻出现，这也正是指令被写成请求式、且从不自称是读者原话的原因。

### 5.4 边界

术语与段落装在侧信道调用所用的同一套 JSON 组帧里传输，因此正文无法打破结构；同样适用同一批上限：术语须满足 `explainTermMaxChars`，段落须满足 `explainContextMaxBytes`。超出上限的术语根本到不了交接：客户端在发出任何调用之前就拒绝该选区。超出上限的段落会让 explain 调用以 `CONTEXT_TOO_LARGE` 失败，而交接入口只存在于未确定状态，因此读者改为缩小选区。

## 6. 术语表写入与刷新

### 6.1 由谁写入

Agent 用它自己的编辑工具写入条目，就在读者确认的那一轮里。术语表路径是插件已经为该会话工作区解析出的那个：相对路径且在工作区内；创建 `.dsh` 目录与文件属于写入方，这保持了既有的「读取与监听从不创建工作区结构」规则。

### 6.2 如何生效

插件的项目文件 watcher 在外部编辑后重读该文件并扇出 `terminology/changed`；面板与行内 Tooltip 随后读取项目层，因此新条目无需刷新、也无需本次变更新增任何代码即可生效。

### 6.3 复核路径

术语表文件是受版本控制的工作区文件，因此 `git diff` 就是 Agent 写入内容的复核界面，而被否决的条目只差一次 checkout。

## 7. 失败与边界情形

- 没有当前会话：交接入口报告 explain 动词本就报告的同一种缺失，面板播报它，而不是往空处排队。
- 队列拒绝该 turn：播报写明失败，面板保持打开。
- 读者在 turn 运行期间关掉面板：该 turn 本就是一条普通会话 turn，会继续运行；本设计没有任何部分依赖面板保持挂载。
- 该术语之后被加入某一层术语表：标注路径接管面板，重复选择会显示存储的解释且不发起模型调用。
- 对一个确实需要仓库的术语，模型始终不输出标记：读者仍可选中该词，在面板以未确定状态打开后使用交接入口，或直接问 Agent；README 把该标记记为模型自撰文本。
- 对一段正文其实已经确定的术语，模型输出了标记：读者付出一轮 Agent 的代价换来一个有依据的答案，这正是本设计想要的交换。

## 8. 测试与验证计划

- 单元，流水线：按解析规则做一张表——只有标记、标记带原因、标记前有前导空白、标记大小写混合、标记出现在后面的行、标记后什么都没有、空答案、以及一段普通解释。
- 单元，策略：客户端 explain 动词把未确定结果映射为新状态，且该状态携带原因。
- 组件：overlay 渲染原因行、交接入口与成本提示，并在该状态隐藏加入术语表动作。
- 单元，交接：该动作向当前会话恰好排入一条消息，内容为固定的指令文本与组帧 JSON，并把被拒的准入表现为一次播报。
- 组装级浏览器场景：脚本化的未确定回答打开面板并显示提示与入口；点击入口排入该 turn，对话记录中出现它；该场景同时保留既有的术语表与触屏断言。
- 文档门禁：README 对、Agent Note 对、两侧 locale 字典与本规格对通过 `doc-sync`，除既有的外部遗留失败外。

## 9. 触及的文件

- `packages/client/ui-terminology/src/explain.ts`：prompt 指令、标记解析、未确定结果。
- `packages/client/ui-terminology/src/types.ts`：判别联合的成功值。
- `packages/client/ui-terminology/src/client/overlay-policy.ts`：未确定状态与交接动词。
- `packages/client/ui-terminology/src/client/index.ts`：explain 映射、交接动作与指令文本。
- `packages/client/ui-terminology/src/client/TerminologyOverlay.tsx` 与 `TerminologyOverlay.module.css`：新状态的渲染。
- `packages/client/ui-terminology/src/client/locales.ts`：两侧 locale 的新文案。
- `packages/client/ui-terminology/README.md` 与 `README.zh.md`：状态、交接与来源限制。
- `packages/client/ui-terminology/tests/explain.host.spec.ts`、`tests/apply.client.spec.ts` 与 overlay 策略 spec：第 8 节的用例。
- `apps/web/tests/terminology-inline.e2e.ts`：组装级场景。
- `.agents/notes/implemented/feature/2026-09-17-web-inline-terminology.md` 及其中文对应件：决策与被否决的备选。

## 10. 已知风险与取舍

- 标记是模型自撰的：从不承认无知的模型保持今天的行为，而过报的模型会让读者付出一轮 Agent 的代价。本设计无法把这个判断变成确定性的；它能让分歧变得便宜且可见。
- 排入的指令在对话记录里归属于读者，见第 5.3 节。
- 面板多出第三种结果，客户端半边的状态机与测试随之增长。
- 探索那一轮不受本包约束：它服从会话自己的工具与审批策略，这是刻意的，因为读者的会话本就拥有那些决定权。

## 附录 A：考虑过并否决的备选

- **用本地确定性规则判断「这个术语看起来像项目专有」**（既不在术语表又在工作区有命中，或形如代码标识符）。用户否决：信号应来自产出解释的那次阅读，而不是看不见含义的形状规则。
- **总是显示交接入口。** 否决：它会让每次查询都邀请一轮 Agent，并丢掉让面板保持诚实的「这段正文不够」这句话。
- **在 explain 调用之前做宿主侧仓库检索。** 否决：它每次查询都把仓库内容发给所路由的模型，并与 Agent 用工具做得更好的事情重复。
- **把 Agent 的回答读回面板。** 暂缓：它把「一个术语」绑定到「某一轮」，并成倍增加面板必须挺过的状态。
- **以术语与段落为键的解释结果缓存。** 用户为本次变更否决；该想法的持久化版本已由术语表承担。
- **基于命令的交接。** 否决：`CommandResult` 永不触达模型，因此命令无法递送指令。
- **用宿主侧 subagent 运行替代会话 turn。** 否决：它为一个客户端插件引入 agent 依赖与预算，去换一个会话 turn 本就产出的结果，并把探索从对话记录里藏起来。

## 附录 B：实测数据

- 按现状交付的一次 explain，在所路由的本地模型、开启推理时：一个短术语约 400 tokens 量级；同一个问题遇到推理偏重的术语达到 1303 completion tokens（合计约 1520）。
- 在同一台网关上用 `chat_template_kwargs.enable_thinking=false` 关闭推理：同一个推理偏重的术语只需 57 completion tokens（合计约 277），答案同样完整。记为另一根独立杠杆；本设计不改推理策略。
- 该网关的前缀缓存：`prompt_tokens_details` 为空，同一段 1288 tokens 前缀连发三次每次都按 1288 个全新 tokens 计费，因此复用已有会话前缀在这条路由上省不下任何东西。
- 缓存读取在任何地方都不是免费的：本机某会话的一轮记录到 219,392 个缓存读取 tokens，因此把问题追加到会话前缀上要比本设计保留的独立调用贵得多。
- 标记自身的成本：新增指令约 30 个输入 tokens，一次未确定回答约 10 到 20 个输出 tokens。
