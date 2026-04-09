---
date: 2026-04-08
topic: repo-convergence
stage: implementation-plan
status: draft
source: conversation
---

# Repo Convergence Implementation Plan

## Goal

Converge AgentMonitor around one canonical product path: the Svelte app plus v2 API contract, backed by a shared cross-agent projection model, with Rust/Tauri moving onto the same surface and only durable v1 localhost behavior carried forward.

## Scope

### In Scope

- Declare the Svelte `/app` plus v2 API as the canonical UI and data contract.
- Introduce a single projection model for Claude and Codex so search, analytics, sessions, and live views stop drifting by source.
- Carry forward useful operator behavior from the current localhost stack without preserving the legacy UI architecture itself.
- Move Rust and Tauri toward serving the same UI and API surface rather than the current legacy dashboard path.
- Harden discovery, pagination, SSE, and parity coverage so convergence work has a reliable safety net.

### Out of Scope

- A visual redesign of the Svelte app.
- Full Codex rich-export parity in the same pass if the source data does not exist yet.
- Remote auth, cloud sync, or multi-user deployment work.
- Immediate deletion of the legacy `/` dashboard before parity gates are met.
- Replacing hook-based localhost ingestion with a different transport model.

## Assumptions And Constraints

- The Svelte app is the product surface making the most forward progress and should become the primary UX.
- The Rust backend and Tauri shell are strategic, but they are not yet the canonical product path because they still serve legacy assets and a smaller API surface.
- Current v2 data is source-skewed: Claude file-watcher paths populate historical/session-browser tables deeply, while Codex OTEL paths mostly populate summary/live tables.
- The right target is not "make Codex look identical by faking data." The right target is one projection contract with explicit capability/fidelity markers and source-appropriate population.
- Durable behavior from the localhost stack should be preserved when it improves operator reliability:
  - SSE client limits, heartbeat, and backpressure cleanup
  - resilient reconnect/status behavior
  - active-session-focused monitor semantics
  - usage monitor rollups
  - non-blocking analytics loading
  - sensible cost/time defaults
- Brittle coupling from the legacy dashboard should not be preserved just because it exists today.
- API and runtime changes must update `README.md`, and relevant system docs should stay aligned with the chosen canonical path.
- The repository is now pinned to Node `24.13.0`; all TypeScript verification in this plan assumes that runtime.

## Useful V1 Carry-Forward Inventory

The legacy localhost path is not the right long-term architecture, but several behaviors are worth preserving as first-class requirements during convergence.

### Keep

- `src/sse/emitter.ts`
  Keep the client limit, heartbeat, backpressure handling, and safe socket cleanup behavior. This is operationally valuable and should be mirrored by the dedicated v2 live stream and the Rust implementation.
- `src/api/stream.ts`
  Keep the "broadcast stats only when clients are connected" pattern and the clear separation between streaming and periodic aggregation.
- `public/js/sse-client.js`
  Keep the simple reconnect/status model. The UI should continue to expose connected, connecting, and disconnected states rather than silently failing.
- `public/js/components/usage-monitor.js`
  Keep the rolling per-agent usage monitor semantics, compact formatting, and top-line operator visibility.
- `public/js/components/agent-cards.js`
  Keep the active-plus-idle session focus, no-cap active-session refresh behavior, and server-backfill idea for newly observed sessions. The implementation can change, but those operator semantics are worth preserving.
- `public/js/app.js`
  Keep the separation between core data bootstrap and non-blocking analytics loads so a partial API failure does not blank the whole monitor.
- `public/js/components/cost-dashboard.js`
  Keep sensible cost window defaults, stable low-value currency formatting, and the idea that cost views should be useful before filters are manually tuned.
- `public/js/components/tool-analytics.js`
  Keep the compact per-tool frequency, error-rate, and duration summary. It is a strong operator view even if the UI is reimplemented in Svelte.

### Do Not Keep

- `public/js/app.js`
  Do not preserve the brittle bootstrap dependency where one failed core fetch can strand unrelated sections.
- Legacy UI-specific DOM orchestration in `public/js/components/*`
  Preserve the behavior, not the imperative rendering approach.
- Any product assumption that `/` and `/app` are equally current surfaces
  That ambiguity is one of the main sources of repo drift.

## Recommended Sequence

This work should be executed as a convergence program, not as unrelated cleanup.

1. Canonicalize the docs and runtime contract.
2. Introduce the shared v2 projection contract.
3. Carry forward durable v1 localhost behavior into the canonical path.
4. Move Rust and Tauri onto the same UI and API surface.
5. Harden discovery, pagination, and parity coverage.
6. Retire the legacy dashboard only after the cutover gates are met.

