---
date: 2026-05-13
topic: agent-usage-intelligence
stage: implementation-plan
status: tasks-1-6-complete
source: conversation
---

# Agent Usage Intelligence Implementation Plan

## Goal

Turn AgentMonitor's existing event-derived Usage surface into an operator-grade usage intelligence layer with model classification, provider-neutral tier rollups, cache economics, high-signal session attribution, and a clear path to budget alerts and human-reviewed tier recommendations.

## Scope

## Implementation Status

As of 2026-05-25, the first implementation slice is complete on branch `agent-usage-intelligence`, and Task 6 is complete on follow-up branch `agent-usage-intelligence-followups`.

Completed:

- Task 1: model classification service and `PricingRegistry.resolve()`.
- Task 2: additive v2 usage API and frontend client types for classification, cache economics, tier rollups, and top-session enrichment.
- Task 3: backend usage-row scan/fold path, `/api/v2/usage/tiers`, cache hit rate, per-row estimated cache savings, classified model rows, and enriched top sessions.
- Task 4: Usage store, API client, insight snapshot, and CSV export updates.
- Task 5: Svelte Usage UI updates for tier attribution, cache economics, pricing coverage, and top-session primary model/tier indicators.
- Task 6: optional `model`, `provider`, and `tier` usage filters plus prior-period comparison.

Verification completed:

- `pnpm lint`
- `pnpm build`
- `pnpm test` (`438` tests passed, `0` failed)
- `node --import tsx --test tests/v2-usage.test.ts`
- `node --import tsx --test tests/usage-state.test.ts`
- Manual smoke checks for `GET /api/health` and `GET /api/v2/usage/tiers`.

Remaining planned follow-up scope:

- Task 7: read-only budget alert contracts.
- Task 8: human-reviewed tier feedback report.

Implementation commits:

- `4bfd4e9` Add pricing model classification
- `dc86fc4` Add usage tier rollups and cache economics
- `1e64f02` Surface usage intelligence in the Svelte app
- `f68557b` Document usage intelligence contract
- `c7f91cd` Stabilize monitor query fixture

### In Scope

- Preserve the current `/api/v2/usage/*` event-derived contract while extending it with richer attribution.
- Add a model classification layer on top of the existing pricing registry.
- Add provider-neutral usage tiers and expose tier rollups through backend and frontend contracts.
- Add cache hit-rate and estimated cache-savings metrics where enough pricing data exists.
- Enrich top usage sessions with primary model, primary tier, model count, tier cost mix, and unknown/partial-data indicators.
- Update the Svelte `/app/` Usage tab and TypeScript API client types.
- Add tests for known, deprecated, aliased, and unknown models.
- Document source/coverage semantics so partial telemetry does not look more precise than it is.
- Leave hooks for later budget alerts and tier-feedback reports without making them enforcement mechanisms in this pass.

### Out Of Scope

- Replacing AgentMonitor's SQLite event model with Prometheus, Loki, or OpenTelemetry-native query storage.
- Copying AgentsView's message-log data model into AgentMonitor usage queries.
- Enforcing budgets through Claude Code hooks or blocking agent dispatches.
- Automatically changing subagent/model tier choices.
- Adding auth, hosted dashboards, or multi-user deployment behavior.
- Implementing dynamic LiteLLM pricing refresh in the first pass.
- Adding Rust backend parity in the same PR unless explicitly scoped by the executor.

## Assumptions And Constraints

- Canonical product work belongs in the Svelte `/app/` frontend and `/api/v2/*` API surface.
- Current usage metrics are event-derived from `events` rows with cost or token fields, not transcript-derived from `browsing_sessions/messages`.
- Existing usage APIs already cover summary, daily, project, model, agent, and top-session views.
- Existing pricing data lives under `src/pricing/data/*.json` and is loaded by `src/pricing/index.ts`.
- Stored `events.cost_usd` should remain the authoritative cost for existing rows. Recomputed cost should only be used for derived comparison/savings estimates unless a later migration explicitly adds provenance.
- Cache savings are derived estimates from current pricing metadata, computed per usage row as:
  - `cache_read_tokens * (input_rate - cache_read_rate) + cache_write_tokens * (input_rate - cache_write_rate)`
  - The result may be negative when cache writes are more expensive than uncached input.
  - Do not derive mixed-model cache savings from aggregate tokens and one representative rate.
