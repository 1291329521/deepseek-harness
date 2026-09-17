# 术语解释

[English](terminology.md) | 中文

[dsh-client-ui-terminology](../../packages/client/ui-terminology/README.zh.md) 的行内术语 seam。Host 服务持有两层词表（设置文档里的全局 section 与工作区项目文件），经类型化 remote 供给渲染输入与手动解释管线，并把每一次模型驱动的解释记为持久会话事件。浏览器半边经 `ctx.remote.terminology` 消费全部内容，把解析出的词表以可选的 `chatAnnotations` 服务交给 Chat，其自身契约由[包 README](../../packages/client/ui-terminology/README.zh.md) 持有。

源码：[`packages/client/ui-terminology/src/index.ts`](../../packages/client/ui-terminology/src/index.ts)

Host 服务、其 remote 面、设置 schema、交互契约与待办限制均由[包 README](../../packages/client/ui-terminology/README.zh.md) 持有；本页只承载生成的 Cordis API 区域。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxterminology--terminologyservice"></a>

### `ctx.terminology` — `TerminologyService`

The terminology Host service: vocabulary owner and remote surface.

```ts cordis-catalog
/**
 * Read one session's full render inputs.
 * @param request - Session identity.
 * @returns Enabled flag, shortcut, selection length limit, project path,
 * both layers, and any project-file read/parse error; `SESSION_NOT_FOUND` /
 * `NO_WORKSPACE` otherwise.
 */
@Remote('state') async state(request: TerminologyStateRequest): Promise<TerminologyStateResult>

/**
 * Persist one entry into the chosen layer.
 * @param request - Term, explanation, target layer, and owning session.
 * @returns Empty success, or `TERM_INVALID` / `SESSION_NOT_FOUND` /
 * `NO_WORKSPACE` / `GLOSSARY_INVALID` / `GLOSSARY_WRITE_FAILED` /
 * `SETTINGS_CONFLICT`.
 */
@Remote('remember') async remember(request: TerminologyRememberRequest): Promise<TerminologyRememberResult>

/**
 * Explain one manually selected term through the session's model route.
 * @param request - Session, selected term, and surrounding context.
 * @returns The plain-prose explanation, or `SESSION_NOT_FOUND` /
 * `TERM_INVALID` / `CONTEXT_TOO_LARGE` / `NO_MODEL_ROUTE` / `LLM_FAILED` /
 * `TIMEOUT`.
 */
@Remote('explain') async explain(request: TerminologyExplainRequest): Promise<TerminologyExplainResult>
```

Source: [`packages/client/ui-terminology/src/index.ts`](../../packages/client/ui-terminology/src/index.ts)

<a id="terminology-events"></a>

### `terminology/*` events

<a id="terminologychanged--emit"></a>

#### `terminology/changed` — emit

The rendered vocabulary changed: a settings write, an external edit of the project glossary file, or a successful remember. Observer failures cannot veto the write that produced it. A global change dispatches with no argument, so forwarded listeners see an empty argument list while local listeners read the missing argument as `undefined`.

```ts cordis-catalog
/**
 * The rendered vocabulary changed: a settings write, an external edit of
 * the project glossary file, or a successful remember. Observer failures
 * cannot veto the write that produced it. A global change dispatches with
 * no argument, so forwarded listeners see an empty argument list while
 * local listeners read the missing argument as `undefined`.
 * @mode emit
 * @param sessionId - session whose project vocabulary changed, or
 * `undefined` when the global layer or an unattributed change moved.
 */
'terminology/changed'(sessionId: SessionId | undefined): void
```

Types: [SessionId](core.zh.md)

Source: [`packages/client/ui-terminology/src/types.ts`](../../packages/client/ui-terminology/src/types.ts)
<!-- END GENERATED cordis-surface -->