## Task Breakdown

### Task 1: Canonicalize The Product And Runtime Contract

**Objective**

Make the intended product path unambiguous before implementation continues: Svelte plus v2 is canonical, legacy `/` is maintenance-only until retirement, and Rust/Tauri are expected to converge onto that contract.

**Files**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `docs/system/FEATURES.md`
- Modify: `docs/project/ROADMAP.md`

**Dependencies**

None

**Implementation Steps**

1. Update top-level docs to state that the Svelte app and v2 APIs are the primary product surface.
2. Mark the legacy localhost dashboard at `/` as maintenance-only and define the retirement condition.
3. Document the current runtime split explicitly:
   - TypeScript serves `/` and `/app`
   - Rust/Tauri currently serve legacy assets
   - convergence requires Rust/Tauri to adopt the Svelte/v2 surface
4. Define the expected fidelity model for Claude and Codex so future work does not imply unsupported parity.
5. Add a short "legacy carry-forward inventory" note so useful v1 behavior is preserved intentionally rather than accidentally.

**Verification**

- Run: `rg -n "canonical|maintenance-only|legacy dashboard|Svelte" README.md AGENTS.md docs/system/ARCHITECTURE.md docs/system/FEATURES.md docs/project/ROADMAP.md`
- Expect: docs consistently describe Svelte/v2 as primary and legacy `/` as transitional.

**Done When**

- A zero-context engineer can tell which UI/API surface is canonical.
- The docs no longer imply that Rust/Tauri and TypeScript are equally current product paths.

### Task 2: Introduce A Shared Projection Contract For V2 Data

**Objective**

Replace source-specific v2 population with one projection contract that can represent both full-fidelity and summary-fidelity sessions without lying about capabilities.

**Files**

- Create: `src/live/projector.ts`
- Modify: `src/live/claude-adapter.ts`
- Modify: `src/live/codex-adapter.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/queries.ts`
- Modify: `src/db/v2-queries.ts`
- Modify: `src/api/v2/types.ts`
- Modify: `src/parser/claude-code.ts`
- Test: `tests/live-claude-adapter.test.ts`
- Test: `tests/codex-adapter.test.ts`
- Test: `tests/v2-api.test.ts`

**Dependencies**

- Task 1

**Implementation Steps**

1. Create one canonical projection layer that accepts normalized agent activity and writes the v2 tables.
2. Add explicit capability or fidelity fields to the v2 model so the UI can distinguish:
   - searchable historical sessions
   - tool-analytics-capable sessions
   - summary-only live sessions
3. Route Claude watcher data through the shared projector instead of directly populating historical tables as a special case.
4. Route Codex summary/live OTEL events through the same projector, preserving summary fidelity rather than pretending they are full transcript sessions.
5. Decide how search and analytics handle partial-fidelity sessions:
   - either populate comparable documents/tool rows from the canonical model
   - or expose explicit capability metadata and filter unsupported sessions out of those queries
6. Keep the projector additive and testable so Rust can later target the same semantics.

**Verification**

- Run: `pnpm test -- --test-name-pattern "Codex|Claude|v2"`
- Expect: projection-related tests pass for both Claude and Codex paths.
- Run: `pnpm build`
- Expect: type changes compile across server and frontend.

**Done When**

- Claude and Codex no longer populate unrelated subsets of the v2 model without explanation.
- The UI and API can reason about fidelity and capability from contract fields rather than source inference.

### Task 3: Carry Forward Durable V1 Localhost Behavior

**Objective**

Preserve the parts of the current localhost stack that improve operator experience and runtime resilience, while leaving behind the brittle legacy dashboard coupling.

**Files**

- Modify: `src/api/stream.ts`
- Modify: `src/api/v2/live-stream.ts`
- Modify: `src/sse/emitter.ts`
- Modify: `frontend/src/lib/stores/sse.ts`
- Modify: `frontend/src/lib/stores/live-sse.ts`
- Modify: `frontend/src/lib/stores/monitor.svelte.ts`
- Modify: `frontend/src/lib/components/monitor/MonitorPage.svelte`
- Modify: `frontend/src/lib/components/monitor/UsageMonitor.svelte`
- Modify: `frontend/src/lib/components/monitor/CostDashboard.svelte`
- Modify: `frontend/src/lib/components/monitor/ToolAnalytics.svelte`
- Reference: `public/js/app.js`
- Reference: `public/js/sse-client.js`
- Reference: `public/js/components/agent-cards.js`
- Reference: `public/js/components/usage-monitor.js`
- Reference: `public/js/components/cost-dashboard.js`
- Reference: `public/js/components/tool-analytics.js`
- Test: `tests/v2-live-stream.test.ts`
- Test: `tests/dashboard-api.test.ts`

