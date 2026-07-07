---
date: 2026-07-07
topic: context-occupancy-gauge
stage: plan
status: complete
source: conversation
---

# Context Occupancy Gauge Plan

## Goal

Sequence the build for the contract in
`docs/specs/2026-07-07-context-occupancy-gauge-spec.md`: surface each live Claude
Code and Codex session's **current context-window occupancy** (used tokens,
window size, percent full) through the live API and render it on the monitor card
and session detail/inspector surfaces. Occupancy numerator = the **most recent
request's prompt size**, never a cumulative session total. Every `Done When`
below traces to that contract.

## Scope

In: numerator extraction from Claude + Codex JSONL, a window-denominator
resolver, persistence on the live projection, live API + SSE exposure, a card
pill + detail gauge, and (deferrable) a session trajectory. Out: the `/context`
category breakdown, Antigravity, historical occupancy, alerting/enforcement.

## Assumptions And Constraints

- **v1/v2 split is real.** `AgentCards.svelte` and `monitor/SessionDetail.svelte`
  read the v1 monitor store (`stores/monitor.svelte.ts`, `getSessions()` →
  `Session`); the Live `InspectorPanel.svelte` reads the v2 `browsing_sessions`
  projection (`LiveSession`). Occupancy is computed once and persisted on the v2
  projection; the v1-fed card/detail surfaces obtain it by merging the v2 value
  keyed by session id (Task 7), because v1 sessions only hold cumulative
  `tokens_in/out` and cannot reconstruct occupancy.
- **Numerator is not in any current model.** v1 `tokens_in/out` are cumulative
  SUMs of event deltas; v2 `browsing_sessions` has no token columns. Both parsers
  currently discard per-turn usage. So the numerator must be freshly extracted at
  parse time.
- **Denominator defaults** (from the operator): Claude → **1M**; Codex → session's
  reported `model_context_window` when present, else a configurable **~256K**.
- Additive-only DB change: follow the existing `ALTER TABLE browsing_sessions ADD
  COLUMN` pattern (`src/db/schema.ts:422+`); no destructive migration.
- Keep TS ESM `.js` import style; v2 SQL stays in `src/db/v2-queries.ts`.

## Map Before You Cut

Data path (verified):
`JSONL → parser (claude-code.ts / codex-sessions.ts) → ParsedSession → live
adapter (claude-adapter.ts / codex-adapter.ts syncCodexLiveSession) →
upsertProjectedSessionSnapshot (projector.ts) → browsing_sessions (schema.ts) →
mapBrowsingSessionRow (v2-queries.ts:66) → LiveSession API + SSE → frontend`.

Chosen seam: carry occupancy as fields on `ParsedSessionMetadata`, computed in
each parser from the last assistant/token turn; the live adapters pass them into
a widened `ProjectedSessionSnapshot`; two new nullable columns on
`browsing_sessions` persist them; `mapBrowsingSessionRow` surfaces them on
`LiveSession`. This mirrors exactly how `mode` and `message_count` already flow,
so it is the thinnest cut that satisfies the contract.

## Task Breakdown

### Task 1: Window-denominator resolver (TDD)

**Objective**: A pure module that resolves a context-window size from
`{ agent, model, reportedWindow?, observedTokens? }`, applying the 1M Claude
default and configurable Codex default, and never returning a window smaller than
observed tokens (guard against `>100%`).

**Files**: `src/pricing/context-windows.ts` (new),
`tests/context-windows.test.ts` (new — tests live in `tests/`, importing from
`../src/...`; `src/**/*.test.ts` is NOT globbed by `pnpm test`), `src/config.ts`
(add `AGENTMONITOR_CODEX_CONTEXT_WINDOW` default ~256000, via the existing
`parseEnvInt` convention).

**Dependencies**: None.

**Implementation Steps**:
1. Red: write tests — Claude resolves to 1,000,000 by default; Codex uses
   `reportedWindow` when given, else config default; when `observedTokens >
   window`, resolves up to the next known tier or returns the observed value so
   percent never exceeds 100.