- Backend implementation should borrow AgentsView's scan-and-fold pattern for classification-heavy metrics: use SQL to select eligible event rows, then fold rows in TypeScript for tier attribution, unknown-pricing counters, cache savings, and top-session enrichment.
- Unknown models and missing pricing must remain visible in API responses and UI copy.
- The first implementation should avoid schema migration unless a task explicitly proves a persisted field is required.
- Keep the first implementation PR limited to Tasks 1 through 5. Treat filters, prior-period comparison, budgets, and tier feedback as follow-up contracts after the base attribution has real data behind it.
- If API response shapes change, update `README.md`, `docs/system/FEATURES.md`, and `docs/system/ARCHITECTURE.md` in the same change.
- Repo verification guidance remains `pnpm lint`, `pnpm build`, and `pnpm test`; run `pnpm rust:test` only if Rust files are touched.

## Source And Reference Points

- AgentMonitor repo guidance: `AGENTS.md`
- Current architecture: `docs/system/ARCHITECTURE.md`
- Current features/API catalog: `docs/system/FEATURES.md`
- Prior AgentsView integration plan: `docs/plans/2026-03-06-agentsview-integration-plan.md`
- Completed usage surface plan: `docs/plans/2026-04-14-agentsview-gap-closure-implementation.md`
- Current usage backend: `src/db/v2-queries.ts`
- Current usage route handlers: `src/api/v2/router.ts`
- Current v2 usage types: `src/api/v2/types.ts`
- Current pricing registry: `src/pricing/index.ts`
- Current frontend API client: `frontend/src/lib/api/client.ts`
- Current usage store and UI: `frontend/src/lib/stores/usage.svelte.ts`, `frontend/src/lib/components/usage/`
- Local competitor reference: `~/Dev/_clones/agentsview`
  - `README.md` validates local, account-free usage/cost analytics.
  - `internal/db/usage.go` shows shared eligibility rules, normalized usage-row scans, per-row pricing, cache savings, and top sessions by cost.
  - `internal/server/usage.go` shows API shapes for totals, daily series, attribution, cache stats, and prior-period comparison.
  - `internal/pricing/litellm.go` and `internal/pricing/fallback.go` show online pricing refresh with versioned offline fallback.
  - `frontend/src/lib/components/usage/UsageSummaryCards.svelte`, `CacheEfficiencyPanel.svelte`, `TopSessionsTable.svelte`, and `AttributionPanel.svelte` show compact usage cards, cache semantics, top-session rows, and grouped cost attribution.
  - Borrow concepts, not storage or contract shape: AgentMonitor remains event-derived from `events`, not transcript/message-log derived.
- External competitor reference: `laran/claude-agent-cost` at `https://github.com/laran/claude-agent-cost`
  - `README.md` frames Claude Code's upstream cost metric as authoritative and tier rollups as query-time reporting.
  - `bin/cost-report.sh` shows grouping by branch, issue, tier, agent, model, day, session, and complexity.
  - `bin/cost-budget-check.sh` shows an alert ladder and hard-stop exit behavior.
  - `bin/tier-feedback.sh` shows human-reviewed tier recommendation output rather than automatic changes.
  - `config/budgets.yml` and `config/pricing.yml` show opt-in budgets and fallback pricing semantics.

## Task Breakdown

### Task 1: Add Model Classification Service

**Objective**

Create a reusable model classification layer that converts raw model names into stable provider, family, tier, lifecycle, and pricing-status metadata without changing stored event rows.

**Files**