**Dependencies**

- Task 1

**Implementation Steps**

1. Port v1 SSE durability behavior into the v2 live stream:
   - max clients
   - heartbeat
   - safe teardown
   - reconnect-friendly replay
2. Preserve the useful active-session semantics from the localhost monitor:
   - active plus idle focus
   - `limit=0` no-cap refresh for active lists
   - graceful server backfill for new live sessions
3. Preserve operator-facing rollups from the legacy dashboard:
   - rolling usage monitor
   - compact tool error-rate and duration summaries
   - cost views with sensible default windows and stable formatting
4. Preserve non-blocking loading behavior where analytics failure does not blank the core monitor surface.
5. Explicitly reject the brittle v1 bootstrap dependency where one failed core fetch prevents unrelated panels from rendering.

**Verification**

- Run: `pnpm test -- --test-name-pattern "SSE|stats|cost|tools|live stream"`
- Expect: SSE and analytics tests pass with the hardened behavior.
- Run: `pnpm build`
- Expect: Svelte stores/components compile after the carry-forward changes.

**Done When**

- The Svelte app has the reliability and operator affordances worth preserving from v1.
- The new surfaces do not inherit the legacy dashboard's all-or-nothing bootstrap coupling.

### Task 4: Move Rust And Tauri Onto The Canonical UI And API Surface

**Objective**

Stop treating Rust/Tauri as a separate product by making them serve the same Svelte and v2 surface the TypeScript path treats as canonical.

**Files**

- Modify: `rust-backend/src/lib.rs`
- Modify: `rust-backend/src/config.rs`
- Create: `rust-backend/src/api/v2/mod.rs`
- Modify: `rust-backend/src/api/mod.rs`
- Modify: `rust-backend/src/runtime_host.rs`
- Modify: `rust-backend/src/state.rs`
- Modify: `src-tauri/src/backend.rs`
- Modify: `src-tauri/src/runtime_coordinator.rs`
- Modify: `src-tauri/AGENTS.md`
- Modify: `rust-backend/AGENTS.md`
- Test: `rust-backend/tests/static_assets_api.rs`
- Test: `rust-backend/tests/runtime_host.rs`
- Test: `src-tauri/tests/runtime_boundary.rs`

**Dependencies**

- Task 1
- Task 2

**Implementation Steps**

1. Change Rust asset serving so the embedded runtime can serve the Svelte build, not only `public/`.
2. Decide and document the routing strategy:
   - temporary `/` redirect to `/app`
   - or Svelte takeover of `/` once parity is reached
3. Add the missing v2 endpoints and live contracts required for the Svelte app to run against Rust.
4. Ensure Tauri startup and runtime metadata reflect the canonical surface and static asset location.
5. Keep Rust/Tauri tests focused on contract parity and startup boundary guarantees.

**Verification**

- Run: `pnpm rust:test`
- Expect: Rust backend and desktop invariant tests pass.
- Run: `pnpm tauri:build --no-bundle`
- Expect: Tauri compiles against the updated runtime surface.

**Done When**

- Rust can serve the same frontend and API contract the TypeScript runtime presents.
- Tauri is no longer coupled to the legacy dashboard as its default product experience.

### Task 5: Harden Discovery, Pagination, And Parity Coverage

**Objective**

Fix the edge-case infrastructure issues that will otherwise keep reintroducing drift or operator-visible bugs during convergence.

**Files**

- Modify: `src/watcher/index.ts`
- Modify: `src/watcher/service.ts`
- Modify: `src/db/v2-queries.ts`
- Modify: `src/api/v2/live-stream.ts`
- Modify: `rust-backend/src/importer.rs`
- Modify: `rust-backend/src/db/queries.rs`
- Modify: `scripts/test/run-parity-ts.sh`
- Create: `tests/parity/v2-contract.test.ts`
- Create: `tests/playwright/smoke-svelte.spec.ts`

**Dependencies**

- Task 2
- Task 3
- Task 4

**Implementation Steps**

1. Make Claude session discovery recursive in the TypeScript watcher path so behavior matches the documented `**/*.jsonl` expectation.
2. Mirror the same recursive discovery semantics in Rust importer/runtime code.
3. Replace timestamp-only v2 cursors with stable composite keyset cursors so equal timestamps do not drop or duplicate rows.
4. Add parity coverage for the canonical v2 endpoints, not only the v1 endpoints.
5. Add a light browser smoke test for the Svelte app so static asset and API contract regressions fail before release.

