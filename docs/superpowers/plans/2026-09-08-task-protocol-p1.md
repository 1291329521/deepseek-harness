# 任务协议 P1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 `packages/task/` 组四个插件（`task`、`tool-task`、`command-task`、`task-context`），交付跨会话持久任务账本的人工闭环（创建 → assign → ask/answer → deliver → accept/reject/release/cancel），含容器任务树与聚合验收。

**架构：** 协议数据存 `storage-domain` 的 `tasks` 域（json 后端，base bundle 已配好路由）；`task` 服务包按工作区串行化写入并在服务层强制状态机；三个 Consumer 包分别注册模型工具、`/task` 命令和会话开场摘要注入。规格见 [`docs/superpowers/specs/2026-09-08-task-protocol-p1.md`](../specs/2026-09-08-task-protocol-p1.md)。

**技术栈：** TypeScript（strict, ESM, NodeNext）、Cordis 插件（`name/inject/Config/apply` + `ctx.effect`）、`zod` v4（域记录 schema）、`@deepseek-ai/schemastery`（插件 Config）、vitest。

**对规格的两处实现级精化（执行时不需再决策）：**
1. 工作区隔离键 = `agent.session.header.cwd ?? process.cwd()`（规格 3.2 说的"工作区根目录绝对路径"在运行时的取值来源；不依赖 `ctx.workspaceRegistry`，因 headless profile 不挂载 workspace 组）。
2. 身份名来源 = 各插件 Config 字段：`tool-task` 的 `identityName`（默认 `"agent"`）、`command-task` 的 `identityName`（默认 `"human"`）。不引入用户系统。

**前置：** 仓库根 `pnpm install` 已完成。步骤中的 `pnpm run test -- <filter>` 是 vitest 文件子串过滤。快照录制步骤（任务 11）需要 `DEEPSEEK_API_KEY`，无 key 时明确停下来报告，不跳过不谎报。

---

## 文件结构（决策已锁定）

```
packages/task/
├── README.md / README.zh.md / README.i18n.yaml      # 任务 10
├── task/                                            # 服务包 → ctx.tasks
│   ├── package.json  tsconfig.json
│   ├── src/types.ts      # 纯类型：TaskId/TaskWorkspaceKey 品牌、Actor、TaskRecord、视图类型
│   ├── src/errors.ts     # TaskError + 封闭错误码 + legalActionsFor
│   ├── src/schema.ts     # zod v4 记录 schema（TaskRecord/Actor/…）
│   ├── src/spec.ts       # defineDomain：name 'tasks', version 1, global 计数器, tables.tasks
│   ├── src/machine.ts    # 纯函数 applyTransition + 容器重算 childrenOf/needsParentRecompute
│   ├── src/service.ts    # TaskService：per-workspace 写链、create/list/act、树校验、父链重算
│   ├── src/index.ts      # 插件 name/inject/Config/apply；Context 合并；re-export
│   └── tests/
│       ├── schema.spec.ts       # 记录 schema 接受/拒绝
│       ├── machine.spec.ts      # 转换矩阵全覆盖（表驱动）
│       ├── service.spec.ts      # 真 storage-json 于临时目录（不 mock 存储层）
│       └── loader.spec.ts       # cordis.yml 经真实 Loader 启动 + HMR dispose
├── tool-task/                                       # 模型工具
│   ├── package.json  tsconfig.json
│   ├── src/index.ts    # task_create / task_query / task_update
│   └── tests/tool-task.spec.ts
├── command-task/                                    # /task 命令
│   ├── package.json  tsconfig.json
│   ├── src/grammar.ts  # 纯解析：parseTaskCommand(rawInput)
│   ├── src/index.ts    # ctx.commands.register + 渲染
│   └── tests/grammar.spec.ts
└── task-context/                                    # 开场摘要注入
    ├── package.json  tsconfig.json
    ├── src/render.ts   # 纯函数 renderLedgerSummary(tasks, {maxItems, charBudget})
    ├── src/index.ts    # projection 'taskLedger' 折叠注入标记 + agent/pre-step turn1step1 注入
    └── tests/render.spec.ts
docs/subsystems/task.md + task.zh.md                  # 任务 10
.agents/notes/implemented/feature/2026-09-08-task-protocol-p1.md  # 任务 10
修改：tsconfig.host.json（4 条 references）、packages/README.md（组表 1 行）、
     packages/bundle/base/package.json（4 条 dependencies）、
     packages/bundle/base/cordis.patch.yml（4 行 insert）、snapshots/session/task-protocol/（任务 11）
```

**参考实现（执行每个任务前先读对应范本）：** 服务包形态 `packages/storage/storage-domain/src/index.ts`（`ctx.provide` + `ctx.effect`）；域声明 `packages/workspace/workspace/src/spec.ts:68-77`；工具形态 `packages/goal/tool-goal/src/index.ts`；命令形态 `packages/goal/command-goal/src/index.ts:188-196`；注入形态 `packages/context/time-context/src/index.ts:152-235`；Loader 启动测试 `packages/todo/tool-todo/tests/loader-composition.spec.ts`；包注册清单 [docs/cookbook/adding-a-package.md](../../cookbook/adding-a-package.md) §1-2。

**已核实的 API（直接使用，不要自造）：**
- `ctx.storageDomain.open(spec): Promise<Domain<S>>`；`domain.table(name): KvTable<K,V>`（`get/put/update/delete/entries/keys/size`）；`domain.global.get()/set()`；`domain.close()`。域自带单一写链，但**跨记录原子性仍需服务层工作区写链**。
- `defineDomain({name, version, global:{schema, initial}, tables:{tasks: domainTable<K,V>(zodSchema)}})` 来自 `@deepseek-ai/dsh-storage-domain`。
- 工具：`ctx.tools.register(defineTool({name, description, parameters: {k: {type, required?, enum?, items?, description}}, output: {schema, render}, execute(args, exec), presentCall?}))`；`exec.agent?: Agent`；`import { defineTool } from '@deepseek-ai/dsh-tools'`。
- 命令：`ctx.commands.register({name, description, input: {hint}, handler: inv => CommandResult | Promise<CommandResult>})`；`CommandResult = {kind:'success'|'error', text}`；`inv.agent`、`inv.rawInput`。类型自 `@deepseek-ai/dsh-commands`。
- 注入：`ctx.sessionProjections.register({key, stateVersion, stateSchema, init, apply})`；`ctx.on('agent/pre-step', async ({agent, turn, step, signal}, next) => PreStepDecision, {prepend: true})`；注入消息 = `createUserMessage({content: [{type:'text', text}], source: {kind:'plugin', plugin: name, form:'snapshot', sections: [{name, text}]}})`（`createUserMessage` 来自 `@deepseek-ai/dsh-llm`）。
- 品牌 id：`import type { Branded } from '@deepseek-ai/dsh-brand'`；`export type TaskId = Branded<'TaskId'>`；运行时无工厂——zod parse 后的 string 直接 `as TaskId`（对齐 `packages/goal/goal/src/runtime.ts:15-16`）。
- 插件 Config：`import z from '@deepseek-ai/schemastery'` + `export const Config: z<Config> = z.object({...})` + `export function apply(ctx: Context, config: Config)`。
- 记录 schema 用 zod v4：`import { z as zod } from 'zod'`。

**包 JSON 不变式（hygiene 门禁会查）：** `version` 与根 `package.json` 一致（当前 `0.1.3-alpha.1`）、`type: "module"`、`main: "lib/index.js"`、`types: "lib/types/index.d.ts"`、`@deepseek-ai/cordis` 同时出现在 `peerDependencies` 和 `devDependencies`、每个 dsh peer 依赖镜像进 `devDependencies`、`@deepseek-ai/schemastery` 与 `zod` 在 `dependencies`、`files` 恰为 `["lib/index.js", "lib/types/**/*.d.ts"]`。相对导入写 `.ts` 后缀。

---

### 任务 1：`task` 包骨架 + 根配置注册

**文件：**
- 创建：`packages/task/task/package.json`、`packages/task/task/tsconfig.json`、`packages/task/task/src/index.ts`（临时最小导出）

- [ ] **步骤 1：创建 package.json**

`packages/task/task/package.json`（对照 `packages/goal/goal/package.json` 的 gates 形状）：

```json
{
  "name": "@deepseek-ai/dsh-task",
  "description": "Durable cross-session task ledger domain: contract fields, enforced state machine, workspace isolation, and task-tree container rules",
  "version": "0.1.3-alpha.1",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./types": { "types": "./lib/types/types.d.ts", "default": "./lib/types/types.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts"],
  "dependencies": {
    "@deepseek-ai/schemastery": "workspace:^",
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-brand": "workspace:^",
    "@deepseek-ai/dsh-storage-domain": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-brand": "workspace:^",
    "@deepseek-ai/dsh-storage-domain": "workspace:^"
  }
}
```

- [ ] **步骤 2：创建 tsconfig.json**

`packages/task/task/tsconfig.json`：

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
  "references": [
    { "path": "../../../vendor/cosmokit" },
    { "path": "../../../vendor/cordis" },
    { "path": "../../../vendor/schemastery" },
    { "path": "../../storage/storage-domain" },
    { "path": "../../util/brand" }
  ],
  "include": ["src/**/*.ts"]
}
```

若 `packages/util/brand` 路径不存在，用 `ls packages/util | grep brand` 找实际目录名后修正（只改这一条 reference）。

- [ ] **步骤 3：临时 src/index.ts**

```ts
/**
 * Durable cross-session task ledger: the tasks domain, enforced state machine,
 * and workspace-scoped service (`ctx.tasks`).
 * @module @deepseek-ai/dsh-task
 */
export {}
```

- [ ] **步骤 4：登记根配置**

1. `tsconfig.host.json` 的 `references` 数组追加（紧邻 goal 组四行之后）：

```json
    { "path": "./packages/task/task" },
```

（任务 6/7/8 完成各自包时再补其余三条，勿一次写死。）

2. 运行生成器登记路径别名：

```sh
pnpm run gen-tsconfig-paths
```

预期：`tsconfig.base.json` 的 generated 区出现 `"@deepseek-ai/dsh-task": ["./packages/task/task/src"]`。

3. `pnpm install`（workspaces glob 自动收纳；预期 `@deepseek-ai/dsh-task` 出现在 lockfile）。

- [ ] **步骤 5：编译验证**

运行：`pnpm run typecheck`
预期：PASS（新包仅空导出）。

- [ ] **步骤 6：Commit**

```sh
git add packages/task/task/package.json packages/task/task/tsconfig.json packages/task/task/src/index.ts tsconfig.host.json tsconfig.base.json pnpm-lock.yaml
git commit -m "feat(task): scaffold the task service package"
```

---

### 任务 2：纯类型 + 错误 + zod schema + 域声明

**文件：**
- 创建：`packages/task/task/src/types.ts`、`src/errors.ts`、`src/schema.ts`、`src/spec.ts`
- 修改：`packages/task/task/src/index.ts`
- 测试：`packages/task/task/tests/schema.spec.ts`

- [ ] **步骤 1：编写失败的测试**

`packages/task/task/tests/schema.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { taskRecordSchema, taskDomainSpec } from '../src/spec.ts'

function validRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1',
    workspace: '/repo/app',
    title: '补中文文档',
    description: '为 storage 子系统写 docs/subsystems/storage.zh.md',
    deliverable: '文件存在且与英文版逐节对齐',
    priority: 'normal',
    status: 'open',
    publisher: { kind: 'human', name: 'weishuhao' },
    blockedBy: [],
    publishedAt: '2026-09-08T00:00:00.000Z',
    submissions: [],
    events: [{ seq: 1, at: '2026-09-08T00:00:00.000Z', actor: { kind: 'human', name: 'weishuhao' }, action: 'create' }],
    ...over,
  }
}

describe('taskRecordSchema', () => {
  it('accepts a minimal contract', () => {
    expect(taskRecordSchema.safeParse(validRecord()).success).toBe(true)
  })
  it('rejects a record without the deliverable contract text', () => {
    const rec = validRecord()
    delete rec.deliverable
    expect(taskRecordSchema.safeParse(rec).success).toBe(false)
  })
  it('rejects an empty description', () => {
    expect(taskRecordSchema.safeParse(validRecord({ description: '' })).success).toBe(false)
  })
  it('rejects an unknown status', () => {
    expect(taskRecordSchema.safeParse(validRecord({ status: 'reviewing' })).success).toBe(false)
  })
  it('rejects unknown extra fields', () => {
    expect(taskRecordSchema.safeParse(validRecord({ extra: 1 })).success).toBe(false)
  })
  it('rejects a bad task id shape', () => {
    expect(taskRecordSchema.safeParse(validRecord({ id: 'task-1' })).success).toBe(false)
  })
})

describe('taskDomainSpec', () => {
  it('declares the tasks domain at version 1 with the tasks table', () => {
    expect(taskDomainSpec.name).toBe('tasks')
    expect(taskDomainSpec.version).toBe(1)
    expect(Object.keys(taskDomainSpec.tables)).toEqual(['tasks'])
  })
})
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm run test -- packages/task/task/tests/schema.spec.ts`
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 `src/types.ts`**

```ts
/**
 * Pure types of the task domain: the ONE home of the workspace-scoped task
 * record shape, actor identity, and view types, free of runtime imports.
 * @module @deepseek-ai/dsh-task/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque task id; displayed as a workspace-sequential `t<n>` handle. */
export type TaskId = Branded<'TaskId'>

/** Opaque workspace isolation key: the resolved absolute session root. */
export type TaskWorkspaceKey = Branded<'TaskWorkspaceKey'>

/** Who acts on the ledger: a durable name, not a live session. */
export interface TaskActor {
  kind: 'human' | 'agent'
  name: string
  /** Session the operation rode; provenance only, never a callback address. */
  session?: string
}

/** The six protocol statuses. Evolution happens by bumping the domain version. */
export type TaskStatus = 'open' | 'in_progress' | 'awaiting_input' | 'submitted' | 'done' | 'cancelled'

/** One append-only delivery. */
export interface TaskSubmission {
  at: string
  by: TaskActor
  note: string
  artifacts: string[]
}

/** One append-only audit entry; the ledger state and this log share one origin. */
export interface TaskTransition {
  seq: number
  at: string
  actor: TaskActor
  action: string
  reason?: string
  /** Present on answer actions that rewrote contract text. */
  contractEdited?: true
}

/** The durable task record stored in the `tasks` domain. */
export interface TaskRecord {
  id: TaskId
  workspace: TaskWorkspaceKey
  title: string
  description: string
  deliverable: string
  priority: 'low' | 'normal' | 'high'
  status: TaskStatus
  publisher: TaskActor
  worker?: TaskActor
  parent?: TaskId
  blockedBy: TaskId[]
  scope?: string[]
  publishedAt: string
  workerSetAt?: string
  deliveredAt?: string
  submissions: TaskSubmission[]
  events: TaskTransition[]
}

/** Global counter slot: next sequence number per workspace. */
export interface TaskLedgerGlobal {
  next: Record<string, number>
}

/** Fields a create operation supplies. */
export interface TaskCreateRequest {
  title: string
  description: string
  deliverable: string
  priority?: 'low' | 'normal' | 'high'
  parent?: string
  blockedBy?: string[]
  scope?: string[]
}

/** The action union the service accepts; tools and commands map onto it 1:1. */
export type TaskAction =
  | { kind: 'assign'; worker: TaskActor }
  | { kind: 'ask'; question: string }
  | { kind: 'answer'; answer: string; descriptionUpdate?: string; deliverableUpdate?: string }
  | { kind: 'deliver'; note: string; artifacts: string[] }
  | { kind: 'accept' }
  | { kind: 'reject'; reason: string }
  | { kind: 'release' }
  | { kind: 'cancel'; reason: string }

/** Filter for list reads. */
export interface TaskFilter {
  status?: TaskStatus
  publisherName?: string
  workerName?: string
  parent?: string
}
```

- [ ] **步骤 4：实现 `src/errors.ts`**

```ts
/**
 * Closed task-domain errors. `invalid-transition` messages carry the current
 * status and its legal actions so the caller can self-correct.
 * @module @deepseek-ai/dsh-task/errors
 */

import type { TaskStatus } from './types.ts'

/** Machine-readable task failure codes. */
export type TaskErrorCode =
  | 'not-found'
  | 'invalid-transition'
  | 'not-owner'
  | 'already-assigned'
  | 'not-unblocked'
  | 'container-not-assignable'
  | 'cycle-detected'
  | 'terminal'
  | 'validation'

/** Legal actions advertised per status (model-facing vocabulary). */
const LEGAL_ACTIONS: Record<TaskStatus, readonly string[]> = {
  open: ['assign'],
  in_progress: ['ask', 'deliver', 'release', 'cancel'],
  awaiting_input: ['answer', 'cancel'],
  submitted: ['accept', 'reject', 'cancel'],
  done: [],
  cancelled: [],
}

/** Throw-ready domain error. */
export class TaskError extends Error {
  constructor(readonly code: TaskErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TaskError'
  }
}

/** Legal action names for one status, for error text. */
export function legalActionsFor(status: TaskStatus): readonly string[] {
  return LEGAL_ACTIONS[status]
}
```

- [ ] **步骤 5：实现 `src/schema.ts` 与 `src/spec.ts`**

`src/schema.ts`：

```ts
/**
 * zod v4 record schemas of the tasks domain; the single validation home for
 * stored records and their view projection.
 * @module @deepseek-ai/dsh-task/schema
 */

import { z as zod } from 'zod'

const actorSchema = zod.object({
  kind: zod.enum(['human', 'agent']),
  name: zod.string().min(1).max(200),
  session: zod.string().optional(),
}).strict()

const submissionSchema = zod.object({
  at: zod.string().min(1),
  by: actorSchema,
  note: zod.string().min(1),
  artifacts: zod.array(zod.string().min(1)),
}).strict()

const transitionSchema = zod.object({
  seq: zod.number().int().positive(),
  at: zod.string().min(1),
  actor: actorSchema,
  action: zod.string().min(1),
  reason: zod.string().optional(),
  contractEdited: zod.literal(true).optional(),
}).strict()

/** One durable task record. */
export const taskRecordSchema = zod.object({
  id: zod.string().regex(/^t[1-9][0-9]*$/),
  workspace: zod.string().min(1),
  title: zod.string().min(1).max(500),
  description: zod.string().min(1),
  deliverable: zod.string().min(1),
  priority: zod.enum(['low', 'normal', 'high']),
  status: zod.enum(['open', 'in_progress', 'awaiting_input', 'submitted', 'done', 'cancelled']),
  publisher: actorSchema,
  worker: actorSchema.optional(),
  parent: zod.string().regex(/^t[1-9][0-9]*$/).optional(),
  blockedBy: zod.array(zod.string().regex(/^t[1-9][0-9]*$/)),
  scope: zod.array(zod.string().min(1)).optional(),
  publishedAt: zod.string().min(1),
  workerSetAt: zod.string().optional(),
  deliveredAt: zod.string().optional(),
  submissions: zod.array(submissionSchema),
  events: zod.array(transitionSchema),
}).strict()

/** Global next-sequence counter per workspace. */
export const taskLedgerGlobalSchema = zod.object({
  next: zod.record(zod.string(), zod.number().int().positive()),
}).strict()
```

`src/spec.ts`：

```ts
/**
 * The tasks domain declaration: identity, version, and record schemas through
 * `defineDomain` (the workspace spec is the structural twin).
 * @module @deepseek-ai/dsh-task/spec
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { taskLedgerGlobalSchema, taskRecordSchema } from './schema.ts'
import type { TaskId, TaskLedgerGlobal, TaskRecord } from './types.ts'

export { taskRecordSchema } from './schema.ts'

/** The tasks domain: one record per task, keyed by task id. */
export const taskDomainSpec = defineDomain({
  name: 'tasks',
  version: 1,
  global: {
    schema: taskLedgerGlobalSchema,
    initial: { next: {} },
  },
  tables: { tasks: domainTable<TaskId, TaskRecord>(taskRecordSchema) },
})
```

- [ ] **步骤 6：更新 `src/index.ts`**

```ts
/**
 * Durable cross-session task ledger: the tasks domain, enforced state machine,
 * and workspace-scoped service (`ctx.tasks`).
 * @module @deepseek-ai/dsh-task
 */

export type * from './types.ts'
export { TaskError, legalActionsFor } from './errors.ts'
export type { TaskErrorCode } from './errors.ts'
export { taskDomainSpec, taskRecordSchema } from './spec.ts'
```

- [ ] **步骤 7：运行验证通过**

运行：`pnpm run test -- packages/task/task/tests/schema.spec.ts`
预期：6 个测试全 PASS。
再运行：`pnpm run typecheck`，预期 PASS。

- [ ] **步骤 8：Commit**

```sh
git add packages/task/task/src packages/task/task/tests
git commit -m "feat(task): task record schema, errors, and domain spec"
```

---

### 任务 3：纯状态机（转换矩阵全覆盖）

**文件：**
- 创建：`packages/task/task/src/machine.ts`
- 测试：`packages/task/task/tests/machine.spec.ts`

- [ ] **步骤 1：编写失败的测试（表驱动全覆盖）**

`packages/task/task/tests/machine.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { applyTransition } from '../src/machine.ts'
import { TaskError } from '../src/errors.ts'
import type { TaskActor, TaskRecord } from '../src/types.ts'

const HUMAN: TaskActor = { kind: 'human', name: 'weishuhao' }
const AGENT: TaskActor = { kind: 'agent', name: 'docs-writer' }

function record(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1' as TaskRecord['id'],
    workspace: '/repo' as TaskRecord['workspace'],
    title: 'x', description: 'd', deliverable: 'done-when',
    priority: 'normal', status: 'open', publisher: HUMAN, blockedBy: [],
    publishedAt: '2026-09-08T00:00:00.000Z', submissions: [], events: [],
    ...over,
  }
}

