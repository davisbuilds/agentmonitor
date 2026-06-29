---
date: 2026-06-29
topic: trace-quality-reframe
stage: spec
status: draft
source: conversation
---

# Trace-Quality Reframe Spec

## Goal

Reframe trace-quality from a persisted Langfuse-style local warehouse (~half the
1.95 GB DB, mis-grained at one trace per event) into a **lean local view** — a
tiny, content-free, export-shaped per-session summary plus **on-demand** trace
detail — reclaiming ~900 MB and realigning with the "collector, not backend"
positioning.

## Background

Established earlier this session (`docs/project/POSITIONING.md`) and by reading
the subsystem:

- trace-quality is 5,630 LOC across `src/trace-quality/*` and **~half the
  database**: `trace_quality_traces` (461k rows, 352 MB), `_observations` (461k,
  271 MB), `_projection_state` (494k, 143 MB), plus indexes — over 900 MB total.
- The dominant cost is a **mis-grain**: `projectEventTraces`
  (`src/trace-quality/projection.ts:916`) mints one trace per event row, so
  traces ≈ observations ≈ 1:1 (the correctly-grained `projectTurnTraces` and
  `projectBrowsingSessionTrace` already exist alongside it).
- `trace_quality_scores` has full CRUD (`/trace-quality/scores*`) over an
  **empty table** — latent eval infrastructure.
- The subsystem is a **derived projection**: fully reconstructable from `events`,
  `session_items`, `session_turns`, and `browsing_sessions`, which are untouched.
- The medallion sibling project consumes Langfuse-shaped agent telemetry into
  `silver.agent_runs` with columns `{user_id/account, session_id, model,
  input_tokens, output_tokens, latency_ms, quality_score, start_time}`. The lean
  summary is shaped to that contract so a future export (deferred) is near-free.

