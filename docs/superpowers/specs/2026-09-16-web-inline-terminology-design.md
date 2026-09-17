# Web Inline Terminology Design Specification

English | [中文](2026-09-16-web-inline-terminology-design.zh.md)

- Date: 2026-09-16
- Status: awaiting final user sign-off
- Scope: automatic and manual term recognition inside Web client question-and-answer prose. No session-protocol change, no new model tool.
- Prerequisites: [docs/subsystems/slots.md](../../subsystems/slots.md), [docs/subsystems/web-client.md](../../subsystems/web-client.md), [docs/web-styling.md](../../web-styling.md), precedent [2026-08-07-web-inline-file-mentions](../../../.agents/notes/implemented/feature/2026-08-07-web-inline-file-mentions.md), template package `packages/client/file-upload` (a client-named package with a Host half and a typert remote)

## 1. Background and Goals

### 1.1 The problem

Project jargon, internal codenames, and domain terms that appear in an assistant answer are a black box to a reader who lacks the context. The only way to learn what a word means here is to select it and take it to a search engine or ask the model, and that step pollutes the session and loses the surrounding context.

### 1.2 One-line positioning

**Give DSH Web question-and-answer prose a terminology layer: a word the glossary matches becomes a clickable, focusable link right in the sentence, opening its explanation on hover, focus, or click; a word the glossary misses can be selected and explained by the model in place, through a context-menu entry or a shortcut, and folded into the glossary in one click.**

### 1.3 Three design principles

1. **The renderer owns no vocabulary.** The prose renderer decides only how an annotated span behaves; which spans are terms is decided by the provider from its own glossary. This copies the existing division of labour in `MarkdownFileMentions`, and it is why this feature cannot produce a dead link that explains nothing: only a word that already has an explanation becomes a link.
2. **The Web layer is pure presentation.** The glossary, the match results, and the hover state never enter the session log. The one exception is the explain call itself — a real model request, which the repository rule "model-visible ⟺ logged" requires to be reconstructable (see 6.5).
3. **No information hides behind hover.** The tooltip carries explanation text and nothing else: no interactive control, no error message, no download entry. Every failure surfaces in a visible, focusable surface (see section 8).

## 2. Scope

### 2.1 In scope

- A word the glossary matches becomes a clickable term link wherever it appears in the assistant's Markdown prose, including headings, list items, table cells, and the plain text inside blockquotes.
- A term link opens its explanation on pointer hover, on keyboard focus, and on click (a touch tap); it closes on pointer leave, on blur, on Escape, and on a pointer press outside.
- Manual recognition: after selecting text in the prose, a context-menu entry or a configurable shortcut opens an explain panel, from which the word can be written back into the glossary.
- A two-layer glossary: the project layer (team vocabulary, stored in a repository file) outranks the global layer (personal vocabulary, stored in the settings document).
- A settings card: master switch, shortcut, create/update/delete for global terms, and a read-only project-term list with a file entry point.

### 2.2 Explicitly out of scope

- **User-authored questions are not covered.** A user message does not go through Markdown rendering; it goes through the `projectUserText` pure function (`packages/client/ui-primitives/src/user-text.tsx`), and annotating it would disturb the fine-grained `@` / `/` reference matching semantics. This phase covers assistant answers only.
- **The model does not annotate terms itself.** No system-prompt section is registered and no marker syntax is introduced. The glossary is the only vocabulary source, and `explain` runs only when the user triggers it.
- **No session-event stream change, no new model tool, no agent-loop change.**
- **No DOM hack.** No MutationObserver, no append to `document.body`, no mutation of host DOM.
- **No built-in download or export.** This phase ships no export surface at all; see section 8 for the constraint that governs adding one later.

### 2.3 Division of labour with adjacent capabilities

| Capability | What it covers |
|---|---|
| `ui-deliverables` / `chatFileMentions` | a **produced-file** path written as inline code → open the file |
| **This feature** | a **term** in plain prose text → show its explanation |
| `session-reference` / `file-reference` | `@` reference completion on the input side |
| `ui-message-feedback` | per-message rating (the structural precedent for a remote plus a separate UI package) |

The two prose seams do not overlap: `MarkdownFileMentions` handles `inlineCode` nodes only, and this seam handles `text` nodes only.