**Verification**

- Run: `pnpm test`
- Expect: TypeScript test suite passes with recursive discovery and stable cursor coverage.
- Run: `pnpm rust:test`
- Expect: Rust suite passes with matching discovery semantics.
- Run: `pnpm exec playwright test`
- Expect: Svelte smoke tests pass against the canonical UI path.

**Done When**

- Discovery behavior matches documentation in both runtimes.
- v2 pagination is stable under duplicate timestamps.
- Convergence work is protected by automated verification across TS, Rust, and browser layers.

### Task 6: Retire The Legacy Dashboard Behind A Controlled Cutover

**Objective**

Remove the legacy dashboard as a source of product drift only after the canonical path is feature-complete enough to absorb its operator value.

**Files**

- Modify: `src/app.ts`
- Modify: `README.md`
- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `docs/system/FEATURES.md`
- Modify: `docs/project/ROADMAP.md`
- Delete: `public/index.html`
- Delete: `public/js/app.js`
- Delete: `public/js/sse-client.js`
- Delete: `public/js/components/agent-cards.js`
- Delete: `public/js/components/cost-dashboard.js`
- Delete: `public/js/components/event-feed.js`
- Delete: `public/js/components/filter-bar.js`
- Delete: `public/js/components/session-detail.js`
- Delete: `public/js/components/stats-bar.js`
- Delete: `public/js/components/tool-analytics.js`
- Delete: `public/js/components/transcript.js`
- Delete: `public/js/components/usage-monitor.js`

**Dependencies**

- Task 3
- Task 4
- Task 5

**Implementation Steps**

1. Define explicit cutover gates:
   - Svelte monitor covers required operator workflows
   - Rust/Tauri serve the same canonical surface
   - v2 tests and smoke coverage are green
2. Change root routing to the canonical frontend once the cutover gates are satisfied.
3. Remove legacy assets and update docs to reflect the new steady state.
4. Keep a short migration note in docs for anyone depending on the old `/` path or screenshots.

**Verification**

- Run: `pnpm test`
- Expect: no TypeScript tests rely on legacy `public/js` behavior.
- Run: `pnpm build`
- Expect: the production build succeeds without the legacy dashboard assets.
- Run: `curl -I http://127.0.0.1:3141/`
- Expect: the canonical frontend is served or redirected intentionally.

**Done When**

- The repo no longer contains two competing UI products.
- Root routing and desktop behavior both point at the same canonical frontend.

## Risks And Mitigations

- Risk: convergence work drags on because the repo keeps shipping both old and new surfaces.
  Mitigation: complete Task 1 first and treat the legacy UI as maintenance-only immediately.

- Risk: Codex data is over-normalized into fake transcript/search/tool rows that imply unsupported fidelity.
  Mitigation: add explicit fidelity/capability fields and only populate richer surfaces where the source can support them.

- Risk: Rust/Tauri fall further behind while TypeScript continues to evolve.
  Mitigation: give Rust/Tauri a dedicated convergence task before deprecating legacy assets.

- Risk: useful localhost operator behavior gets lost during UI migration.
  Mitigation: complete the v1 carry-forward task as an explicit phase with named source references.

- Risk: pagination and discovery bugs continue to create subtle operator mistrust.
  Mitigation: harden cursors and recursive discovery before final cutover.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Canonical product path is documented | `rg -n "canonical|maintenance-only|legacy dashboard" README.md AGENTS.md docs/system/ARCHITECTURE.md docs/system/FEATURES.md docs/project/ROADMAP.md` | docs consistently describe Svelte/v2 as primary |
| Shared projection contract behaves for both agents | `pnpm test -- --test-name-pattern "Codex|Claude|v2"` | projection and v2 tests pass |
| Durable v1 operator behavior is preserved intentionally | `pnpm test -- --test-name-pattern "SSE|stats|cost|tools|live stream"` | SSE and analytics tests pass with hardened behavior |
| Rust/Tauri serve the canonical surface | `pnpm rust:test && pnpm tauri:build --no-bundle` | Rust tests and Tauri compile succeed |
| Discovery and cursor hardening are complete | `pnpm test && pnpm rust:test` | TS and Rust suites pass with recursive discovery and stable pagination coverage |
| Canonical frontend is browser-usable | `pnpm exec playwright test` | Svelte smoke tests pass |
| Legacy cutover is safe | `pnpm build && curl -I http://127.0.0.1:3141/` | production build passes and root serves or redirects intentionally |

## Handoff

1. Execute in this session, task by task.
2. Open a separate execution session.
3. Refine this plan before implementation.