describe('applyTransition', () => {
  it('open -> in_progress via assign (self-fill, no privilege)', () => {
    const next = applyTransition(record(), { kind: 'assign', worker: AGENT }, AGENT, 2)
    expect(next.status).toBe('in_progress')
    expect(next.worker).toEqual(AGENT)
    expect(next.events).toHaveLength(1)
  })
  it('assign onto an occupied slot by a stranger rejects not-owner', () => {
    const rec = record({ status: 'in_progress', worker: AGENT })
    const opponent: TaskActor = { kind: 'agent', name: 'opponent' }
    expect(() => applyTransition(rec, { kind: 'assign', worker: opponent }, opponent, 2))
      .toThrowError(expect.objectContaining({ code: 'not-owner' }))
  })
  it('publisher may swap the worker while in progress', () => {
    const rec = record({ status: 'in_progress', worker: AGENT })
    const other: TaskActor = { kind: 'agent', name: 'other' }
    const next = applyTransition(rec, { kind: 'assign', worker: other }, HUMAN, 2)
    expect(next.worker).toEqual(other)
  })
  it('ask is worker-only', () => {
    const rec = record({ status: 'in_progress', worker: AGENT })
    expect(() => applyTransition(rec, { kind: 'ask', question: '?' }, HUMAN, 2))
      .toThrowError(expect.objectContaining({ code: 'not-owner' }))
    expect(applyTransition(rec, { kind: 'ask', question: '?' }, AGENT, 2).status).toBe('awaiting_input')
  })
  it('answer returns to in_progress and a contract edit is stamped as an amendment', () => {
    const rec = record({ status: 'awaiting_input', worker: AGENT })
    const next = applyTransition(rec, { kind: 'answer', answer: 'a', descriptionUpdate: 'new d' }, HUMAN, 2)
    expect(next.status).toBe('in_progress')
    expect(next.description).toBe('new d')
    expect(next.events[0]?.contractEdited).toBe(true)
  })
  it('deliver from in_progress appends a submission and moves to submitted', () => {
    const rec = record({ status: 'in_progress', worker: AGENT })
    const next = applyTransition(rec, { kind: 'deliver', note: 'n', artifacts: ['a.md'] }, AGENT, 2)
    expect(next.status).toBe('submitted')
    expect(next.submissions).toHaveLength(1)
    expect(next.deliveredAt).toBeTruthy()
  })
  it('accept is publisher-only and reaches the terminal done', () => {
    const rec = record({ status: 'submitted', worker: AGENT, submissions: [
      { at: 'x', by: AGENT, note: 'n', artifacts: [] },
    ] })
    expect(() => applyTransition(rec, { kind: 'accept' }, AGENT, 2))
      .toThrowError(expect.objectContaining({ code: 'not-owner' }))
    expect(applyTransition(rec, { kind: 'accept' }, HUMAN, 2).status).toBe('done')
  })
  it('reject returns to in_progress keeping the same worker and requires a reason', () => {
    const rec = record({ status: 'submitted', worker: AGENT })
    const next = applyTransition(rec, { kind: 'reject', reason: '目录未汉化' }, HUMAN, 2)
    expect(next.status).toBe('in_progress')
    expect(next.worker).toEqual(AGENT)
    expect(next.events[0]?.reason).toBe('目录未汉化')
  })
  it('release clears the worker and returns to open', () => {
    const rec = record({ status: 'in_progress', worker: AGENT })
    const next = applyTransition(rec, { kind: 'release' }, AGENT, 2)
    expect(next.status).toBe('open')
    expect(next.worker).toBeUndefined()
  })
  it('cancel is publisher-only from any non-terminal status', () => {
    for (const status of ['open', 'in_progress', 'awaiting_input', 'submitted'] as const) {
      const rec = record({ status, worker: AGENT })
      expect(applyTransition(rec, { kind: 'cancel', reason: 'r' }, HUMAN, 2).status).toBe('cancelled')
    }
    expect(() => applyTransition(record({ status: 'open' }), { kind: 'cancel', reason: 'r' }, AGENT, 2))
      .toThrowError(expect.objectContaining({ code: 'not-owner' }))
  })
  it('terminal records reject every action with the terminal code', () => {
    for (const status of ['done', 'cancelled'] as const) {
      const rec = record({ status })
      expect(() => applyTransition(rec, { kind: 'assign', worker: AGENT }, AGENT, 2))
        .toThrowError(expect.objectContaining({ code: 'terminal' }))
    }
  })
  it('assign while blockedBy is unsettled rejects not-unblocked', () => {
    const rec = record({ blockedBy: ['t9' as TaskRecord['id']] })
    expect(() => applyTransition(rec, { kind: 'assign', worker: AGENT }, AGENT, 2, { unblocked: false }))
      .toThrowError(expect.objectContaining({ code: 'not-unblocked' }))
  })
  it('invalid-transition text carries current status and legal actions', () => {
    try {
      applyTransition(record({ status: 'open' }), { kind: 'accept' }, HUMAN, 2)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(TaskError)
      const message = (error as TaskError).message
      expect(message).toContain('open')
      expect(message).toContain('assign')
    }
  })
})
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm run test -- packages/task/task/tests/machine.spec.ts`
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 `src/machine.ts`**

```ts
/**
 * Pure task state machine: every legal transition, its authority check, and
 * its audit stamp. It performs no IO; the service owns durability, tree
 * rules, and workspace scoping around it.
 * @module @deepseek-ai/dsh-task/machine
 */

import { TaskError, legalActionsFor } from './errors.ts'
import type { TaskAction, TaskActor, TaskRecord, TaskStatus, TaskTransition } from './types.ts'

/** Same durable identity: kind plus name. */
export function sameActor(a: TaskActor | undefined, b: TaskActor): boolean {
  return a !== undefined && a.kind === b.kind && a.name === b.name
}

/** Throw the protocol's self-explaining refusal. */
function invalid(record: TaskRecord): never {
  throw new TaskError('invalid-transition',
    `This task is '${record.status}'. Legal actions from this status: [${legalActionsFor(record.status).join(', ')}].`)
}

function terminal(record: TaskRecord): never {
  throw new TaskError('terminal', `Task '${record.id}' is ${record.status}; terminal records accept no operation.`)
}

function requireOwner(cond: boolean, message: string): void {
  if (!cond) throw new TaskError('not-owner', message)
}

/** Apply one action to one record; returns the next immutable record. */
export function applyTransition(
  current: TaskRecord,
  action: TaskAction,
  actor: TaskActor,
  nowMs: number,
  context?: { unblocked?: boolean; isContainer?: boolean },
): TaskRecord {
  if (current.status === 'done' || current.status === 'cancelled') terminal(current)
  if (action.kind === 'assign' && context?.isContainer === true) {
    throw new TaskError('container-not-assignable',
      `Task '${current.id}' is a container: assign workers to leaf tasks, containers complete through their children.`)
  }
  if (action.kind === 'assign' && context?.unblocked === false) {
    throw new TaskError('not-unblocked',
      `Task '${current.id}' is blocked by: ${current.blockedBy.join(', ')}. Those tasks must complete first.`)
  }
  const at = new Date(nowMs).toISOString()
  const base = { ...current, events: [...current.events] }
  const stamp = (kind: string, extra: Partial<TaskTransition> = {}): TaskRecord => ({
    ...base,
    events: [...current.events, { seq: current.events.length + 1, at, actor, action: kind, ...extra }],
  })
  switch (action.kind) {
    case 'assign': {
      if (current.status === 'in_progress' || current.status === 'awaiting_input') {
        requireOwner(sameActor(current.publisher, actor),
          `Only the publisher may replace the worker of an assigned task; current worker: ${current.worker?.name ?? 'none'}.`)
        return { ...stamp('assign', { reason: `worker replaced: ${current.worker?.name ?? '?'} -> ${action.worker.name}` }),
          worker: action.worker, status: 'in_progress', workerSetAt: at }
      }
      if (current.status !== 'open') invalid(current)
      return { ...stamp('assign'), worker: action.worker, status: 'in_progress', workerSetAt: at }
    }
    case 'ask': {
      if (current.status !== 'in_progress') invalid(current)
      requireOwner(sameActor(current.worker, actor), 'Only the current worker can ask.')
      return { ...stamp('ask', { reason: action.question }), status: 'awaiting_input' }
    }
    case 'answer': {
      if (current.status !== 'awaiting_input') invalid(current)
      requireOwner(sameActor(current.publisher, actor), 'Only the publisher can answer and amend the contract.')
      const edited = action.descriptionUpdate !== undefined || action.deliverableUpdate !== undefined
      return {
        ...stamp('answer', edited ? { contractEdited: true } : {}),
        description: action.descriptionUpdate ?? current.description,
        deliverable: action.deliverableUpdate ?? current.deliverable,
        status: 'in_progress',
      }
    }
    case 'deliver': {
      if (current.status !== 'in_progress') invalid(current)
      requireOwner(sameActor(current.worker, actor), 'Only the current worker can deliver.')
      return { ...stamp('deliver'),
        status: 'submitted', deliveredAt: at,
        submissions: [...current.submissions, { at, by: actor, note: action.note, artifacts: action.artifacts }] }
    }
    case 'accept': {
      if (current.status !== 'submitted') invalid(current)
      requireOwner(sameActor(current.publisher, actor), 'Only the publisher can accept a delivery.')
      return { ...stamp('accept'), status: 'done' }
    }
    case 'reject': {
      if (current.status !== 'submitted') invalid(current)
      requireOwner(sameActor(current.publisher, actor), 'Only the publisher can reject a delivery.')
      if (action.reason.trim().length === 0) {
        throw new TaskError('validation', 'A rejection must carry the reason for the rework.')
      }
      // A rejected container returns to open (its tree is re-editable); a
      // rejected leaf returns to its still-assigned worker.
      return { ...stamp('reject', { reason: action.reason }),
        status: context?.isContainer === true ? 'open' : 'in_progress' }
    }
    case 'release': {
      if (current.status !== 'in_progress') invalid(current)
      requireOwner(sameActor(current.worker, actor), 'Only the current worker can release.')
      const released = stamp('release')
      const next: TaskRecord = { ...released, status: 'open' }
      delete next.worker
      delete next.workerSetAt
      return next
    }
    case 'cancel': {
      requireOwner(sameActor(current.publisher, actor), 'Only the publisher can cancel the contract.')
      if (action.reason.trim().length === 0) {
        throw new TaskError('validation', 'A cancellation must carry a reason.')
      }
      return { ...stamp('cancel', { reason: action.reason }), status: 'cancelled' }
    }
  }
}

