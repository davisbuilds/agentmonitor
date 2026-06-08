---
date: 2026-06-08
topic: trace-quality-findings
stage: plan
status: draft
source: conversation
---

# Trace Quality Findings (Task 7) Implementation Spec

Implementation plan layered on **Task 7 — Add Quality Findings And Alert Taxonomy** of
`docs/specs/2026-06-06-trace-quality-layer-spec.md` (lines 563–628). The parent spec defines the
objective, the 13 finding kinds, and the "read-only, evidence-bearing, configurable thresholds"
principles. This plan fills the decisions the spec leaves open so the work is executable with TDD.

## Goal

Replace the minimal row-level findings (`observation_error`, `low_score`, `low_coverage` in
`src/trace-quality/queries.ts`) with a unified, deterministic, read-only findings engine in a new
`src/trace-quality/findings.ts` that surfaces local quality, cost, latency, and telemetry problems
across the full Task 7 taxonomy, each with concrete evidence and a next-inspection target, computed
from local SQLite with no Prometheus/Grafana/PromQL dependency.

Two decisions are already locked from conversation:

1. **Unify in `findings.ts`.** Move the three existing kinds into the new module, renaming
   `low_coverage → low_trace_coverage` and `low_score → low_quality_score` to match the spec
   vocabulary, and add the aggregate kinds alongside them.
2. **Plan before code.** This document is that plan; implementation follows it task by task with
   red/green TDD.

## Scope

### In Scope

- New module `src/trace-quality/findings.ts` owning all finding computation.
- Full finding taxonomy (14 kinds — 13 from the spec plus retained `observation_error`; see
  Assumptions for the retention rationale).
- Default thresholds + windows as code constants, covered by tests.
- Optional local JSON threshold override file (last task, after defaults are tested), mirroring the
  `src/usage/budgets.ts` config pattern.
- Typed evidence contract with next-inspection targets and coverage caveats.
- `TraceQualityFinding` type/contract changes in `src/api/v2/types.ts` and the mirrored
  `frontend/src/lib/api/client.ts`.
- Rewire `GET /api/v2/trace-quality/findings` to the new module.
- Docs: `docs/system/FEATURES.md`, `docs/system/OPERATIONS.md`.

### Out Of Scope

- Notifying, paging, blocking, or mutating agent behavior (findings stay strictly read-only).
- Svelte findings UI (Task 9).
- New `kind`/`severity` query-string filters on the endpoint (note as a follow-up; not required).
- Rust-backend parity (no trace-quality surface exists in `rust-backend/`).
- LLM-judge or evaluator-generated findings (separate score workflow).

## Assumptions And Constraints

- **Aggregation scope.** Every finding is computed over the *selected trace set* derived from
  `TraceQualityTraceListParams` via the existing `includedTraceSelection(params)` helper (honors
  `date_from/date_to/project/agent/status/model/tool/...`). This keeps findings consistent with the
  other trace-quality read APIs and with the returned `coverage` block.
- **Primary data source is the projection** (`trace_quality_observations` joined to selected
  traces), not raw events — except `collector_or_otel_dropoff`, which inherently needs the
  `events.source = 'otel'` provider signal and therefore reads `events`. This exception is called
  out per-kind below.
- **No SQLite percentile function.** p95/median are computed in JS from a fetched value list, reusing
  the `median()` helper pattern already in `queries.ts` (add a sibling `percentile()`).
- **Retain `observation_error`.** The spec's aggregate error kinds (`high_error_rate`,
  `tool_failure_rate`, `model_error_rate`) detect *rates*; they do not point at the specific failing
  step. `observation_error` is kept as the per-observation drill-down signal. Granularity per kind is
  documented in Task 2–7.7.
- **Severity vocabulary aligns to the spec:** `info | warning | high | critical`. The current type
  uses `error`; this becomes `high` (a breaking enum change — acceptable, see Risks).
- **Breaking contract changes are acceptable.** The findings endpoint is pre-product with no Svelte
  consumer (only a type in `client.ts`); kind renames, severity `error→high`, nullable `trace_id`,
  and the typed `evidence` shape land in one change with the v2 contract test + client type updated.
