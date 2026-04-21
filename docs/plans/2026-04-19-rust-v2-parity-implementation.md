---
date: 2026-04-19
topic: rust-v2-parity
stage: implementation-plan
status: completed
source: conversation
---

# Rust V2 Parity Implementation Plan

## Current Status

Implemented on `feat/rust-v2-parity`.

The Rust runtime now covers the current historical `/api/v2` surface used by the Svelte app:

- schema/config parity for `pinned_messages`, `insights`, sync exclude patterns, and multi-provider insights settings
- Codex OTEL parity for meaningful prompt/response/completion/error events, with the same websocket-noise filtering intent as TypeScript
- session-review parity for activity buckets, pins, and search sorting/context
- analytics parity for coverage-aware summary, activity, projects, tools, hour-of-week, top-sessions, velocity, and agent breakdowns
- usage parity for event-derived summary, daily, project/model/agent attribution, and top-session views
- insights parity for persisted CRUD plus OpenAI, Anthropic, and Gemini-backed generation

Implemented commits on this branch:

- `77d5eb4` `Add Rust schema and config parity primitives`
- `ea1c153` `Align Rust Codex OTEL parsing with TS`
- `c474bab` `Add Rust session review parity routes`
- `82ffad9` `Expand Rust analytics v2 contract parity`
- `71ecaf9` `Add Rust usage v2 API parity`
- `63742fc` `Add Rust insights provider parity`

Shared parity coverage now exercises the expanded historical contract through the black-box `tests/parity/v2` suite, including activity, pins, advanced analytics, usage, and insights generation metadata. Provider-backed insight generation itself remains covered by Rust integration tests rather than the shared parity harness, because the black-box harness does not provision provider keys or install test stubs.

The remaining work after this plan is PR/review/merge and any later rollout decision about making Rust the default runtime. This branch does not require further implementation to satisfy the plan goals.

## Goal

Bring the Rust runtime up to parity with the current TypeScript `/api/v2` contract and Codex ingest behavior so the Rust backend can become a credible replacement for the canonical TS runtime without regressing product capabilities.

## Current Drift Snapshot

The Rust runtime is materially behind the TypeScript runtime in the following areas:

- missing `/api/v2` endpoint families: session activity, pins, advanced analytics, usage, and insights
- older response shapes on existing endpoints: search has no `sort=relevance`, analytics still reflects the pre-PR1 contract, and coverage metadata is absent
- schema drift: Rust schema lacks `pinned_messages` and `insights`
- config drift: Rust config lacks `sync` exclude patterns and multi-provider insights settings
- ingest drift: Rust OTEL parsing still skips `codex.sse_event`, `codex.response`, and `codex.websocket.event`, while TS now keeps the meaningful Codex signals and only filters the known empty websocket markers

This plan assumes the parity target is the current TypeScript runtime on `main`, plus the pending Task 8 behavior from PR #12 once that branch merges.

## Scope

### In Scope

- Rust schema and config parity required for current TS `/api/v2` features
- Rust Codex OTEL parser parity for meaningful prompt/response/completion/error handling
- Rust `/api/v2` parity for sessions, search, pins, analytics, usage, and insights
- shared parity and regression tests proving Rust behavior matches the TS contract closely enough for the Svelte app
- Rust-facing docs updates needed to keep the runtime contract understandable

### Out Of Scope

- frontend changes or `/app` redesign work
- making Rust the default runtime in this pass
- rewriting the legacy `/api/*` and `/` surfaces beyond what existing parity tests require
- broad new parser support outside current Claude and Codex coverage
- local database cleanup or migration of existing user data beyond the schema needed for parity

## Assumptions And Constraints

- The TypeScript runtime remains the canonical source of truth for API shape and behavior while parity work is in progress.
- The Rust work should be split into multiple reviewable PRs rather than one monolithic parity branch.
- Contract parity matters more than implementation identity. Rust does not need to mirror the TypeScript file layout as long as the runtime behavior and response shapes align.
- Existing Rust tests and shared parity scripts should be extended rather than replaced.
- The pending Task 8 PR adds relevant parity targets for sync exclude patterns and Codex websocket filtering, so this branch should be rebased or refreshed once that PR merges.
- High-risk areas are Codex OTEL parsing, analytics/usage response shape drift, and provider-backed insights generation.

