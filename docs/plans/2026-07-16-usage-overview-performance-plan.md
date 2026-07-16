---
date: 2026-07-16
topic: usage-overview-performance
stage: plan
status: complete
source: conversation
---

# Usage Overview Performance Plan

## Goal

Bring the representative 30-day Usage overview below a 150 ms warm median with
exact response parity, realizing
`docs/specs/2026-07-16-usage-overview-performance-spec.md`.

## Scope

### In Scope

- A read-only, threshold-aware benchmark for the canonical Usage overview.
- Removal of redundant coverage work and avoidable row materialization.
- Batched top-session enrichment at the existing query seam.
- Existing Usage contract parity plus targeted performance regression evidence.
- Backlog, roadmap, and operations documentation for the completed work.

### Out of Scope

- A persisted analytics rollup or schema migration.
- Usage API or frontend response changes.
- General analytics, Monitor, legacy dashboard, ingestion, and pricing work.

## Assumptions And Constraints

- The live 2026-06-17 through 2026-07-16 window is the local acceptance dataset.
- The benchmark hits an already-running API and never opens or mutates the install
  database; tests continue to use isolated temporary databases.
- Profiling showed duplicate coverage at 58–63 ms per call, current-row selection
  at 32–35 ms warm, prior-period materialization at 11–13 ms, and top-session
  enrichment at 15–20 ms. The ordered-vs-unordered SQL probe showed the temp sort
  costs only about 5–10 ms, so it is a contributing cost rather than the root cause.
- Exact session counts, classification filters, coverage honesty, and endpoint
  ordering are compatibility requirements.

## Map Before You Cut

`GET /api/v2/usage/overview` calls `getUsageOverview`, which selects usage-bearing
event rows once, feeds them through eight rollups, and calls `getUsageCoverage` at
the top level. `getUsageSummary` receives the shared rows but independently calls
`getUsageCoverage` and materializes a second period's full usage rows. Top-session
rollup then performs three indexed lookups for each returned session. The thinnest
seam is therefore the shared overview context plus batched enrichment; a persisted
derived store is not justified by the measured costs.

## Task Breakdown

### Task 1: Establish the failing performance signal

**Objective**

Add a repeatable read-only endpoint benchmark that reports cold and warm timing,
computes the median, and can fail against an explicit latency budget.

**Files**

- Create: `scripts/benchmark-usage-overview.ts`
- Modify: `package.json`

**Dependencies**

None

**Assumptions Verified**

- `package.json:31-32` already exposes dedicated TypeScript benchmark commands.
- `scripts/storage-bench.ts:113-136` establishes the repository convention of
  dropping a cold run and reporting the median of warm runs.
- `src/api/v2/router.ts:671-679` exposes the canonical overview as a GET endpoint,
  so measurement can stay read-only and exercise the real serialization path.

**Implementation Steps**

1. Add CLI parsing for base URL, date bounds, warm-run count, warmup count, and an
   optional maximum-median threshold.
2. Fetch the overview sequentially, record status/body bytes and elapsed monotonic
   time, report structured JSON, and exit nonzero when the threshold is missed.
3. Register `pnpm bench:usage` and run it against the current server with a 150 ms
   maximum to capture the required red signal before changing the query path.

**Verification**

- Run: `pnpm bench:usage -- --date-from 2026-06-17 --date-to 2026-07-16 --runs 5 --max-median-ms 150`
- Expect: pre-fix nonzero exit with a warm median above 150 ms.

**Done When**

- The benchmark is read-only, repeatable, machine-readable, and demonstrably red
  against the current hot path.

### Task 2: Remove redundant overview scans and materialization

**Objective**

Compute coverage once per overview, calculate prior-period cost without loading a
second row set, and remove row ordering that downstream folds do not consume.

**Files**

- Modify: `src/db/v2-queries.ts`
- Test: `tests/v2-usage.test.ts`

**Dependencies**

Task 1

**Assumptions Verified**

- `src/db/v2-queries.ts:2602-2629` selects and sorts all usage rows even though
  every downstream date- or cost-sensitive result applies its own explicit sort.
- `src/db/v2-queries.ts:2778-2846` reselects all prior-period rows and computes
  coverage inside summary even when overview already owns the shared request.
- `src/db/v2-queries.ts:3253-3274` calls summary and then coverage again for the
  same parameters.
- `tests/v2-usage.test.ts:750-801` already asserts overview equivalence against
  every per-panel endpoint and exercises Usage filtering.
- `package.json:19` discovers the proposed Usage behavior test file.

**Implementation Steps**

1. Extend the shared summary seam so overview supplies its already-computed
   coverage while standalone summary callers retain identical behavior; derive
   usage-side coverage from the rows the overview already selected.
2. Replace prior-period full-row materialization with a model-grouped cost query;
   apply classification filters in JavaScript so model/provider/tier semantics
   remain registry-backed and exact.
3. Classify each selected row once for reuse by every overview fold while retaining
   deterministic timestamp/id reduction order.
4. Run overview parity and filtered-coverage tests after each cut; retain only changes that
   preserve byte-equivalent parsed JSON.

**Verification**

- Run: `node --import tsx --test tests/v2-usage.test.ts`
- Expect: all Usage parity, filter, and filtered-coverage checks pass.