2. Green: implement `resolveContextWindow(...)` with a small model→window map and
   the config-backed Codex default.
3. Expose a `computeOccupancy({ usedTokens, window })` helper returning
   `{ used, window, pct }` with `pct = round((used / window) * 100)`.

**Verification**: `pnpm test` — new `tests/context-windows.test.ts` green (matched
by the `tests/*.test.ts` glob in the `test` script).

**Done When**: resolver + occupancy helper pass unit tests including the
over-window guard. (Traces to contract: denominator resolution + no nonsensical
`>100%`.)

**Assumptions Verified**: `src/pricing/` has no context-window field today
(`rg context.?window src/pricing` empty); `src/config.ts` is the env-var home;
`package.json:19` `test` script globs `tests/*.test.ts` + `tests/codebase/*.test.ts`
only (no `src/**` — all 61 existing tests live in `tests/`).

### Task 2: Claude numerator extraction (TDD)

**Objective**: The Claude parser captures the latest assistant turn's
`input + cache_read + cache_creation` input tokens and the model, exposing them
on `ParsedSessionMetadata`.

**Files**: `src/parser/claude-code.ts`, `tests/claude-parser.test.ts` (new, in
`tests/`, importing from `../src/parser/claude-code.js`).

**Dependencies**: None.

**Implementation Steps**:
1. Red: fixture JSONL with two assistant turns of differing `message.usage`;
   assert metadata reports the **last** turn's input+cache sum and its model.
2. Green: add `usage` to the inline `ClaudeCodeLine.message` type
   (`claude-code.ts:50-54` already declares `model` but not `usage`); while
   iterating lines, track the most recent assistant `message.usage` +
   `message.model`; add `context_used_tokens?: number` and `model?: string` to
   `ParsedSessionMetadata`; populate them.

**Verification**: `pnpm test` — `tests/claude-parser.test.ts` green; existing
suite green.

**Done When**: parser surfaces last-turn occupancy tokens + model without
altering existing parsed output. (Traces to: Claude numerator = latest request.)

**Assumptions Verified**: `ParsedMessage`/`ParsedSessionMetadata`
(`claude-code.ts:64-99`) carry no token fields today; `ClaudeCodeLine.message`
(`:50-54`) types `model` but not `usage`; usage lives at `message.usage` in the
raw line.

### Task 3: Codex numerator + reported window extraction (TDD)

**Objective**: The Codex JSONL parser captures the latest `token_count` event's
`last_token_usage` input (inclusive of cached) and `model_context_window`,
exposing them on `ParsedSessionMetadata`.

**Files**: `src/parser/codex-sessions.ts`, `tests/codex-parser.test.ts` (new, in
`tests/`).

**Dependencies**: Task 2 — **shared-file convenience only** (both edit the shared
`ParsedSessionMetadata` interface; no logical prerequisite). Sequence to avoid a
merge conflict on that interface.

**Note on task size**: this is **net-new parsing logic**, not surfacing an
already-typed field. `codex-sessions.ts` today only processes `session_meta` and
`response_item` lines (`:93-184`) and its `CodexLine.payload` type has **no `info`
field** — it has never looked at telemetry lines. Task 3 adds a whole new
`event_msg`/`token_count` branch plus payload typing.

**Implementation Steps**:
1. Red: fixture Codex JSONL with `event_msg`/`token_count` lines carrying
   `info.last_token_usage` and `info.model_context_window`; assert metadata
   reports the last event's input (+cached) and the reported window.
2. Green: add a `token_count` branch to the line loop and an `info` field to the
   `CodexLine.payload` type; track the most recent `last_token_usage` +
   `model_context_window`; populate `context_used_tokens` and a new
   `context_window_reported?: number`. Do **not** use `total_token_usage`
   (cumulative — already consumed by billing).

**Verification**: `pnpm test` — `tests/codex-parser.test.ts` green.

**Done When**: Codex parser surfaces last-request occupancy + reported window.
(Traces to: Codex numerator + first-party window.)