## Task Breakdown

### Task 1: Add Missing Rust Schema And Config Primitives

**Objective**

Add the schema tables and environment-driven config surfaces that newer TS features already depend on, so later Rust API work has the right storage and runtime settings.

**Files**

- Modify: `rust-backend/src/db/schema.rs`
- Modify: `rust-backend/src/config.rs`
- Test: `rust-backend/tests/schema_compatibility.rs`
- Test: `rust-backend/tests/runtime_invariants.rs`
- Create or modify: `rust-backend/tests/config_compatibility.rs`

**Dependencies**

None

**Implementation Steps**

1. Add `pinned_messages` and `insights` to the Rust schema, matching the current TS schema closely enough for shared UI behavior.
2. Add Rust config parsing for `AGENTMONITOR_SYNC_EXCLUDE_PATTERNS`.
3. Add Rust config parsing for multi-provider insights settings:
   `AGENTMONITOR_INSIGHTS_PROVIDER`,
   `AGENTMONITOR_OPENAI_API_KEY`,
   `AGENTMONITOR_ANTHROPIC_API_KEY`,
   `AGENTMONITOR_GEMINI_API_KEY`,
   and the provider/model/base-url overrides that TS already supports.
4. Add schema/config tests so parity drift is caught before runtime work starts.

**Verification**

- Run: `pnpm rust:test -- schema_compatibility runtime_invariants config_compatibility`
- Expect: schema and config tests pass with the new tables and env parsing present.

**Done When**

- Rust schema contains the primitives required for pins and insights.
- Rust config can represent the sync and insights settings that the TS runtime already supports.

### Task 2: Bring Codex OTEL Parsing Up To Current TS Behavior

**Objective**

Stop dropping meaningful Codex OTEL events in Rust and align the parser with the current TS behavior for prompt, response, completion, error, and websocket-noise handling.

**Files**

- Modify: `rust-backend/src/otel/parser.rs`
- Test: `rust-backend/tests/otel_api.rs`
- Test: `rust-backend/tests/v2_live_api.rs`

**Dependencies**

- Task 1

**Implementation Steps**

1. Port the TS Codex event-type resolution logic for `codex.response`, `codex.event_msg`, `codex.sse_event`, `codex.websocket_event`, and `codex.websocket.event`.
2. Preserve useful Codex payload typing and metadata so Rust can produce the same response/tool/error/live-summary behavior as TS.
3. Filter only the known empty websocket lifecycle markers, matching the narrowed TS Task 8 behavior instead of skipping all Codex response-adjacent events.
4. Extend OTEL tests to cover both keep-cases and drop-cases.

**Verification**

- Run: `pnpm rust:test -- otel_api v2_live_api`
- Expect: Rust OTEL ingest keeps meaningful Codex events, drops the known websocket noise, and still produces expected live-summary rows.

**Done When**

- Rust no longer skips `codex.sse_event`, `codex.response`, and websocket response events wholesale.
- Rust behavior for Codex OTEL ingest matches current TS intent closely enough to share the same live UX assumptions.

### Task 3: Add Session Activity, Pins, And Search Sorting Parity

**Objective**

Bring the session-review workflows needed by the current Svelte app to the Rust runtime: session activity, pinned messages, and sorted search results.

**Files**

- Modify: `rust-backend/src/api/v2/mod.rs`
- Modify: `rust-backend/src/api/v2/history.rs`
- Modify: `rust-backend/src/db/v2_queries.rs`
- Test: `rust-backend/tests/v2_history_api.rs`
- Test: `rust-backend/tests/v2_queries.rs`
- Modify: `scripts/test/run-v2-contract-rust.sh`

**Dependencies**

- Task 1

**Implementation Steps**

1. Add `/api/v2/sessions/:id/activity` with the response shape required by the minimap/session viewer flow.
2. Add `/api/v2/pins`, `/api/v2/sessions/:id/pins`, and the session message pin/unpin endpoints using ordinal-stable persistence.
3. Extend Rust search to accept `sort=relevance|recent` and return the same contextual fields the TS frontend expects.
4. Add route and query tests that compare Rust outputs to the TS contract assumptions.

**Verification**

