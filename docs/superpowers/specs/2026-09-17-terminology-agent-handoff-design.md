# Terminology Project Handoff Design Specification

English | [中文](2026-09-17-terminology-agent-handoff-design.zh.md)

- Date: 2026-09-17
- Status: awaiting final user sign-off
- Scope: how the manual-lookup panel escalates when a passage cannot determine a term — a wider-context retry, then a handoff to the session agent. No new model tool, no session-protocol change, no host-side repository search.
- Prerequisites: [2026-09-16-web-inline-terminology-design.md](2026-09-16-web-inline-terminology-design.md), [packages/client/ui-terminology/README.md](../../../packages/client/ui-terminology/README.md), [docs/subsystems/slots.md](../../subsystems/slots.md)

## 1. Background and Goals

### 1.1 The problem

The explain side-channel call sees exactly one prose block: the paragraph around the selection. That is enough for vocabulary a general model knows and not enough for project jargon, internal codenames, or a word whose meaning lives in the code. When the passage does not determine the term, the model answers anyway: the panel presents a fluent guess with the same confidence as a grounded answer, and the reader has no way to tell the two apart.

### 1.2 One-line positioning

**A lookup escalates through three priced rungs and stops at the cheapest one that answers: the passage, then the whole answer the selection sits in, then the session agent, which reads the repository only when the conversation cannot determine the term; whatever the last rung concludes can be folded into the project glossary.**

### 1.3 Design principles

- The model reports its own inability. The alternative — local rules that guess when a term "looks project-specific" — was rejected by the user in favour of the model saying so, so the signal comes from the same reading that produces the explanation.
- Each rung is priced before it runs. The paragraph call costs hundreds of tokens, the wider retry costs thousands, and an agent turn re-sends the whole session and is measured here in hundreds of thousands, so the design never reaches a rung the reader did not need.
- The handoff reuses the session's own turn channel. No new inference path, no plugin-owned tool, no second conversation: the instruction becomes a normal queued turn, so the exploration is logged, visible, and reconstructible like any other turn.
- Nothing reaches the glossary without the user's confirmation. The agent proposes one entry and writes it only after the user agrees, and the project file is version-controlled, so the write is reviewable.

## 2. Scope

### 2.1 In scope

- The undetermined outcome of the explain call: its prompt instruction, its parsing rule, and its place in the remote result.
- The wider-context retry: where the wider text comes from, how it is bounded, and what happens when it fails.
- The panel state that renders the reason, the handoff entry, and the cost notice.
- The prepared instruction the panel queues into the current session.
- The glossary write path for the agent's conclusion and the refresh that follows it.
- The per-lookup usage line the panel shows, including the provider's cache counters when it reports them.
- Copy in both locale dictionaries, the package README pair, and the owning Agent Note pair.

### 2.2 Explicitly out of scope

- Host-side repository search. Rejected: it sends repository content to whatever route the session selects, and it turns a two-second lookup into a retrieval pipeline.
- Searching the session log for other occurrences of the term. Deferred: the wider retry already covers the common case, and this adds a retrieval path with its own bounds.
- Reading the agent's answer back into the panel to offer a save button there. Rejected for now: it forces the panel to bind one term to one turn across streaming, multiple turns, and session switches.
- An explanation result cache. The user declined it for this change.
- Any model-facing tool owned by this package.
- A composer prefill or message-attribution extension point.

### 2.3 Division of labour with adjacent capabilities

- The commands capability cannot carry this: `CommandResult` returns text to the dispatching surface and deliberately never reaches the model, so a command cannot inject an instruction.
- The client sessions service already owns the way into a conversation: `binding(id).session.prompt(content, 'queue')` is the same call the composer makes, and `SessionBinding.session` is the outward session face feature code is allowed to hold.
- The conversation renderer owns the message boundary the wider retry needs, so this change adds one stable hook beside the annotation seam it already provides.
- The project glossary already has a watcher that re-reads an externally edited file and fans out `terminology/changed`, so a file the agent writes with its own tools appears in the panel and in the tooltips without new code.
- The settings card and both vocabulary layers are unchanged.

