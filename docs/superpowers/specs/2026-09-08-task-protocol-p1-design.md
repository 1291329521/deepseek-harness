# 任务协议（Task Protocol）P1 设计规格

- 日期：2026-09-08
- 状态：待用户终审
- 范围：P1（任务协议核心）。P2–P5 见附录 A，仅记录方向，不在本规格内设计。
- 前置阅读：[docs/architecture.md](../../architecture.md)、[docs/subsystems/storage.md](../../subsystems/storage.md)、goal 组四包先例（`packages/goal/`）

## 1. 背景与目标

### 1.1 痛点

DSH 现有的 `todo_write`（会话内清单）、`goal`（单会话目标）、`subagent`/`jobs`/`workflow`（会话内委派与后台执行）全部随会话消亡。用户在每个仓库里的长期工作没有跨会话的账本：每次开新会话都要重新交代"我的项目推进到哪了"。

### 1.2 一句话定位

**给 DSH 装一个跨会话、跨角色的持久任务账本：一切工作抽象为"自包含合同"式的任务，人与 agent 会话都可扮演发布者（publisher）与工作者（worker），全异步闭环，按工作区隔离持久化。**

### 1.3 三条立国之本

1. **任务 = 自包含合同**。`description` + `deliverable` 必须充足到一个对发布者历史一无所知的冷启动执行者能直接开工、能自证达标。这是任务与普通 todo 的本质区别：todo 是给自己看的备忘，任务是一份可执行的合同。
2. **发布者主权不可变**。发布者身份终身不可改；验收权（accept/reject）与取消权（cancel）只属于发布者；合同文本修订权也属于发布者，且修订留痕。
3. **状态机归协议，演进靠版本**。合法状态与转换由协议定义并在服务层强制；未来阶段的新状态（如 P4 审校态）通过域 schema 版本升级进入；下游私有数据（审校轮次、派单得分等）放下游自己的存储，永不进入状态枚举。

### 1.4 与相邻能力的分工

| 能力 | 管辖范围 |
|---|---|
| `todo_write` | 会话内工作清单（易失） |
| `goal` | 单会话完成目标 |
| `subagent` / `workflow` / `jobs` | 会话内委派、编排、后台进程 |
| **本任务协议** | **跨会话、跨角色、持久化的任务交换** |
| `workspace` 组 | 目录注册与分组；其 GUI 列表虽也称 "projects"，但管的是目录，与本协议的任务合同无关 |

## 2. 全系统分期与依赖图（总览）

```
P1 任务协议核心          本规格。实体+状态机+身份+storage 持久化+工具+命令+摘要注入
     ↘                        ↙
      P3 派单路由（一次性 LLM 调用：任务 → 最合适的 agent 模版标识）
            ↓
      P4 执行流水线 driver（冷启动 subagent 执行 + LLM 审校门 + 打回重写
         + 超限标记 + 验收唤醒；审校只是质量门，发布者终审）
P2 agent 模版注册表      preset 之上的可路由元数据（说明+标签）+ 可缓存目录注入
                         ——与 P1 互不可见，仅被 P3/P4 同时消费
P5 Web GUI 看板          只读账本（已确认后置）
```

- 依赖为单向 DAG；**P1 与 P2 互不依赖**（任务不认识模版，模版不认识任务），P3 是唯一同时接触两端的层。
- 判断新需求归属的准则：**改合同（字段/状态/验收权）动 P1（走版本升级）；消费合同（生成、分派、执行、评判、展示）永远是新的 Consumer 包。**
- P1 必须单独可用：人给人发任务、手动闭环。这既是产品形态，也是检验"合同字段是否自包含"的实验路径——字段不够用会在真实认领中暴露成"认领后要回头问发布者"。

## 3. P1 定位与边界

### 3.1 功能边界（只管"账本和规矩"，不管"干活"）