- Run: `pnpm rust:test -- v2_history_api v2_queries`
- Expect: pins, session activity, and sorted search routes pass with stable response shapes.
- Run: `pnpm test:parity:rust`
- Expect: shared parity coverage for the touched `/api/v2` routes remains green or the deltas are explicitly accounted for.

**Done When**

- Rust can support the current session-review and search-navigation flows without frontend branching.
- Pin persistence semantics match the TS runtime closely enough for the Pinned page and session viewer.

### Task 4: Expand Rust Analytics To The Current V2 Contract

**Objective**

Close the analytics contract gap so Rust serves the same expanded, coverage-aware analytics endpoints that TS introduced in PR 1.

**Files**

- Modify: `rust-backend/src/api/v2/mod.rs`
- Modify: `rust-backend/src/api/v2/history.rs`
- Modify: `rust-backend/src/db/v2_queries.rs`
- Test: `rust-backend/tests/v2_history_api.rs`
- Test: `rust-backend/tests/v2_queries.rs`

**Dependencies**

- Task 1

**Implementation Steps**

1. Add Rust query support for hour-of-week, top-sessions, velocity, and per-agent analytics.
2. Introduce capability-aware coverage metadata on analytics responses to match the TS contract shape.
3. Preserve the current fidelity-aware semantics rather than flattening all sessions into one misleading bucket.
4. Expand Rust tests to cover the new analytics routes and response envelopes.

**Verification**

- Run: `pnpm rust:test -- v2_history_api v2_queries`
- Expect: advanced analytics endpoints and coverage metadata pass route/query tests.
- Run: `pnpm test:parity:rust`
- Expect: Rust analytics routes no longer lag the TS app contract.

**Done When**

- Rust serves the same analytics families the TS frontend now depends on.
- Analytics responses include explicit coverage semantics instead of older minimal payloads.

### Task 5: Add Usage API Parity

**Objective**

Implement the event-derived usage backend in Rust so the Usage tab can run unchanged against the Rust runtime.

**Files**

- Modify: `rust-backend/src/api/v2/mod.rs`
- Modify: `rust-backend/src/api/v2/history.rs`
- Modify: `rust-backend/src/db/v2_queries.rs`
- Test: `rust-backend/tests/v2_history_api.rs`
- Test: `rust-backend/tests/v2_queries.rs`

**Dependencies**

- Task 1
- Task 4

**Implementation Steps**

1. Port the event-derived usage queries for summary, daily, projects, models, agents, and top-sessions.
2. Add usage coverage metadata that matches the TS response shape, including source-aware breakdowns where applicable.
3. Ensure Rust preserves the TS inclusion rules for usage-bearing events so the Usage tab does not silently diverge.
4. Add API/query tests and parity coverage for the usage endpoints.

**Verification**

- Run: `pnpm rust:test -- v2_history_api v2_queries`
- Expect: usage routes and coverage metadata pass in Rust.
- Run: `pnpm test:parity:rust`
- Expect: usage endpoints remain contract-compatible for the Svelte app.

**Done When**

- Rust can back the Usage tab without frontend-specific fallbacks.
- Usage coverage and aggregation rules match the TS runtime closely enough for reviewer confidence.

### Task 6: Add Insights API And Provider Parity

**Objective**

Port the persisted, multi-provider insights layer to Rust with the same API shape and configuration semantics used by the TS runtime.

**Files**

- Create or modify: `rust-backend/src/api/v2/insights.rs`
- Modify: `rust-backend/src/api/v2/mod.rs`
- Create or modify: `rust-backend/src/insights/mod.rs`
- Create or modify: `rust-backend/src/insights/service.rs`
- Modify: `rust-backend/src/db/v2_queries.rs`
- Test: `rust-backend/tests/v2_insights_api.rs`
- Test: `rust-backend/tests/v2_queries.rs`

**Dependencies**

- Task 1
- Task 4
- Task 5

**Implementation Steps**

1. Add Rust endpoints for listing, fetching, generating, and deleting insights.
2. Reuse the new insights config surface to support OpenAI, Anthropic, and Gemini provider selection.
3. Port the dataset-building behavior so insights use the same analytics/usage inputs and filter normalization that TS uses.
4. Stub provider calls in tests and add failure-path coverage for missing API keys and invalid input.