## 3. The Undetermined Signal

### 3.1 Prompt instruction

The explain system prompt gains one instruction: when the passage does not determine the term's meaning in this project, reply with exactly one line beginning `NEEDS_PROJECT:` followed by a short reason, and nothing else; otherwise answer as today. The instruction is model-facing English, like the rest of the prompt, and stays inside the existing `explainMaxSentences` framing.

### 3.2 Parsing rule

- The first line decides. Leading whitespace is ignored and the marker is matched case-insensitively.
- The marker line is stripped; the remainder of that line is the reason, trimmed, and may be empty.
- A marker appearing later in the text does not qualify: the answer is an explanation, and the marker is prose.
- A marker with no reason still produces the undetermined outcome; the panel then shows a generic reason line from the dictionary. Marker recognition settles the outcome before the emptiness rule below is reached.
- When no marker is recognized and the assembled answer is empty, today's `LLM_FAILED` stands, because an explanation with no text carries nothing to show.

### 3.3 Contract change

`TerminologyExplainResult`'s success value becomes a discriminated union: `{ kind: 'explained'; explanation: string }` or `{ kind: 'undetermined'; reason: string }`. The union is switched on by `kind` at every consumer, which is this package's own client half. The durable `terminology/explain-request` record is unchanged in shape: it records requests, not outcomes, so the wider retry appends a second record of the same type.

### 3.4 What does not change

- `LLM_TRUNCATED`, `LLM_FAILED`, `TIMEOUT`, `TERM_INVALID`, `CONTEXT_TOO_LARGE`, and `NO_MODEL_ROUTE` keep their meanings and their copy.
- The tooltip contract stays "the explanation text and nothing else": the marker never reaches a tooltip, because it is consumed by the pipeline.
- Routing is unchanged: the configured pair first, otherwise the session's last model selection, otherwise `NO_MODEL_ROUTE`.

### 3.5 The wider-context retry

- One undetermined answer triggers exactly one retry, and only when a wider context is available. The narrow call's context is the paragraph; the retry's context is the whole assistant answer that paragraph belongs to.
- The client supplies it. `evaluateSelection` already returns the enclosing block's text; it also walks up to the enclosing message root and returns that text as `wideContext`, empty when the selection sits outside an assistant answer. This change adds the stable hook that marks that root, beside the annotation seam this feature already relies on.
- The host bounds it. A new validated field, `explainWideContextMaxBytes`, caps the retry's context the way `explainContextMaxBytes` caps the narrow call, and registration rejects a wide bound smaller than the narrow one.
- A retry that reports `undetermined` again ends the escalation at rung two: the panel opens the handoff entry. A retry that explains ends it with the explanation. Either way the reader sees one settled surface, never a retry in flight.
- A retry that fails on its own terms — truncation, a provider failure, a timeout — does not hide the first answer's honesty: the panel still opens the undetermined state with the first reason, and renders the retry's own dictionary line beneath it, because a wider attempt that failed is a fact the reader needs.
- When no wider context exists (no enclosing assistant answer, or the narrow call already consumed the whole of it), the retry is skipped and the panel opens the handoff entry directly.

### 3.6 Usage and cache reporting

- Every explain call ends with a `usage` chunk, and the pipeline keeps the terminal one. The result therefore carries the call's `inputTokens`, `outputTokens`, the provider's `totalTokens` when it reports one, and the provider's `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens` when it reports those.
- An unreported counter stays absent. A route that returns no cache detail is not a cache miss, and neither half may fabricate a zero for it: the local gateway this feature was measured against reports no cache counters at all, while one measured cloud route reports an explicit zero on a miss and a count on a hit.
- Each call reports its own usage, and the retry is a second call with its own. The panel sums the calls a lookup actually ran and states how many that was, so a two-rung lookup cannot look like a one-rung one.
- The session's token meter stays the authority for what the session spent, and it already counts these calls because they carry the session id. The panel's line reports one lookup; it is a convenience view, not the accounting.

## 4. Panel Surface

### 4.1 New stage and its rendering