- **Determinism.** Given identical DB state and params, findings (ids, ordering, evidence) are
  byte-stable. Ordering: severity rank (`critical < high < warning < info`), then a per-kind sort
  rank, then time, then id.
- **No false positives on sparse data.** Each kind has a minimum sample/baseline gate; when unmet,
  the kind emits nothing OR emits with a populated `coverage_caveat` (never a silent false positive).
  This is the headline verification requirement.
- **Guardrail compliance.** Shared SQL helpers (`includedTraceSelection`, `lowCoverageExpr`,
  `traceScoreTargetSql`, `getTraceQualityCoverage`, normalizers, `parseJsonRecord`) are exported
  from `queries.ts` and imported by `findings.ts`; finding-specific SQL lives in the trace-quality
  domain alongside the rest of that layer.

### Default thresholds and windows

All values are code constants in `DEFAULT_TRACE_QUALITY_FINDING_THRESHOLDS`
(`src/trace-quality/constants.ts`), overridable later via JSON (Task 8). `rate` = fraction in
`[0,1]`. "latest day" / "baseline" use UTC calendar days within the selected window.

| Kind | Data source | Metric | Default trip | Severity tiers | Min-sample gate |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `high_error_rate` | observations | (error+timeout)/total | rate ≥ 0.10 | ≥0.10 warning, ≥0.25 high, ≥0.50 critical | ≥20 observations |
| `tool_failure_rate` | observations (per `tool_name`) | error rate for that tool | rate ≥ 0.20 | ≥0.20 warning, ≥0.40 high, ≥0.60 critical | ≥10 calls/tool |
| `model_error_rate` | observations (per `model`) | error rate for that model | rate ≥ 0.10 | ≥0.10 warning, ≥0.25 high, ≥0.50 critical | ≥20 calls/model |
| `rate_limit_events` | observations + events metadata | count of rate-limit markers (429 / "rate limit" / "overloaded") | count ≥ 1 | ≥1 warning, ≥5 high, ≥20 critical | none (count is the signal) |
| `high_latency_p95` | observations w/ `duration_ms` | p95 duration | ≥ 30000 ms | ≥30s warning, ≥60s high, ≥120s critical | ≥20 samples |
| `latency_spike` | observations w/ `duration_ms`, per day | latest-day p95 ÷ trailing-7d p95 | ratio ≥ 2.0 | ≥2.0 warning, ≥3.0 high | ≥10 samples/window, ≥2 days |
| `token_spike` | observations, per day | latest-day total tokens ÷ trailing-7d daily avg | ratio ≥ 2.5 | ≥2.5 warning, ≥4.0 high | ≥3 baseline days |
| `cost_anomaly` | observations, per day | latest-day cost ÷ trailing-7d daily avg | ratio ≥ 2.5 | ≥2.5 warning, ≥4.0 high, ≥6.0 critical | ≥3 baseline days, baseline avg > $0.01 |
| `daily_budget_risk` | `getUsageBudgets()` | budget alert state | state ≥ warning | budget info→info, warning→warning, critical→high, hard_stop_candidate→critical | budgets configured |
| `unknown_pricing` | observations (usage-bearing) | (cost_usd IS NULL among generation/token-bearing) / total | rate ≥ 0.10 | ≥0.10 warning, ≥0.30 high | ≥10 usage-bearing observations |
| `low_trace_coverage` | traces (`lowCoverageExpr`) | low-coverage traces / selected traces | rate ≥ 0.20 | ≥0.20 warning, ≥0.50 high | ≥5 traces |
| `collector_or_otel_dropoff` | `events` (`source='otel'`) | minutes since last otel event, given prior otel history + recent non-otel activity | gap ≥ 60 min | ≥60m warning, ≥1440m high | otel history exists in window |
| `low_quality_score` | scores (`traceScoreTargetSql`) | numeric score ≤ threshold (per score) | value ≤ 0.5 | ≤0.5 warning, ≤0.25 high, ≤0.1 critical | none (per-score) |
| `observation_error` (retained) | observations | status error/timeout or severity error/critical (per observation) | any | severity→high, critical→critical | none (per-observation) |

