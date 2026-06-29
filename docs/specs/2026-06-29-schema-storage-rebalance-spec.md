---
date: 2026-06-29
topic: schema-storage-rebalance
stage: spec
status: draft
source: conversation
---

# Schema & Storage Rebalance Spec

## Goal

Cut AgentMonitor's local SQLite footprint and make analytics reads index-only by
fixing the mis-grained trace-quality projection, adding trigger-maintained
analytics rollups, pruning dead indexes, and enforcing payload retention — landed
safe-to-risky so each phase is independently shippable and reversible.

## Background And Evidence

Measured against the local dev DB (`data/agentmonitor.db`, 2.0 GB, WAL 70 MB) on
2026-06-29:

| table | bytes | rows |
| --- | --- | --- |
| `trace_quality_traces` | 352 MB | **460,794** |
| `trace_quality_observations` | 270 MB | 461,022 |
| `trace_quality_projection_state` | 143 MB | 493,759 |
| `messages` | 155 MB | 130,687 |
| `session_items` | 140 MB | 151,731 |
| `events` | 127 MB | 428,134 |
| `trace_quality_scores` | ~0 | **0** |

Findings:

1. **Mis-grained event traces (dominant cost).** `trace_quality_traces` has ~one
   row per observation (460,794 traces vs 461,022 observations) against only 788
   `browsing_sessions`. Root cause is `projectEventTraces` in
   `src/trace-quality/projection.ts:916`, which mints one trace per event row via
   `stableId('tq-trace', ['event', event.id])` — unlike the correctly-grained
   `projectTurnTraces` (one trace per turn) and `projectBrowsingSessionTrace`
   (one trace per session). With 428k events this inflates traces to ~428k. The
   trace-quality subsystem (traces + observations + projection_state + indexes)
   is **>900 MB, roughly half the database**.
2. **No analytics rollups.** Every analytics/usage/monitor query rescans `events`.
   Confirmed plan for a daily/model aggregate:
   `SEARCH events USING INDEX idx_events_created_at` then
   `USE TEMP B-TREE FOR GROUP BY`. Hot read functions live in
   `src/db/v2-queries.ts` (`getAnalyticsSummary` ~1077, `getAnalyticsActivity`
   ~1120, `getAnalyticsProjects` ~1137, `getAnalyticsTools` ~1155,
   `getMonitorStats` ~1457, `getMonitorToolStats` ~1173) and v1 in
   `src/db/queries.ts` (9 `GROUP BY` sites). Session-list queries also run N+1
   correlated `SUM`/`COUNT` subqueries over `events` per session row
   (`src/db/v2-queries.ts:1269-1275`, `:1598-1600`).
3. **Dead index weight on the hot ingest path.** `events` carries six
   single-column indexes. Measured cardinalities: `agent_type` = 2,
   `event_type` = 8, `model` = 14, `tool_name` = 36. The low-selectivity
   singletons cost write throughput on the hottest table for negligible filter
   benefit.
4. **Payload bulk is retained JSON.** `session_items.payload_json` (140 MB),
   trace `metadata_json`/`coverage_json`, and `events.metadata` dominate raw
   bytes. `payload_policy` ('summary_only') exists but is not enforced as a
   retention boundary.
5. **Latent scoring/export infra.** `trace_quality_scores` is empty (0 rows) and
   the export subsystem is unused, yet both carry schema, indexes, and CHECK
   surface.

This spec does **not** normalize `events` dimension columns into lookup tables
(marginal in a row store) and does **not** introduce a columnar/DuckDB analytics
store; both are recorded as deferred end-states in Out of Scope.

## Scope

### In Scope

- TypeScript runtime only (`src/`, `frontend/` reads): `schema.ts`,
  `v2-queries.ts`, `queries.ts`, `trace-quality/projection.ts` + `service.ts`.
- Phase 0: baseline measurement harness (sizes + query timings) to prove deltas.
- Phase 1: `events` index hygiene (drop dead singletons, add covering composites).
- Phase 2: trigger-maintained analytics rollup table + read-path rewrite, plus
  removal of N+1 per-session subqueries.