- Create: `src/pricing/model-classification.ts`
- Modify: `src/pricing/index.ts`
- Test: `tests/pricing.test.ts`
- Reference: `src/pricing/data/claude.json`
- Reference: `src/pricing/data/codex.json`
- Reference: `src/pricing/data/gemini.json`

**Dependencies**

None

**Implementation Steps**

1. Define `ModelClassification` with at least:
   - `raw_model`
   - `canonical_model`
   - `provider`
   - `family`
   - `tier`
   - `known`
   - `deprecated`
   - `pricing_status`
2. Extend `PricingRegistry` with a public resolver, such as `resolve(model)`, that returns canonical model ID plus pricing metadata after provider-prefix stripping and alias lookup.
3. Make classification call the registry resolver first. Do not duplicate alias or provider-prefix logic in `model-classification.ts`.
4. Define `pricing_status` as a small explicit vocabulary:
   - `known`
   - `deprecated`
   - `unknown`
5. Define a small provider-neutral tier vocabulary for the Usage UI:
   - Claude: `haiku`, `sonnet`, `opus`
   - Codex/OpenAI: `economy`, `standard`, `premium`, `reasoning`
   - Gemini: `flash`, `pro`, `ultra`
   - fallback: `unknown`
6. Keep tier rules deterministic and local. Use exact known model IDs first, then conservative substring fallback only for unknown-but-obvious names.
7. Expose helper functions such as `classifyModel(model: string | null | undefined)` and `classifyModelForUsage(model: string)`.
8. Add tests covering canonical names, aliases, provider-prefixed names, deprecated models, unknown models, and empty/null model values.

**Verification**

- Run: `pnpm test -- tests/pricing.test.ts`
- Expect: existing pricing tests pass plus new classification tests for known, aliased, deprecated, and unknown models.
- Run: `pnpm build`
- Expect: new exported types compile without circular imports.

**Done When**

- Classification is usable by backend usage queries without duplicating model-name parsing in route handlers.
- Unknown and deprecated models are explicitly distinguishable.
- No database migration is required.

### Task 2: Extend Usage API Types For Classification And Cache Economics

**Objective**

Expand the v2 usage response contract to carry model classification, tier rollups, cache hit rate, cache savings estimates, and partial-data metadata while preserving existing fields.

**Files**

- Modify: `src/api/v2/types.ts`
- Modify: `frontend/src/lib/api/client.ts`
- Modify: `docs/system/FEATURES.md`
- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `README.md`

**Dependencies**

- Task 1

**Implementation Steps**

1. Add `UsageModelClassification` or reuse the backend classification type where import boundaries allow.
2. Extend `UsageModelBreakdown` with:
   - `provider`
   - `family`
   - `tier`
   - `canonical_model`
   - `known`
   - `deprecated`
   - `pricing_status`
3. Add `UsageTierBreakdown` with:
   - `tier`
   - `provider`
   - `cost_usd`
   - `input_tokens`
   - `output_tokens`
   - `cache_read_tokens`
   - `cache_write_tokens`
   - `usage_events`
   - `session_count`
   - `unknown_model_events`
4. Extend `UsageSummary` with:
   - `cache_hit_rate`
   - `estimated_cache_savings_usd`
   - `pricing_known_events`
   - `pricing_unknown_events`
   - `unknown_model_events`
5. Extend `UsageTopSessionRow` with:
   - `primary_model`
   - `primary_tier`
   - `primary_provider`
   - `model_count`
   - `tier_costs`
   - `unknown_model_events`
6. Define `tier_costs` as an array rather than an object so ordering is stable:
   - `provider`
   - `tier`
   - `cost_usd`
   - `usage_events`
7. Do not add `tier`, `model`, or `provider` filters in Tasks 1 through 5. Those belong to Task 6 after the base rollups are stable.
8. Update docs to state that `cost_usd` is stored event cost while cache savings are derived estimates from current pricing metadata.

**Verification**