Granularity: `low_quality_score` and `observation_error` are **per-row** (one finding per offending
score/observation). `tool_failure_rate`/`model_error_rate` are **per-dimension** (one per offending
tool/model). `daily_budget_risk` is **per-budget**. All others are **single aggregate** findings.

### Evidence contract

```ts
// src/api/v2/types.ts
export type TraceQualityFindingKind =
  | 'high_error_rate' | 'tool_failure_rate' | 'model_error_rate' | 'rate_limit_events'
  | 'high_latency_p95' | 'latency_spike' | 'token_spike' | 'cost_anomaly'
  | 'daily_budget_risk' | 'unknown_pricing' | 'low_trace_coverage'
  | 'collector_or_otel_dropoff' | 'low_quality_score' | 'observation_error';

export type TraceQualityFindingSeverity = 'info' | 'warning' | 'high' | 'critical';

export interface TraceQualityFindingInspection {
  target: 'traces' | 'trace' | 'observation' | 'scores' | 'usage';
  params: Record<string, string | number | boolean>; // e.g. { tool: 'Bash', status: 'error' }
}

export interface TraceQualityFindingWindow {
  from: string | null;
  to: string | null;
  label?: string; // 'latest_day' | 'baseline_7d' | 'selected_range'
}

export interface TraceQualityFindingEvidence {
  metric_value?: number;
  threshold?: number;
  comparator?: 'gte' | 'lte';
  unit?: 'ratio' | 'ms' | 'usd' | 'tokens' | 'count';
  window?: TraceQualityFindingWindow;
  baseline_value?: number;
  baseline_window?: TraceQualityFindingWindow;
  sample_size?: number;
  dimension?: { type: 'tool' | 'model' | 'budget' | 'score'; value: string };
  impacted_trace_ids?: string[];        // capped (default 50)
  impacted_observation_ids?: string[];  // capped (default 50)
  impacted_session_ids?: string[];      // capped (default 50)
  impacted_total?: number;              // true count before capping
  coverage_caveat?: string | null;
  next_inspection?: TraceQualityFindingInspection;
  [key: string]: unknown;               // forward-compatible
}

export interface TraceQualityFinding {
  id: string;                           // stable: `${kind}:${dimensionOrRowKey}`
  kind: TraceQualityFindingKind;
  severity: TraceQualityFindingSeverity;
  trace_id: string | null;              // null for aggregate findings
  observation_id: string | null;
  score_id: number | null;
  title: string;
  message: string;
  evidence: TraceQualityFindingEvidence;
  created_at: string | null;            // window end / now for aggregates
}
```

## Task Breakdown

### Task 1: Define finding taxonomy types, severity, evidence, and default thresholds

**Objective**

Land the type/contract and constants the rest of the work compiles against, with no behavior yet.

**Files**

- Modify: `src/api/v2/types.ts`
- Modify: `frontend/src/lib/api/client.ts`
- Modify: `src/trace-quality/constants.ts`
- Test: `tests/trace-quality-findings.test.ts` (new — start with constants/shape assertions)

**Dependencies**

None

**Implementation Steps**

1. Add `TraceQualityFindingKind`, `TraceQualityFindingSeverity`, `TraceQualityFindingInspection`,
   `TraceQualityFindingWindow`, `TraceQualityFindingEvidence`, and the revised `TraceQualityFinding`
   to `src/api/v2/types.ts` (per the Evidence contract above).
2. Mirror the changed `TraceQualityFinding`/evidence types in `frontend/src/lib/api/client.ts`.
3. Add `TRACE_QUALITY_FINDING_KINDS`, `TRACE_QUALITY_FINDING_SEVERITIES`, and
   `DEFAULT_TRACE_QUALITY_FINDING_THRESHOLDS` to `src/trace-quality/constants.ts` (values from the
   threshold table).
4. Write a first failing test asserting the constants exist, kinds count = 14, severity ordering
   helper ranks `critical < high < warning < info`.

**Verification**

- Run: `pnpm build` → expect: clean (types compile).
- Run: `node --import tsx --test tests/trace-quality-findings.test.ts` → expect: the constants/shape
  test passes; placeholder behavior tests (added later) still red.
- Run: `pnpm frontend:check` → expect: 0 errors.

**Done When**

- Taxonomy types and default thresholds exist and compile on both runtimes' type checks.
- A test pins the kind set and severity ordering.

