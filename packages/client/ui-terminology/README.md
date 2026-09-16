---
description: "Inline terminology annotations for assistant prose: a two-layer glossary, hover/focus/tap explanations, and user-triggered model-backed lookup."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-terminology

English | [中文](README.zh.md)

## Summary

This package turns glossary terms inside the Web client's assistant prose into annotated words. The vocabulary has two layers — a global entry list the user owns in settings and a project file inside the workspace that wins over it — and a matched word opens its plain-prose explanation on hover, keyboard focus, or tap. A word the vocabulary misses can still be explained: selecting it and invoking the shortcut asks the session's current model route once, and the answer can be saved back into either layer so the next sighting is annotation-only.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package in the profile; the browser feature activates through the Web client plugin row.

```yaml
- id: ui-terminology
  name: '@deepseek-ai/dsh-client-ui-terminology'
```

The Host service is `ctx.terminology` (a `TypertRemoteService` keyed `terminology`), and the browser consumes it through the generated `terminology` Remote. It owns the settings namespace `terminology` (`enabled`, `explainShortcut`, `terms`) with the Host configuration below as its composition base, and it publishes `terminology/changed` whenever either vocabulary layer moves. Configuration:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Default switch of the `terminology` settings namespace. |
| `terms` | `[]` | Composition base for the global entry list. |
| `explainShortcut` | `"Alt+Shift+E"` | Default manual-explain chord shown by the settings card. |
| `projectGlossaryPath` | `".dsh/terminology.yml"` | Project glossary file, workspace-relative; absolute or escaping paths resolve to no project layer. |
| `explainProvider` | unset | Pinned provider for manual explain; requires `explainModel`. |
| `explainModel` | unset | Pinned model for manual explain; requires `explainProvider`. |
| `explainMaxTokens` | `256` | Completion budget of one explain request. |
| `explainMaxSentences` | `3` | Sentence cap of one explanation. |
| `explainTimeoutMs` | `30000` | Wall-clock budget of one explain request. |
| `explainTermMaxChars` | `64` | Longest word an explain or remember request may carry. |
| `explainContextMaxBytes` | `2048` | Byte budget of the selection context sent with an explain request. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`state` returns one session's full render inputs: enabled flag, effective shortcut, both vocabulary layers merged longest-term-first, the resolved project file path, and the project file's read/parse error when it has one (the project layer is then ignored and the call still succeeds). `remember` writes one entry into the chosen layer: the global layer through the settings scope, the project layer through `withFileLock` plus an atomic write of the whole document. Reads and `remember` keep a per-path cache; chokidar re-reads the project file after external edits. Every settings write, project-file move, and successful `remember` fans out `terminology/changed`, and an observer failure never vetoes the committed write. `explain` explains one selected word through a model route: the pinned `explainProvider`/`explainModel` pair when configured, otherwise the session's last model selection, with neither source rejecting the call. Each call bounds the term and context, frames them as one JSON object, appends `terminology/explain-request` to the Session log before dispatch, and consumes one `purpose: 'terminology'` stream under a single `explainTimeoutMs` deadline; only a plain-text answer is returned, and any other outcome — timeout, truncation, tool request, empty text — is a typed failure.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service lifecycle, settings ownership, project-file cache and watcher, and the `state`/`remember`/`explain` remotes |
| [`src/explain.ts`](src/explain.ts) | Framed explain input, pre-dispatch logging, deadline, and output rules |
| [`src/namespace.ts`](src/namespace.ts) | The `terminology` key both halves join on, carried without schema runtime |
| [`src/spec.ts`](src/spec.ts) | Host Config, settings schema, and the project file schema |
| [`src/types.ts`](src/types.ts) | Remote payloads, the closed failure catalog, and the declaration-merged events |
| [`src/glossary.ts`](src/glossary.ts) | Project file parsing and the two-layer merge |
| [`src/client/index.ts`](src/client/index.ts) | Browser assembly: vocabulary, manual-lookup takeover, and both slot registrations |
| [`src/client/resolver.ts`](src/client/resolver.ts) | Longest-first, case-sensitive, non-overlapping annotation scanner |
| [`src/client/selection.ts`](src/client/selection.ts) | Which live selection the takeover may claim, and where it anchors |
| [`src/client/shortcut.ts`](src/client/shortcut.ts) | Chord text parsing and exact-match key comparison |
| [`src/client/overlay-policy.ts`](src/client/overlay-policy.ts) | Manual-lookup state machine: menu, loading, shown, failed, save |
| [`src/client/card-policy.ts`](src/client/card-policy.ts) | Settings-card snapshot and whole-array term writes through the owner scope |
| [`src/client/TerminologyOverlay.tsx`](src/client/TerminologyOverlay.tsx) | The takeover menu and the explanation dialog |
| [`src/client/TerminologyCard.tsx`](src/client/TerminologyCard.tsx) | The settings page's terminology card |
| [`src/client/locales.ts`](src/client/locales.ts) | `ui-terminology` dictionary (zh and en) |