**Assumptions Verified**: `src/parser/codex-sessions.ts:93-184` handles only
`session_meta`/`response_item` and its `CodexLine.payload` has no `info` field
(net-new work). `src/import/codex.ts:13-38` (a *separate* historical importer,
not this file) types the same `info.{last_token_usage,total_token_usage,
model_context_window}` shape — reference only. Raw telemetry confirmed present in
today's live rollout JSONL. Live JSONL path is `syncCodexLiveSession`
(`codex-adapter.ts:434`), distinct from the OTEL/hook event path
`syncCodexSummaryLiveEvent` — the JSONL path is what a running Codex session
flows through.

### Task 4: Persist occupancy on the live projection

**Objective**: Occupancy tokens + resolved window persist on `browsing_sessions`
and are written by both live adapters.

**Files**: `src/db/schema.ts` (additive columns), `src/live/projector.ts`
(`ProjectedSessionSnapshot` + upsert SQL), `src/live/claude-adapter.ts`,
`src/live/codex-adapter.ts` (`syncCodexLiveSession`).

**Dependencies**: Tasks 1–3.

**Implementation Steps**:
1. Add nullable `context_used_tokens` and `context_window_tokens` columns via the
   existing `ALTER TABLE browsing_sessions ADD COLUMN` guard block
   (`schema.ts:422+`).
2. Widen `ProjectedSessionSnapshot` with the two fields; add them to the
   `upsertProjectedSessionSnapshot` INSERT + `ON CONFLICT` SET (use `excluded.…`,
   not COALESCE, so occupancy always reflects the latest sync).
3. In each adapter, call the Task 1 resolver with the parsed numerator/model/
   reported-window and write both fields into the snapshot upsert.

**Verification**: `pnpm test` + `pnpm build`. Add `tests/live-occupancy.test.ts`
(or extend `tests/codex-adapter.test.ts`) asserting a synced session persists the
expected occupancy.

**Done When**: a synced Claude and Codex session row in `browsing_sessions` holds
correct `context_used_tokens`/`context_window_tokens`. (Traces to: live pipeline
carries occupancy.)

**Assumptions Verified**: additive migration pattern at `schema.ts:422+`; both
adapters already call `upsertProjectedSessionSnapshot` (claude-adapter.ts:110,
codex-adapter.ts:502).

### Task 5: Expose occupancy on the live API

**Objective**: `LiveSession` responses include `context_used_tokens`,
`context_window_tokens`, and derived `context_pct`.

**Files**: `src/db/v2-queries.ts` (`BrowsingSessionDbRow`, `mapBrowsingSessionRow`
at `:66`, `LiveSessionRow`), `src/api/v2/types.ts`.

**Dependencies**: Task 4.

**Implementation Steps**:
1. Add the two columns to `BrowsingSessionDbRow` and map them (plus computed
   `context_pct` via the Task 1 helper) in `mapBrowsingSessionRow`; emit `null`
   occupancy when tokens are absent (unavailable, not `0%`).
2. Extend the `LiveSession` API type. **No SSE payload change needed**: the live
   SSE events (`session_presence`/`turn_update`) carry no session data — they
   trigger a debounced REST refetch (`stores/live.svelte.ts:262-282`), and
   `mapBrowsingSessionRow` is `SELECT *`, so widened columns flow through the
   existing refetch path automatically.

**Verification**: `pnpm test` + a request-level test (or existing API test) that
`GET` live sessions returns occupancy fields; `pnpm build`.