### Task 2: Scaffold `findings.ts`, migrate the three existing kinds, rewire the endpoint

**Objective**

Create the unified module and move `observation_error`, `low_quality_score` (from `low_score`), and
`low_trace_coverage` (from `low_coverage`) into it with the new severity/evidence shape, deleting the
old logic from `queries.ts`.

**Files**

- Create: `src/trace-quality/findings.ts`
- Modify: `src/trace-quality/queries.ts` (remove `listTraceQualityFindings`, `findingSeverityRank`,
  `mapLowScoreSeverity`, `FindingSortFields`, `TraceQualityFindingWithSort`; export the shared
  helpers `includedTraceSelection`, `lowCoverageExpr`, `traceScoreTargetSql`,
  `getTraceQualityCoverage`, `normalizedLimit`, `normalizedOffset`, `parseJsonRecord`)
- Modify: `src/api/v2/router.ts` (import `listTraceQualityFindings` from `../../trace-quality/findings.js`)
- Modify: `tests/v2-trace-quality-api.test.ts` (update finding kind names/severity/evidence)

**Dependencies**

Task 1

**Implementation Steps**

1. Export the shared helpers from `queries.ts` (no SQL duplication).
2. In `findings.ts`, implement `listTraceQualityFindings(params)` returning the same
   `{ data, total, limit, offset, coverage }` shape, plus a pure `computeTraceQualityFindings(...)`
   that returns the unsorted finding list (testable without pagination).
3. Port `observation_error` (severity `error→high`), `low_quality_score` (rename + add
   `next_inspection` to the observation/trace, `dimension: { type: 'score', value: name }`), and
   `low_trace_coverage` (convert from per-trace to a single aggregate finding with
   `impacted_trace_ids` capped + `metric_value` = low-coverage ratio).
4. Implement the deterministic sort + `percentile()` helper (for later tasks) in `findings.ts`.
5. Update the v2 contract test fixtures to the new kind names/severity/evidence.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-findings.test.ts` → expect: migrated-kind tests
  pass (trips + boundary + missing-data).
- Run: `node --import tsx --test tests/v2-trace-quality-api.test.ts` → expect: green with new shape.
- Run: `pnpm lint && pnpm build` → expect: clean.

**Done When**

- The endpoint serves the three migrated kinds from `findings.ts`; `queries.ts` no longer owns
  finding logic; no duplicated SQL.

### Task 3: Error-rate findings

**Objective**

Add `high_error_rate`, `tool_failure_rate`, `model_error_rate`, `rate_limit_events`.

**Files**

- Modify: `src/trace-quality/findings.ts`
- Test: `tests/trace-quality-findings.test.ts`

**Dependencies**

Task 2

**Implementation Steps**

1. Aggregate error/timeout counts over selected observations; emit `high_error_rate` with tiered
   severity, `sample_size`, `metric_value`, `threshold`, `next_inspection → traces?status=error`.
2. Group by `tool_name` and by `model` for the per-dimension kinds (respect min-sample gates).
3. Detect rate-limit markers from observation status + `events.metadata`/observation `metadata_json`
   (`429`, `rate limit`, `overloaded`); emit count-tiered `rate_limit_events`.
4. When sample gates are unmet, emit nothing (and assert that in the missing-data test).

**Verification**

- Run: `node --import tsx --test tests/trace-quality-findings.test.ts` → expect: each kind trips on
  its fixture, boundary (exactly-at-threshold) handled, sub-sample data produces no finding.

**Done When**

- All four error-family kinds fire deterministically with evidence and inspection targets.

### Task 4: Latency findings

**Objective**

Add `high_latency_p95` and `latency_spike`.

**Files**

- Modify: `src/trace-quality/findings.ts`
- Test: `tests/trace-quality-findings.test.ts`

**Dependencies**

Task 2 (uses `percentile()`)

**Implementation Steps**

1. Fetch `duration_ms` list for selected observations; compute p95 in JS; emit `high_latency_p95`
   with tiers + `sample_size`.
2. Bucket durations by UTC day; compare latest-day p95 vs trailing-7d p95; emit `latency_spike` with
   `baseline_value`/`baseline_window`; require ≥2 days else `coverage_caveat`.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-findings.test.ts` → expect: p95 boundary correct
  (e.g. 20 samples), spike ratio boundary correct, single-day data yields caveat not false positive.