| 环节 | P1 管 | P1 不管 |
|---|---|---|
| 定义 | 任务完整字段合同 | 任务生成、字段润色 |
| 发布 | 创建任务进工作区账本 | 自动/定时发布 |
| 获取 | assign（设 worker，先到先得或指定） | 决定"该给谁"（P3） |
| 执行 | —（账本外的事） | 启动 worker、管理过程（P4） |
| 交付 | 追加交付记录 | 评判交付质量（P4 审校门） |
| 验收 | 发布者 accept/reject | 预审、重试上限 |
| 感知 | 新会话摘要注入 + 工具查询 | 唤醒死会话、推送、看板 |
| 记账 | 每次流转带操作者审计 | 统计、报表 |

### 3.2 复用 DSH 原生系统（绝不重造）

| 事情 | 归谁 |
|---|---|
| 磁盘持久化、版本化、变更事件 | `storage`/`storage-domain` |
| 工作区身份 | `workspace` 组（读其标识做隔离键） |
| 工具注册/校验/策略/PTC | `dsh-tools` |
| 斜杠命令 | `commands` |
| 上下文注入规范（user-role 消息入会话日志） | `context` 组模式 |
| worker 的系统提示词/身份（P4 时代） | `preset` + `persona` |

### 3.3 明确不做（P1 非目标）

无模版注册、无 AI 路由、无自动执行、无 AI 审校、无 Web GUI、无专用工具卡片、无推送通道、无批量导入工具、无任务间"资源锁"调度（scope 字段仅声明，执法插件属未来 Consumer）。

## 4. 任务协议（v1）

### 4.1 任务记录字段（zod schema，落在 storage-domain）

```ts
interface TaskRecord {
  id: TaskId                    // 品牌化 id；工作区内递增序号，如 "t7"
  workspace: string             // 隔离键：工作区根目录绝对路径
  title: string                 // 必填非空
  description: string           // 必填非空；合同主体，自包含
  deliverable: string           // 必填非空；验收定义："什么算做完"
  priority: 'low' | 'normal' | 'high'   // 工具层显式默认 'normal'（无隐藏 ??）
  status: TaskStatus            // 见 4.2 闭合联合
  publisher: Actor              // 发布者身份，终身不可变
  worker?: Actor                // 当前执行者；空→非空即进入 in_progress
  parent?: TaskId               // 父任务（任务树）；同工作区、无环，否则拒绝
  blockedBy: TaskId[]           // 前置依赖；未全部 done 则不可 assign（not-unblocked）
  scope?: string[]              // 变更面声明（glob）：合同的一部分；未来调度互斥键；策略插件执法依据
  publishedAt: string           // ISO 时间戳；另 workerSetAt? / deliveredAt?
  submissions: Submission[]     // 交付记录，只追加
  events: Transition[]          // 完整审计日志，只追加：每次状态/字段变化一条（operator、reason）
}

interface Actor {
  kind: 'human' | 'agent'
  name: string                  // 持久身份名（如 'weishuhao'、'docs-writer'），非会话 id
  session?: string              // 操作时所在会话 id——仅溯源，不是回调地址
}

interface Submission {
  at: string; by: Actor
  note: string                  // 交付说明：怎么做的、如何自证达标
  artifacts: string[]           // 产出路径/分支名；协议不解释内容
}
```

"认领还是被指派"不在状态机区分：`events` 中的 operator 记录天然回答该问题。

### 4.2 状态机（6 状态）

```
            assign(设 worker)                deliver(交付,追加 submission)
 open ─────────────────────▶ in_progress ─────────────────────▶ submitted ──accept──▶ done ✔
  ▲  ▲                         │   ▲                                │               (终止态)
  │  │       ask(worker 提问)  │   │ answer(发布者回答,可修合同)      │
  │  └─────────────────────────┴───┘── awaiting_input              │ reject(必附原因)
  │ release(worker 放弃,清空) ◀── in_progress      submitted ────────┘ 回 in_progress(worker 不变)
  └──── 回公共池
 cancel(仅发布者,任何非终止态) ──▶ cancelled ✔ (终止态)
```