## 3. Architecture Overview

Three layers, bottom to top:

```
Layer 1 — core seam (changes this project's own source)
  ui-primitives : MarkdownAnnotations contract + AnnotatedTerm element
  ui-chat       : optional chatAnnotations service → forwards to MarkdownText

Layer 2 — Host half (new package src/)
  two-layer glossary / settings namespace / LLM explain / typert remote / change event

Layer 3 — browser half (new package src/client/)
  annotation provider / glossary sync / selection + keyboard listeners / explain panel / settings card
```

Data flow:

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

## 4. Core Seam Specification (changes this project's own source)

### 4.1 The seam contract

Added beside `MarkdownFileMentions` in `packages/client/ui-primitives/src/markdown/render.tsx`:

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

**Precondition (the provider must honour it; the renderer performs no runtime validation)**: concatenating the `text` of the segments returned by `split(value)` in order must produce **exactly** `value`. The repository rule "Trust TypeScript at typed same-process boundaries" forbids runtime validation of a value the static interface already guarantees, so this invariant is carried by the JSDoc declaration plus tests on the provider side. Violating it rewrites or drops prose, so the provider must carry a property test asserting the concatenation identity.

### 4.2 Renderer change

`MarkdownRenderContext` gains a field:

```ts ignore-check
/** Prose annotations; absent when no vocabulary is mounted or while streaming. */
readonly annotations: MarkdownAnnotations | undefined
```

`case 'text'` (which currently returns the string directly at lines 217–218) branches:

- `context.annotations === undefined` → **return the string unchanged**. This is why the byte-for-byte DOM constraint (`tests/fixtures/markdown-dom`) is unaffected: with no vocabulary mounted, the rendered output is identical to the output before this change.
- Otherwise call `renderAnnotatedText(node.value, key, context)`, mapping each segment to a React node; an annotation segment renders as `<AnnotatedTerm>`.
- When `context.inLink === true`, **do not call** `split`. A `<button>` cannot nest inside an `<a>`, the same rule `fileMentions` follows (`render.tsx:256`).

### 4.3 The AnnotatedTerm element and its accessibility

New files `packages/client/ui-primitives/src/markdown/AnnotatedTerm.tsx` and `AnnotatedTerm.module.css`. The trigger's form copies the existing fileMention button (`render.tsx:258-271`).

| Event | Behaviour |
|---|---|
| Pointer enter | Opens after a 150-millisecond delay (a fixed interaction constant, so sweeping across prose does not flash tooltips) |
| Keyboard focus | Opens immediately |
| Click / touch tap | Opens; closes when already open |
| Pointer leave | Closes unless the pointer is inside the bubble; entering the bubble keeps it open (reuses `pointer-grace.ts`) |
| Blur | Closes |
| Escape | Closes |
| Pointerdown outside the bubble | Closes (reuses `useDismissOnOutsidePointer.ts`) |

Accessibility contract:

- The trigger is a `<button type="button">`, so it is a button in the accessibility tree — this, not any hover-only visual cue, is what lets touch and screen-reader users still identify what the control does.
- The accessible name comes from the provider's `label` (for example "term Transformer, show explanation"), because `ui-primitives` is a cordis-free general-purpose primitive and **owns no product copy**.
- While open, the trigger's `aria-describedby` points at the bubble; the bubble carries `role="tooltip"` (the WAI-ARIA tooltip pattern), with a stable id from `useId()`.
- **Visibility without focus cannot rest on hover either**: the resting state already carries a dotted underline and `cursor: help`.
- The bubble contains no interactive element.
- All three WCAG 1.4.13 requirements hold: dismissable (Escape), hoverable (the pointer can move into it), and persistent (it never disappears on a timer).

Colour and typography use `--dsw-*` semantic aliases only, following [docs/web-styling.md](../../web-styling.md).

### 4.4 MarkdownText and the ui-chat forwarding

`MarkdownText` gains an optional prop `annotations?: MarkdownAnnotations | undefined`:

- It participates in **settled** renders only. Both contexts the `StreamingRenderer` builds keep `annotations: undefined`, exactly as they already keep `fileMentions: undefined` (`MarkdownText.tsx:108`, `:126`). The reason is that the streaming cache bakes handlers into frozen React elements, and the vocabulary is not final while the prose is still growing.
- It joins the `useMemo` dependency array. **A new resolver identity discards the cached parse of every settled message**, so the provider must hold its identity stable while the vocabulary is unchanged (see 7.1).

`packages/client/ui-chat/src/client/contract/slots.ts` gains (beside `ChatFileMentions`):

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

It is simpler than `ChatFileMentions` because that one's vocabulary is "the files this turn produced" and therefore needs an owner argument, while the glossary is global and independent of the turn.

The forwarding chain mirrors `fileMentions` layer for layer: `annotations: () => ctx.get('chatAnnotations')?.annotations()` in `apply.ts` → `ChatViewInjected` → `ChatView` → `ChatNodeSeat` → `AssistantNodeView` (resolved once with `useMemo(() => annotations(), [annotations])`, the pattern at `AssistantNodeView.tsx:20-23`) → `AssistantMarkdown` → `MarkdownText`.

**The service's absence is the feature's off state**: without ui-terminology mounted, `ctx.get` returns `undefined`, the resolver is `undefined`, the renderer takes the unchanged-string path, and the cost is zero.

### 4.5 Core file change list

| File | Change |
|---|---|
| `packages/client/ui-primitives/src/markdown/render.tsx` | two new types, the context field, the `case 'text'` branch, `renderAnnotatedText` |
| `packages/client/ui-primitives/src/markdown/AnnotatedTerm.tsx` | new |
| `packages/client/ui-primitives/src/markdown/AnnotatedTerm.module.css` | new |
| `packages/client/ui-primitives/src/markdown/MarkdownText.tsx` | new prop, forwarding, dependency array |
| `packages/client/ui-primitives/src/index.ts` | export the new types and element |
| `packages/client/ui-chat/src/client/contract/slots.ts` | `ChatAnnotations`, the Context declaration, two props fields |
| `packages/client/ui-chat/src/client/apply.ts` | the `annotations` injection member |
| `packages/client/ui-chat/src/client/chat/ChatView.tsx` | forward |
| `packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx` | forward |
| `packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx` | resolve the resolver |
| `packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx` | forward to `MarkdownText` |

### 4.6 Classifying the LLM side-channel call

`GenerateOptions.purpose` is the closed union `'compaction' | 'session-title'` (`packages/llm/llm/src/types.ts:442`), mirrored by a second declaration at `packages/llm/deepseek-llm-api-extensions/src/types.ts:25`. This feature adds the member `'terminology'` to both.

The reason is load-bearing rather than decorative: the explain call is a **UI-triggered side-channel model request** that belongs to no turn or step. Without a declared purpose, an adapter or a telemetry consumer cannot tell it apart from an ordinary agent call. Both consumption sites are equality checks (`llm-deepseek/src/adapter.ts:540`, `llm-deepseek/src/serialize.ts:84`) with no exhaustive switch, so adding the member cannot break them.

Whether `serialize.ts` disables thinking for `'terminology'` is decided during implementation from measured latency; this specification does not fix it in advance.

## 5. Package Layout and Registration Surfaces

### 5.1 Package structure

One new package with two halves, modelled on `packages/client/file-upload` (a client-named package with a Host half, a typert remote, and separate host/client tsconfig faces):

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

### 5.2 Registration surface list

Missing any one of these fails at a later and different point:

1. The aggregate `references` entry in `tsconfig.client.json`.
2. The `dsh.client` row in `packages/bundle/web-app/cordis.patch.yml`.
3. The dependency in `packages/bundle/web-app/package.json` (profile boot resolves bare row names through the `$DSH_HOME/profiles/node_modules` fallback, and a row no manifest declares fails to import).
4. The remote-assembly import and its `type {}` declaration in `packages/api/remotes/src/client/index.ts`, plus that package's `package.json` dependency.
5. The forwarded-event allowlist entry in `packages/api/remotes/src/remote-events.ts`.
6. One run of the typert generator, producing `lib/typert.host.*` and `lib/typert.remote-client.*`.
7. The `gen-persistence-catalog` generator (`terminology/explain-request` is a new `SessionEventMap` member).

## 6. Host Half Specification

### 6.1 The two glossary layers