- Run: `pnpm build`
- Expect: backend and frontend TypeScript compile with the extended response types.
- Run: `pnpm test -- tests/v2-router-errors.test.ts`
- Expect: existing v2 error envelope tests still pass.

**Done When**

- API contracts express classification and cache-economics fields without removing or renaming current fields.
- Docs explain which values are stored, derived, and coverage-limited.

### Task 3: Implement Backend Tier Rollups And Cache Economics

**Objective**

Implement the actual usage rollup behavior in `src/db/v2-queries.ts`, keeping all usage endpoints aligned on one eligibility rule and one classification path.

**Files**

- Modify: `src/db/v2-queries.ts`
- Modify: `src/api/v2/router.ts`
- Modify: `src/api/v2/types.ts`
- Test: `tests/v2-usage.test.ts`
- Test: `tests/usage-state.test.ts`
- Test: `tests/v2-router-errors.test.ts`

**Dependencies**

- Task 1
- Task 2

**Implementation Steps**

1. Keep `usageMetricsCondition()` as the single source of truth for usage-bearing events.
2. Add an internal usage-row scan helper in `src/db/v2-queries.ts`, such as `selectUsageRows(params)`, that returns eligible event rows with:
   - `session_id`
   - `project`
   - `agent_type`
   - `model`
   - `cost_usd`
   - `tokens_in`
   - `tokens_out`
   - `cache_read_tokens`
   - `cache_write_tokens`
   - timestamp fields needed for existing date filters and top-session ordering
3. Add a small fold layer over those rows for classification-heavy metrics. Fold rows in TypeScript for:
   - model classification attachment
   - tier rollups
   - pricing-known and pricing-unknown counters
   - unknown-model counters
   - per-row cache savings
   - top-session primary model/tier and tier-cost mix
4. Keep existing simple SQL aggregation for endpoints where it stays clearer, but do not implement tier attribution, cache savings, or primary model selection with complex SQL string logic.
5. Compute cache hit rate as:
   - denominator: `input_tokens + cache_read_tokens`
   - numerator: `cache_read_tokens`
   - return `0` when denominator is `0`
6. Compute estimated cache savings per usage row only when the model resolves to known pricing:
   - `cache_read_tokens * (input_rate - cache_read_rate) + cache_write_tokens * (input_rate - cache_write_rate)`
   - Sum per-row values across the requested slice.
   - Return `0` for rows without known pricing and count those rows through unknown-pricing metadata.
   - Keep this estimate visually and contractually separate from stored `events.cost_usd`.
7. Extend `getUsageModels()` to attach model classification fields.
8. Add `getUsageTiers()` and route it as `GET /api/v2/usage/tiers`.
9. Extend `getUsageSummary()` with cache hit rate, estimated cache savings, and unknown-pricing counters.
10. Extend `getUsageTopSessions()` with primary model/tier and tier-cost mix. Primary model should be the highest-cost model in the session, falling back to highest input-token volume when cost is zero.
11. Keep source coverage from `getUsageCoverage()` intact and add only additive fields if needed.
12. Add tests with fixture events for:
    - known Claude/Codex/Gemini models
    - aliased model names
    - unknown model names
    - cache read/write tokens
    - mixed-model rows proving cache savings are summed per row, not derived from aggregate token totals
    - top session with multiple models/tiers
13. Add negative-path tests for unknown model and zero-token/zero-cost rows.

**Verification**

- Run: `pnpm test -- tests/v2-api.test.ts`
- Expect: usage summary, model, tier, cache-savings, and top-session assertions pass.
- Run: `pnpm test -- tests/v2-router-errors.test.ts`
- Expect: new `/api/v2/usage/tiers` route error handling is covered.
- Run: `pnpm build`
- Expect: all usage query/type changes compile.

**Done When**

- `/api/v2/usage/models` includes classification metadata.
- `/api/v2/usage/tiers` returns deterministic provider/tier attribution.
- `/api/v2/usage/summary` includes cache economics and unknown-pricing counters.
- `/api/v2/usage/top-sessions` identifies primary model/tier and tier mix.

