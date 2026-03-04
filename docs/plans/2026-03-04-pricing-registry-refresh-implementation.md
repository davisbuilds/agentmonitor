---
date: 2026-03-04
topic: pricing-registry-refresh
stage: implementation-plan
status: draft
source: conversation
---

# Pricing Registry Refresh Implementation Plan

## Goal

Update AgentMonitor pricing data to current official provider rates and model IDs (Anthropic, OpenAI/Codex, Gemini), while preserving TypeScript/Rust parity and accurate historical cost rollups.

## Scope

### In Scope

- Refresh model pricing JSON data in `src/pricing/data/*.json`.
- Add newly available model IDs and aliases used in real events.
- Update changed rates and lifecycle flags (`deprecated`) for existing models.
- Keep TypeScript and Rust pricing behavior aligned (shared JSON inputs).
- Add/adjust tests for lookup, alias resolution, and cost math.
- Validate optional post-update backfill workflow via `scripts/recalculate-costs.ts`.

### Out of Scope

- Changing event schema or cost math formulas beyond current per-token fields.
- UI redesign for cost dashboard visualization.
- Introducing automated web scraping of provider pricing pages.
- Rewriting pricing ingestion to a remote service.

## Assumptions And Constraints

- `src/pricing/data/*.json` is the single source of truth for both runtimes.
- Rust backend pricing relies on compile-time `include_str!` of those same JSON files.
- Model pricing must be sourced from official provider docs/pages only.
- Existing schema requires all four costs per model: input, output, cache read, cache write (per MTok).
- Some providers publish multiple price modes (standard, cached input, batch, flex/priority). This pass records the standard online/API values used by current event-cost calculation.
- Historical events may retain stale `cost_usd` until a backfill is run.

## Source URLs

- Anthropic pricing: `https://platform.claude.com/docs/en/about-claude/pricing`
- Anthropic models overview: `https://platform.claude.com/docs/en/about-claude/models/overview`
- Anthropic model lifecycle/deprecations: `https://platform.claude.com/docs/en/about-claude/model-deprecations`
- OpenAI API pricing: `https://platform.openai.com/docs/pricing/`
- OpenAI GPT-5 model docs: `https://platform.openai.com/docs/models/gpt-5/`
- OpenAI GPT-5 mini model docs: `https://platform.openai.com/docs/models/gpt-5-mini/`
- OpenAI GPT-5 nano model docs: `https://platform.openai.com/docs/models/gpt-5-nano/`
- OpenAI GPT-5.2 Pro model docs: `https://platform.openai.com/docs/models/gpt-5.2-pro/`
- Gemini API pricing: `https://ai.google.dev/gemini-api/docs/pricing`
- Gemini 3 model docs: `https://ai.google.dev/gemini-api/docs/gemini-3`

## Task Breakdown

### Task 1: Build Provider Pricing Evidence Packet

**Objective**

Collect a dated, provider-by-provider mapping of current model IDs, aliases, and rates that can be copied into `agentmonitor` JSON schema without guesswork.

**Files**

- Modify: `src/pricing/data/claude.json`
- Modify: `src/pricing/data/codex.json`
- Modify: `src/pricing/data/gemini.json`
- Reference only: `docs/system/ARCHITECTURE.md`

**Dependencies**

None

**Implementation Steps**

1. Pull official Anthropic pricing + model lifecycle pages and list current Claude model IDs, input/output rates, cache read/write rates, and deprecations.
2. Pull official OpenAI pricing pages for GPT-5/Codex families and map to `codex.json` model IDs with explicit alias strategy (dated IDs and `*-latest` where applicable).
3. Pull official Google Gemini pricing/model pages and map Gemini 3/3.1 IDs and rates.
4. Normalize all values to per-MTok numeric fields required by current schema.
5. Record `lastUpdated` date as the research date for each provider file.

**Verification**

- Run: `python3 -m json.tool src/pricing/data/claude.json >/dev/null && python3 -m json.tool src/pricing/data/codex.json >/dev/null && python3 -m json.tool src/pricing/data/gemini.json >/dev/null`
- Expect: no parse errors after edits.

**Done When**

- Every touched model has all required numeric fields.
- No model/rate entries rely on inferred or undocumented provider values.
- `lastUpdated` fields reflect the actual refresh date.

### Task 2: Apply Pricing Data Refresh In JSON Registries

**Objective**

Land the actual model/rate updates in the three pricing data files while preserving backward-compatible alias lookup for observed model names.

**Files**

- Modify: `src/pricing/data/claude.json`
- Modify: `src/pricing/data/codex.json`
- Modify: `src/pricing/data/gemini.json`

**Dependencies**

- Task 1

**Implementation Steps**

1. Update changed rates for existing canonical models (for example, Anthropic Opus/Haiku changes).
2. Add missing active models (for example, Claude Sonnet 4.6 / Opus 4.1, Gemini 3/3.1, GPT-5 family).
3. Add aliases for provider-prefixed and dated IDs frequently seen in ingested telemetry.
4. Mark retired/deprecated models consistently using `deprecated: true`.
5. Keep JSON ordering stable and human-scannable by provider family.

**Verification**

- Run: `pnpm test -- tests/pricing.test.ts`
- Expect: lookup/cost unit tests pass with updated data.
- Run: `pnpm rust:test`
- Expect: Rust pricing tests pass with shared JSON updates.

**Done When**

- Both TS and Rust tests pass without lookup regressions.
- Unknown-model behavior remains `null`/`None`.
- Alias coverage includes new canonical and common variant IDs.