| 状态 | 含义 | 当前行动方 |
|---|---|---|
| `open` | 待安排 worker（blockedBy 未清则可见不可派） | 市场 / 派单方 |
| `in_progress` | worker 已定，执行中 | worker |
| `awaiting_input` | worker 提问，合同待澄清/修订 | 发布者 |
| `submitted` | 已交付，待验收 | 发布者 |
| `done` | 完成，账本封存 | — |
| `cancelled` | 取消 | — |

### 4.3 转换与权限（服务层强制，非法即 `TaskError`）

| 动作 | 授权方 | 效果 |
|---|---|---|
| create | 任何 Actor | → `open`；`parent` 存在时入树（父须为 `open`） |
| assign（设/换 worker） | 填空位：任何人；**换人**：仅发布者 | → `in_progress` |
| ask | worker | → `awaiting_input` |
| answer | 发布者 | → `in_progress`；可同时修订 description/deliverable（amendment 事件留痕） |
| deliver | worker | → `submitted`，submissions 追加 |
| accept / reject | 仅发布者 | → `done` / 回 `in_progress`（reject 必附原因） |
| release | worker | → `open`，worker 清空 |
| cancel | 仅发布者 | → `cancelled` |

### 4.4 任务树与容器规则

- `parent` 构成任意深度的子任务树（场景：PRD 拆分为设计/前后端实现等子任务；一切 agent 可做的事皆可入树）。
- **容器**：有子任务的任务不可 assign、不可直接 deliver；可执行合同永远是叶子。
- 加子任务要求父处于 `open`。
- **聚合验收**：全部子任务 done → 容器自动 `submitted`；容器发布者 accept = 整枝验收，reject = 回 `open`（可修树再推）。防御"每个叶子都通过、整体目标未达成"。
- `blockedBy` 表达先后顺序，与树的分组职责正交。

### 4.5 发布者寻址：发布者"回到"账本，而非被"找到"

`publisher` 是持久身份不是会话，协议不存在"回调地址"。交付后任务停在 `submitted`：

1. **账本拉取（P1，全场景兜底）**：人 `/task review`；agent 会话启动时 task-context 摘要注入列出"你发布的已交付待验收 / 等待你回答"。
2. **活会话捎带提醒（P4，随唤醒编排一起做）**：交付时若 `publisher.session` 会话仍存活，`agent.inject` 一条提醒。原生语义：inject 是"下次模型请求可见"，**不是唤醒**；协议闭环不依赖它，跨 agent 的 inject 接线与唤醒编排共用同一批待验证积木，故并入 P4 落地。
3. **唤醒编排（P4 Consumer，不动协议）**：以发布者身份冷启动验收会话，积木现成——`webhook` 组（事件→拉起 Workspace 会话）、`schedule` 组、goal round-driver 模式。

### 4.6 不变式（测试直接对应）

1. 终止态拒绝一切写转换。
2. `events` 与实际状态严格同源：每个变化必有事件，反之亦然。
3. `submissions` 只追加；`done` 必有 ≥1 次提交（容器例外，其证据是子任务）。
4. `publisher` 永不可变；合同文本变更只留 amendment 事件。
5. 父链无环、同工作区；`blockedBy` 未清不可 assign。
6. 并发 assign 同一任务只有一个赢家（服务层写队列，见 6.2）。
7. 容器不可持有 worker。

## 5. 表面（包、工具、命令、注入）

### 5.1 包结构（新组 `packages/task/`）

```
packages/task/
├── README.md            # 组地图（双语）
├── task/                # 服务包 → ctx.tasks；types.ts 纯类型；inject: ['storageDomain']
├── tool-task/           # 模型工具；inject: ['tools','tasks']
├── command-task/        # /task 命令；inject: ['commands','tasks']
└── task-context/        # 摘要注入；inject: ['tasks']
```

- 全部为标准函数插件（`name`/`inject`/`Config`/`apply` 命名导出、无默认导出）；注册全部 `ctx.effect()`，fiber dispose 即注销。
- `storageDomain` 缺失 → 加载即抛（misconfiguration fails loud）。
- profile 可按需只装部分包。