/** True when a status ends the ledger. */
export function isTerminal(status: TaskStatus): boolean {
  return status === 'done' || status === 'cancelled'
}
```

- [ ] **步骤 4：运行验证通过**

运行：`pnpm run test -- packages/task/task/tests/machine.spec.ts`
预期：13 个测试全 PASS。`pnpm run typecheck` PASS。

- [ ] **步骤 5：Commit**

```sh
git add packages/task/task/src/machine.ts packages/task/task/tests/machine.spec.ts
git commit -m "feat(task): pure task state machine with authority rules and audit stamps"
```

---

### 任务 4：TaskService（工作区写链、树规则、容器重算）

**文件：**
- 创建：`packages/task/task/src/service.ts`
- 修改：`packages/task/task/src/index.ts`
- 测试：`packages/task/task/tests/service.spec.ts`

- [ ] **步骤 1：编写失败的测试（真 storage-json，不 mock 存储层）**

`packages/task/task/tests/service.spec.ts`：

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import StorageJson from '@deepseek-ai/dsh-storage-json'
import StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { TaskService } from '../src/service.ts'
import { TaskError } from '../src/errors.ts'
import type { TaskActor, TaskCreateRequest } from '../src/types.ts'

const WS = '/ws/alpha'
const HUMAN: TaskActor = { kind: 'human', name: 'weishuhao' }
const AGENT: TaskActor = { kind: 'agent', name: 'docs-writer' }

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<TaskService> {
  root = await mkdtemp(join(tmpdir(), 'dsh-task-'))
  ctx = new Context()
  ctx.plugin(Storage)
  ctx.plugin(StorageJson, { root })
  ctx.plugin(StorageDomain, { backend: 'json' })
  const service = new TaskService(ctx, { maxDescriptionBytes: 65536 })
  ctx.effect(() => () => service.dispose())
  await ctx.start()
  return service
}

function req(over: Partial<TaskCreateRequest> = {}): TaskCreateRequest {
  return { title: 't', description: 'd', deliverable: 'w', ...over }
}

describe('TaskService', () => {
  it('creates sequential ids per workspace and lists them', async () => {
    const service = await boot()
    const a = await service.create(WS, HUMAN, req({ title: 'one' }))
    const b = await service.create(WS, HUMAN, req({ title: 'two' }))
    expect(a.id).toBe('t1')
    expect(b.id).toBe('t2')
    expect(service.list(WS, {}).map(r => r.id)).toEqual(['t1', 't2'])
    expect(service.list('/ws/other', {})).toEqual([])
  })
  it('persists across reopen of the same directory', async () => {
    const first = await boot()
    await first.create(WS, HUMAN, req())
    await ctx!.fiber.dispose()
    ctx = new Context()
    ctx.plugin(Storage)
    ctx.plugin(StorageJson, { root: root! })
    ctx.plugin(StorageDomain, { backend: 'json' })
    const again = new TaskService(ctx, { maxDescriptionBytes: 65536 })
    ctx.effect(() => () => again.dispose())
    await ctx.start()
    expect(again.list(WS, {}).map(r => r.title)).toEqual(['t'])
    const next = await again.create(WS, HUMAN, req())
    expect(next.id).toBe('t2')
  })
  it('concurrent assigns produce exactly one winner', async () => {
    const service = await boot()
    const created = await service.create(WS, HUMAN, req())
    const other: TaskActor = { kind: 'agent', name: 'other' }
    const results = await Promise.allSettled([
      service.act(WS, created.id, { kind: 'assign', worker: AGENT }, AGENT),
      service.act(WS, created.id, { kind: 'assign', worker: other }, other),
    ])
    const ok = results.filter(r => r.status === 'fulfilled')
    expect(ok).toHaveLength(1)
    const rejected = results.find(r => r.status === 'rejected')!.reason as TaskError
    expect(rejected.code).toBe('not-owner')
  })
  it('enforces blockedBy before assign and parent-chain before child deliver', async () => {
    const service = await boot()
    const blocker = await service.create(WS, HUMAN, req())
    const blocked = await service.create(WS, HUMAN, req({ blockedBy: [blocker.id] }))
    await expect(service.act(WS, blocked.id, { kind: 'assign', worker: AGENT }, AGENT))
      .rejects.toThrowError(expect.objectContaining({ code: 'not-unblocked' }))
    await service.act(WS, blocker.id, { kind: 'assign', worker: AGENT }, AGENT)
    await service.act(WS, blocker.id, { kind: 'deliver', note: 'n', artifacts: [] }, AGENT)
    await service.act(WS, blocker.id, { kind: 'accept' }, HUMAN)
    await service.act(WS, blocked.id, { kind: 'assign', worker: AGENT }, AGENT)
    expect((await service.get(WS, blocked.id))!.status).toBe('in_progress')
  })
  it('a container cannot be assigned and auto-submits when its last child is accepted', async () => {
    const service = await boot()
    const parent = await service.create(WS, HUMAN, req({ title: 'parent' }))
    const c1 = await service.create(WS, HUMAN, req({ parent: parent.id }))
    const c2 = await service.create(WS, HUMAN, req({ parent: parent.id }))
    await expect(service.act(WS, parent.id, { kind: 'assign', worker: AGENT }, AGENT))
      .rejects.toThrowError(expect.objectContaining({ code: 'container-not-assignable' }))
    for (const child of [c1, c2]) {
      await service.act(WS, child.id, { kind: 'assign', worker: AGENT }, AGENT)
      await service.act(WS, child.id, { kind: 'deliver', note: 'n', artifacts: [] }, AGENT)
      await service.act(WS, child.id, { kind: 'accept' }, HUMAN)
    }
    expect((await service.get(WS, parent.id))!.status).toBe('submitted')
    await service.act(WS, parent.id, { kind: 'accept' }, HUMAN)
    expect((await service.get(WS, parent.id))!.status).toBe('done')
  })
  it('rejecting a container returns it to open with children kept', async () => {
    const service = await boot()
    const parent = await service.create(WS, HUMAN, req({ title: 'p' }))
    const child = await service.create(WS, HUMAN, req({ parent: parent.id }))
    await service.act(WS, child.id, { kind: 'assign', worker: AGENT }, AGENT)
    await service.act(WS, child.id, { kind: 'deliver', note: 'n', artifacts: [] }, AGENT)
    await service.act(WS, child.id, { kind: 'accept' }, HUMAN)
    expect((await service.get(WS, parent.id))!.status).toBe('submitted')
    await service.act(WS, parent.id, { kind: 'reject', reason: '还差联动测试' }, HUMAN)
    expect((await service.get(WS, parent.id))!.status).toBe('open')
  })
  it('adding a child requires the parent to be open and rejects a parent cycle', async () => {
    const service = await boot()
    const parent = await service.create(WS, HUMAN, req())
    const child = await service.create(WS, HUMAN, req({ parent: parent.id }))
    await expect(service.create(WS, HUMAN, req({ parent: child.id }))).resolves.toBeTruthy()
    await expect(service.create(WS, HUMAN, req({ parent: 't999' })))
      .rejects.toThrowError(expect.objectContaining({ code: 'validation' }))
  })
})
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm run test -- packages/task/task/tests/service.spec.ts`
预期：FAIL（`service.ts` 不存在）。

- [ ] **步骤 3：实现 `src/service.ts`**

```ts
/**
 * Workspace-scoped task ledger service (`ctx.tasks`). Serializes each
 * workspace's mutations on a promise chain (storage orders single calls,
 * multi-record transitions need this chain), enforces tree rules, and
 * recomputes container aggregation after every child completion.
 * @module @deepseek-ai/dsh-task/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Domain, DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { applyTransition } from './machine.ts'
import { TaskError } from './errors.ts'
import { taskDomainSpec } from './spec.ts'
import type {
  TaskAction, TaskActor, TaskCreateRequest, TaskFilter, TaskId,
  TaskLedgerGlobal, TaskRecord, TaskWorkspaceKey,
} from './types.ts'

/** Materialized service config. */
export interface TaskServiceConfig {
  /** Hard bound on description/deliverable text length in bytes. */
  maxDescriptionBytes: number
}

const SYSTEM: TaskActor = { kind: 'agent', name: 'task-ledger' }

/** One workspace's serial mutation queue. */
type Chain = Promise<unknown>

export class TaskService {
  private readonly chains = new Map<string, Chain>()
  private domain: Promise<Domain<typeof taskDomainSpec>> | undefined
  private tableRef: KvTable<TaskId, TaskRecord> | undefined
  private globalRef: DomainGlobal<TaskLedgerGlobal> | undefined

  constructor(private readonly ctx: Context, private readonly config: TaskServiceConfig) {}

  /** Open the domain lazily; dispose closes it. */
  private async ledger(): Promise<KvTable<TaskId, TaskRecord>> {
    if (this.tableRef !== undefined) return this.tableRef
    this.domain ??= this.ctx.storageDomain.open(taskDomainSpec)
    const domain = await this.domain
    this.tableRef = domain.table('tasks')
    this.globalRef = domain.global
    return this.tableRef
  }

  /** Drain queued writes and release the domain. */
  async dispose(): Promise<void> {
    for (const chain of this.chains.values()) await chain.catch(() => undefined)
    this.chains.clear()
    const domain = await this.domain?.catch(() => undefined)
    await domain?.close()
    this.tableRef = undefined
    this.globalRef = undefined
  }

  /** Serialize one workspace mutation behind its predecessors. */
  private enqueue<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(workspace) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    this.chains.set(workspace, next.catch(() => undefined))
    return next
  }

  private async requireTask(workspace: string, id: string): Promise<TaskRecord> {
    const table = await this.ledger()
    const record = table.get(id as TaskId)
    if (record === undefined || record.workspace !== workspace) {
      throw new TaskError('not-found', `No task '${id}' exists in this workspace.`)
    }
    return record
  }

  private hasChildren(table: KvTable<TaskId, TaskRecord>, workspace: string, id: string): boolean {
    for (const [, record] of table.entries()) {
      if (record.workspace === workspace && record.parent === id) return true
    }
    return false
  }

  private unblocked(table: KvTable<TaskId, TaskRecord>, workspace: string, record: TaskRecord): boolean {
    return record.blockedBy.every(dep => {
      const target = table.get(dep)
      return target !== undefined && target.workspace === workspace && target.status === 'done'
    })
  }

  private validateCreate(request: TaskCreateRequest): void {
    const tooLong = (text: string): boolean => new TextEncoder().encode(text).length > this.config.maxDescriptionBytes
    if (request.title.trim().length === 0 || request.description.trim().length === 0
      || request.deliverable.trim().length === 0) {
      throw new TaskError('validation', 'title, description, and deliverable are required and non-empty.')
    }
    if (tooLong(request.description) || tooLong(request.deliverable)) {
      throw new TaskError('validation',
        `description and deliverable must stay within ${this.config.maxDescriptionBytes} bytes.`)
    }
  }

  /** Create one task; ids are workspace-sequential and unique. */
  async create(workspace: string, actor: TaskActor, request: TaskCreateRequest): Promise<TaskRecord> {
    this.validateCreate(request)
    const table = await this.ledger()
    return this.enqueue(workspace, async () => {
      if (request.parent !== undefined) {
        const parent = table.get(request.parent as TaskId)
        if (parent === undefined || parent.workspace !== workspace) {
          throw new TaskError('validation', `Parent task '${request.parent}' does not exist in this workspace.`)
        }
        if (parent.status !== 'open') {
          throw new TaskError('validation',
            `Children may only attach to an open parent; '${request.parent}' is ${parent.status}.`)
        }
      }
      const global = this.globalRef
      if (global === undefined) throw new TaskError('validation', 'task ledger is not open.')
      const current = global.get()
      const nextSeq = (current.next[workspace] ?? 0) + 1
      const id = `t${nextSeq}` as TaskId
      const at = new Date().toISOString()
      const record: TaskRecord = {
        id, workspace: workspace as TaskWorkspaceKey,
        title: request.title.trim(), description: request.description, deliverable: request.deliverable,
        priority: request.priority ?? 'normal', status: 'open', publisher: actor,
        blockedBy: (request.blockedBy ?? []) as TaskId[],
        ...request.scope === undefined || request.scope.length === 0 ? {} : { scope: request.scope },
        ...request.parent === undefined ? {} : { parent: request.parent as TaskId },
        publishedAt: at, submissions: [],
        events: [{ seq: 1, at, actor, action: 'create' }],
      }
      await table.put(id, record)
      await global.set({ ...current, next: { ...current.next, [workspace]: nextSeq } })
      return record
    })
  }

  /** Read one task. */
  get(workspace: string, id: string): Promise<TaskRecord | undefined> {
    return this.enqueue(workspace, async () => {
      const table = await this.ledger()
      const record = table.get(id as TaskId)
      return record !== undefined && record.workspace === workspace ? record : undefined
    })
  }

  /** Synchronous filtered listing sorted by id. */
  list(workspace: string, filter: TaskFilter): TaskRecord[] {
    const table = this.tableRef
    if (table === undefined) return []
    const records: TaskRecord[] = []
    for (const [, record] of table.entries()) {
      if (record.workspace !== workspace) continue
      if (filter.status !== undefined && record.status !== filter.status) continue
      if (filter.publisherName !== undefined && record.publisher.name !== filter.publisherName) continue
      if (filter.workerName !== undefined && record.worker?.name !== filter.workerName) continue
      if (filter.parent !== undefined && record.parent !== filter.parent) continue
      records.push(record)
    }
    return records.sort((a, b) => seq(a.id) - seq(b.id))
  }

  /** Apply one protocol action and reconcile container aggregation upwards. */
  async act(workspace: string, id: string, action: TaskAction, actor: TaskActor): Promise<TaskRecord> {
    const table = await this.ledger()
    return this.enqueue(workspace, async () => {
      const current = await this.requireTask(workspace, id)
      const next = applyTransition(current, action, actor, Date.now(), {
        unblocked: this.unblocked(table, workspace, current),
        isContainer: this.hasChildren(table, workspace, id),
      })
      await table.put(next.id, next)
      // A child leaving or entering `done` can flip each ancestor between
      // aggregated-submitted and open; walk the parent chain and reconcile.
      if (next.parent !== undefined && ['accept', 'reject', 'release', 'cancel'].includes(action.kind)) {
        await this.reconcileAncestors(workspace, next.parent)
      }
      return next
    })
  }

  /** Open containers with all children done aggregate to submitted;
   *  auto-submitted containers with any non-done child fall back to open. */
  private async reconcileAncestors(workspace: string, parentId: string): Promise<void> {
    const table = await this.ledger()
    let cursor: string | undefined = parentId
    const seen = new Set<string>()
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor)
      const parent = table.get(cursor as TaskId)
      if (parent === undefined || parent.workspace !== workspace) return
      const children = this.list(workspace, { parent: cursor })
      const allDone = children.length > 0 && children.every(child => child.status === 'done')
      if (parent.status === 'open' && allDone) {
        const at = new Date().toISOString()
        await table.put(parent.id, {
          ...parent, status: 'submitted', deliveredAt: at,
          events: [...parent.events, { seq: parent.events.length + 1, at, actor: SYSTEM, action: 'children-complete' }],
        })
      } else if (parent.status === 'submitted' && !allDone) {
        const at = new Date().toISOString()
        const rolledBack: TaskRecord = {
          ...parent, status: 'open',
          events: [...parent.events, { seq: parent.events.length + 1, at, actor: SYSTEM, action: 'children-incomplete' }],
        }
        delete rolledBack.deliveredAt
        await table.put(parent.id, rolledBack)
      }
      cursor = parent.parent
    }
  }
}

function seq(id: TaskId): number {
  return Number(id.slice(1))
}
```