- Phase 3: payload retention/compaction enforcement keyed on `payload_policy`.
- Phase 4: gate latent score/export infra (stop paying for unused structures).
- Phase 5 (gated, risky): re-grain `projectEventTraces` to session/turn-level
  traces, re-project, and reclaim space (`VACUUM`).

### Out of Scope

- **Rust runtime parity.** All schema/query/projection changes land in TS first;
  porting to `rust-backend/` is a tracked follow-up spec (honors the AGENTS.md
  TS↔Rust parity rule but is explicitly deferred here). Temporary drift is
  accepted for the duration.
- **Columnar / DuckDB / Parquet OLAP store.** Documented as the end-state to
  revisit only if rollups stop being sufficient; not built here.
- **`events` dimension normalization** into lookup/dictionary tables.
- Frontend redesign; reads adapt to new query outputs only where shapes change.

## Assumptions And Constraints

- **Trace-quality is a derived projection.** It is fully reconstructable from
  `events`/`session_items`/`session_turns`/`browsing_sessions`, so re-grain uses
  drop-and-rebuild (bump `projection_version`) rather than a risky in-place data
  migration. This does **not** violate the "never destroy the archive" rule —
  source tables are untouched.
- **Additive-first migrations.** Follow the existing `schema.ts` pattern:
  `CREATE TABLE/INDEX IF NOT EXISTS`, `PRAGMA table_info` column guards, and
  `PRAGMA user_version` for one-shot data migrations. Index drops are safe and
  idempotent (`DROP INDEX IF EXISTS`).
- **Rollups maintained by incremental triggers** on `events` (agentsview
  `stats`-style), accepting modest added write cost on ingest in exchange for
  real-time-correct aggregates and a one-time backfill.
- **CI gate:** `pnpm lint`, `pnpm build`, `pnpm test` must stay green; add
  `pnpm frontend:check` if any frontend read shape changes. TDD (red/green) for
  new behavior per AGENTS.md.
- Phases 1–4 are independently shippable. Phase 5 is gated behind 1–4 landing and
  an explicit go decision (its own PR/review).
- Measurements use the existing 2.0 GB dev DB; do not commit the DB.

## Task Breakdown

### Task 0: Baseline measurement harness

**Objective**

A repeatable script that records DB size, per-table bytes (`dbstat`), free-page
count, and timings for the hot analytics queries, so every later phase proves a
delta against a committed baseline.

**Files**

- Create: `scripts/storage-bench.ts`
- Create: `docs/specs/baselines/2026-06-29-storage-baseline.md`
- Modify: `package.json` (add `"bench:storage": "tsx scripts/storage-bench.ts"`)

**Dependencies**

None

**Implementation Steps**

1. Script opens the configured DB read-only and emits JSON: `page_count`,
   `page_size`, `freelist_count`, top-15 `dbstat` table/index sizes, and row
   counts for `events`, `messages`, `session_items`, `trace_quality_traces`,
   `trace_quality_observations`, `trace_quality_projection_state`.
2. Time each hot read with `performance.now()` (median of 5): `getAnalyticsSummary`,
   `getAnalyticsActivity`, `getMonitorStats`, and the session-list query.
3. Write the captured numbers into the baseline doc as a Markdown table.

**Verification**

- Run: `pnpm bench:storage`
- Expect: JSON with non-zero sizes/timings; baseline doc populated with the
  table above (≈2.0 GB, traces ≈460k rows).

**Done When**

- `pnpm bench:storage` runs clean and is re-runnable.
- Baseline doc committed with current numbers.

### Task 1: `events` index hygiene

**Objective**

Replace low-selectivity single-column indexes with covering composites matched to
real query shapes, lowering ingest write cost and enabling index-only analytics.

**Files**

- Modify: `src/db/schema.ts` (index section after `events` creation, ~line 129)
- Test: `tests/db/events-indexes.test.ts`