### Task 4: Update Usage Store, API Client, And CSV Export

**Objective**

Wire the extended usage contract into the frontend data layer without changing user-facing layout yet.

**Files**

- Modify: `frontend/src/lib/api/client.ts`
- Modify: `frontend/src/lib/stores/usage.svelte.ts`
- Modify: `frontend/src/lib/usage-state.ts`
- Test: existing frontend-adjacent tests if present

**Dependencies**

- Task 2
- Task 3

**Implementation Steps**

1. Add `fetchUsageTiers()` to the API client.
2. Add `tiers` state, loading state, and error state to `usage.svelte.ts`.
3. Include tier data in `fetchAll()`.
4. Update CSV export to include at least:
   - model classification fields in model rows
   - a tier section or tier rows
   - cache hit rate and estimated savings in summary metadata
5. Keep existing hash/query filter behavior unchanged unless backend tier/model filtering was implemented.
6. Guard all new fields with defaults so old fixture responses fail gracefully during development.

**Verification**

- Run: `pnpm build`
- Expect: Svelte and TypeScript compile cleanly.
- Run: `pnpm test`
- Expect: no regression in existing API/client behavior.

**Done When**

- The frontend data layer can load tier data and enriched model/session rows.
- CSV export contains the new information without breaking existing columns.

### Task 5: Update Usage UI For Tier Attribution And Cache Economics

**Objective**

Make the new usage intelligence visible in the Svelte Usage tab with compact, scannable additions rather than a broad redesign.

**Files**

- Modify: `frontend/src/lib/components/usage/UsagePage.svelte`
- Modify: `frontend/src/lib/components/usage/UsageSummaryCards.svelte`
- Modify: `frontend/src/lib/components/usage/UsageBreakdownTable.svelte`
- Modify: `frontend/src/lib/components/usage/UsageTopSessions.svelte`
- Modify: `frontend/src/lib/components/usage/UsageCoverageBanner.svelte`
- Create: `frontend/src/lib/components/usage/UsageTierBreakdown.svelte`

**Dependencies**

- Task 4

**Implementation Steps**

1. Add summary cards for cache hit rate and estimated cache savings.
2. Add a compact tier breakdown panel. Prefer a table/list consistent with current Usage panels; avoid a large visual redesign.
3. Add provider/tier badges to model rows.
4. Add primary model/tier and model-count display to top sessions.
5. Show unknown/deprecated model indicators without alarmist language.
6. Update the coverage banner to mention unknown pricing/model rows when present.
7. Keep mobile layout stable; ensure long model names truncate cleanly.

**Verification**

- Run: `pnpm build`
- Expect: frontend compiles.
- Manual:
  - Run `pnpm dev` and `pnpm frontend:dev`.
  - Open `/app`.
  - Navigate to Usage.
  - Confirm summary cards, model rows, tier panel, and top sessions render without layout overlap at desktop and narrow widths.
- Optional if Playwright is available and stable:
  - Run: `pnpm exec playwright test`
  - Expect: existing browser tests pass.

**Done When**

- Users can see cost by tier, cache effectiveness, and unknown-model coverage from the Usage tab.
- Existing project/agent usage filtering still works.
- Usage remains readable without turning into a dense observability wall.

### Task 6: Add Optional Filters And Prior-Period Comparison

**Objective**

Add higher-leverage exploration controls after the base classification and tier data are stable.

**Files**

- Modify: `src/api/v2/types.ts`
- Modify: `src/db/v2-queries.ts`
- Modify: `src/api/v2/router.ts`
- Modify: `frontend/src/lib/api/client.ts`
- Modify: `frontend/src/lib/stores/usage.svelte.ts`
- Modify: `frontend/src/lib/usage-state.ts`
- Modify: usage components under `frontend/src/lib/components/usage/`
- Test: `tests/v2-api.test.ts`

**Dependencies**

- Task 5