- [ ] **步骤 4：运行验证通过**

运行：`pnpm run test -- packages/task/task/tests/service.spec.ts`
预期：7 个测试全 PASS。`pnpm run typecheck` PASS。

- [ ] **步骤 5：Commit**

```sh
git add packages/task/task/src/service.ts packages/task/task/tests/service.spec.ts
git commit -m "feat(task): workspace-serialized task ledger service with container aggregation"
```

---

### 任务 5：`task` 插件接线（provide + effect + 打开/关闭域）与 Loader 测试

**文件：**
- 修改：`packages/task/task/src/index.ts`
- 测试：`packages/task/task/tests/loader.spec.ts`

- [ ] **步骤 1：编写失败的 Loader 测试**

`packages/task/task/tests/loader.spec.ts`（启动真实 cordis.yml：storage 三件套 + task；模型对照 `packages/todo/tool-todo/tests/loader-composition.spec.ts`）：

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import StorageJson from '@deepseek-ai/dsh-storage-json'
import StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as TaskPlugin from '@deepseek-ai/dsh-task'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-task-loader-'))
  const storageRoot = join(root, 'storages')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(storageRoot)}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-task'",
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-task', TaskPlugin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('task plugin composition', () => {
  it('boots through the real Loader and exposes ctx.tasks', async () => {
    const ctx = await boot()
    expect(ctx.tasks).toBeDefined()
    const created = await ctx.tasks.create('/ws/loader', { kind: 'human', name: 'weishuhao' },
      { title: 'loader task', description: 'd', deliverable: 'w' })
    expect(created.id).toBe('t1')
    expect(ctx.tasks.list('/ws/loader', {})).toHaveLength(1)
  })
  it('disposing the fiber closes the domain so a re-open succeeds', async () => {
    const ctx = await boot()
    await ctx.tasks.create('/ws/loader', { kind: 'human', name: 'weishuhao' },
      { title: 'x', description: 'd', deliverable: 'w' })
    await ctx.fiber.dispose()
    context = undefined
    const again = await boot()
    expect(again.tasks.list('/ws/loader', {})).toHaveLength(1)
  })
}, 30_000)
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm run test -- packages/task/task/tests/loader.spec.ts`
预期：FAIL（`ctx.tasks` 不存在 / yml 行加载失败）。

- [ ] **步骤 3：实现插件形态（`src/index.ts` 全文替换）**

```ts
/**
 * Durable cross-session task ledger: the tasks domain, enforced state machine,
 * and workspace-scoped service (`ctx.tasks`).
 * @module @deepseek-ai/dsh-task
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TaskService } from './service.ts'

export type * from './types.ts'
export { TaskError, legalActionsFor } from './errors.ts'
export type { TaskErrorCode } from './errors.ts'
export { taskDomainSpec, taskRecordSchema } from './spec.ts'
export { TaskService } from './service.ts'
export type { TaskServiceConfig } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tasks: TaskService
  }
}

/** Cordis plugin name. */
export const name = 'task'
/** The domain form must be mounted before this package opens its ledger. */
export const inject = ['storageDomain']

/** Deployment-tunable ledger bounds. */
export interface Config {
  /** Byte cap for description and deliverable text on every create. */
  maxDescriptionBytes: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxDescriptionBytes: z.number().int().min(1024).max(1_048_576).default(65_536),
})

/** Open the ledger, provide `ctx.tasks`, and close the domain on disposal. */
export function apply(ctx: Context, config: Config): void {
  const service = new TaskService(ctx, { maxDescriptionBytes: config.maxDescriptionBytes })
  ctx.effect(() => () => service.dispose())
  ctx.provide('tasks', service)
}
```

同时把 `service.spec.ts` 中构造参数 `{ maxDescriptionBytes: 65536 }` 保持不变（已对齐）。

- [ ] **步骤 4：运行验证通过**

运行：`pnpm run test -- packages/task/task`
预期：schema/machine/service/loader 全部 PASS。
再运行：`pnpm run typecheck`，预期 PASS。

- [ ] **步骤 5：Commit**

```sh
git add packages/task/task/src/index.ts packages/task/task/tests/loader.spec.ts
git commit -m "feat(task): plugin wiring with ctx.tasks, effect-owned domain lifecycle"
```

---

### 任务 6：`tool-task`（三个模型工具）

**文件：**
- 创建：`packages/task/tool-task/package.json`、`tsconfig.json`、`src/index.ts`
- 修改：`tsconfig.host.json`
- 测试：`packages/task/tool-task/tests/tool-task.spec.ts`

- [ ] **步骤 1：创建包（复制包骨架）**

`package.json` 复制任务 1 步骤 1 的全文，改名与依赖改为：

```json
{
  "name": "@deepseek-ai/dsh-tool-task",
  "description": "Model-facing task_create, task_query, and task_update tools over the durable task ledger",
  "version": "0.1.3-alpha.1",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts"],
  "dependencies": {
    "@deepseek-ai/schemastery": "workspace:^",
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-agent": "workspace:^",
    "@deepseek-ai/dsh-task": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-agent": "workspace:^",
    "@deepseek-ai/dsh-task": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^"
  }
}
```

`tsconfig.json` 同任务 1 步骤 2，references 换成：`../../../vendor/cosmokit`、`../../../vendor/cordis`、`../../../vendor/schemastery`、`../../core/tools`、`../../core/agent`、`../task`（`core/agent` 实际目录名先 `ls packages/core` 确认为 `agent`）。

- [ ] **步骤 2：tsconfig.host.json 追加 `{ "path": "./packages/task/tool-task" }`，运行 `pnpm run gen-tsconfig-paths` 与 `pnpm install`。**

- [ ] **步骤 3：编写失败的测试**

`packages/task/tool-task/tests/tool-task.spec.ts`——骨架复制 `packages/todo/tool-todo/tests/loader-composition.spec.ts` 的 `boot()/agent()/resultText()` 三个 helper（yml 行换成：dsh-agent、dsh-system-prompt、dsh-tools、dsh-storage 三件套、dsh-task、dsh-tool-task；工具名换成 `task_create`），断言：

```ts
it('creates then queries a task through the tool plane', async () => {
  const ctx = await boot()
  const owner = agent(ctx)
  const created = await ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('c1'),
    name: 'task_create', agent: owner,
    arguments: { title: 'write zh doc', description: 'docs/subsystems/storage.zh.md', deliverable: '逐节对齐' },
  })
  expect(created.isError).toBeUndefined()
  const value = JSON.parse(resultText(created)) as { task: { id: string; status: string } }
  expect(value.task.id).toBe('t1')
  expect(value.task.status).toBe('open')

  const queried = await ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('c2'),
    name: 'task_query', agent: owner, arguments: {},
  })
  const list = JSON.parse(resultText(queried)) as { tasks: unknown[] }
  expect(list.tasks).toHaveLength(1)
})