**Dependencies**

Task 0 (baseline)

**Implementation Steps**

1. `DROP INDEX IF EXISTS idx_events_agent_type` and `idx_events_event_type`
   (cardinality 2 and 8 — not useful for filtering).
2. Add covering composites for the measured access patterns:
   `idx_events_created_model (created_at, model, tokens_in, tokens_out, cost_usd)`
   and `idx_events_session_cost (session_id, tokens_in, tokens_out, cost_usd)`
   (kills the N+1 per-session `SUM` table lookups).
3. Keep `idx_events_created_at`, `idx_events_session_id`, `idx_events_tool_name`,
   `idx_events_model` only where still justified after composites; document the
   final set with a comment.
4. Make all changes idempotent and ordered after the additive column guards.

**Verification**

- Run: `sqlite3 data/agentmonitor.db "EXPLAIN QUERY PLAN SELECT date(created_at),
  model, SUM(tokens_in), SUM(cost_usd) FROM events WHERE created_at >= '2026-05-01'
  GROUP BY 1,2;"`
- Expect: plan uses `idx_events_created_model`; no `USE TEMP B-TREE` for the
  per-session `SUM` path.
- Run: `pnpm build && pnpm test`
- Expect: green.

**Done When**

- Dead singletons dropped, composites created, schema init idempotent.
- Query plans confirm covering-index use for the targeted reads.

### Task 2: Trigger-maintained analytics rollups

**Objective**

Add an incrementally-maintained daily rollup and route hot analytics reads
through it, eliminating full-`events` scans and per-session N+1 subqueries.

**Files**

- Modify: `src/db/schema.ts` (rollup table + triggers + backfill via `user_version`)
- Modify: `src/db/v2-queries.ts` (analytics/monitor read functions)
- Modify: `src/db/queries.ts` (v1 GROUP BY sites; session-list subqueries)
- Test: `tests/db/events-rollup.test.ts`

**Dependencies**

Task 1

**Implementation Steps**

1. Create `events_rollup_daily(day TEXT, agent_type TEXT, model TEXT, project TEXT,
   event_count INTEGER, tokens_in INTEGER, tokens_out INTEGER,
   cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL,
   PRIMARY KEY(day, agent_type, model, project))`.
2. Add `AFTER INSERT`, `AFTER DELETE`, and `AFTER UPDATE` triggers on `events`
   that UPSERT/decrement the matching rollup bucket
   (`day = date(created_at)`), mirroring the agentsview `stats`-trigger pattern.
3. Add a one-shot backfill in `runDataMigrations` guarded by a bumped
   `DATA_SCHEMA_VERSION` (→ 2): populate `events_rollup_daily` from existing
   `events` inside the existing transaction.
4. Rewrite `getAnalyticsSummary/Activity/Projects/Tools`, `getMonitorStats`,
   and `getMonitorToolStats` to read from the rollup; keep tool-name breakdown on
   `events` only where the rollup grain is insufficient.
5. Replace the N+1 correlated `SUM`/`COUNT` subqueries in the session-list
   queries with a single grouped join (backed by `idx_events_session_cost`).

**Verification**

- Run: `pnpm test tests/db/events-rollup.test.ts`
- Expect: red→green; a test asserts rollup totals equal a direct
  `SELECT SUM(...) FROM events` over the same window after random insert/update/
  delete sequences (trigger correctness).
- Run: `pnpm bench:storage`
- Expect: hot analytics timings drop materially vs the Task 0 baseline.

**Done When**

- Rollup table backfilled and trigger-consistent under insert/update/delete.
- Analytics/monitor reads no longer scan full `events`; session list has no N+1.
- Outputs match pre-change values within rounding (parity test passes).

### Task 3: Payload retention enforcement

**Objective**

Make `payload_policy` a real retention boundary: stop persisting full raw
payloads where the policy is `summary_only`, and prune/truncate historical bulk.

**Files**

- Modify: `src/trace-quality/projection.ts` (respect `payload_policy` when
  populating `input_summary`/`output_summary` vs raw)