The browser half holds no subscription of its own. It pulls one session's vocabulary through `terminology.state` — every known session when none is bound, newest response winning — and publishes it to Chat through `ctx.provide('chatAnnotations', …)`: the resolver identity is reused while no term or explanation moved, so memoized Markdown survives a settings round trip, and `undefined` (no vocabulary, feature off, rejected read) leaves prose unannotated. Manual lookup is claimed on the document's capture-phase `contextmenu` and on the configured chord; a claimed gesture replaces the browser menu with its one Explain entry, and a refused one is left untouched. `OverlayPolicy` owns the lookup surface (`shell.overlay`) and `TerminologyCardPolicy` the settings entry (`settings.plugin.item`, key `terminology`); both are registered through `ctx.slots.inject`, so they arrive with the slot declaration and leave with the plugin fiber. `ok: false` from the Host — business failure or transport failure — is never shown as a usable feature: reads fold into no vocabulary, and a call that cannot run reports its own failure code in the dialog.

</details>

**Runtime invariant:** No companion is published. The settings namespace has exactly one owner scope, and the project-file cache is refreshed by the same watcher and writes that publish its changes.

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-primitives](../ui-primitives/README.md) — the `MarkdownAnnotations` seam the browser half renders through.
- [ui-chat](../ui-chat/README.md) — the assistant prose surface that forwards the optional annotation provider.
- [Settings](../../settings/settings/README.md) — namespace registration and the composition-base layer the `base` fields feed.
- [LLM](../../llm/llm/README.md) — the routed auxiliary request the manual explain issues.
- [Client group map](../README.md) — browser services and UI feature packages.

-----

<a id="model-experience"></a>
## Model Experience

### Automatic annotation

#### What the model sees

Nothing: automatic annotation reads matched words from the two vocabulary layers in the browser, and glossary content, annotation results, and hover state never enter a model request or the Session log.

#### Token effect

None on any request; the automatic path adds no text to the conversation or to an auxiliary request.

#### KV Cache effect

None; the vocabulary layers are render input beside the transcript, so conversation content and prefixes stay unchanged.

### Manual explain request

#### What the model sees

One user-triggered lookup sends one auxiliary request: a system prompt that fixes plain-prose output, and a user message carrying the selected term plus its surrounding sentence (bounded by `explainContextMaxBytes`). The request runs outside any turn or step with `purpose: 'terminology'`, and before dispatch it is appended to the Session log as `terminology/explain-request`, which carries the exact framed messages, route, and `maxTokens` so the request is reconstructable from the log.

#### Token effect

One short exchange per manual lookup: a fixed system prompt, a context-bounded user message, and an answer capped by `explainMaxSentences` and `explainMaxTokens`. Saved entries reach later turns only through the settings or project file the next render reads.

#### KV Cache effect

None on the conversation; the auxiliary request shares no prefix with it and the conversation history is unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits apply to the rendered annotation behavior and the project-file watcher.

- **Matching runs inside one text node** — a term split across Markdown nodes is not annotated.
- **Emphasis syntax splits words** — a term written as `Trans**former**` in source does not match the glossary entry.
- **Chinese has no word boundaries** — a vocabulary containing `模型` also annotates the `模型` inside `大模型`; longest-term-first ordering and user-maintained vocabulary are the mitigation.
- **Body explanations refresh on the next natural re-render** — a vocabulary change reaches already-rendered prose when the node re-renders, not by forced repaint.
- **No download or export** — the feature offers none; if one is added, its format choice must be an explicit card-level control in the settings surface, never a tooltip entry.
- **An externally deleted project glossary keeps its last read** — the watcher re-reads on `add` and `change` only, so the cached terms stay in effect until a write or a restart refreshes them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