- The overlay's request state gains `undetermined`, carrying the reason and an optional retry-failure line. It renders the reason, that line when present, the handoff entry, and the close action.
- The stage appears only after the escalation is settled: the loading stage covers both calls, so the reader never sees the panel flip from loading to undetermined and back.
- The add-to-glossary action does not appear in this state: there is no explanation to save, and saving a reason would write prose the model explicitly said it could not stand behind.
- The explain verb of the client policy returns this state from the remote outcome, and the panel's existing dismissal, focus, and announcement behaviour is unchanged.

### 4.2 The cost notice

The handoff entry states, beside its label, that it starts one agent turn. A turn is orders of magnitude more expensive than the calls it follows, so the reader decides with the cost in view rather than discovering it.

### 4.3 Copy ownership

The reason line renders the model's text verbatim as user data. Every string the panel owns — the reason fallback, the retry-failure line, the handoff label, the cost notice — lives in the locale dictionaries in both locales, reached through the existing `t` seat.

### 4.4 The usage line

- It renders beneath an explanation, and in the undetermined state as well, because those calls were paid for even though neither rung produced an answer.
- It names what the lookup spent: input tokens, output tokens, and the provider's total when it reports one. The cache clause comes only from reported counters — a hit states the cache-read count, a reported zero states that nothing was served from cache, and a route that reports no counters leaves the clause out rather than claiming a miss.
- It covers the rungs this lookup ran: one call, or two when the wider retry ran. The handoff's agent turn is deliberately outside it, because that turn is the session's, and the session meter already shows it.
- The tooltip never carries it. The tooltip contract stays the explanation text alone, and a glossary hit makes no call whose usage could be reported.

## 5. The Agent Handoff

### 5.1 Transport

The panel's handoff action resolves the current session through the client sessions service and queues one user turn with `prompt(content, 'queue')`. A rejected admission returns the remote's business error, which the panel announces through the existing transient announcement; the panel stays open so the reader can retry.

### 5.2 The prepared instruction

The instruction is model-facing English and names the term, the passage it came from, what has already been tried, and what makes a good answer. Its exact text is pinned here so the model-visible contract cannot drift silently:

```text
Explain the term below for the reader of a DSH session.

Term and its passage (JSON):
<the same JSON object the explain call frames>

The reader's passage was not enough to determine the meaning, and neither was the whole answer it came from. Use any other context you already hold in this conversation, and read repository files, documentation, or configuration when the conversation does not determine what the term means in this project. Then answer in at most three sentences of plain text, in the language of the passage.

Finish by proposing exactly one project glossary entry as "term: <term>" and "explanation: <your explanation>", and write it into the project glossary file only after the reader confirms.
```

### 5.3 Attribution honesty

`prompt()` carries no source tag, so the queued instruction appears in the transcript as a user message. The package README records this as a known limitation: a reader reviewing the session sees the instruction in their own voice, which is why the instruction is phrased as a request and never claims to be the reader's words.

### 5.4 Bounds

The term and the passage travel inside the same JSON framing the side-channel call uses, so prose cannot break the structure, and the same limits apply: the term must fit `explainTermMaxChars` and the passage must fit `explainContextMaxBytes`. A term beyond its limit never reaches the handoff, because the client refuses that selection before any call. A passage beyond its limit fails the explain call with `CONTEXT_TOO_LARGE`, and the handoff entry exists only in the undetermined state, so the reader narrows the selection instead.

## 6. Glossary Write and Refresh

### 6.1 Who writes

The agent writes the entry with its own editing tools, in the same turn the reader confirms in. The glossary path is the one the plugin already resolves for the session's workspace, relative and inside the workspace; creating the `.dsh` directory and the file belongs to the writer, which keeps the existing rule that reads and watchers never create workspace structure.

### 6.2 How it appears

The plugin's project-file watcher re-reads the file after the external edit and fans out `terminology/changed`; the panel and the inline tooltips then read the project layer, so the new entry is live without a reload and without new code in this change.

### 6.3 Review path

The glossary file is a workspace file under version control, so `git diff` is the review surface for what the agent wrote, and a rejected entry is a checkout away.