### 5.2 模型工具（三个，仿 goal 组先例）

1. **`task_create`**：入 `title, description, deliverable, priority?, parent?, blockedBy?, scope?`；出任务摘要 + 合法下一步提示。
2. **`task_query`**：过滤 `status?, worker?, publisher?, parent?`，cursor 分页；条数与字节双上限（bounds 作用于完整结果）。
3. **`task_update`**：discriminated union 单工具收全部动作：
   `assign{id,worker} | ask{id,question} | answer{id,answer,descriptionUpdate?,deliverableUpdate?} | deliver{id,note,artifacts[]} | accept{id} | reject{id,reason} | release{id} | cancel{id,reason}`；闭合联合 + `assertNever` 兜底。

统一约定：返回 canonical JSON（PTC 模式免费类型化）；失败为 `isError` + 错误码；身份默认当前 agent，`worker` 可显式指定；工具描述文本逐字进快照测试。

### 5.3 人类命令（单个 `/task` 带子命令）

```
/task                          总览：状态计数 + 待我验收/待我回答
/task new 标题|说明|交付成果      三段 | 分隔；缺段报用法（三必填不可妥协）
/task list [status]            /task show t7（详情含子树与提交历史）
/task assign t7 [名字]          缺名字 = 自己上
/task deliver t7 说明 [路径...]  /task answer t7 回答
/task accept t7                /task reject t7 原因
/task cancel t7 原因           /task review（待我验收快捷视图）
```

命令结果作为消息进会话日志：人肉操作对同会话模型即时可见（model-visible ⟺ logged，无需新会话事件类型）。

### 5.4 摘要注入（`task-context` 包）

- 时机：会话首次模型请求注入一次（快照语义；会话内变化靠工具自查）。
- 形态：user-role 上下文消息（context 组规范：持久化、可回放、可压缩），零新事件类型。
- 内容与预算：状态计数 + "等你处理的（你发布的）" + "你名下的（你是 worker）"，条数与字符预算为校验过的 `Config` 字段（`maxItems` 等），超限截断并报告总数。

### 5.5 模型可见面写作规则

工具描述与错误消息只含任务域词汇（从模型视角写作）；稳定文案以快照钉死。

## 6. 工程决策

### 6.1 错误处理

`TaskError` 封闭错误码：`not-found / invalid-transition / not-owner / already-assigned / not-unblocked / container-not-assignable / cycle-detected / terminal / validation`。
`invalid-transition` 消息携带当前状态与该状态合法动作集（错误即协议说明书）。分层：参数格式由 `defineTool` 前置校验；业务规则在服务层；`storageDomain` 缺失加载即炸；无静默降级路径。

### 6.2 并发与写入顺序

- 存储层契约：单次调用原子、排序归调用方 → 服务层为每工作区维护一条 promise 链写队列，读-校验-改-写-发事件整段原子执行（不变式 6 的实现点）。
- 崩溃安全：json 后端整文件原子重发布；域版本戳不符拒绝加载。
- **已知边界**：写序列化仅单进程成立；两进程同挂一个账本有竞态（DSH 通常单进程部署；跨进程属未来 sqlite 路线）。记入 README Known Limitations。

### 6.3 存储布局

- 域名 `tasks`，域 `version: 1`（storage-domain `DomainSpec.version`），`layout: 'single'`：整工作区账本为一个人可读 JSON 文件（数百任务 < 1MB；未来嫌大→换 sqlite 后端仅改路由，协议零改动）。
- id 计数器存域 global slot：`{ [workspacePath]: nextSeq }`。
- 文件位置由 storage-json 后端管理，本包不拼接路径。

### 6.4 测试策略