- Modify: `src/trace-quality/service.ts` (write path)
- Modify: `src/db/schema.ts` (one-shot prune migration via `user_version` → 3)
- Test: `tests/trace-quality/payload-retention.test.ts`

**Dependencies**

Task 0

**Implementation Steps**

1. Confirm the policy resolution point and ensure observations under
   `summary_only` store hashes/summaries, never full payload bodies.
2. Add a guarded one-shot migration that nulls/truncates raw payload fields on
   existing `summary_only` observations (retain `input_hash`/`output_hash` and
   summaries), wrapped in the migration transaction.
3. Add a size cap + truncation flag for oversized `session_items.payload_json`
   retained beyond projection, documented in `docs/system/trace-quality.md`.

**Verification**

- Run: `pnpm test tests/trace-quality/payload-retention.test.ts`
- Expect: red→green; asserts `summary_only` rows carry summaries/hashes and no
  full body, and that projection round-trips without the pruned bytes.
- Run: `sqlite3 data/agentmonitor.db "SELECT SUM(pgsize) FROM dbstat WHERE name
  IN ('trace_quality_observations','session_items');"`
- Expect: lower than the Task 0 baseline after the prune migration.

**Done When**

- New projections honor `payload_policy` as a retention boundary.
- Historical `summary_only` bulk pruned; trace-quality docs updated.

### Task 4: Gate latent score/export infrastructure

**Objective**

Stop paying schema/index cost for unused scoring/export structures until they are
actually populated, without deleting the design.

**Files**

- Modify: `src/db/schema.ts` (defer `trace_quality_scores` / export indexes
  behind a feature guard or create-on-first-use)
- Modify: `docs/system/trace-quality.md` (document the gated state)
- Test: `tests/db/schema-gating.test.ts`

**Dependencies**

Task 0

**Implementation Steps**

1. Keep table definitions but defer their secondary indexes until first row
   insert (or behind an `AGENTMONITOR_TRACE_SCORES` flag), since
   `trace_quality_scores` is empty (0 rows).
2. Document that the export subsystem remains latent and unindexed until the
   ingestion-API export path ships.

**Verification**

- Run: `pnpm test tests/db/schema-gating.test.ts`
- Expect: fresh DB init creates no score/export secondary indexes by default;
  enabling the flag (or first insert) creates them.
- Run: `pnpm build && pnpm test`
- Expect: green.

**Done When**

- Default init carries no unused score/export indexes.
- Behavior and rationale documented; design preserved.

### Task 5: Re-grain event traces (GATED — risky)

**Objective**

Fix the dominant storage cost: project event-sourced traces at session/turn
grain (many observations per trace) instead of one trace per event, then reclaim
space. **Do not start until Tasks 0–4 are merged and an explicit go decision is
made; ship as its own PR.**

**Files**

- Modify: `src/trace-quality/projection.ts` (`projectEventTraces` ~916; reuse the
  container pattern from `projectTurnTraces` ~968 / `projectBrowsingSessionTrace`
  ~1022)
- Modify: `src/trace-quality/constants.ts` (bump `projection_version`)
- Modify: `src/trace-quality/service.ts` (re-projection orchestration)
- Test: `tests/trace-quality/event-trace-grain.test.ts`

**Dependencies**

Tasks 0–4

**Implementation Steps**

1. Change `projectEventTraces` to build **one trace per `(browsing_session, day
   or turn)` container** keyed by a stable id (e.g.
   `stableId('tq-trace', ['events-session', sessionId])`), with each event
   projected as an observation under it — matching the other two strategies.
2. Set the trace `coverage`/`metadata` to aggregate over its events; keep
   per-event detail at the observation level.
3. Bump `projection_version` so `trace_quality_projection_state` re-projects;
   drop-and-rebuild affected derived rows (source tables untouched).
4. Run a `VACUUM` after re-projection to reclaim freed pages.

**Verification**