**Verification**

- Run: `pnpm rust:test -- v2_insights_api v2_queries`
- Expect: insights CRUD and generation config behavior pass in Rust.
- Run: `pnpm test:parity:rust`
- Expect: the Rust runtime exposes the same insights contract the TS frontend now assumes.

**Done When**

- Rust supports the full Insights tab API contract.
- Provider/config behavior is explicit and test-covered.

### Task 7: Strengthen Shared Parity Tests And Runtime Docs

**Objective**

Make the parity work durable by encoding the current TS contract into Rust-facing tests and documentation.

**Files**

- Modify: `scripts/test/run-v2-contract-rust.sh`
- Modify: `rust-backend/AGENTS.md`
- Modify: `docs/system/FEATURES.md`
- Modify: `docs/system/ARCHITECTURE.md`
- Test: `rust-backend/tests/v2_boot_api.rs`
- Test: `rust-backend/tests/v2_history_api.rs`
- Test: `rust-backend/tests/v2_live_api.rs`

**Dependencies**

- Tasks 2 through 6

**Implementation Steps**

1. Expand parity coverage to include the newly ported routes and response-shape invariants.
2. Update Rust backend guidance to reflect the new parity target and any remaining intentional deltas.
3. Update system docs so the repo no longer implies Rust is closer to TS parity than it really is.
4. Capture any remaining known gaps explicitly so future drift is visible instead of implied.

**Verification**

- Run: `pnpm rust:test`
- Expect: Rust suite stays green with the expanded contract coverage.
- Run: `pnpm test:parity:rust`
- Expect: parity checks cover the newly added route families.
- Run: `pnpm build`
- Expect: the TypeScript side still builds cleanly after any shared-doc updates.

**Done When**

- Rust parity work is guarded by tests rather than memory.
- Docs clearly describe the real Rust-vs-TS parity state.

## Risks And Mitigations

- Risk: Rust ships endpoint names that exist but return older TS shapes.
  Mitigation: validate response envelopes against current TS expectations, not just route existence.

- Risk: Codex OTEL parity work reintroduces the websocket noise that TS just filtered.
  Mitigation: port the selective filtering rules and add keep/drop tests for real Codex cases.

- Risk: insights provider integration turns into a large bespoke subsystem.
  Mitigation: keep the Rust interface contract-compatible and stub provider calls in tests; do not over-generalize provider abstractions early.

- Risk: parity work gets blocked behind the pending Task 8 merge.
  Mitigation: keep this branch planning-only until PR #12 lands, then rebase before implementation.

- Risk: the Rust runtime appears “parity complete” while analytics/usage fidelity still differs.
  Mitigation: keep capability and coverage semantics explicit in both code and docs.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Rust schema and config can represent current TS features | `pnpm rust:test -- schema_compatibility runtime_invariants config_compatibility` | New tables and env parsing are present and validated |
| Codex OTEL behavior matches the current TS intent | `pnpm rust:test -- otel_api v2_live_api` | Meaningful Codex prompt/response/completion/error signals survive and websocket noise is filtered |
| Session review and search workflows work on Rust | `pnpm rust:test -- v2_history_api v2_queries` | Pins, session activity, and search sorting routes return expected shapes |
| Advanced analytics parity is implemented | `pnpm rust:test -- v2_history_api v2_queries` | Hour-of-week, top-sessions, velocity, agents, and coverage metadata pass |
| Usage parity is implemented | `pnpm rust:test -- v2_history_api v2_queries` | Usage endpoints and coverage metadata pass |
| Insights parity is implemented | `pnpm rust:test -- v2_insights_api v2_queries` | Insights CRUD and provider-config behavior pass |
| Shared contract parity remains trustworthy | `pnpm test:parity:rust` | Rust contract checks cover the expanded `/api/v2` surface |
| TS side remains stable while docs/shared expectations evolve | `pnpm build` | Main repo still builds cleanly |

## Completion

The implementation work described above is complete on `feat/rust-v2-parity`.

Recommended next steps:

1. Open and review the Rust parity PR against `main`.
2. Validate the branch against any additional manual runtime smoke checks you want before merge.
3. Decide separately whether Rust should remain an alternate runtime or move into a broader rollout plan.