## 7. Failure and Edge Cases

- The wider retry answers: the panel shows the explanation, and no handoff entry appears.
- The wider retry is undetermined or was skipped: the panel opens the handoff entry with the first reason.
- The wider retry fails on its own terms: the undetermined state still opens, with the retry's failure named beneath the reason.
- No current session: the handoff entry reports the same absence the explain verb already reports, and the panel announces it instead of queuing into nothing.
- The queue rejects the turn: the announcement names the failure and the panel stays open.
- The reader dismisses the panel while the turn runs: the turn is already a normal session turn and continues; nothing in this design depends on the panel staying mounted.
- The term is later added to a glossary layer: the annotation path takes over from the panel, and a repeat selection shows the stored explanation with no model call.
- The model never emits the marker for a term that genuinely needs the repository: the reader can still select the term and use the handoff once the panel is open in the undetermined state, or ask the agent directly; the README names the marker as model-authored text.
- The model emits the marker for a term the passage did determine: the reader pays one wider retry and, at worst, one agent turn, and gets a grounded answer, which is the intended trade.

## 8. Test and Verification Plan

- Unit, pipeline: a table over the parsing rule — marker alone, marker with a reason, marker after leading whitespace, marker in mixed case, marker on a later line, marker with nothing after it, empty answer, and an ordinary explanation.
- Unit, retry: an undetermined narrow answer dispatches exactly one wider call whose context is the wider text; an explained retry returns the explanation; a second undetermined retry returns the undetermined outcome; a failing retry returns the undetermined outcome carrying the failure; a skipped retry (no wider text) dispatches nothing.
- Unit, bounds: registration rejects a wide bound below the narrow bound, and the retry's context is measured against the wide bound.
- Unit, policy: the client explain verb maps the undetermined outcome to the new state, and the state carries the reason and the optional failure.
- Component: the overlay renders the reason, the optional failure line, the handoff entry, and the cost notice, and hides the add-to-glossary action in this state.
- Unit, handoff: the action queues exactly one message into the current session, with the pinned instruction text and the framed JSON, and surfaces a rejected admission as an announcement.
- Unit, usage: each call's terminal usage is captured and returned; a route that reports no cache counters yields a result without them; a lookup that ran the retry reports the summed usage and a call count of two.
- Component: the overlay renders the usage line under an explanation and in the undetermined state, states a cache hit from a reported count, states no hit from a reported zero, and omits the cache clause when nothing was reported.
- Component: the annotated-term tooltip renders the same as before, with no usage line.
- Assembled browser scenario: a scripted undetermined narrow reply followed by an explained retry settles the panel on the explanation; a second scripted pair that stays undetermined opens the hint and the entry; clicking the entry queues the turn and the transcript shows it; the scenario keeps the existing glossary and touch assertions.
- Docs gates: the README pair, the Agent Note pair, the locale dictionaries, and this pair pass `doc-sync` apart from the pre-existing foreign failures.

## 9. Files Touched

- `packages/client/ui-terminology/src/explain.ts`: prompt instruction, marker parsing, undetermined result, the retry, and the terminal usage it returns.
- `packages/client/ui-terminology/src/types.ts`: the discriminated success value, the usage it carries, and the wide-context bound's place in the config type.
- `packages/client/ui-terminology/src/index.ts`: the wide-context bound and its registration check, and the retry wiring.
- `packages/client/ui-terminology/src/client/selection.ts`: the wider context from the enclosing answer.
- `packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx`: the stable message-root hook the wider context is read from.
- `packages/client/ui-terminology/src/client/overlay-policy.ts`: the undetermined state, its optional failure, the per-lookup usage, and the handoff verb.
- `packages/client/ui-terminology/src/client/index.ts`: the explain mapping, the handoff action, and the instruction text.
- `packages/client/ui-terminology/src/client/TerminologyOverlay.tsx` and `TerminologyOverlay.module.css`: the new state's rendering and the usage line.
- `packages/client/ui-terminology/src/client/locales.ts`: the new copy in both locales, the usage line included.
- `packages/client/ui-terminology/README.md` and `README.zh.md`: the rungs, the state, the handoff, the attribution limitation, and the new config row.
- `packages/client/ui-terminology/tests/explain.host.spec.ts`, `tests/selection.client.spec.ts`, `tests/apply.client.spec.ts`, and the overlay policy spec: the cases in section 8.
- `apps/web/tests/terminology-inline.e2e.ts`: the assembled scenario.
- `.agents/notes/implemented/feature/2026-09-17-web-inline-terminology.md` and its Chinese counterpart: the decision and the rejected alternatives.