**Test Discovery Verified**

- Runner/discovery evidence: `package.json:19` includes `tests/*.test.ts`.
- Literal proof: `node --import tsx --test tests/v2-usage.test.ts` runs the exact file.

**Done When**

- Coverage is selected once per overview, prior comparison does not materialize
  event rows, and Usage output remains exactly equivalent.

### Task 3: Batch top-session enrichment

**Objective**

Replace the per-result metadata and event-count lookups with bounded bulk reads
without changing top-session ranking or fallback semantics.

**Files**

- Modify: `src/db/v2-queries.ts`
- Test: `tests/v2-usage.test.ts`

**Dependencies**

Task 2

**Assumptions Verified**

- `src/db/v2-queries.ts:3031-3187` sorts and limits the aggregated sessions, then
  performs browsing-session, session, and event-count queries inside `.map()`.
- `src/db/v2-queries.ts:3037-3046` applies date/project/agent filters—but not
  registry-backed classification filters—to `event_count`; the batched query must
  preserve that existing distinction.
- `tests/v2-usage.test.ts:757-787` compares the full top-session array from overview
  to the standalone endpoint, protecting order, metadata, and metric parity.

**Implementation Steps**

1. Sort and slice the aggregated entries before enrichment, then collect their
   bounded session IDs.
2. Fetch browsing metadata, session metadata, and grouped event counts once each
   for those IDs, retaining the current filter scope and fallback precedence.
3. Map the bulk rows by session ID and render the existing response shape.

**Verification**

- Run: `node --import tsx --test tests/v2-usage.test.ts`
- Expect: overview and standalone top-session payloads remain identical.

**Test Discovery Verified**

- Runner/discovery evidence: `package.json:19` includes `tests/*.test.ts`.
- Literal proof: `node --import tsx --test tests/v2-usage.test.ts` runs the exact file.

**Done When**

- Top-session enrichment uses three bounded bulk queries rather than three queries
  per result, with no response change.

### Task 4: Prove the budget and close the backlog loop

**Objective**

Verify the optimized source and built paths, record the measured result, and make
project documentation match the new performance boundary.

**Files**

- Modify: `docs/project/BACKLOG.md`
- Modify: `docs/project/ROADMAP.md`
- Modify: `docs/system/OPERATIONS.md`
- Modify: `docs/specs/2026-07-16-usage-overview-performance-spec.md`
- Modify: `docs/plans/2026-07-16-usage-overview-performance-plan.md`

**Dependencies**

Tasks 1–3

**Assumptions Verified**

- `docs/project/BACKLOG.md:96-111` owns the session-grained-rollup option and its
  150 ms revisit trigger.
- `docs/project/ROADMAP.md:72-76` owns current Analytics/Usage direction and shipped
  milestones.
- `docs/system/OPERATIONS.md` is the documented command catalog per `AGENTS.md`.

**Implementation Steps**

1. Run the same benchmark command that failed in Task 1 and record cold, warm,
   median, response-size, and status evidence.
2. Run targeted tests, lint, build, the full suite, and a built-path benchmark;
   inspect the final diff for leftover instrumentation or contract drift.
3. Resolve the rollup backlog item as unnecessary at current scale, retain its
   session-grained design as the future >150 ms fallback, add the shipped roadmap
   result, and document the benchmark command.
4. Mark the spec and plan complete only after every verification gate is fresh.

**Verification**

- Run: `pnpm bench:usage -- --date-from 2026-06-17 --date-to 2026-07-16 --runs 5 --max-median-ms 150`
- Expect: exit 0 and warm median below 150 ms.
- Run: `pnpm lint && pnpm build && pnpm test`
- Expect: all required pre-push gates pass.
- Run: `git diff --check`
- Expect: no whitespace errors.

**Done When**

- The local acceptance benchmark is green below 150 ms, all behavior and build
  gates pass, docs match the shipped design, and no persisted rollup was added.

## Risks And Mitigations

- Risk: local latency varies under concurrent ingestion or a cold page cache.
  Signal: warm-run spread is large or the median repeatedly crosses 150 ms.
  Mitigation: report every run, separate warmup from measured samples, and keep
  deterministic contract/plan checks as required gates.
- Risk: a future dataset with many distinct models makes model-grouped prior cost
  less compact.
  Signal: benchmark stage or total latency regresses above 150 ms.
  Mitigation: retain the backlog's session-grained derived-store trigger rather
  than approximating current counts.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Pre-fix signal is real | `pnpm bench:usage -- --date-from 2026-06-17 --date-to 2026-07-16 --runs 5 --max-median-ms 150` | Fails before optimization |
| Exact Usage behavior | `node --import tsx --test tests/v2-usage.test.ts` | Overview equals every panel |
| Performance budget | `pnpm bench:usage -- --date-from 2026-06-17 --date-to 2026-07-16 --runs 5 --max-median-ms 150` | Warm median below 150 ms |
| Required project gates | `pnpm lint && pnpm build && pnpm test` | All commands exit 0 |

## Handoff

1. Execute in this session, task by task.
2. Review the plan with `verify-before-complete` inline because subagents are
   unavailable for this task.
3. Refine the plan first if profiling evidence changes the chosen seam.
