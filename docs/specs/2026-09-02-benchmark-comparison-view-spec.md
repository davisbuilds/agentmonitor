---
title: Benchmark comparison view (Benchmarks tab)
status: complete
created: 2026-09-02
owner: davis
related:
  - docs/project/BACKLOG.md ("No UI surfaces the benchmark bake-off")
  - docs/system/ARCHITECTURE.md (import pipeline · benchmark.ts)
  - docs/system/FEATURES.md (benchmark segregation)
  - docs/project/POSITIONING.md (coverage-honesty stance)
  - openbench branch feat/results-row-study-identity (emits study/study_sha256/suite/canonical_model/reasoning_effort)
---

# Benchmark comparison view

## Motivation

`amon import benchmark` (PR #103) ingests openbench `results.jsonl` bake-offs as
`source='benchmark'` events, correctly segregated out of every default
usage/analytics/Monitor surface. Nothing renders them: the only way to see a
bake-off today is to hand-call `/api/v2/usage/*?include_benchmark=true`. This
spec adds the downstream consumer — a dedicated **Benchmarks** tab in `/app/`
that answers the question the ingest exists for: *which model to route real work
to, on accuracy against cost.*

The design target is the hand-authored "Bug-Fix Routing Frontier" artifact
(Pareto scatter + arm ladder + honesty caveats), generalized from a one-off
narrative into a data-driven, repeatable view. The mechanical parts (frontier,
ladder) port cleanly; the narrative parts (routing prose) become computed
verdict chips; and the caveats become **auto-generated from what the console
actually tracks** — the one place the product beats a static artifact, because
it cannot misstate captured-vs-derived cost or excluded trials.

## Vocabulary (the data hierarchy)

```
STUDY   one bake-off = one results.jsonl import   (e.g. am-consistency-pareto-2026-08-29)
 └─ ARM   one model(+effort)                        → one frontier dot / one ladder row
     └─ TRIAL   one repeat                           → the cells averaged into (n, mean score)
         └─ CELL   one (task × model × trial)        = one run_id = one benchmark EVENT
```

- **Cell** — the atomic ingested unit. `run_id = harness:task:model:trial`, one
  `events` row, `source='benchmark'`.
- **Arm** — a model aggregated across its trials: `n`, mean score, mean $/trial,
  mean `t_agent`, cache-read totals. One point on the frontier, one ladder row.
- **Study** — the set of arms compared *together*. The unit the frontier is
  *about*.

## Study identity — resolved upstream in openbench

The frontier plots *the arms of one study together*. That grouping originally
lived **only in the imported directory name** and was carried in no row field —
so amon would have had to reconstruct it (unreliably: task ≠ study, model spans
studies, two studies can run the same day). Rather than compensate downstream,
openbench now emits it directly (branch `feat/results-row-study-identity`, new
nullable fields, additive — existing fields untouched):

| row field          | meaning                                   | amon use                     |
|--------------------|-------------------------------------------|------------------------------|
| `study_sha256`     | **exact per-run key** (suite + first-launch ts + nonce + canonical spec) | **grouping key** |
| `study`            | per-run **slug** `{suite}-{launch-date}`  | display label                |
| `suite`            | config-level slug (reusable)              | future cross-run facet       |
| `canonical_model`  | model without effort, e.g. `gpt-5.6-terra`| pricing / classification / arm id |
| `reasoning_effort` | e.g. `xhigh` (null if unknown adapter)    | arm id                       |
| `is_open_model`    | true = bridge-routed open/pay-per-token, false = native subscription, null = adapter can't classify | **native marker** (hollow) |

**Group on `study_sha256`, not `study`.** The slug `{suite}-{launch-date}`
collides for two runs of the same suite on the same day; only `study_sha256`
distinguishes them (its nonce). Keying on the sha is what guarantees "arms that
ran *together*" — the whole point of the grouping. `study` is the human label; if
two studies share a slug, disambiguate in the UI (launch time / short sha).

**amon reads these; it does not derive them.** The old parent-directory
derivation survives only as a **legacy fallback** for pre-field files (and
already-imported rows): if `study_sha256` is absent, fall back to the parent-dir
name as both slug and (best-effort) id — same-day collision accepted for legacy
data only. `--study <label>` stays as a manual override / escape hatch.

## Data model & migration

`src/db/schema.ts` — follow the established idempotent pattern (presence-check
via `PRAGMA table_info(events)`, then `ALTER TABLE events ADD COLUMN`). Two
nullable columns: the grouping key and the display slug (both null for
non-benchmark rows):

```sql
ALTER TABLE events ADD COLUMN study_id  TEXT;   -- = openbench study_sha256 (grouping key)
ALTER TABLE events ADD COLUMN study     TEXT;   -- = openbench study slug (display label)
```

Index the grouping key (benchmark rows are the only non-null ones, so it stays
small):

```sql
CREATE INDEX IF NOT EXISTS idx_events_study_id ON events(study_id) WHERE study_id IS NOT NULL;
```

`suite`, `canonical_model`, and `reasoning_effort` ride in event **metadata** (not
columns); `study_id` already holds `study_sha256`, so it is not duplicated there.
`suite` promotes to a column only when the future cross-run facet is built. No reshaping of existing rows: prior benchmark
events have `study_id = NULL` until re-imported; `amon import benchmark <file>`
re-stamps them via the existing duplicate **backfill** branch (the same one that
backfills a null cost), now also setting `study_id`/`study` where null.

## Ingest changes (`src/import/benchmark.ts`, `src/cli/commands/maintenance.ts`)

1. Resolve study identity per row, preferring the upstream fields:
   - `study_id = options.study_id ?? row.study_sha256 ?? <legacy: parent-dir name>`
   - `study    = options.study    ?? row.study        ?? <legacy: parent-dir name>`
   - carry `row.suite` into metadata (null for legacy).
2. Resolve model identity, preferring the upstream fields:
   - `canonical_model = row.canonical_model ?? stripEffortSuffix(row.model)` (the
     existing heuristic becomes the legacy fallback only).
   - `reasoning_effort = row.reasoning_effort ?? <suffix if recognized, else null>`.
   - keep `row.model` verbatim for display.
3. Thread `study_id`/`study` into the `insertEvent({ ... })` call; put
   `study_sha256`/`suite`/`canonical_model`/`reasoning_effort` in metadata.
4. **Backfill on duplicate**: extend the existing null-cost backfill branch to
   also set `study_id`/`study` (and metadata identity) where null — so
   re-importing legacy rows adopts identity without a forced reset. Fold into the
   existing backfill count in the result + CLI summary.
5. CLI: keep `--study`/`--study-id` as manual overrides in the option set; surface
   the resolved study slug in `printSummary`.

TDD: red tests first — (a) `study_id`/`study`/`canonical_model`/`reasoning_effort`
read straight from row fields when present; (b) legacy fallback (no upstream
fields) derives slug from parent dir and strips the effort suffix; (c) two runs
of the same suite same day (same `study` slug, different `study_sha256`) form
**two** studies, not one; (d) re-import of a null-identity row backfills it.

## Queries (`src/db/v2-queries.ts`)

Two read functions, both explicitly benchmark-scoped (this tab is the
benchmark-native surface — the *only* place that reads with benchmark rows
included; it must not touch `buildUsageFilterState`, which stays benchmark-
excluding for every other surface):

### `getBenchmarkStudies(): BenchmarkStudySummary[]`

`GROUP BY study_id` over `events WHERE source='benchmark'`. Per study: `study_id`
(key), `study` slug + `suite` (labels), `arm_count`, `cell_count`, task set, date
range (`min/max client_timestamp`), total cost, and a `cost_basis` rollup
(captured vs derived vs unpriced). Ordered newest-first.

### `getBenchmarkStudy(study_id: string): BenchmarkStudyDetail`

All cells for one study (`WHERE study_id = ?`), aggregated into arms. An **arm =
`(canonical_model, reasoning_effort)`** — so `terra@xhigh` and `luna@max` are
distinct arms, as are `terra@xhigh` and `terra@high` (matching the artifact's
distinct points). Pricing and `native` key off `canonical_model` directly — no
effort-suffix stripping now that the field is authoritative.

```ts
interface BenchmarkArm {
  canonical_model: string;       // arm identity + pricing/classification key
  reasoning_effort: string | null; // arm identity (null = unknown adapter)
  label: string;                 // display, e.g. "terra · xhigh" (from model)
  n: number;                     // cells with a score
  mean_score: number;            // y-axis
  cost_per_trial: number | null; // x-axis; null if any cell unpriced
  cost_basis: 'captured' | 'derived' | 'unpriced';
  mean_t_agent_s: number;
  cache_reads: number;
  native: boolean;               // row.is_open_model === false; pricing-provider fallback when null
  // computed frontier geometry:
  pareto: boolean;               // on the non-dominated frontier
  dominated_by: string | null;   // arm that beats it on both axes (connector)
  verdict: 'value-pick' | 'on-frontier' | 'dominated' | 'trivial-only' | 'unreliable';
  // honesty flags:
  excluded_trials: number;       // trials dropped (rate-limited, etc.) → n < expected
  noop_trials: number;           // success with zero workspace change
  token_basis: string;           // vendor_split / estimated / proxy / …
  usage_evidence_grade: string | null; // openbench #4 — how trustworthy the usage is
}
```

Frontier geometry is computed in TS from the arm set (definitions below), not
stored. `usage_evidence_grade` becomes meaningful once openbench's #4 lands
(currently null/mixed); until then the honesty panel leans on `token_basis` +
`cost_basis`.

### Mechanical definitions (no narrative)

- **Pareto/non-dominated**: arm A is dominated if some arm B has
  `score_B >= score_A` **and** `cost_B <= cost_A` with at least one strict. The
  frontier is the non-dominated set, drawn as an ascending-cost polyline.
- **value-pick**: among arms that *engage* (mean_score above a floor, e.g. > 0.5),
  the highest `mean_score / cost_per_trial`.
- **trivial-only**: on-frontier by cost but `mean_score` below the engage floor
  (glm at 0.22).
- **unreliable**: `noop_trials > 0` or `n < expected_trials` — flagged, not
  ranked away silently.
- **native** (hollow marker): `row.is_open_model === false`. openbench now emits
  this authoritatively (it knows open-vs-native via its `OPEN_MODELS` set), so
  amon reads it rather than inferring. **Fallback** when `is_open_model` is null
  (adapter couldn't classify) or absent (legacy rows):
  `classifyModel(canonical_model).provider !== 'openrouter'` — first-party tables
  (codex.json `openai`, claude.json `anthropic`, gemini.json `google`) vs
  `openrouter.json`; unpriced → `provider: 'unknown'` → treated as routed. The
  original bench rows carried **no** discriminating field (all `harness='codex'`,
  `exec_mode='local'`, `cost_source=None`), which is why this moved upstream.

## Frontend (`frontend/src/`)

### Tab wiring

- `route-state.ts`: extend `AppTab` union + `TAB_SET` with `'benchmarks'`; add a
  `buildAppHash('benchmarks', { study })` path (`#benchmarks?study=<id>`).
- `App.svelte`: add the tab to the shell `tabs` nav.
- New route component `BenchmarksPage.svelte` with two states: **studies list**
  (default) and **study detail** (`?study=<id>`).

### Charts — house style: hand-rolled inline SVG + tokens (no library)

The app has **no charting dependency**; plotted charts are inline `<svg>` with
`var(--color-*)` tokens (canonical: CostDashboard "Spend Over Time"
`<polyline vector-effect="non-scaling-stroke">`). The frontier is rebuilt as
inline SVG — **not** ported from the artifact's `<canvas>` — because for this app
SVG is strictly better: theme inherits via CSS vars (no manual token re-read +
redraw), each arm is a real `<circle>` DOM node (hover/click drill-in with no
hit-testing), and `viewBox` handles responsiveness (no ResizeObserver/DPR).

New per-view component **`BenchmarkFrontier.svelte`** (inline SVG, tokenized):
- log10 x-scale, linear y in [0,1] (via shared scale helpers, below).
- `<polyline>` through the Pareto arms (dashed, `--color-accent`/teal token).
- faint `<line>` domination connectors (dominated arm → its dominator).
- `<circle>` per arm: filled (API) vs hollow `fill=surface stroke` (native).
- text labels; hover a circle → arm tooltip; click → drill to the arm's trials.

### Shared chart primitives (scoped — helpers + frame, not a chart engine)

The app has **one** viz primitive today (`Bar`, 1D) and builds plotted charts
inline per-view. There are ~2 real SVG-plot consumers (CostDashboard's timeline
polyline; this frontier), and they are different shapes — so this spec adds the
**low-level shared pieces**, not a generic `<Chart type=…>` component (which
would over-fit two divergent cases and couple them):

- `ui/chart/scales.ts` — **pure TS**: `linearScale`, `log10Scale`
  (domain → 0..100 viewBox units), nice-tick generation, `$/token` formatting.
  Unit-tested, zero coupling.
- `ui/chart/PlotFrame.svelte` — **thin, tokenized**: gridlines, tick labels, axis
  titles given scales + ranges. No marks, no data opinions.

**Marks and composition stay per-view** — `BenchmarkFrontier` and the timeline
each draw their own `<circle>`/`<polyline>` inside a `PlotFrame`.

**Validation guardrail (in-scope for this slice):** extract the primitives *and*
refactor CostDashboard's "Spend Over Time" timeline onto them in the same change.
A primitive proven against only its first consumer is over-fit by construction;
the timeline is the second consumer that proves the abstraction isn't frontier-
shaped. If the timeline won't sit on it cleanly, the abstraction is wrong — cheap
to learn now. Behavior of the existing timeline must be preserved (screenshot
before/after).

### Ladder & honesty — reuse existing primitives

- **Ladder**: `DataTable` + inline `Bar` for magnitude columns + `Badge` for
  verdict chips (computed, no prose). Columns mirror the artifact: arm · n ·
  mean score · $/trial · t_agent · cache-reads · verdict.
- **Honesty panel**: `Panel` listing auto-generated caveats from the arm honesty
  flags — derived-vs-captured cost, `n` below expected trials, no-op trials,
  `token_basis`, unpriced arms. Generated, not authored; this is the differentiator.
- **Studies list**: `DataTable`/`SectionHeader`/`EmptyState`.

## Segregation invariant (must hold)

The Benchmarks tab is the sole benchmark-inclusive surface. Its queries filter
`source='benchmark'` *in* explicitly and never route through
`buildUsageFilterState`. Every other surface (Usage/Analytics/Monitor/Live)
keeps excluding benchmark by default. Add a test asserting the new queries return
only benchmark rows and that adding benchmark data does not move any default
Usage/Monitor total (guards the [[insertevent-fanout-cross-cutting-filters]]
class from the read side).

## Phasing

- **P1 — data + queries (backend, TDD). ✅ SHIPPED** (`a578209`, `86972f0`).
  `study_id`/`study` columns + migration + index; ingest reads the upstream
  `study_sha256`/`study`/`suite`/`canonical_model`/`reasoning_effort`/
  `is_open_model` fields (legacy fallback for old rows) + duplicate backfill;
  `getBenchmarkStudies` / `getBenchmarkStudy` with arm aggregation + Pareto/
  verdict + honesty flags; `GET /api/v2/benchmarks[/:studyId]`; `--study`
  override. Shipped behind no UI.
- **P2 — Benchmarks tab shell. ✅ SHIPPED** (`e5ef0d7`). `benchmarks` tab +
  `#benchmarks?study=` route; studies list; study-detail ladder (DataTable + Bar +
  verdict Badges + ◯native/●routed) + auto-generated honesty panel. Playwright-
  validated against three real openbench studies. Usable without the chart.
- **P3 — frontier chart + shared primitives. ✅ SHIPPED** (2026-09-04).
  `ui/chart/scales.ts` (pure `linearScale`/`log10Scale` + nice-tick + `formatUsd`,
  unit-tested & mutation-verified) + `ui/chart/layout.ts` + tokenized
  `PlotFrame.svelte` (frame only). `BenchmarkFrontier.svelte` draws marks on top:
  Pareto polyline (`arm.pareto`), domination connectors (matched on
  `canonical_model` via `dominated_by`), hollow ◯ native / filled ● routed
  markers, hover tooltip, and click-drill that highlights + scrolls to the arm's
  ladder row (added optional `rowClass`/`rowAttrs` to `DataTable`). Pure geometry
  lives in `benchmarks/frontier-geometry.ts` so it is testable without a DOM.
  Unpriced arms are held off the cost axis and named in a legend note. The
  CostDashboard "Spend Over Time" timeline was refactored onto `linearScale` as
  the second-consumer validation (algebraically identical, behavior preserved).
- **P4 (optional) — export to artifact.** "Publish study" emits the standalone
  frontier page (the artifact format), app as source of truth. Nice symmetry;
  not required.

## Open decisions

1. **Study fallback** — *largely resolved.* Upstream now emits
   `study_sha256`/`study`, so this only governs **legacy** files predating the
   field: fall back to parent-dir name (slug + best-effort id), warn, accept
   same-day collision for legacy data only. `--study` remains a manual override.
2. **`expected_trials`** for the `n < expected` honesty flag — infer as the max
   trial index seen in the study, or a fixed 3? Lean: max seen per study.
3. **`native`/routed detection** — *resolved upstream.* openbench now emits
   `is_open_model` (commit `6b2c196`) authoritatively from its `OPEN_MODELS` set:
   `native = is_open_model === false`. amon's pricing-provider inference
   (`classifyModel(canonical_model).provider !== 'openrouter'`) is kept only as
   the fallback for null (unclassifiable adapter) / legacy rows. Ties to the
   unpriced-comparator backlog item: an arm lands on the cost axis only if
   priced — unpriced arms show in the ladder + honesty panel, never silently
   dropped.
4. **Effort suffixes** — *resolved upstream.* openbench now emits
   `canonical_model` + `reasoning_effort` as separate fields, so arm identity is
   `(canonical_model, reasoning_effort)` — `terra@xhigh` and `luna@max` are
   distinct arms, no string heuristic. The suffix strip survives only as the
   legacy fallback for pre-field rows.
5. **Per-attempt cost (watch — openbench #5 in flight).** Today only the final row
   per cell is kept, so cost is a *floor* (retries uncounted) — reflected as a
   honesty caveat. If openbench #5 retains per-attempt cost/tokens (or a per-cell
   attempt count + summed cost), amon's cost becomes *complete* and that caveat is
   dropped/changed. Do **not** hard-code the "floor" assumption into P1's cost
   aggregation; revisit when #5's row shape is known.

## Testing

- Ingest: study derivation, override, duplicate backfill (red first).
- Queries: arm aggregation math, Pareto/domination/verdict on a fixture study,
  honesty flags, benchmark-only scoping + no-leak into default totals.
- Frontend: `frontend:check`; unit tests for `ui/chart/scales.ts` (log/linear
  domain→viewBox mapping, tick generation — pure, exhaustive); a component test
  for frontier geometry (points + which arms are on the polyline) — mutation-
  verify against a known study so a wrong frontier goes red. CostDashboard
  timeline unchanged after the refactor (before/after screenshot).