- Run: `pnpm test tests/trace-quality/event-trace-grain.test.ts`
- Expect: red→green; asserts event-sourced sessions produce trace:observation
  ratios far below 1:1 (one trace per session/turn, N observations).
- Run: `pnpm bench:storage` (after re-project + VACUUM)
- Expect: `trace_quality_traces` row count drops from ~460k toward the
  session/turn count; total DB size materially smaller than the Task 0 baseline.
- Run: `pnpm build && pnpm test`
- Expect: green; trace-quality UI/read queries still resolve.

**Done When**

- `projectEventTraces` is session/turn-grained; ratio test passes.
- DB re-projected, VACUUMed, and measurably smaller; no source-data loss.

## Risks And Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Rollup triggers drift from `events` truth | Med | High | Parity test asserts rollup == direct SUM after randomized insert/update/delete (Task 2); triggers cover all three mutations. |
| Trigger write cost slows ingest | Low | Med | Single-row UPSERT per event; measure ingest in bench; rollback path is dropping triggers (reads fall back to scan). |
| Re-grain changes trace semantics consumed by UI/insights | Med | High | Gated Phase 5 in its own PR; ratio + read-resolution tests; `projection_version` bump lets re-project be re-run. |
| Index changes regress an unmeasured query | Med | Med | `EXPLAIN QUERY PLAN` checks in Task 1; full `pnpm test`; keep singleton drops reversible. |
| Payload prune removes data a feature still needs | Low | High | Retain hashes + summaries; prune only `summary_only`; round-trip test (Task 3). |
| TS/Rust drift while Rust deferred | High | Low | Explicitly accepted; tracked as follow-up spec; parity rule re-applied there. |
| `VACUUM` on a 2 GB DB is slow / needs disk | Low | Med | Run in maintenance step, off the hot path; document space/time cost. |

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| 0 Baseline | `pnpm bench:storage` | Sizes+timings captured; baseline doc written |
| 1 Indexes | `EXPLAIN QUERY PLAN ...` | Covering index used; no temp b-tree on targeted reads |
| 1 Indexes | `pnpm build && pnpm test` | Green |
| 2 Rollups | `pnpm test tests/db/events-rollup.test.ts` | Rollup == direct SUM after CRUD churn |
| 2 Rollups | `pnpm bench:storage` | Analytics timings down vs baseline |
| 3 Retention | `pnpm test tests/trace-quality/payload-retention.test.ts` | `summary_only` carries summaries/hashes, no raw body |
| 3 Retention | `dbstat` size query | Observation/item bytes below baseline |
| 4 Gating | `pnpm test tests/db/schema-gating.test.ts` | No score/export indexes by default |
| 5 Re-grain | `pnpm test tests/trace-quality/event-trace-grain.test.ts` | Trace:observation ratio ≪ 1:1 |
| 5 Re-grain | `pnpm bench:storage` (post-VACUUM) | Traces ~460k → session/turn count; DB smaller |
| All | `pnpm lint && pnpm build && pnpm test` | Green (CI gate) |

## Handoff

- Land Phases 0–4 as independent PRs (safe, mechanical, reversible). Each must
  pass the CI gate and show a bench delta vs the Task 0 baseline.
- Phase 5 is gated: open only after 0–4 merge and an explicit go decision; ship
  in its own reviewed PR with before/after bench numbers.
- After Phase 5 lands, update `docs/system/ARCHITECTURE.md` (trace-quality grain),
  `docs/system/trace-quality.md` (retention + grain), and `docs/project/ROADMAP.md`.
- Open the follow-up spec: **Rust runtime parity** for all schema/query/projection
  changes in this spec (`rust-backend/`), per the AGENTS.md parity rule.
- Record the columnar/DuckDB option in `docs/project/IMPROVEMENT_BACKLOG.md` as a
  deferred end-state to revisit only if rollups become insufficient.

### Next Steps

1. Execute in this session, starting with Task 0 (baseline) then Phase 1.
2. Open a separate execution session per phase PR.
3. Refine this spec before implementation.