it('drives the full loop and rejects a wrong-role action with a readable code', async () => {
  const ctx = await boot()
  const owner = agent(ctx)
  const run = (name: string, args: Record<string, unknown>, id: string) => ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId(id), name, agent: owner, arguments: args,
  })
  await run('task_create', { title: 'x', description: 'd', deliverable: 'w' }, 'a1')
  const assigned = await run('task_update', { id: 't1', action: 'assign' }, 'a2')
  expect(JSON.parse(resultText(assigned)).task.status).toBe('in_progress')
  const tooEarly = await run('task_update', { id: 't1', action: 'accept' }, 'a3')
  expect(tooEarly.isError).toBe(true)
  expect(resultText(tooEarly)).toContain('invalid-transition')
  expect(resultText(tooEarly)).toContain('in_progress')
})
```

（`session.header.cwd`：fake agent 工厂里 `Session.create(id)` 若不带 header.cwd，服务取 `process.cwd()`——两种都可接受，测试断言只查 id/status。）

- [ ] **步骤 4：运行验证失败**

运行：`pnpm run test -- packages/task/tool-task`
预期：FAIL（插件不存在）。

- [ ] **步骤 5：实现 `src/index.ts`**

要点（全文由执行者按下列契约写全，代码骨架如下）：

```ts
/**
 * Model-facing `task_create`, `task_query`, and `task_update` tools over the
 * durable task ledger.
 * @module @deepseek-ai/dsh-tool-task
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TaskError } from '@deepseek-ai/dsh-task'
import type { TaskActor, TaskRecord } from '@deepseek-ai/dsh-task'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-task'
/** The ledger service key is 'tasks'; tool registration needs 'tools'. */
export const inject = ['tasks', 'tools']

/** Model-visible identity for this deployment. */
export interface Config {
  /** Durable identity name recorded for this agent's ledger operations. */
  identityName: string
}

export const Config: z<Config> = z.object({
  identityName: z.string().min(1).max(200).default('agent'),
})

const UPDATE_ACTIONS = ['assign', 'ask', 'answer', 'deliver', 'accept', 'reject', 'release', 'cancel'] as const
```

（**决策修正：** `inject` 只写 `['tasks', 'tools']`——'task' 不是服务键，插件名不是注入键。）

三个工具的完整定义：

```ts
function actorFor(config: Config, exec: { agent?: { id: string } }): TaskActor {
  const agent = exec.agent
  if (agent === undefined) throw new TaskError('validation', 'task tools require a calling agent.')
  return { kind: 'agent', name: config.identityName, session: String(agent.id) }
}

function workspaceFor(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  const cwd = exec.agent?.session?.header?.cwd
  if (cwd === undefined || cwd.length === 0) {
    throw new TaskError('validation', 'task tools require a session with a workspace directory.')
  }
  return cwd
}

function summarize(record: TaskRecord): Record<string, unknown> {
  return {
    id: record.id, status: record.status, title: record.title, priority: record.priority,
    publisher: record.publisher.name,
    ...record.worker === undefined ? {} : { worker: record.worker.name },
    ...record.parent === undefined ? {} : { parent: record.parent },
    blockedBy: record.blockedBy,
    submissions: record.submissions.length,
    openQuestion: record.status === 'awaiting_input'
      ? record.events.filter(e => e.action === 'ask').at(-1)?.reason : undefined,
  }
}

const TASK_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      task: {
        type: 'object',
        additionalProperties: false,
        required: true,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true,
            enum: ['open', 'in_progress', 'awaiting_input', 'submitted', 'done', 'cancelled'] },
          title: { type: 'string', required: true },
        },
      },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

const LIST_OUTPUT = {
  schema: { type: 'object', additionalProperties: false, properties: {
    tasks: { type: 'array', required: true, items: { type: 'object' } },
    truncated: { type: 'boolean', required: true },
  } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}
```

`apply(ctx, config)` 中注册：

1. `task_create`：description 文本（**逐字定稿**，进快照）：`'Publish one durable task contract in this workspace ledger: title, a self-contained description, and a deliverable that states what counts as done. Everything a fresh worker with no shared history needs must be inside description and deliverable.'`；parameters：`title`(string, required), `description`(string, required), `deliverable`(string, required), `priority`(string, enum low/normal/high), `parent`(string), `blocked_by`(array of string), `scope`(array of string)；execute → `ctx.tasks.create(workspaceFor(exec), actorFor(config, exec), {...})` 返回 `{ task: summarize(record) }`。
2. `task_query`：parameters 全可选：`status`(string enum 六态), `publisher`(string), `worker`(string), `parent`(string), `limit`(number)；execute → `ctx.tasks.list(...)` 过滤 + 截断 `limit ?? 50`，返回 `{ tasks: [...summaries], truncated }`。
3. `task_update`：parameters：`id`(string, required), `action`(string, required, enum UPDATE_ACTIONS), `worker`(string, assign 必填非空), `question`(string, ask 必填), `answer`(string, answer 必填), `description_update`(string), `deliverable_update`(string), `note`(string, deliver 必填), `artifacts`(array of string, deliver 必填), `reason`(string, reject/cancel 必填)。execute 先按 action 校验组合缺失 → `TaskError('validation', ...)`；再 `ctx.tasks.act(workspace, id, action, actor)`。
   **权限事实**：人肉身份（human/<配置名>）与 agent 身份（agent/<配置名>）不同名即不同权限——accept/reject/cancel/answer 只对发布者身份放行，跨 agent 越权表现为 `not-owner`。
4. 错误映射：每个 execute 包 `try/catch`：`TaskError` → `throw new Error(\`[${error.code}] ${error.message}\`)`（registry 把 throw 转 isError，模型可见 `[code] message` 前缀）。

- [ ] **步骤 6：运行验证通过**

运行：`pnpm run test -- packages/task/tool-task`
预期：PASS。`pnpm run typecheck` PASS。

- [ ] **步骤 7：Commit**

```sh
git add packages/task/tool-task tsconfig.host.json tsconfig.base.json pnpm-lock.yaml
git commit -m "feat(task): model-facing task_create/task_query/task_update tools"
```

---

### 任务 7：`command-task`（`/task` 命令）

**文件：**
- 创建：`packages/task/command-task/{package.json,tsconfig.json,src/grammar.ts,src/index.ts}`
- 修改：`tsconfig.host.json`
- 测试：`packages/task/command-task/tests/grammar.spec.ts`、`tests/execute.spec.ts`

- [ ] **步骤 1：骨架注册（同任务 6 步骤 1/2 模式；package.json 的 peer/dev 依赖换成 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-task`；tsconfig references 换 `../../interaction/commands` 与 `../task`——实际目录以 `ls packages/interaction` 为准。）**

- [ ] **步骤 2：编写失败的测试（纯文法全覆盖）**

`tests/grammar.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { parseTaskCommand } from '../src/grammar.ts'

describe('parseTaskCommand', () => {
  it('bare input is the overview', () => {
    expect(parseTaskCommand('')).toEqual({ kind: 'overview' })
  })
  it('splits the three-segment contract on the first two pipes', () => {
    const parsed = parseTaskCommand('标题|说明说明|交付成果')
    expect(parsed).toEqual({ kind: 'new', title: '标题', description: '说明说明', deliverable: '交付成果' })
  })
  it('missing segments are an invalid-new', () => {
    expect(parseTaskCommand('标题|只有两段').kind).toBe('invalid-new')
  })
  it('parses id-taking actions', () => {
    expect(parseTaskCommand('accept t7')).toEqual({ kind: 'accept', id: 't7' })
    expect(parseTaskCommand('reject t7 目录未汉化')).toEqual({ kind: 'reject', id: 't7', reason: '目录未汉化' })
    expect(parseTaskCommand('deliver t7 已完成|a.md,b.md'))
      .toEqual({ kind: 'deliver', id: 't7', note: '已完成', artifacts: ['a.md', 'b.md'] })
    expect(parseTaskCommand('assign t7 docs-writer')).toEqual({ kind: 'assign', id: 't7', worker: 'docs-writer' })
    expect(parseTaskCommand('assign t7')).toEqual({ kind: 'assign', id: 't7', worker: undefined })
  })
  it('review and list are filters', () => {
    expect(parseTaskCommand('review')).toEqual({ kind: 'review' })
    expect(parseTaskCommand('list in_progress')).toEqual({ kind: 'list', status: 'in_progress' })
    expect(parseTaskCommand('list bogus')).toEqual({ kind: 'invalid-list' })
  })
  it('show takes one id', () => {
    expect(parseTaskCommand('show t7')).toEqual({ kind: 'show', id: 't7' })
  })
})
```

- [ ] **步骤 3：运行验证失败**（模块不存在）→ **步骤 4：实现 `src/grammar.ts`**

```ts
/**
 * Grammar of the `/task` command. Pure: maps raw input to one closed
 * instruction or an explicit invalid shape the renderer turns into usage text.
 * @module @deepseek-ai/dsh-command-task/grammar
 */

import type { TaskStatus } from '@deepseek-ai/dsh-task'

const STATUSES: readonly string[] = ['open', 'in_progress', 'awaiting_input', 'submitted', 'done', 'cancelled']

/** One parsed instruction. */
export type TaskInstruction =
  | { readonly kind: 'overview' }
  | { readonly kind: 'new'; readonly title: string; readonly description: string; readonly deliverable: string }
  | { readonly kind: 'invalid-new' }
  | { readonly kind: 'list'; readonly status?: TaskStatus }
  | { readonly kind: 'invalid-list' }
  | { readonly kind: 'review' }
  | { readonly kind: 'show'; readonly id: string }
  | { readonly kind: 'assign'; readonly id: string; readonly worker?: string }
  | { readonly kind: 'deliver'; readonly id: string; readonly note: string; readonly artifacts: string[] }
  | { readonly kind: 'answer'; readonly id: string; readonly answer: string }
  | { readonly kind: 'accept'; readonly id: string }
  | { readonly kind: 'reject'; readonly id: string; readonly reason: string }
  | { readonly kind: 'cancel'; readonly id: string; readonly reason: string }
  | { readonly kind: 'usage' }

const ID_RE = /^t[1-9][0-9]*$/

/** Parse raw `/task` input. */
export function parseTaskCommand(rawInput: string): TaskInstruction {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'overview' }
  if (input === 'review') return { kind: 'review' }
  const [head = '', ...rest] = input.split(/\s+/)
  const tail = input.slice(head.length).trim()
  switch (head.toLowerCase()) {
    case 'new': {
      const segments = tail.split('|').map(part => part.trim())
      if (segments.length !== 3 || segments.some(s => s.length === 0)) return { kind: 'invalid-new' }
      return { kind: 'new', title: segments[0]!, description: segments[1]!, deliverable: segments[2]! }
    }
    case 'list': {
      if (tail.length === 0) return { kind: 'list' }
      if (!STATUSES.includes(tail)) return { kind: 'invalid-list' }
      return { kind: 'list', status: tail as TaskStatus }
    }
    case 'show': return idOnly(tail, 'show')
    case 'accept': return idOnly(tail, 'accept')
    case 'assign': {
      const [id, worker] = tail.split(/\s+/)
      if (id === undefined || !ID_RE.test(id)) return { kind: 'usage' }
      return { kind: 'assign', id, ...worker === undefined ? {} : { worker } }
    }
    case 'deliver': {
      const [id, ...rest2] = tail.split(/\s+/)
      if (id === undefined || !ID_RE.test(id) || rest2.length === 0) return { kind: 'usage' }
      const body = tail.slice(id!.length).trim()
      const [note = '', artifactList = ''] = body.split('|').map(s => s.trim())
      if (note.length === 0) return { kind: 'usage' }
      const artifacts = artifactList.length === 0 ? [] : artifactList.split(',').map(s => s.trim()).filter(Boolean)
      return { kind: 'deliver', id: id!, note, artifacts }
    }
    case 'answer': {
      const [id, ...rest2] = tail.split(/\s+/)
      if (id === undefined || !ID_RE.test(id) || rest2.length === 0) return { kind: 'usage' }
      return { kind: 'answer', id: id!, answer: tail.slice(id!.length).trim() }
    }
    case 'reject': case 'cancel': {
      const [id, ...rest2] = tail.split(/\s+/)
      if (id === undefined || !ID_RE.test(id) || rest2.length === 0) return { kind: 'usage' }
      return { kind: head.toLowerCase() as 'reject' | 'cancel', id: id!, reason: tail.slice(id!.length).trim() }
    }
    default: return { kind: 'usage' }
  }
}

function idOnly(tail: string, kind: 'show' | 'accept'): TaskInstruction {
  if (!ID_RE.test(tail)) return { kind: 'usage' }
  return { kind, id: tail }
}
```

- [ ] **步骤 5：运行文法测试通过** → `pnpm run test -- packages/task/command-task` PASS。

- [ ] **步骤 6：实现 `src/index.ts`（注册 + 执行 + 渲染）**

结构逐字对照 `packages/goal/command-goal/src/index.ts`：

```ts
export const name = 'command-task'
export const inject = ['commands', 'tasks']

export interface Config {
  /** Durable human identity name for ledger operations from this plane. */
  identityName: string
}
export const Config: z<Config> = z.object({
  identityName: z.string().min(1).max(200).default('human'),
})
```

`executeTaskCommand(ctx, invocation, config): Promise<CommandResult>` 以命名导出发布（`export async function executeTaskCommand(...)`，命令注册与测试共用这一入口）。参数类型是它消费的字段的最小声明，随导出发布：

```ts
/** The part of a command invocation the task command consumes. */
export interface TaskCommandRequest {
  readonly agent: {
    readonly id: unknown
    readonly session: { readonly header: { readonly cwd?: string } }
  }
  readonly rawInput: string
}
```
workspace = `invocation.agent.session.header.cwd ?? process.cwd()`；actor = `{kind:'human', name: config.identityName, session: String(invocation.agent.id)}`；`switch (instruction.kind)` 到服务调用；`TaskError` → `{kind:'error', text: `[${e.code}] ${e.message}`}`；渲染函数 `renderTask(record)` 输出多行文本（id/status/title/worker/publisher/blockedBy/scope + 子任务列表 + 最近 5 条 events + 最新 submission note）；`overview` 渲染计数行 + 待验收(`submitted` 且 publisher.name===我) + 待回答(`awaiting_input` 且 publisher.name===我) 列表。`review` = list filter submitted+publisher-me。
`apply` 注册：

```ts
ctx.commands.register({
  name: 'task',
  description: 'read and drive the durable workspace task ledger',
  input: { hint: '[new 标题|说明|交付成果|list [status]|show t7|assign t7 [名字]|deliver t7 说明 [路径]|answer t7 …|accept t7|reject t7 原因|cancel t7 原因|review]' },
  handler: invocation => executeTaskCommand(ctx, invocation, config),
})
```

- [ ] **步骤 7：直测执行入口（真实账本，无 mock）**

`tests/execute.spec.ts`——boot() 复制任务 4 `service.spec.ts` 的 `Context` 组装（storage 三件套 + `new TaskService(ctx, { maxDescriptionBytes: 65536 })` + `ctx.start()`；不需要 Loader）。`executeTaskCommand` 的参数声明为它实际消费的最小结构（生产路径里完整 `CommandInvocation` 结构上满足它，因此测试用字面量即可，全程无类型断言）：

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import StorageJson from '@deepseek-ai/dsh-storage-json'
import StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { TaskService } from '@deepseek-ai/dsh-task'
import { executeTaskCommand, type Config, type TaskCommandRequest } from '../src/index.ts'

const config: Config = { identityName: 'weishuhao' }

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function invocation(rawInput: string): TaskCommandRequest {
  return { agent: { id: 'a1', session: { header: { cwd: '/ws/cmd' } } }, rawInput }
}

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-task-cmd-'))
  ctx = new Context()
  ctx.plugin(Storage)
  ctx.plugin(StorageJson, { root })
  ctx.plugin(StorageDomain, { backend: 'json' })
  const service = new TaskService(ctx, { maxDescriptionBytes: 65536 })
  ctx.effect(() => () => service.dispose())
  ctx.provide('tasks', service)
  await ctx.start()
  return ctx
}

describe('executeTaskCommand', () => {
  it('new then list round-trips through the ledger text', async () => {
    const context = await boot()
    const created = await executeTaskCommand(context, invocation('new 修文档|说明文本|交付判定'), config)
    expect(created.kind).toBe('success')
    expect(created.text).toContain('t1')
    const listed = await executeTaskCommand(context, invocation('list'), config)
    expect(listed.text).toContain('t1')
    expect(listed.text).toContain('修文档')
  })
  it('the full human-plane loop runs under one durable identity', async () => {
    const context = await boot()
    await executeTaskCommand(context, invocation('new x|d|w'), config)
    const assigned = await executeTaskCommand(context, invocation('assign t1 weishuhao'), config)
    expect(assigned.kind).toBe('success')
    const delivered = await executeTaskCommand(context, invocation('deliver t1 完成|a.md'), config)
    expect(delivered.kind).toBe('success')
    const accepted = await executeTaskCommand(context, invocation('accept t1'), config)
    expect(accepted.kind).toBe('success')
  })
  it('usage text names the verb list on an unknown verb', async () => {
    const context = await boot()
    const unknown = await executeTaskCommand(context, invocation('frobnicate'), config)
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toContain('new')
    expect(unknown.text).toContain('review')
  })
})
```

（第二个用例断言的是"发布者身份从命令平面直达即合法"这一身份模型——错误路径的编码断言已由工具平面 spec 覆盖，不在这里重复 mock 越权。）

运行：`pnpm run test -- packages/task/command-task`
预期：grammar + execute 全 PASS。`pnpm run typecheck` PASS。

- [ ] **步骤 8：commit**

```sh
git add packages/task/command-task tsconfig.host.json tsconfig.base.json pnpm-lock.yaml
git commit -m "feat(task): human /task command over the ledger"
```

---

### 任务 8：`task-context`（开场摘要注入）

**文件：**
- 创建：`packages/task/task-context/{package.json,tsconfig.json,src/render.ts,src/index.ts}`
- 修改：`tsconfig.host.json`
- 测试：`packages/task/task-context/tests/render.spec.ts`

- [ ] **步骤 1：骨架注册（peer/dev 依赖：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session-projection`、`@deepseek-ai/dsh-task`）。**

- [ ] **步骤 2：编写失败的测试（纯渲染函数）**

`tests/render.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { renderLedgerSummary } from '../src/render.ts'
import type { TaskRecord } from '@deepseek-ai/dsh-task'

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: 't1' as TaskRecord['id'], workspace: '/ws' as TaskRecord['workspace'],
    title: '补中文文档', description: 'd', deliverable: 'w', priority: 'normal',
    status: 'open', publisher: { kind: 'human', name: 'weishuhao' }, blockedBy: [],
    publishedAt: '2026-09-08T00:00:00.000Z', submissions: [], events: [], ...over,
  }
}