**Done When**: live API returns occupancy; sessions without usage report `null`.
(Traces to: contract's falsifiable API behaviors.)

**Assumptions Verified**: read path is `listLiveSessions` (`v2-queries.ts:217`) /
`getLiveSession` (`:279`) → `mapBrowsingSessionRow` (`:66`). (Note `:182` is
`listBrowsingSessions`, a different v1-style list — do not confuse.) SSE events
are refetch-triggers, not data carriers (`live.svelte.ts:262-282`).

### Task 6: Card pill + detail/inspector gauge (frontend)

**Objective**: A `ContextPill` renders occupancy on monitor cards, and a fuller
used/window/percent gauge renders in the session detail + Live inspector.

**Files**: `frontend/src/lib/components/monitor/ContextPill.svelte` (new, mirror
`QuotaPill.svelte`), `frontend/src/lib/components/monitor/AgentCards.svelte`,
`frontend/src/lib/components/monitor/SessionDetail.svelte`,
`frontend/src/lib/components/live/InspectorPanel.svelte`,
`frontend/src/lib/api/client.ts` (`LiveSession`/`Session` occupancy fields).

**Dependencies**: Task 5. (The `AgentCards` pill placement lands in Task 7, which
supplies the v1 card's occupancy data; the `ContextPill` component + the
v2-native Live inspector/detail readout built here do not depend on Task 7.)

**Implementation Steps**:
1. Add occupancy fields to the frontend `LiveSession` type.
2. Build `ContextPill` reusing the `QuotaPill` fill-color thresholds
   (`ok/warn/danger` at 60/85%); render `null` occupancy as absent, not `0%`.
3. Add the used/window/percent readout in `live/InspectorPanel` (v2-native).
   (`monitor/SessionDetail` + `AgentCards` pill placement follow in Task 7 once
   the v1 `Session` carries occupancy.)

**Verification**: `pnpm frontend:check`; `pnpm build`; manual `:3141/app/` render
against a live session; optional Playwright snapshot.

**Done When**: card shows a fill pill; detail/inspector show the full readout;
occupancy updates live. (Traces to: card + detail rendering, live updates.)

**Assumptions Verified**: `QuotaPill.svelte` exists as the pill precedent;
`AgentCards.svelte` renders per-session cards via `getSessions()`.

### Task 7: Bridge occupancy into the v1 monitor card/detail (frontend)

**Objective**: The v1-fed monitor cards and `monitor/SessionDetail` obtain
occupancy despite reading the v1 store, by fetching v2 live occupancy and merging
it onto the v1 `Session` objects keyed by session id.

**Note on task size**: this is a **full vertical slice, not a thin merge**
(confirmed). `stores/monitor.svelte.ts` has **no v2 fetch of any kind** today, and
its SSE handler (`handleSessionUpdate`) only recognizes `idle_check`,
`auto_import`/`resync`, and `session_parsed` — it ignores the
`session_presence`/`turn_update` events the watcher broadcasts. So there is no
existing fetch/subscription to reuse; all three pieces below are net-new. Consider
splitting into 7a (fetch + index) and 7b (merge + refresh trigger) if it runs
long.

**Files**: `frontend/src/lib/stores/monitor.svelte.ts`,
`frontend/src/lib/api/client.ts` (v1 `Session` occupancy fields),
`frontend/src/lib/components/monitor/AgentCards.svelte`,
`frontend/src/lib/components/monitor/SessionDetail.svelte`.

**Dependencies**: Task 5, Task 6 (consumes the `ContextPill` built there).

**Implementation Steps**:
1. Add a v2 occupancy fetch to the monitor store, reusing `fetchLiveSessions` /
   `fetchLiveSession` (`client.ts:889-901`, already built for the Live tab);
   index results by session id.
2. Refresh the index on a live signal — either subscribe the monitor store to
   `session_presence`/`turn_update` on the existing SSE channel, or piggyback on
   the polling already in `stores/live.svelte.ts` — rather than adding an
   independent poll loop.
3. Add occupancy fields to the v1 `Session` type and merge occupancy onto the
   `Session` objects `getSessions()` returns.
4. Place `ContextPill` in `AgentCards` and add the used/window/percent readout in
   `monitor/SessionDetail`.

**Verification**: `pnpm frontend:check`; manual check that a Claude and a Codex
card both show occupancy sourced from v2, matching the Live inspector.

**Done When**: monitor cards render occupancy that matches the Live inspector for
the same session. (Traces to: card surface requirement despite v1/v2 split.)

**Assumptions Verified**: `stores/monitor.svelte.ts` owns `Session` state and
merges live event aggregates (`applyLiveEventAggregate`, `handleSessionUpdate`) —
correct merge point — but has **no v2 fetch** and its SSE handler ignores
`session_presence`/`turn_update` (net-new wiring required). `fetchLiveSessions`/
`fetchLiveSession` exist at `client.ts:889-901`.

### Task 8 (deferrable): Occupancy trajectory sparkline

**Objective**: A session-lifetime fill trajectory (with compaction drop-offs) in
the detail/inspector surface.

**Files**: projection sample retention (projector/adapters), live API type, a new
frontend sparkline in `SessionDetail`/`InspectorPanel`.

**Dependencies**: Tasks 4–6.

**Implementation Steps**:
1. Decide retention (bounded ring buffer of `{ t, used }` samples) and where it
   lives (open question in the spec); persist or keep in-projection.
2. Expose the series on the live API; render a sparkline reusing existing chart
   primitives.

**Verification**: `pnpm test` for the sample buffer; `pnpm frontend:check`;
manual render showing a drop after a compaction.

**Done When**: trajectory renders and drops after compaction. **This task may be
moved to `docs/project/BACKLOG.md`** if it materially expands the change; Tasks
1–7 are the firm deliverable.

**Assumptions Verified**: spec flags trajectory as deferrable and retention as an
open question.

## Risks And Mitigations

- **v1/v2 data-model split** (highest risk, and Task 7's cost is now confirmed,
  not conditional): the card surface reads v1, occupancy lives in v2, and the
  monitor store has **no** existing v2 fetch and ignores presence SSE events — so
  Task 7 is a full vertical slice (fetch + refresh subscription + merge), not a
  thin bridge. Mitigation: reuse the already-built `fetchLiveSessions` and the
  Live tab's SSE/polling rather than duplicating the extraction pipeline into v1;
  split Task 7 into 7a/7b if it runs long.
- **Claude window ambiguity**: 1M is a resolved default, not transcript-proven; a
  200K session would misreport the denominator. Mitigation: over-window guard
  (Task 1) plus observed-peak upward correction; documented as a known limit.
- **Codex numerator confusion**: using `total_token_usage` would overcount.
  Mitigation: Task 3 explicitly uses `last_token_usage` and a test guards it.
- **Occupancy staleness**: `ON CONFLICT` COALESCE would freeze stale values.
  Mitigation: Task 4 uses `excluded.…` for occupancy columns.

## Verification Matrix

| Requirement | Proof command | Expected signal |
|-------------|---------------|-----------------|
| Denominator resolves + over-window guard (T1) | `pnpm test src/pricing/context-windows.test.ts` | resolver + guard green |
| Claude latest-request numerator (T2) | `pnpm test` (claude parser) | last-turn numerator green |
| Codex `last_token_usage` + reported window (T3) | `pnpm test` (codex parser) | last-request + window green |
| Occupancy persisted on projection (T4) | `pnpm test` + `pnpm build` | persisted occupancy row |
| Live API exposes occupancy / `null` (T5) | `pnpm test` (API) | occupancy or `null`, never `0%` |
| Card pill + detail gauge render live (T6) | `pnpm frontend:check` + manual `:3141/app/` | pill + gauge render, updates live |
| v1 card occupancy matches v2 inspector (T7) | `pnpm frontend:check` + manual | card matches inspector |
| Trajectory drops after compaction (T8) | `pnpm test` + manual | sparkline drops on compaction |
| Pre-push CI gates (all) | `pnpm lint`, `pnpm build`, `pnpm test` | all green |

## Handoff

1. Execute in this session, task by task (TDD red/green per project agreement).
2. Review the plan with a critique subagent (or `verify-before-complete` inline)
   before executing — confirm the v1/v2 bridge seam (Task 7) and Codex numerator
   grounding.
3. On completion, update `docs/system/ARCHITECTURE.md` + `FEATURES.md`, flip spec
   + plan `status` to `complete`, and log any deferred trajectory work in
   `docs/project/BACKLOG.md`.