| Layer | Storage | Precedence | Maintained by |
|---|---|---|---|
| Project | `<cwd>/.dsh/terminology.yml` | high (the project layer wins for the same term) | committed with the repository, shared by the team |
| Global | the `terms` field of settings namespace `terminology` | low | personal vocabulary, edited in the settings card |

The project layer exists to be a committable, reviewable team asset, which is why it must be a workspace file rather than the settings document. The global layer lives in the settings document so it inherits revision fencing, change events, an editable-document path, and card read/write for free — hand-rolling another YAML file with its own reader and watcher would be reinventing a maintained dependency.

The project file is read and written with `node:fs/promises` plus `@deepseek-ai/dsh-atomic-write` (the same pair `packages/settings/settings-file` uses), and `node:fs.watch` with debouncing observes external edits. A missing file is a normal state, not an error. A malformed file **fails loud**: the settings card shows that project's parse error and the project layer is discarded as a whole (falling back to the global layer alone), never silently skipped.

Merge rule: case-sensitive literal matching by term, with the project layer overriding the global layer for the same term. Matching happens **inside a single text node** (a term split across nodes — for example by `**bold**` in the middle — is not recognized in this phase).

### 6.2 The settings namespace

The namespace is `terminology`. `Config` (cordis.yml) supplies deployment defaults and, through `base`, the composition layer that the user document layer overrides:

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

Every one is a schema field, with no hardcoded tunable constant (a repository rule: any value a different deployment might set belongs in configuration). `explainShortcut` needs a `validate` that rejects an unparsable chord; `projectGlossaryPath` must be workspace-relative, and an absolute or escaping path is refused at write time.

### 6.3 The typert remote, namespace `terminology`

Following the form of `packages/feedback/message-feedback`: `class TerminologyService extends TypertRemoteService` with `@Remote(...)`, and typed results (`{ ok: true, value } | { ok: false, error }`) instead of thrown exceptions.

| Method | Request | Success value | Failure kinds |
|---|---|---|---|
| `state` | `{ sessionId }` | `{ enabled, shortcut, projectPath, projectTerms, globalTerms }` | `SESSION_NOT_FOUND`, `GLOSSARY_INVALID` |
| `explain` | `{ sessionId, term, context }` | `{ explanation }` | `TERM_INVALID`, `CONTEXT_TOO_LARGE`, `NO_MODEL_ROUTE`, `LLM_FAILED`, `TIMEOUT` |
| `remember` | `{ sessionId, term, explanation, layer }` | `{}` | `TERM_INVALID`, `GLOSSARY_WRITE_FAILED`, `NO_WORKSPACE` |

A single `state` call gives the client everything it needs, avoiding extra round trips and the races between them.

**Forwarded event** `terminology/changed` (a `{ sessionId }` or global payload): the Host emits it when the project file changes externally, when settings are written, and when `remember` succeeds; the client refetches `state` on receipt. It rides the existing forwarding mechanism in `API_REMOTE_FORWARDED_EVENTS`, with the event signature declared in the package's `./types` export.

### 6.4 The LLM explain pipeline

The form copies `packages/session/session-title-llm/src/index.ts`:

- **Route resolution**: prefer `explainProvider` plus `explainModel` (both must be given); otherwise read the model route currently selected for the session, through the `lastUsed` field of `ctx.sessionProjections.stateOf(session, 'modelSelection')` (precedent: `packages/api/session-controller/src/agent.ts:279`). When neither resolves, return `NO_MODEL_ROUTE` rather than **silently falling back to a default model**.
- **Input**: the system message is a fixed instruction (return plain text only, no Markdown, give the explanation directly, use the asker's language, at most `explainMaxSentences` sentences), and the user message frames `{ term, context }` as JSON — copying what `frameMessages` does so user text cannot break the structural delimiters.
- **Bounds**: `explainMaxTokens`, `explainMaxSentences`, `explainTimeoutMs`, `explainTermMaxChars`, and `explainContextMaxBytes` all come from configuration; each call carries its own deadline (the `deadline()` helper, as session-title uses).
- **Output**: take text blocks only and reject a tool-call block; an empty result counts as a failure.
- **Model-facing writing rule**: the prompt and the diagnostics carry only task-relevant concepts (the term, the context, the language), never UI, transport, or implementation vocabulary.

### 6.5 The session event

Under the repository rule "model-visible ⟺ logged", the model request behind `explain` must be reconstructable from the session log. Declaration merging adds one `SessionEventMap` member:

```
'terminology/explain-request'
```

Its payload carries the framework input: `{ term, context, system, messages, route, maxTokens }`. The append uses the same two-argument log-only form as `session/title-llm-request`: once `gen-persistence-catalog` admits the type to the KNOWN catalog, current builds read the log; builds older than the type refuse it, matching the posture that precedent accepted. The event type and its payload schema belong to this package, declared in `packages/client/ui-terminology/src/types.ts`, and the `gen-persistence-catalog` generator produces and checks the catalog.

The glossary itself, the match results, and the panel state **never enter the log** (principle two in 1.3).

## 7. Browser Half Specification

### 7.1 The annotation provider

`ctx.provide('chatAnnotations', { annotations })` in `apply`. `annotations()` returns the current resolver, or `undefined` while the feature is off.

**Identity stability is part of the contract**: the resolver instance is rebuilt only when the vocabulary actually changes. `MarkdownText` memoizes the settled render on prop identity, so returning a fresh instance from every render would re-parse the whole prose on every frame.

Inside the resolver: sort the glossary by descending length (so a longer term wins, for example `Transformer 架构` over `Transformer`) and single-pass scan each text node into segments. While the feature is off it returns `undefined` and the renderer takes the unchanged-string path.

### 7.2 Glossary synchronisation

- Fetch `ctx.remote.terminology.state(sessionId)` at `apply` startup and on every session switch.
- Refetch when the forwarded `terminology/changed` arrives.
- Write the result into `createSnapshotStore()` (`@deepseek-ai/dsh-client-store`, already in the `PLATFORM_MODULES` baseline).
- A changed vocabulary snapshot rebuilds the resolver instance.
- This is presentation state and **never enters the session log**.

### 7.3 Manual recognition

**Selection listeners**: inside `apply`, use `ctx.effect()` to attach `contextmenu` (capture) and `keydown` listeners on `document`; unload tears them down automatically (registration is an effect, so no hand-written `removeEventListener`).

Takeover conditions (failing any one of them lets the native behaviour through):

- `window.getSelection()` is non-collapsed and non-empty after trimming;
- the selection's ancestor is **not** inside `input` / `textarea` / `[contenteditable]`, so the composer keeps its own context menu and shortcuts;
- the selected text is no longer than `explainTermMaxChars` (an over-long selection gets a visible rejection reason in the panel rather than silently opening nothing).

On triggering, record `{ text, rect, context }` and then `preventDefault()`. `context` is the text of the nearest block-level ancestor of the selection, truncated to the configured bound. This is the only place in the design that reads the DOM directly: read-only, no mutation of host DOM, no MutationObserver, and `window.getSelection()` is established practice in this repository (`ui-conversation/src/client/skeleton/InputBar.tsx:159`, `ui-primitives/src/HoverCard.tsx:149`).

**Context menu**: the `Menu` primitive from `ui-primitives`, anchored at the pointer and registered into `shell.overlay`. It carries **exactly one entry**: "explain '<xxx>'". It does not offer "add to glossary" — the user has not seen the explanation yet and should not be asked to store it first.

**Shortcut**: the `explainShortcut` configuration field, defaulting to `Alt+Shift+E`, under the same selection rules.

### 7.4 The explain panel

Registered into `shell.overlay` (a list slot, purely additive, touching no native region), anchored to the selection rectangle with `useAnchoredPosition`.

**It is `role="dialog"`, not a tooltip**: the panel contains interactive controls (add to glossary, retry, close), which by the ARIA patterns makes it a dialog. That is precisely why it is not bound by the tooltip content restriction and can legitimately carry buttons and an error state.

State machine:

```
open → (glossary hit?) ──yes──▶ show explanation
                       └─no──▶ loading ──ok──▶ show explanation
                                    └──fail──▶ visible error state + retry button (plus a Toast)
```

Opening moves focus into the panel; Escape closes it. Two buttons sit at the bottom: "add to glossary" and "close".

**Which layer it writes**: the default is the **global layer** (personal vocabulary), because defaulting to the project file would dirty the user's worktree and manufacture an unexpected diff. The settings card lets the user explicitly choose "add to project glossary"; when the project layer is unavailable (no workspace) that option is disabled with its reason shown.

### 7.5 The settings card

- Host: `ctx.settings.register('terminology', Config, { base: config })` obtains the scope.
- Browser: `ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name: 'settings.plugin.item', key: 'terminology', locale: NS, inject }, TerminologyCard))`, with the key equal to the Host namespace (this is the join key that pairs the two halves).
- Card contents: the master switch, the shortcut, create/update/delete for global terms, a read-only project-term list with the file path and an "open the project glossary in the editor" action, and a visible error bar when the project file fails to parse.
- Reads and writes go through `ctx.settingsScope.bind({ namespace: 'terminology' })`, with revision fencing on writes.

## 8. Error and Information Visibility Policy

The requirement "do not hide the download format or error information inside the tooltip" lands as four testable constraints:

1. **The automatic term tooltip carries explanation text and nothing else.** No button, no link, no error, no download entry. It is `role="tooltip"`, and the ARIA pattern forbids interactive content there in the first place.
2. **The manual explain panel is a dialog, and an error appears in it as a visible error state with a retry button**, alongside a `Toast`. Failure information never depends on hover and never leaves the user guessing.
3. **A glossary file parse error appears in the settings card**, not only on hover.
4. **This feature ships no download.** Should an export be added later, its format choice must be an explicit control on the card's level and must never be placed inside a tooltip — recorded as a constraint in the package README's Known Limitations and guarded by the assertions in section 9.

## 9. Test and Verification Plan

| Surface | Evidence |
|---|---|
| Render seam | `ui-primitives` unit tests: with no annotations the existing DOM fixture is byte-identical; with annotations only `text` nodes are split and every other node is untouched; no annotation inside `inLink`; no annotation while `streaming`; a provider-side property test for the concatenation identity |
| Accessibility | `AnnotatedTerm` component tests: hover / focus / click / Escape / blur / outside pointer / pointer moving into the bubble keeps it open; `aria-describedby` plus `role="tooltip"`; no interactive element inside the bubble (assert the `role="tooltip"` subtree contains no button, anchor, or input) |
| Touch | A Playwright e2e with a `hasTouch: true` context, opening the bubble with `page.tap(term)`; assert the trigger has role button in the accessibility tree and that its underline is visible without hover (no `:hover` dependency) |
| Browser behaviour | The context menu, the shortcut, selection boundaries (no takeover inside an input, over-long rejection), longest-term-first matching, the panel state machine, and card read/write with a revision conflict |
| Host | Two-layer merge precedence including a same-term override, project-file read/write with missing and malformed cases, and `explain`'s prompt / route / timeout / empty-output paths plus `remember` on both layers |
| Real composition | A **REAL-composition test** (repository-mandated): mount the package through a test-only `cordis.yml` and the Loader plus app/process, asserting model-visible, durable, or user-visible output, without hand-building `ctx.plugin(...)` |
| Snapshots | A keyless recorded-session snapshot: `terminology/explain-request` enters the log and replays; a Web composition snapshot pins the visible output |
| Gates | `pnpm run test:gui`, `DSH_SNAPSHOT=replay pnpm run test:web`, `typecheck`, `lint`, `duplication`, `doc-sync`, `gen-persistence-catalog` |

## 10. Delivery Split

The repository uses stacked PRs, so "all at once" means one design delivered as a stack:

1. The `ui-primitives` seam and `AnnotatedTerm`, with seam unit tests and component tests — independently reviewable and revertible, with zero behaviour change while no plugin is mounted.
2. `ui-chat` forwarding `chatAnnotations`.
3. The `ui-terminology` Host half: settings namespace, two-layer glossary, typert remote, LLM explain, session event, change event.
4. The browser half: annotation provider, glossary synchronisation, manual recognition, explain panel, settings card.
5. The registration surfaces (all seven in 5.2), the composition test, the e2e, and the snapshot.
6. Documentation: the package README pair (with its Model Experience section and Known Limitations), the subsystem documentation updates it requires, and the Agent Note pair.

## 11. Known Risks and Trade-offs

1. **Changing 11 files across three core packages is the heaviest part of this work.** It is required: no slot in this repository can decorate message prose, and `conversation.chat.node` is a whole-row keyed replacement that would force a plugin to fork roughly 300 lines of built-in rendering. The measured cost of the alternatives is in Appendix A.
2. **A term split across nodes is not recognized.** A term broken in the middle by Markdown emphasis syntax (such as `Trans*former*`) does not match. That follows directly from matching inside a single text node, and it buys implementation simplicity and zero collateral damage.
3. **Matching in prose is literal, with no word boundaries and no tokenization.** Chinese has no natural word boundary, so a glossary entry of `模型` will also mark the `模型` inside "模型化" and "大模型". The mitigations are longest-term-first ordering and a user-maintained glossary; this phase introduces no tokenizer. This belongs in the package README's Known Limitations.
4. **Manual recognition reads the DOM selection.** It is the only place in the design that reads the DOM, with the bounds stated in 7.3: read-only, no mutation, no observer, and inputs excluded. If the repository later offers an official selection or context-menu seam, this should migrate to it.
5. **`terminology/explain-request` is a new durable event type**, adding one more event kind to the session log. Builds older than it refuse the log under the existing version mechanism, the same posture accepted when `session/title-llm-request` was introduced.
6. **Touch has no hover.** A term link therefore needs a visible interactive cue in its resting state, and its behaviour tests must run under a `hasTouch` context rather than only in a desktop pointer environment.

## Appendix A: Alternatives Considered and Rejected

- **A pure plugin taking over the `assistant-step` key of `conversation.chat.node` (zero core change).** Rejected. `ui-chat`'s `/client` exports only `apply`, `inject`, and types, and the client rules forbid a plugin from value-importing another feature plugin's values, so a taker-over would have to rewrite `AssistantNodeView` plus `AssistantMarkdown` plus `ReasoningRow` plus `searchable-hidden` plus two stylesheets — roughly 300 lines — and would drift on every change DSH makes to message rendering.
- **Copying the core files to be changed into the plugin and registering from there.** Rejected. The measured copy closures total roughly 4,238 lines (`MarkdownText`: 15 files, 3,107 lines; `AssistantNodeView`: 15 files, 1,131 lines). Beyond the drift, three consequences are more expensive: the Markdown safety policy (protocol allowlist, no raw HTML in the DOM, KaTeX without trusted commands) would exist in two copies; `ui-primitives` is a shared `PLATFORM_MODULES` singleton, so the copy would be a second private instance with split CSS Module class names, a split KaTeX instance, and a split highlight cache; and the jscpd clone detection behind `pnpm run duplication` would necessarily flag it.
- **A zero-core-change degraded version: only "select → explain" inside `shell.overlay`.** Kept as a fallback. It fully covers manual recognition but cannot deliver an automatic inline link in the prose, so it is not the primary plan.
- **Having the model annotate terms itself (registering a system-prompt section plus marker syntax).** Rejected. It would introduce a private marker syntax into prose that every rendering surface (trajectory, export, copy) would have to understand, and the glossary would no longer be under the user's control.
- **Reusing the `chatFileMentions` seam.** Rejected. It recognizes `inlineCode` nodes only, returns `{ open, label, title }`, and renders its tooltip through the native `title` attribute — no keyboard-focus opening, no click or touch, and no control over styling or behaviour.
- **Storing the global glossary in a separate `$DSH_HOME/terminology.yml`.** Rejected. The settings document already provides revision fencing, change events, an editable-document path, and card read/write; a second file would be reinventing it.

## Appendix B: Measured Data

`MarkdownText` copy closure (starting at `packages/client/ui-primitives/src/markdown/MarkdownText.tsx`): 15 files / 3,107 lines, the largest being `render.tsx` 629, `highlight.ts` 487, `incremental.ts` 360, `mathCompatibility.ts` 349, and `MarkdownText.module.css` 321.

`AssistantNodeView` copy closure (starting at `packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx`): 15 files / 1,131 lines, the largest being `contract/slots.ts` 235, `contract/snapshot.ts` 142, `AssistantMarkdown.tsx` 129, and `contract/chat-nodes.ts` 129.

This plan's core change: 11 files, of which 9 are seam edits of a few lines to a few dozen and 2 are new files.