describe('renderLedgerSummary', () => {
  it('returns undefined for an empty ledger', () => {
    expect(renderLedgerSummary([], { me: 'weishuhao', maxItems: 10, charBudget: 2000 })).toBeUndefined()
  })
  it('renders counts plus items waiting on me and mine', () => {
    const text = renderLedgerSummary([
      task({ status: 'submitted' }),
      task({ id: 't2' as TaskRecord['id'], status: 'awaiting_input' }),
      task({ id: 't3' as TaskRecord['id'], status: 'in_progress', worker: { kind: 'agent', name: 'docs-writer' } }),
      task({ id: 't4' as TaskRecord['id'], status: 'open', publisher: { kind: 'human', name: 'boss' } }),
    ], { me: 'weishuhao', maxItems: 10, charBudget: 2000 })!
    expect(text).toContain('open 1')
    expect(text).toContain('t1')
    expect(text).toContain('awaiting your acceptance')
    expect(text).toContain('awaiting your answer')
    expect(text).toContain('docs-writer')
  })
  it('truncates by maxItems and reports the hidden count', () => {
    const tasks = Array.from({ length: 7 }, (_, i) =>
      task({ id: `t${i + 1}` as TaskRecord['id'], status: 'open' }))
    const text = renderLedgerSummary(tasks, { me: 'nobody', maxItems: 3, charBudget: 2000 })!
    expect(text).toContain('and 4 more')
  })
})
```

- [ ] **步骤 3：实现 `src/render.ts`**

```ts
/**
 * Pure ledger summary text: counts, items waiting on this identity, and this
 * identity's own active items, within an item and character budget.
 * @module @deepseek-ai/dsh-task-context/render
 */

import type { TaskRecord } from '@deepseek-ai/dsh-task'

/** Budget knobs mirrored from validated plugin config. */
export interface SummaryBudget {
  readonly me: string
  readonly maxItems: number
  readonly charBudget: number
}

/** Render the session-opening summary, or undefined for an empty ledger. */
export function renderLedgerSummary(tasks: readonly TaskRecord[], budget: SummaryBudget): string | undefined {
  if (tasks.length === 0) return undefined
  const count = (status: TaskRecord['status']): number => tasks.filter(t => t.status === status).length
  const waiting = tasks.filter(t => t.status === 'submitted' && t.publisher.name === budget.me)
  const questions = tasks.filter(t => t.status === 'awaiting_input' && t.publisher.name === budget.me)
  const mine = tasks.filter(t => t.worker?.name === budget.me && t.status === 'in_progress')
  const lines: string[] = [
    `Task ledger: open ${count('open')} · in_progress ${count('in_progress')} · submitted ${count('submitted')} · awaiting_input ${count('awaiting_input')}.`,
  ]
  const section = (label: string, items: readonly TaskRecord[]): void => {
    if (items.length === 0) return
    const shown = items.slice(0, budget.maxItems)
    lines.push(`${label}: ${shown.map(t => `${t.id} "${t.title}"`).join('; ')}`
      + (items.length > shown.length ? `; and ${items.length - shown.length} more` : ''))
  }
  section('Awaiting your acceptance', waiting)
  section('Awaiting your answer', questions)
  section('Assigned to you', mine)
  const otherActive = tasks.filter(t => (t.status === 'in_progress' && t.worker?.name !== budget.me)
    || (t.status === 'open' && t.publisher.name !== budget.me)).slice(0, budget.maxItems)
  if (otherActive.length > 0) {
    lines.push(`Other active: ${otherActive.map(t => t.id).join(', ')}`)
  }
  const text = lines.join('\n')
  return text.length > budget.charBudget ? `${text.slice(0, budget.charBudget)}…` : text
}
```

- [ ] **步骤 4：运行渲染测试通过** → **步骤 5：实现 `src/index.ts`**

逐字对照 `packages/context/time-context/src/index.ts` 的 projection+pre-step 机制（该文件 152-235 行）：

```ts
export const name = 'task-context'
export const inject = ['sessionProjections', 'tasks']