**Implementation Steps**

1. Add optional `model`, `provider`, and `tier` query params.
2. Apply these filters consistently to summary, daily, project, model, agent, tier, and top-session usage queries.
3. Add exclude filters only if the include filters prove insufficient during manual use.
4. Add a prior-period comparison field to `UsageSummary`:
   - previous period uses the same duration immediately before `date_from`
   - include `prior_total_cost_usd` and `cost_delta_pct`
5. Add UI controls for provider/tier/model only if they are not too noisy for current datasets.
6. Use the same usage-row scan/fold path introduced in Task 3 so filters apply consistently across summary, daily, project, model, agent, tier, and top-session views.
7. Preserve hash state for any new filters.

**Verification**

- Run: `node --import tsx --test tests/v2-usage.test.ts`
- Expect: all usage endpoints respect model/provider/tier filters and prior-period math.
- Run: `node --import tsx --test tests/usage-state.test.ts`
- Expect: usage hash state and CSV export include the new filters and comparison fields.
- Run: `pnpm build`
- Expect: frontend compiles with extended filters.
- Manual:
  - Filter Usage by provider and tier.
  - Confirm all panels update consistently.

**Done When**

- Filtering by model/provider/tier is consistent across every usage panel.
- Prior-period comparison is deterministic and absent/zero when no valid prior window exists.

### Task 7: Design Read-Only Budget Alert Contracts

**Objective**

Prepare budget alerting as a read-only report surface without adding blocking hooks or enforcement behavior.

**Files**

- Create: `src/usage/budgets.ts`
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/v2/router.ts`
- Modify: `src/db/v2-queries.ts`
- Create: `docs/system/usage-budgets.md`
- Test: `tests/v2-api.test.ts`

**Dependencies**

- Task 6

**Implementation Steps**

1. Define a small budget config shape inspired by `claude-agent-cost/config/budgets.yml`:
   - `name`
   - `period`
   - `limit_usd`
   - alert thresholds
   - optional filters for provider, model, tier, project, agent
2. Keep config loading local and optional. If no config is present, return an empty budget list.
3. Add a read-only `GET /api/v2/usage/budgets` endpoint.
4. Reuse usage summary/filter logic to compute current spend for each budget.
5. Return alert state as `ok`, `info`, `warning`, `critical`, or `hard_stop_candidate`, but do not block anything.
6. Document that hook enforcement is a future opt-in and is not implemented here.

**Verification**

- Run: `pnpm test -- tests/v2-api.test.ts`
- Expect: no-config, under-budget, over-budget, and malformed-config cases are covered.
- Run: `pnpm build`
- Expect: budget types and endpoint compile.

**Done When**

- AgentMonitor can report budget state without enforcing it.
- Budget semantics are documented and clearly opt-in.

### Task 8: Design Human-Reviewed Tier Feedback Report

**Objective**

Add a deterministic report that identifies likely over-tiered or under-tiered usage patterns while keeping all recommendations human-reviewed.

**Files**

- Create: `src/usage/tier-feedback.ts`
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/v2/router.ts`
- Create: `docs/system/tier-feedback.md`
- Test: `tests/v2-api.test.ts`

**Dependencies**

- Task 6

**Implementation Steps**

1. Define a fixed JSON output contract with:
   - `generated_at`
   - `window`
   - `tier_mismatches`
   - `cost_outliers`
   - `confidence`
   - `evidence`
2. Start with conservative heuristics only:
   - repeated high-cost sessions on economy/haiku-like tiers
   - repeated low-tool, low-duration sessions on premium/opus-like tiers
   - unknown models that dominate spend
3. Use existing usage/session metrics only; do not inspect private message content.
4. Add `GET /api/v2/usage/tier-feedback`.
5. Document that recommendations are advisory and should not auto-apply.
6. Keep this endpoint out of the main UI until backend confidence is proven on real local data.

**Verification**