Decisions locked for this spec: **hybrid** storage (persist per-session
summaries, derive detail on-demand); **cut to the trace/cost view** (remove the
scores eval subsystem; defer findings + prompt attribution to export); **keep one
derived per-session quality scalar**; summary is **export-shaped**; the actual
export integration is a **separate, deferred spec** (recommended sink:
direct-to-medallion, mirroring prism's `insight` schema). This supersedes Task 5
of `docs/specs/2026-06-29-schema-storage-rebalance-spec.md`.

## Scope

### In Scope

- A new persisted `session_trace_summary` table: one content-free, export-shaped
  row per session (counts, tokens, cost, latency, coverage, quality scalar).
- On-demand projection of a session's trace/observation tree for the detail and
  drill-in endpoints (re-grained per session/turn); stop persisting the tree.
- Remove the heavy persisted subsystem: drop `trace_quality_traces`,
  `_observations`, `_projection_state`; remove the scores subsystem (CRUD API +
  `scores.ts` + table); remove (defer to export) findings + prompt attribution.
- Keep `trace_quality_export_state` **dormant** (the future export seam).
- Frontend: `TraceQualityPage.svelte` reads the summary; `TraceDrillInLink`
  detail uses on-demand projection; remove scores/findings/prompts UI.
- `VACUUM` + `pnpm bench:storage` to prove the reclaim.

### Out of Scope

- **The actual Langfuse/medallion export integration** — its own deferred spec.
  This spec only makes the summary export-shaped so that work is cheap. amon
  gains **no** external dependency; it stays fully standalone.
- **The messages / FTS / session-browse subsystem** — untouched. Prompts and
  transcripts remain fully surfaced and searchable in amon (they were never part
  of trace-quality).
- The daily analytics rollup (separate `docs/project/BACKLOG.md` item).

## Assumptions And Constraints

- trace-quality is a **derived projection**; dropping/replacing it is safe — the
  source tables (`events`, `session_items`, `session_turns`,
  `browsing_sessions`) are never touched, so no archival data is lost.
- **Strangler order**: build the lean replacement, switch reads to it, then
  delete the old persisted subsystem. Each phase is independently shippable.
- Schema changes follow the existing `schema.ts` pattern (`IF NOT EXISTS`,
  `PRAGMA table_info` guards, `PRAGMA user_version` for one-shot data steps);
  table drops are recorded as a guarded migration.
- The summary is **content-free** (no message text) and **export-shaped** to
  medallion's `silver.agent_runs`: `{session_id, model, tokens_in, tokens_out,
  latency_ms, quality_score, started_at}` plus `cost_usd`, cache tokens, and
  coverage.
- On-demand detail projects a **single session** per request — cheap (ms), since
  it touches only that session's events/items.
- TDD (red/green); run tests in a clean env (provider keys unset, per
  `docs/project/BACKLOG.md` / memory) so the suite is green.

## Task Breakdown

### Task 0: Baseline the trace-quality footprint and capture detail oracles

**Objective**

Record current trace-quality table sizes and a correctness fixture of detail
output for representative sessions, so the reclaim and on-demand parity are
provable.

**Files**

- Modify: `scripts/storage-bench.ts` (add trace-quality read timings)
- Create: `docs/specs/baselines/2026-06-29-trace-quality-baseline.md`
- Create: `tests/fixtures/trace-quality-detail-oracle.json` (seeded-DB detail snapshot)

**Dependencies**

None

**Implementation Steps**

1. Extend `bench:storage` to time `/trace-quality/traces`, `/traces/:id`, and
   `/traces/:id/observations` against a representative session.
2. Build a small seeded DB and snapshot the current persisted detail output for a
   few sessions as the on-demand parity oracle.
3. Write the baseline doc (table sizes + row counts + timings).

**Verification**

- Run: `pnpm bench:storage`
- Expect: trace-quality tables reported at ~900 MB; baseline doc populated.

**Done When**

- Baseline + oracle committed and regenerable.

### Task 1: Export-shaped `session_trace_summary` + derivation

**Objective**

Persist one content-free, export-shaped summary row per session, including a
derived quality scalar, maintained where projection currently runs.

**Files**

- Modify: `src/db/schema.ts` (new table + backfill via `user_version`)
- Create: `src/trace-quality/summary.ts` (`deriveSessionTraceSummary`)
- Modify: `src/trace-quality/service.ts` (maintain summary on session update/import)
- Test: `tests/trace-quality-summary.test.ts`

**Dependencies**

Task 0

**Implementation Steps**

1. Create `session_trace_summary(session_id PK, agent_type, primary_model,
   started_at, ended_at, event_count, observation_count, tokens_in, tokens_out,
   cache_read_tokens, cache_write_tokens, cost_usd, latency_ms_total,
   coverage_json, quality_score REAL, quality_grade TEXT, updated_at)` — no
   message-text columns.
2. `deriveSessionTraceSummary(sessionId)`: roll up tokens/cost/latency/counts from
   `events`/`session_items`; reuse the projection's coverage logic; compute the
   quality scalar from coverage + outcome heuristics. Document the formula inline.
3. Maintain the row from the existing per-session projection hooks in
   `service.ts`; backfill all sessions via a guarded `user_version` migration.

**Verification**

- Run: `pnpm test tests/trace-quality-summary.test.ts`
- Expect: summary token/cost totals equal a direct `SUM` over the session's
  events; quality scalar deterministic and in range; no content columns.
- Run: `sqlite3 data/agentmonitor.db "SELECT COUNT(*) FROM session_trace_summary;"`
- Expect: ≈ session count (hundreds), not ~460k.

**Done When**

- Every session has a correct, content-free, export-shaped summary row.

### Task 2: Read-layer regrain — list from summary + on-demand session detail

> **Approach corrected 2026-06-29 (seam-first).** The original plan here re-grained
> the shared `projectEventTraces` and stopped persistence. A data-path trace showed
> that is the wrong seam: the persist machinery cleans orphans only by
> `session_turns`/`browsing_sessions` scope (not `events`), `stableId` is a
> non-reversible hash, and the frontend already navigates by `sessionId` and reads
> each row's `id` from the list response. The thinnest seam is the **read layer**:
> the correct grain only needs the projection's *observations* (always per-event/
> item), synthesized under one session-level container. So **`projectEventTraces`
> and the persist path are NOT touched in this phase, and persistence is NOT
> stopped here** — `stop-persisting` + dropping tables move to Phase 3, which keeps
> scores/findings/prompts working until they are removed wholesale. No frontend
> change is required. (File-level steps below are proposed — confirm against code
> when executing.)

**Objective**

Present the correctly-grained, one-trace-per-session detail entirely in the read
layer — list from `session_trace_summary`, detail projected on-demand per session
— without touching the shared projection or the persist path.

**Files** (proposed — verify the seam first)

- Modify: `src/db/schema.ts` (`session_trace_summary` gains a stable `trace_id`
  the list emits and the detail endpoints resolve back to a session)
- Create: `src/trace-quality/on-demand.ts` (`listSessionTraces` from summary;
  `getSessionTraceDetail`/`listSessionObservations` projecting on-demand, using
  only `projectTraceQuality(...).observations` under one synthesized session trace)
- Modify: `src/api/v2/router.ts` (`/trace-quality/traces` reads the summary;
  `/traces/:id` and `/:id/observations` resolve `trace_id`→session then project)
- Test: `tests/trace-quality-ondemand.test.ts`

**Dependencies**

Task 1

**Implementation Steps**

1. Add a deterministic `trace_id` to `session_trace_summary` (one per session);
   the list emits it as each row's `id`, and the detail endpoints reverse it to a
   `session_id` via the summary.
2. Build the on-demand read module: list maps summary rows → the trace list shape;
   detail resolves `trace_id`→session, runs `projectTraceQuality`, and returns the
   session's **observations** under one synthesized session trace (ignore the
   projection's own per-event trace grouping — only observations are used, so the
   mis-grain in `projectEventTraces` is irrelevant and left untouched).
3. Point `/trace-quality/traces` + the two detail endpoints at the on-demand
   module. Leave `scores`/`findings`/`prompts` endpoints and the persist path as
   they are (Phase 3 removes them together).

**Verification**

- Run: `pnpm test tests/trace-quality-ondemand.test.ts`
- Expect: on-demand detail returns one trace per session with every event/item as
  an observation (ratio ≪ 1:1); list shows one row per session from the summary.
- Run: `pnpm build && pnpm test && pnpm frontend:check` (clean env)
- Expect: green; the existing Quality explorer/drill-in works unchanged.

**Done When**

- List + detail are summary-backed / on-demand and correctly grained; the shared
  projection, persist path, and frontend are untouched.

### Task 3: Remove the heavy subsystem, frontend, and reclaim space

**Objective**

Delete the now-unused persisted tables and eval/findings/prompt surfaces, update
the frontend, and reclaim the ~900 MB.

**Files**

- Modify: `src/db/schema.ts` (guarded `DROP TABLE` for the heavy + scores tables)
- Delete: `src/trace-quality/scores.ts`, `findings.ts`, `prompts.ts`
- Modify: `src/api/v2/router.ts` (remove `/scores*`, `/score-summary`,
  `/score-rollups`, `/findings`, `/prompts` endpoints)
- Modify: `frontend/src/lib/components/trace-quality/TraceQualityPage.svelte`
  (read summary; remove scores/findings/prompts UI)
- Modify: `tests/codebase/dead-code.test.ts` (exceptions as needed)

**Dependencies**

Task 2

**Implementation Steps**

1. **Stop persisting the tree** (moved here from Phase 2): remove the
   `projectTraceQualityForSource` persist calls from the ingest hooks while
   keeping the summary maintainers (`maintainSessionTraceSummary` /
   `bumpSessionTraceSummaryForEvent`); then guarded migration: `DROP TABLE`
   `trace_quality_traces`, `_observations`, `_projection_state`, `_scores`,
   `_prompt_refs`, `_observation_prompts`. Keep `trace_quality_export_state`
   dormant for the future export seam.
2. Remove the scores/findings/prompts modules, their routes, and the now-dead
   projection-persistence + `projection_state` code paths.
3. Update `TraceQualityPage.svelte` and remove dead frontend score/finding UI;
   keep the trace/cost view and on-demand drill-in.
4. `VACUUM`; rewrite `docs/system/trace-quality.md` and update
   `docs/system/ARCHITECTURE.md` + `FEATURES.md`.

**Verification**

- Run: `pnpm bench:storage` (after migration + VACUUM)
- Expect: trace-quality storage down from ~900 MB to the small summary table; DB
  materially smaller.
- Run: `pnpm lint && pnpm build && pnpm test && pnpm frontend:check` (clean env)
- Expect: green; no references to removed modules/endpoints remain.

**Done When**

- Heavy tables and eval/findings/prompt surfaces gone; frontend works on the lean
  view; DB reclaimed; docs current.

## Risks And Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| On-demand detail is incorrect (missing/duplicated observations) | Med | High | Assert correctness directly — every event/item appears once under one session trace; do not diff against the old (mis-grained) persisted output. |
| On-demand projection slow for very large sessions | Low | Med | Single-session projection is ms-scale; add a per-session cache only if a measured read exceeds budget. |
| Removing findings/prompts deletes features users rely on | Med | Med | User-approved aggressive cut; depth returns via the deferred export; code preserved in git history; `trace_quality_export_state` kept. |
| Frontend breakage from removed endpoints | Med | Med | Frontend task + `pnpm frontend:check`; remove UI in the same change. |
| Quality-scalar formula churn | Med | Low | Documented, deterministic, unit-tested; it is derived and recomputable at will. |
| Dropping tables on a real DB | Low | High | Derived data only; guarded migration; sources untouched; `VACUUM` after. |

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Baseline captured | `pnpm bench:storage` | trace-quality ~900 MB recorded |
| Summary correct + lean | `pnpm test tests/trace-quality-summary.test.ts` | totals == direct SUM; ~session-count rows; content-free |
| Re-grained on-demand detail (Phase 2) | `pnpm test tests/trace-quality-ondemand.test.ts` | one trace per session; every event/item an observation |
| Persist stopped (Phase 3) | `sqlite3 ... "SELECT COUNT(*) FROM trace_quality_traces"` before/after an ingest | unchanged after Phase 3 (persist removed) |
| Space reclaimed (Phase 3) | `pnpm bench:storage` (post-VACUUM) | trace-quality storage → small summary table |
| No dead references | `pnpm lint && pnpm build && pnpm frontend:check` | green |
| Full suite | `pnpm test` (clean env) | green |

## Handoff

- Land Phases 0–3 as independent PRs (strangler order: summary → on-demand →
  delete). Each must pass the CI gate and show a `bench:storage` delta.
- After Phase 3, update `docs/system/trace-quality.md`,
  `docs/system/ARCHITECTURE.md`, `FEATURES.md`, and `docs/project/ROADMAP.md`.
- Open the deferred **export spec**: publish the content-free
  `session_trace_summary` to a sink — recommended **direct-to-medallion**
  (mirroring prism's `insight` schema: reuse `medallion_bi` grant +
  delete-then-insert idempotency), with Langfuse/OTel as alternates. The summary
  is already shaped to medallion's `silver.agent_runs`.
- Confirm the messages/FTS/browse subsystem is untouched so prompt search is
  unaffected.

### Next Steps

1. Execute in this session, starting with Task 0 then Phase 1.
2. Open a separate execution session per phase PR.
3. Refine this spec before implementation.