### Task 3: Strengthen Regression Tests For New/Changed Models

**Objective**

Prevent future pricing drift by adding explicit assertions for newly added model IDs and changed cost math in both runtime test suites.

**Files**

- Modify: `tests/pricing.test.ts`
- Modify: `rust-backend/src/pricing.rs`

**Dependencies**

- Task 2

**Implementation Steps**

1. Add TS tests for canonical + alias lookup for one new model from each provider.
2. Add TS cost math tests that include cache read/write contributions for at least one updated model.
3. Add Rust unit assertions mirroring the same model-cost expectations.
4. Add one negative-path test ensuring unknown IDs still return null/none after expansion.
5. Keep expected values exact or tolerance-bounded to avoid floating-point flakes.

**Verification**

- Run: `pnpm test -- tests/pricing.test.ts`
- Expect: all pricing tests pass, including new cases.
- Run: `pnpm rust:test -- --nocapture`
- Expect: Rust pricing tests pass and no parsing warnings for updated JSON.

**Done When**

- At least one new model per provider is test-covered.
- Cache pricing path is directly asserted.
- TS/Rust expected totals are consistent for mirrored test cases.

### Task 4: Validate Runtime Integration And Historical Backfill Path

**Objective**

Confirm updated pricing data flows through ingestion, stats endpoints, and optional historical recomputation without breaking production workflows.

**Files**

- Reference: `src/db/queries.ts`
- Reference: `src/api/stats.ts`
- Reference: `scripts/recalculate-costs.ts`
- Reference: `public/js/components/cost-dashboard.js`

**Dependencies**

- Task 2
- Task 3

**Implementation Steps**

1. Run server-level tests to verify ingest auto-calculates costs with updated models.
2. Start local server and query `/api/stats/cost` to confirm model breakdowns remain non-empty and sorted.
3. Dry-run `pnpm recalculate-costs -- --dry-run` against a representative DB snapshot.
4. Verify unknown model rows are counted as skipped and not overwritten.
5. Document operator runbook note for when to run non-dry backfill.

**Verification**

- Run: `pnpm test`
- Expect: full test suite passes.
- Run: `pnpm recalculate-costs -- --dry-run`
- Expect: summary prints updated/unchanged/unknown counts without DB writes.
- Run: `curl -sf http://127.0.0.1:3141/api/stats/cost?limit=5`
- Expect: valid JSON with `timeline`, `by_project`, and `by_model` keys.

**Done When**

- Ingest + stats continue to function with refreshed pricing data.
- Backfill script behavior is predictable and documented.
- No API contract changes are required for the refresh.

### Task 5: Documentation And Release Hygiene

**Objective**

Capture pricing refresh mechanics and cadence so future updates are low-friction and auditable.

**Files**

- Modify: `docs/system/OPERATIONS.md`
- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `README.md`

**Dependencies**

- Task 4

**Implementation Steps**

1. Add a short “pricing refresh playbook” section with source-of-truth links and update steps.
2. Document expected post-update commands (tests + optional cost backfill).
3. Clarify that both TS and Rust consume the same JSON files.
4. Add note about handling cached-token fields when provider pages change format.
5. Include date-stamped examples for the last successful refresh.

**Verification**

- Run: `rg -n "pricing refresh|recalculate-costs|shared JSON" README.md docs/system/OPERATIONS.md docs/system/ARCHITECTURE.md`
- Expect: all key operational notes are present.

**Done When**

- Operators can execute refresh end-to-end without reverse-engineering code.
- Documentation reflects current provider/model scope.
- Future refreshes have explicit verification checkpoints.

## Risks And Mitigations

- Risk: Provider pages expose multiple pricing modes and we capture the wrong one.
  Mitigation: Record exact source URLs and lock this pass to standard online/API rates only.
- Risk: Alias omissions cause costs to remain null for real-world event model strings.
  Mitigation: Add alias coverage from observed telemetry samples plus unit tests per provider.
- Risk: TS and Rust behavior diverges after JSON updates.
  Mitigation: Run both test suites and include mirrored assertions for at least one model per provider.
- Risk: Historical dashboards show stale totals after pricing refresh.
  Mitigation: Run `pnpm recalculate-costs -- --dry-run` then non-dry execution as an explicit release step.
- Risk: Cache read/write fields drift from provider definitions.
  Mitigation: Treat cache fields as first-class values in evidence packet and test a cache-inclusive scenario.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Pricing JSON remains valid after edits | `python3 -m json.tool src/pricing/data/claude.json >/dev/null && python3 -m json.tool src/pricing/data/codex.json >/dev/null && python3 -m json.tool src/pricing/data/gemini.json >/dev/null` | Command exits `0` with no parse errors |
| TS pricing registry resolves and calculates updated models | `pnpm test -- tests/pricing.test.ts` | Pricing tests pass with new model assertions |
| Rust pricing parity remains intact | `pnpm rust:test` | Rust tests pass; pricing module tests succeed |
| End-to-end ingest/stats is unaffected | `pnpm test` | Full suite passes including ingest integration |
| Backfill workflow is safe before mutation | `pnpm recalculate-costs -- --dry-run` | Summary prints counts, no write-side effects |
| Cost API shape remains stable | `curl -sf http://127.0.0.1:3141/api/stats/cost?limit=5` | JSON includes `timeline`, `by_project`, `by_model` |

## Handoff

Plan complete and saved to docs/plans/2026-03-04-pricing-registry-refresh-implementation.md.

1. Execute in this session, task by task.
2. Open a separate execution session.
3. Refine this plan before implementation.