**Done When**

- Both latency kinds are deterministic and caveat-safe on short history.

### Task 5: Volume-anomaly findings

**Objective**

Add `token_spike` and `cost_anomaly`.

**Files**

- Modify: `src/trace-quality/findings.ts`
- Test: `tests/trace-quality-findings.test.ts`

**Dependencies**

Task 2

**Implementation Steps**

1. Per-day sum of `tokens_in+tokens_out` and of `cost_usd` over selected observations.
2. Compare latest day vs trailing-7d daily average; emit tiered findings with baseline evidence.
3. Guard `cost_anomaly` against near-zero baselines (min baseline avg) to avoid divide blow-ups.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-findings.test.ts` → expect: ratio tiers correct,
  `<3` baseline days yields caveat, zero-baseline cost produces no false positive.

**Done When**

- Both anomaly kinds fire only with adequate baseline and report baseline evidence.

### Task 6: Pricing and telemetry findings

**Objective**

Add `unknown_pricing` and `collector_or_otel_dropoff`.

**Files**

- Modify: `src/trace-quality/findings.ts`
- Test: `tests/trace-quality-findings.test.ts`

**Dependencies**

Task 2

**Implementation Steps**

1. `unknown_pricing`: ratio of usage-bearing observations (generation or tokens>0) with
   `cost_usd IS NULL`; evidence includes sample model names.
2. `collector_or_otel_dropoff`: read `events` filtered by the same date/project/agent window; compute
   minutes since last `source='otel'` event; emit only when otel history exists in the window AND
   non-otel activity is recent (distinguish "otel broke" from "agent idle"); tiers by gap length.
3. No otel history in window → no finding (assert in test).

**Verification**

- Run: `node --import tsx --test tests/trace-quality-findings.test.ts` → expect: unknown-pricing
  ratio boundary correct; dropoff fires on stale-otel-but-active fixture, stays silent on
  no-otel-history and on fully-idle fixtures.

**Done When**

- Both kinds fire correctly and never false-positive when telemetry/pricing data is simply absent.

### Task 7: Budget-risk finding

**Objective**

Add `daily_budget_risk` by reusing `getUsageBudgets()`.

**Files**

- Modify: `src/trace-quality/findings.ts`
- Reference: `src/usage/budgets.ts`
- Test: `tests/trace-quality-findings.test.ts`, `tests/usage-budgets.test.ts`

**Dependencies**

Task 2

**Implementation Steps**

1. Call `getUsageBudgets()`; for each budget at/above `warning`, emit one finding mapping budget
   alert state → finding severity (info→info, warning→warning, critical→high,
   hard_stop_candidate→critical).
2. Evidence: budget name, `used_usd`, `limit_usd`, `used_percent`, `period`, thresholds,
   `next_inspection → usage`.
3. Do not duplicate budget math; delegate entirely to the usage module.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-findings.test.ts` → expect: at-risk budget
  fixture produces a finding with correct severity mapping; no budgets configured → no finding.
- Run: `node --import tsx --test tests/usage-budgets.test.ts` → expect: unchanged (no regression in
  shared helpers).

**Done When**

- Budget risk surfaces as a finding without re-implementing budget logic.

### Task 8: Configurable thresholds via local JSON

**Objective**

Allow overriding defaults through a local file, after defaults are test-covered (spec step 6).

**Files**

- Modify: `src/trace-quality/findings.ts` (loader mirroring `budgets.ts`)
- Modify: `src/config.ts` (`AGENTMONITOR_TRACE_QUALITY_FINDINGS_PATH`, default
  `./config/trace-quality-findings.json`)
- Modify: `docs/system/OPERATIONS.md` (env var + file)
- Test: `tests/trace-quality-findings.test.ts`

**Dependencies**

Tasks 3–7

**Implementation Steps**

1. Add a parse/validate function (reuse the `budgets.ts` validation style: typed errors, fall back to
   defaults on malformed input).