- Run: `pnpm test -- tests/v2-api.test.ts`
- Expect: deterministic recommendations from fixture data and empty recommendations for insufficient evidence.
- Run: `pnpm build`
- Expect: endpoint and types compile.

**Done When**

- A new agent can generate tier feedback from usage data.
- Output is stable, evidence-bearing, and explicitly human-reviewed.

## Risks And Mitigations

- Risk: Model tier labels create false precision across providers.
  Mitigation: keep tiers simple, expose `known` and `pricing_status`, and mark unknowns explicitly.
- Risk: Cache savings can be misleading when historical pricing changes.
  Mitigation: label savings as estimated from current pricing metadata and do not mutate stored `cost_usd`.
- Risk: Usage endpoints drift because each query defines usage-bearing events differently.
  Mitigation: keep `usageMetricsCondition()` as the single eligibility rule, use the scan/fold helper for classification-heavy metrics, and test summary/model/tier/top-session consistency against the same fixtures.
- Risk: Scan-and-fold logic becomes slower than SQL-only aggregation on very large local databases.
  Mitigation: keep row selection constrained by indexed date/project/agent predicates, preserve simple SQL aggregation where appropriate, and add performance-oriented refactoring only if local datasets prove it necessary.
- Risk: Cache savings are read as exact historical accounting.
  Mitigation: document that savings use current pricing metadata and are estimates; keep stored `cost_usd` as authoritative spend.
- Risk: UI becomes too dense.
  Mitigation: add compact cards, badges, and one tier panel before adding filters or advisory reports.
- Risk: Budget alerts imply enforcement.
  Mitigation: make budgets read-only in this plan and reserve blocking hooks for a future opt-in plan.
- Risk: External references rely on different architectures.
  Mitigation: borrow concepts from AgentsView and `claude-agent-cost`, not their storage/query stacks.
- Risk: Rust backend parity falls behind if TypeScript v2 contracts change.
  Mitigation: document TypeScript as canonical for this plan and schedule Rust parity after contract stabilization.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Model classification handles known, alias, deprecated, and unknown models | `pnpm test -- tests/pricing.test.ts` | Pricing and classification tests pass |
| Usage API types compile after additive contract changes | `pnpm build` | TypeScript and Svelte build completes |
| Per-row cache savings handles mixed model pricing | `pnpm test -- tests/v2-api.test.ts` | Cache-savings fixture proves row-level pricing is used |
| Tier endpoint and summary/session enrichments are deterministic | `pnpm test -- tests/v2-api.test.ts` | Usage model, tier, summary, and top-session tests pass |
| V2 route error envelopes remain stable | `pnpm test -- tests/v2-router-errors.test.ts` | Existing usage route errors and new tier route error pass |
| Full repository regression check | `pnpm lint && pnpm build && pnpm test` | Pre-push gates pass |
| UI renders enriched usage data | Manual `/app` Usage check after `pnpm dev` and `pnpm frontend:dev` | Summary cards, tier panel, model badges, coverage banner, and top sessions render without overlap |
| Optional browser regression | `pnpm exec playwright test` | Existing Playwright flows pass when available |
| Rust unaffected unless touched | `pnpm rust:test` | Required only if Rust files or shared contract parity files are changed |

## Handoff

Recommended execution order for a fresh agent:

1. Start with Task 1 and Task 3 test fixtures before touching UI.
2. Add the pricing-registry resolver before classification so alias handling has one owner.
3. In Task 3, implement the usage-row scan/fold helper before adding route handlers; this is the main refinement from the AgentsView exploration.
4. Keep the first implementation PR limited to Tasks 1 through 5.
5. Treat Tasks 6 through 8 as follow-up PRs after real local usage data validates the base attribution.
6. Do not add budget enforcement, automatic tier changes, persisted pricing refresh, or AgentsView-style message-log usage scans without a separate design review.
7. Update this plan's status and task notes as each implementation slice lands.

Plan complete and saved to `docs/plans/2026-05-13-agent-usage-intelligence-implementation.md`.
