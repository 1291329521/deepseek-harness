# Agent Note: Web inline terminology annotations through an optional Markdown seam

Status: implemented

English | [中文](2026-09-17-web-inline-terminology.zh.md)

## Problem

Glossary terms inside the Web assistant's prose should become clickable words whose hover, keyboard-focus, or tap opens a plain-text explanation, and a word the vocabulary misses should be explainable from its selection through the session's model route. The feature belongs in a plugin, but the rendering must happen inside the settled Markdown renderer that `ui-primitives` owns and every transcript surface shares. Forking or copying that renderer into the plugin would duplicate a hot path; a seam that reaches every transcript even with no provider installed would tax unrelated surfaces. Vocabulary is also a reactive fact that arrives asynchronously and moves after render: reading it through a plain getter at render time loses the late arrival on a settled transcript, because nothing re-renders the node afterward.

## Decision

### Renderer seam

`ui-primitives` gained `MarkdownAnnotations`: one `split(value)` call that turns one authored text run into contiguous text/annotation segments, and the renderer paints each annotation segment through `AnnotatedTerm`. The render context carries `annotations: MarkdownAnnotations | undefined`; with no provider the `text` case returns the authored string unchanged, so the settled DOM stays byte-for-byte the recorded one. Annotations run only in settled renders (streaming contexts pin `annotations: undefined`) and never inside an anchor, where a button cannot nest.

### Reactive channel

The vocabulary travels as a Cordis service named `chatAnnotations` whose face is `vocabulary(): ObservableSnapshot<MarkdownAnnotations | undefined>` — a bare observable source, not a getter. `ui-chat` binds it as the `useAnnotations` hook through the existing keyed `conversation.chat.node` hooks compartment, the same channel `useTurnData` uses, and `AssistantNodeView` reads the resolver through that hook. The provider keeps the two source identities stable: the snapshot reference changes only when a term or explanation moved, so an unchanged refetch notifies no consumer and memoized Markdown survives. With no provider mounted the hook reads `undefined` and prose stays plain.

### Vocabulary layers and watch

`ui-terminology` owns the settings namespace `terminology` (global layer: `enabled`, `explainShortcut`, `terms`) and a project file at `.dsh/terminology.yml` under the session workspace that wins term-for-term over the global layer. `state`/`remember`/`explain` cross the Remote boundary as typed results; project writes go through `withFileLock` plus `writeFileAtomic`. One chokidar watcher per project path starts when the containing directory exists and releases on service disposal through an effect owned at `[Service.init]` — a lazy registration inside the request path would survive the fiber. Reads and watching never create workspace structure: the directory's creation belongs to the write that fills it, and a missing directory simply has no glossary to watch.

### Explain pipeline

Manual lookup frames `{ term, context }` as one JSON object inside a fixed instruction, appends `terminology/explain-request` to the Session log before dispatch in the same two-argument log-only form as `session/title-llm-request`, then consumes one `purpose: 'terminology'` stream under a single `explainTimeoutMs` deadline. Routing is the configured `explainProvider`/`explainModel` pair — half a pair throws at load — otherwise the session's last model selection, otherwise `NO_MODEL_ROUTE`; there is no silent default. Only a plain-text answer succeeds: timeout, truncation, a tool request, or empty text is a typed failure the dialog states in prose.

### Interaction contract

Hover opens after a 150 ms dwell (pinned constant); keyboard focus opens immediately; tap or click toggles in a click mode immune to pointer-leave, because a press delivers `focus` before `click` and a focus-opened tooltip must not be toggled shut by the click that follows it. The tooltip carries the explanation text only — no buttons, actions, or error surfaces — and the settings card and manual-lookup dialog own every action with visible prose errors, retry, and no export or download affordance. Manual lookup claims the document `contextmenu` capture phase and the configured chord only for a non-collapsed selection outside editable regions. A rejected read (business or transport) folds to no vocabulary instead of a feature that pretends to work.

## Consequences

- The optional seam is the sanctioned route for prose features that drive rendering from their own vocabulary: `ui-primitives` stays copy-free and vocabulary-free, `ui-chat` forwards only the observable, and the vocabulary stays with its plugin.
- Booting a settled transcript can now miss the first vocabulary arrival; the hook notifies settled nodes when it lands instead of waiting for an unrelated re-render, at the cost of one repaint per vocabulary change.
- The resolver is session-agnostic: one vocabulary per browser session. A product with simultaneous workspaces needs a per-session keyed provider; today's single-global-settings product does not, and the gap is named in the package README.
- `terminology/explain-request` adds a durable event type: builds older than it refuse the Session log under the existing version mechanism, the posture already accepted for `session/title-llm-request`. First-party writers cannot set the envelope's `ignorable`, so no older-build readability is promised.
- The browser half shares only constants with the Host half (own `namespace.ts`, private merge copy) so the settings schema runtime never enters `lib/client.js`.
- `test:web` goldens now include the terminology surface; the two click-path fixes (hooks channel, press-before-click tooltip) each carry a regression spec that renders the failing sequence first.

## Alternatives considered

- Forking the keyed chat-node transcript renderer into the plugin, or copying `ui-primitives`'s Markdown renderer wholesale: both keep the annotation logic out of core but duplicate a hot path and drift on every transcript change; measured, the copy route carried thousands of lines.
- Reading vocabulary through a plain getter prop threaded from the provider: rejected by the assembled browser scenario — opening an existing settled session renders before the async vocabulary read lands and no later render carries it, so annotations appear only after a remount.
- Delivering the vocabulary through `uiSession.provide`: the per-session provide hook's reach into keyed chat-node renderers is unproven, while the keyed hooks compartment is already bound for `useTurnData`; the implementation uses only the proven channel.
- Reusing the `chatFileMentions` seam: file mentions are inline-code-scoped and open files, not prose spans opening explanations.
- Having the model mark terms in its output: presentation-only vocabulary would then be a model-visible input, forcing per-message logging and putting vocabulary drift into committed transcripts.
- One glossary file under `$DSH_HOME` for every workspace: rejected with the project layer, because project terms belong to the repository the reader is working in.
- Setting the `ignorable` envelope flag on `terminology/explain-request` so older builds skip it: `Session.append` accepts no options for non-surface event types and first-party writers do not set `ignorable` (see the [session log version mechanism](../architecture/2026-08-10-session-log-version-mechanism.md)); two-argument append per the auxiliary-request precedent is the honest form.