1. 单元测试：状态机转换矩阵全覆盖（合法边 × 越权者 × 容器 × blockedBy × 环检测 × events 同源成对断言）。
2. 组件测试：服务 + 真实 storage-json 后端（临时目录，不 mock 存储层）。
3. REAL-composition 测试：测试 `cordis.yml` 经 Loader 真实启动四包全家，断言模型可见/用户可见输出（product-visible 插件硬规定）。
4. 录制会话快照（keyless replay）：脚本会话覆盖 `create → assign → ask/answer → deliver → reject → deliver → accept` 全链路，钉死工具描述、错误消息、摘要注入的逐字文案。
5. 并发竞态 spec：同任务双 assign，恰一个成功（自持临时路径，遵守并行执行规则）。
6. HMR dispose 测试：卸载 fiber 后工具与命令确认注销。

### 6.5 文档与门禁

组 README + 四包双语 README（含 Known Limitations）；`docs/subsystems/task.md` 子系统契约页；Agent Note 入 `.agents/notes/`；`packages/README.md` 组表与根 `AGENTS.md` 布局表登记；tool catalog / config catalog 随 `doc-sync` 生成通过。

### 6.6 P1 完工定义（DoD）

1. 会话 A（模型）`task_create` 真实合同 → 会话 B 摘要注入即时可见。
2. B `assign` + `deliver` → A 摘要出现"待你验收"；A `accept` → `done`。
3. 对终止态再操作 → 错误消息自解释。
4. 人全程 `/task` 命令走同一闭环，账面结果与模型路径一致。
5. 中途杀进程重启，账本完好、状态连续。
6. `pnpm run test / typecheck / lint / doc-sync` 全绿，快照与 REAL-composition 守卫就位。

## 7. 已知限制（随 P1 README 发布）

1. 无身份认证：同进程可信环境，名字冒充不在 P1 防御面（账本协议与跨网络协议的本质边界）。
2. 写序列化仅单进程成立（见 6.2）。
3. P1 不做任何主动通知（含活会话捎带提醒）：账本拉取 + 会话开场摘要注入是全部感知面；通知与唤醒编排统一在 P4。
4. 审校态、自动路由、模版注册、GUI 均在后续期次；状态集届时按版本升级演进。

## 8. 先例参照（外部佐证）

- [A2A 协议规范](https://raw.githubusercontent.com/a2aproject/A2A/main/docs/specification.md)：Task 状态机含打断态（input-required ≈ 本设计 `awaiting_input`）；终止态显式声明且封存；Task/Artifact 分离 ≈ `deliverable` 定义与 `submissions` 分离；Opaque Execution 原则 ≈ 合同自包含 + worker 冷启动。差异：本设计是工作区内账本协议，无传输层/鉴权/流式/推送。
- [CrewAI Task](https://docs.crewai.com/v1.15.18/en/concepts/tasks)：`expected_output` 必填 ≈ `deliverable` 必填。
- Contract Net Protocol（Smith, 1980）：公告→投标→授标→回报的 publisher-worker 异步闭环同构先例。
- [LLM-as-a-judge 护栏研究](https://arxiv-org.ezproxy.obspm.fr/html/2609.02246v1)：支持"审校仅质量门、发布者终审、重试上限升级人工"（P4 决策依据）。
- GitHub Issues / sub-issues：人类世界验证过的合同-指派-验收模式与任务树先例。

## 附录 A：后续阶段意向（非本规格承诺）

- **P2 模版注册表**：preset 名册之上的路由元数据（说明/标签），注册校验 preset id 存在；可缓存目录注入（字节级稳定前缀）。与 P1 互不可见。
- **P3 派单路由**：一次性 LLM 调用（可为 tool_use），输入 = 稳定模版目录 + 任务合同，输出 = 模版标识；发布时可指定模版跳过路由；scope 重叠互斥调度在此。
- **P4 执行流水线**：冷启动 subagent（按模版 preset）执行 → 一次性 LLM 审校对照 `deliverable`（重试上限为配置字段，超限特殊标记）→ `submitted` → 唤醒发布者终审（webhook/schedule/driver，见 4.5）。隔离三层：scope 字段 + `fs/write-intent` 策略插件执法 + worktree/e2b 隔离与合并（本地 worktree 生命周期管理为当前真实缺口，e2b 后端现成）。
- **P5 Web GUI**：看板/树视图，只读账本 + 受控写操作。