export interface Config {
  maxItems: number
  charBudget: number
}
export const Config: z<Config> = z.object({
  maxItems: z.number().int().min(1).max(100).default(10),
  charBudget: z.number().int().min(200).max(8000).default(1500),
})
```

`apply`：注册投影 `{ key: 'taskLedger', stateVersion: 1, stateSchema: zod.object({ injected: zod.boolean() }), init: () => ({ injected: false }), apply: (state, event) => event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === name ? { injected: true } : state }`；监听 `agent/pre-step`：`turn === 1 && step === 1 && !state.injected` 时读 `ctx.tasks.list(cwd, {})`，`renderLedgerSummary` 有文本则在 `next()` 的 decision.messages 追加 `createUserMessage({content:[{type:'text',text}], source:{kind:'plugin', plugin: name, form:'snapshot', sections:[{name: 'task-ledger', text}]}})`。cwd 取 `agent.session.header.cwd`，缺失则跳过注入。

- [ ] **步骤 6：`pnpm run test -- packages/task/task-context` 与 `pnpm run typecheck` 通过**

- [ ] **步骤 7：commit**

```sh
git add packages/task/task-context tsconfig.host.json tsconfig.base.json pnpm-lock.yaml
git commit -m "feat(task): session-opening task ledger summary injection"
```

---

### 任务 9：REAL-composition 总装测试（全闭环）

**文件：**
- 创建：`packages/task/task/tests/composition.spec.ts`

- [ ] **步骤 1：编写总装测试**

结构复制任务 5 的 loader boot()（module-map 形态）；yml 在 `dsh-task` 行后再加三行，module map 相应追加 `['@deepseek-ai/dsh-tool-task', ToolTask]` 与 `['@deepseek-ai/dsh-task-context', TaskContext]`（默认导出）：

```yaml
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-tool-task'",
    "- name: '@deepseek-ai/dsh-task-context'",
```

fake Agent 工厂与 `resultText()` helper 复制 `packages/todo/tool-todo/tests/loader-composition.spec.ts` 的同名函数。**命令平面不在此文件**：`CommandRuntime` 依赖 typert 装配，测试 boot 成本高；`/task` 的真实存储闭环由任务 7 的 `executeTaskCommand` 直测覆盖（它接的就是同一个 `ctx.tasks`）。

```ts
it('closes one full contract loop across service and tool planes', async () => {
  const ctx = await boot()
  const owner = agent(ctx)
  const run = (name: string, args: Record<string, unknown>, id: string) => ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId(id), name, agent: owner, arguments: args,
  })
  await run('task_create', { title: '父', description: 'd', deliverable: 'w' }, 'c1')
  await run('task_create', { title: '子', description: 'd', deliverable: 'w', parent: 't1' }, 'c2')
  await run('task_update', { id: 't2', action: 'assign' }, 'c3')
  await run('task_update', { id: 't2', action: 'ask', question: '对齐哪个版本?' }, 'c4')
  const answered = await run('task_update', { id: 't2', action: 'answer', answer: 'HEAD', description_update: 'd2' }, 'c5')
  expect(JSON.parse(resultText(answered)).task.status).toBe('in_progress')
  await run('task_update', { id: 't2', action: 'deliver', note: 'n', artifacts: ['x.md'] }, 'c6')
  await run('task_update', { id: 't2', action: 'accept' }, 'c7')
  // container aggregation: the parent auto-submitted once its only child went done
  const reviewed = JSON.parse(resultText(await run('task_query', { status: 'submitted' }, 'c8'))) as { tasks: { id: string }[] }
  expect(reviewed.tasks.map(t => t.id)).toEqual(['t1'])
  await run('task_update', { id: 't1', action: 'accept' }, 'c9')
  const done = JSON.parse(resultText(await run('task_query', { status: 'done' }, 'c10'))) as { tasks: { id: string }[] }
  expect(done.tasks.map(t => t.id).sort()).toEqual(['t1', 't2'])
  const events = (await ctx.tasks.get(ownerWorkspace(ctx), 't2'))!.events
  expect(events.map(e => e.action)).toEqual(['create', 'assign', 'ask', 'answer', 'deliver', 'accept'])
})
```

（`ToolCallId` 品牌导入、fake agent 的 `session.header.cwd` 缺省走 `process.cwd()` 等细节，全部照抄 tool-todo 范本；`identityName` 保持默认 `'agent'`，因此 create/assign/deliver/accept 都由同一身份完成——accept 的发布者正是 actor 本身，合法。`ownerWorkspace(ctx)` 即 fake agent 的 `session.header.cwd ?? process.cwd()`，测试里直接内联 `process.cwd()`。）

- [ ] **步骤 2：运行通过 + `pnpm run typecheck` PASS**

- [ ] **步骤 3：Commit**

```sh
git add packages/task/task/tests/composition.spec.ts
git commit -m "test(task): full-loop REAL composition across service and command planes"
```

---

### 任务 10：文档与决策记录（全部文档 gate 的前置）

**文件：**
- 创建：`packages/task/README.md`、`README.zh.md`、`README.i18n.yaml`；4 个包 README（各 `.md/.zh.md/.i18n.yaml`）；`docs/subsystems/task.md`（+ zh 对照按 pairing 工作流）；`.agents/notes/implemented/feature/2026-09-08-task-protocol-p1.md`
- 修改：`packages/README.md`（组表加一行）

- [ ] **步骤 1：读规范**：`docs/cookbook/adding-a-package.md` §4（README 必备 Model Experience 区块与 Known Limitations 小节格式）、`.agents/notes/README.md`（note 格式：frontmatter 复制 `.agents/notes/implemented/feature/` 最近一份）、`docs/i18n/README.md`（中英 pair 记录方式）。

- [ ] **步骤 2：组 README `packages/task/README.md`**：Summary（组职责一段）+ Packages 表（四包：role/ctx key，对齐 `packages/goal/README.md` 表形）+ Related documentation 链 `docs/subsystems/task.md` 与本设计规格。**Known Limitations** 三条照规格 §7。

- [ ] **步骤 3：四个包 README**：`task` 包 README 含：域 spec 表（name/version/layout）、`ctx.tasks` 服务 API 摘要、TaskError 码表、Model Experience 区块（模型请求可见 = 工具 schema 文本 + 注入摘要；token 效应一句）、Known Limitations（无认证；单进程写序列化；`./invariant` 有意省略——理由：账本读数只有 storage-domain 一个来源，无独立可分歧观测，引 packages/AGENTS.md 规则）。其余三包 README 各 ≤ 20 行 + Known Limitations 一句或 allowlist 条目（`scripts/verify-package-readme-limitations.ts`）。

- [ ] **步骤 4：`docs/subsystems/task.md`**：类型表（TaskRecord 逐字段）、状态机表、转换权限表、事件条目结构——从规格 §4 改写为参考文档语态（现在时，无“将”“计划”）。

- [ ] **步骤 5：Agent Note**：`.agents/notes/implemented/feature/2026-09-08-task-protocol-p1.md`——决策与放弃项：为何账本不做 claim/assign 双态（审计日志已回答操作者）、为何状态机不下放 Consumer（转换验证不可外包）、为何容器聚合用系统 actor 事件、写链在工作区粒度（存储层写链只覆盖单记录）。

- [ ] **步骤 6：`packages/README.md` 组表加一行**（`task/`：模型/人类共享的跨会话任务账本）。

- [ ] **步骤 7：验证**

运行：`pnpm run doc-sync`
预期：PASS（生成的 tool-catalog/config-catalog 收录三个 task 工具与四包 config；文档 gate 全绿）。若报中英 pair 缺项，按报错指引用 [docs/i18n/README.md](../../i18n/README.md) 的 pair 工作流补齐 `.zh.md` 与 `README.i18n.yaml` 记录后重跑。

- [ ] **步骤 8：Commit**

```sh
git add packages/task docs .agents/notes packages/README.md
git commit -m "docs(task): package READMEs, subsystem reference, and the P1 decision note"
```

---

### 任务 11：挂载进 base bundle + 快照录制

**文件：**
- 修改：`packages/bundle/base/package.json`、`packages/bundle/base/cordis.patch.yml`
- 创建：`snapshots/session/task-protocol/{snapshot.yml,session.v2.jsonl}`

- [ ] **步骤 1：bundle 依赖 + patch 行**

`packages/bundle/base/package.json` 的 `dependencies` 加四条 `"@deepseek-ai/dsh-task": "workspace:^"`（其余三个同）。`cordis.patch.yml` 在 `- id: tool-goal` 行块之后插入：

```yaml
    # Durable cross-session task ledger: domain, model tools, `/task` command,
    # and the session-opening ledger summary. The storage stack is already in
    # the shared base above.
    - id: task
      name: '@deepseek-ai/dsh-task'

    - id: task-context
      name: '@deepseek-ai/dsh-task-context'
```

并在 `tool-goal` 行之后（工具分组区）插入：

```yaml
    - id: tool-task
      name: '@deepseek-ai/dsh-tool-task'

    - id: command-task
      name: '@deepseek-ai/dsh-command-task'
```

（命令分组实际位置以文件内 `command-goal` 行所在区段为准，插到它的邻行。）

- [ ] **步骤 2：`pnpm install` + `pnpm run doc-sync`**，预期 PASS（verify-cordis-config 通过意味着依赖清单已闭合）。

- [ ] **步骤 3：录制快照（需要 DEEPSEEK_API_KEY；无 key 时停下报告，不谎报完成）**

创建 `snapshots/session/task-protocol/snapshot.yml`（逐字段对照 `snapshots/session/todo-write/snapshot.yml`）：

```yaml
version: 1
scenario: task-protocol
profile: headless
composition: default
recording: live
header:
  class: default
```

录制输入 prompt（写入录制会话的首条用户消息；具体 record 流程与参数读 `docs/testing.md` §snapshot 一节和 `pnpm run test:snapshot:record --help`）：

```
Use the task ledger for real here. 1) task_create a task titled "docs: 为 storage 子系统写 zh 文档" with a self-contained description and deliverable. 2) task_update assign it to yourself. 3) task_update deliver it with note "written" and artifacts ["docs/subsystems/storage.zh.md"]. 4) task_update accept it. Report the final status of the task.
```

运行：`pnpm run test:snapshot:record -- -t task-protocol`
预期：生成 `snapshots/session/task-protocol/session.v2.jsonl`。

运行：`pnpm run test:snapshot -- -t task-protocol`
预期：无 key 重放 PASS，输出与 fixture 逐字一致。

- [ ] **步骤 4：Commit**

```sh
git add packages/bundle snapshots pnpm-lock.yaml
git commit -m "feat(task): mount the task ledger into the base bundle with a replay snapshot"
```

---

### 任务 12：全量门禁与收尾

- [ ] **步骤 1：按 [dsh-pre-push-checks](../../.agents/skills/dsh-pre-push-checks/SKILL.md) 选择覆盖本次 diff 的最小检查集**；本次至少：

```sh
pnpm run test -- packages/task
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
pnpm run hygiene
```

预期：全 PASS。任何一项红：修复后重跑该项，不许绕过或注释豁免。

- [ ] **步骤 2：`git status` 干净、逐任务 commit 已在。**

- [ ] **步骤 3：对照 DoD 手验一遍（规格 §6.6 六条），在 PR 描述里列出已跑命令清单（只列命令，不贴输出）。**