## 10. Known Risks and Trade-offs

- The marker is model-authored: a model that never admits ignorance keeps today's behaviour, and a model that over-reports pays the wider retry and can pay an agent turn. The design cannot make the judgement deterministic; it can make the disagreement cheap and visible.
- The wider retry doubles the model spend on the undetermined path. The measured rungs keep that bounded: a retry costs thousands of tokens against an agent turn's hundreds of thousands.
- The wider context may still miss the answer, in which case the reader pays for the retry and then reaches the agent anyway.
- The queued instruction is attributed to the reader in the transcript, as section 5.3 records.
- The panel gains a third outcome and the pipeline gains a second dispatch, so both halves' state machines and their tests grow with it.
- The usage line reports what the provider reports: a route with no cache counters shows input and output alone, and the number is tokens rather than money, because pricing belongs to the deployment and not to this panel.
- The exploration turn is not bounded by this package: it obeys the session's own tool and approval policy, which is deliberate, because the reader's session already owns those decisions.

## Appendix A: Alternatives Considered and Rejected

- **Local deterministic heuristics for "this term looks project-specific"** (glossary miss plus a workspace hit, or a code-shaped token). Rejected by the user: the signal should come from the reading that produces the explanation, not from a shape rule that cannot see meaning.
- **Always showing the handoff entry.** Rejected: it invites an agent turn for every lookup and drops the "this passage is not enough" statement that makes the panel honest.
- **Treating "use the context you already hold" inside the agent turn as the second rung.** Rejected after measurement: an agent turn re-sends the whole session before the model reads anything, so paying for it to read context a standalone call could have read is the most expensive possible order.
- **Host-side repository search.** Rejected: it sends repository content to the routed model on every lookup and duplicates what the agent does better with tools.
- **Searching the session log for other occurrences of the term.** Deferred: the enclosing answer covers the common case, and a log search adds a retrieval path with its own bounds and tests.
- **Reading the agent's answer back into the panel.** Deferred: it binds one term to one turn and multiplies the states the panel must survive.
- **An explanation result cache keyed by term and passage.** Declined by the user for this change; the durable version of the idea already exists as the glossary.
- **A command-based handoff.** Rejected: `CommandResult` never reaches the model, so a command cannot deliver the instruction.
- **A host-side subagent run instead of a session turn.** Rejected: it adds an agent dependency and a budget to a client plugin for an outcome the session turn already produces, and it hides the exploration from the transcript.

## Appendix B: Measured Data

- One-shot explain as shipped, on the routed local model with thinking on: a short term costs roughly 400 tokens and a reasoning-heavy term reached 1303 completion tokens (≈1520 total) for the same question.
- The same route with a short passage versus one at the narrow cap: prompt tokens moved from 160 to 601, which is the range the wider retry trades against.
- Thinking disabled on that gateway through `chat_template_kwargs.enable_thinking=false`: the same reasoning-heavy term cost 57 completion tokens (≈277 total) with an equally complete answer. Recorded as a separate lever; this design does not change the thinking policy.
- Prefix caching on that gateway: `prompt_tokens_details` is empty and an identical 1288-token prefix sent three times was billed 1288 fresh tokens each time, so reusing an existing conversation prefix saves nothing on this route.
- Cached reads are not free anywhere: one turn of a session on this machine recorded 219,392 cache-read tokens, which is the order of an agent turn's input against a standalone call's hundreds.
- The marker's own cost: the added instruction is roughly 30 input tokens, and an undetermined reply is roughly 10 to 20 output tokens.