2. Merge file values over `DEFAULT_TRACE_QUALITY_FINDING_THRESHOLDS`; invalid file → defaults +
   surfaced parse errors (never crash the endpoint).
3. Document the env var and config schema in OPERATIONS.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-findings.test.ts` → expect: an override file
  shifts a boundary case across its threshold; malformed file falls back to defaults.

**Done When**

- Thresholds are overridable locally and malformed config degrades safely to defaults.

### Task 9: Integration sweep, ordering, and docs

**Objective**

Prove all kinds fire from one fixture set with correct ordering, and update reference docs.

**Files**

- Test: `tests/trace-quality-findings.test.ts` (integration block)
- Modify: `docs/system/FEATURES.md` (finding kinds + endpoint detail)
- Modify: `docs/system/OPERATIONS.md` (verification command)
- Modify: `README.md` (only if the findings line needs wording updates)

**Dependencies**

Tasks 2–8

**Implementation Steps**

1. Build a combined fixture DB that triggers every kind; assert the full sorted result (severity →
   sort rank → time → id) and that pagination (`limit`/`offset`) is stable.
2. Add a "missing data" integration case: sparse DB → only caveat-bearing or zero findings, no false
   positives.
3. Update FEATURES.md kind catalog and OPERATIONS.md run command.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-findings.test.ts` → expect: all kinds present,
  deterministic order, stable pagination.
- Run: `pnpm lint && pnpm build && pnpm test` → expect: green.
- Run: `pnpm frontend:check` → expect: 0 errors.

**Done When**

- Findings engine is complete, deterministic, documented, and the full suite is green.

## Risks And Mitigations

- **False positives on sparse/short-history data** — every kind has a min-sample/baseline gate and a
  `coverage_caveat`; a dedicated missing-data test per kind plus an integration sparse-DB case
  enforce "caveat, not false positive."
- **Breaking contract changes** (`kind` renames, severity `error→high`, nullable `trace_id`, typed
  `evidence`) — pre-product endpoint with no Svelte consumer; land atomically with the v2 contract
  test and `client.ts` type updated in the same change.
- **Anomaly math instability** (divide-by-near-zero, single-day baselines) — explicit baseline
  minimums and zero-guards, covered by boundary tests.
- **No native percentile in SQLite** — fetch value lists and compute p95/median in JS via a tested
  `percentile()` helper; lists are scoped by `includedTraceSelection`, so bounded by the filter.
- **Performance** (several aggregate queries per request) — all queries scoped to the selected trace
  set on indexed columns (`idx_tq_observations_*`); impacted-id arrays capped with `impacted_total`.
- **SQL-centralization guardrail** — reuse exported helpers from `queries.ts`; do not duplicate the
  selection/coverage SQL in `findings.ts`.
- **OTEL-dropoff semantics** (idle vs broken) — require prior otel history AND recent non-otel
  activity before firing; aligns with the existing CLAUDE.md Codex OTEL drop-out note.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| :--- | :--- | :--- |
| Each kind trips | `node --import tsx --test tests/trace-quality-findings.test.ts` | one passing "trips" test per 14 kinds |
| Boundary handling | same | exactly-at-threshold cases classified deterministically |
| No false positives on missing data | same | sub-sample/no-history fixtures yield zero or caveat-only findings |
| Threshold override | same | override file moves a boundary case; malformed file → defaults |
| Ordering + pagination | same (integration block) | full sorted result stable; `limit`/`offset` stable |
| Budget reuse, no regression | `node --import tsx --test tests/usage-budgets.test.ts` | unchanged green |
| Contract migration | `node --import tsx --test tests/v2-trace-quality-api.test.ts` | new kind/severity/evidence shape green |
| Type parity | `pnpm build` + `pnpm frontend:check` | both clean |
| Full gate | `pnpm lint && pnpm build && pnpm test` | green (required CI gate) |

## Handoff

Plan complete and saved to `docs/plans/2026-06-08-task7-quality-findings-plan.md`.

Next options:
1. Execute in this session, task by task (1 → 9), red/green per task.
2. Open a separate execution session from this plan.
3. Refine the plan first (e.g., adjust default thresholds, drop/keep `observation_error`, or change
   anomaly window definitions) before implementation.

When implementing, branch is already prepared: `trace-quality-findings`.
