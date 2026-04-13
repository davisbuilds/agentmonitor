---
date: 2026-04-10
topic: rust-runtime-convergence
stage: implementation
status: in_progress
source: conversation
---

# Rust Runtime Convergence Plan

## Goal

Make the Rust backend a maintained alternate runtime for the canonical Svelte app by serving `/app` and implementing the minimum API surface the current frontend actually uses, then grow that into full canonical parity in staged slices.

## Key Finding

The Svelte app is canonical, but it is not yet v2-only.

- Initial app mount fetches:
  - `GET /api/filter-options`
  - `GET /api/v2/live/settings`
  - `GET /api/stream` via `EventSource`
- The default `Monitor` tab still depends on v1 endpoints:
  - `GET /api/stats`
  - `GET /api/events`
  - `GET /api/sessions`
  - `GET /api/stats/cost`
  - `GET /api/stats/tools`
- Sessions, Search, Analytics, and Live use v2 endpoints.

Planning implication:

- Rust can support the canonical Svelte app in phases.
- The first useful milestone is not "full v2 parity." It is "the Svelte app boots and the default Monitor experience works against Rust."
- Full canonical parity still requires substantial new v2 database and API work in Rust.

## Current State

### Frontend Contract

Current frontend route usage by area:

- App shell:
  - `GET /api/filter-options`
  - `GET /api/v2/live/settings`
  - `GET /api/stream`
- Monitor:
  - `GET /api/stats`
  - `GET /api/events`
  - `GET /api/sessions`
  - `GET /api/stats/cost`
  - `GET /api/stats/tools`
  - `GET /api/sessions/:id`
  - `GET /api/sessions/:id/transcript`
- Sessions:
  - `GET /api/v2/projects`
  - `GET /api/v2/agents`
  - `GET /api/v2/sessions`
  - `GET /api/v2/sessions/:id`
  - `GET /api/v2/sessions/:id/messages`
  - `GET /api/v2/sessions/:id/children`
- Search:
  - `GET /api/v2/projects`
  - `GET /api/v2/agents`
  - `GET /api/v2/search`
- Analytics:
  - `GET /api/v2/analytics/summary`
  - `GET /api/v2/analytics/activity`
  - `GET /api/v2/analytics/projects`
  - `GET /api/v2/analytics/tools`
- Live:
  - `GET /api/v2/live/settings`
  - `GET /api/v2/projects`
  - `GET /api/v2/agents`
  - `GET /api/v2/live/sessions`
  - `GET /api/v2/live/sessions/:id`
  - `GET /api/v2/live/sessions/:id/turns`
  - `GET /api/v2/live/sessions/:id/items`
  - `GET /api/v2/live/stream`

### Rust Runtime

Rust currently provides:

- v1 ingest and monitor endpoints
- OTEL endpoints
- v1 SSE at `GET /api/stream`
- static fallback from `public/`
- Svelte app serving at `/app`
- `GET /api/v2/live/settings`
- canonical live v2 endpoints for:
  - `GET /api/v2/live/sessions`
  - `GET /api/v2/live/sessions/:id`
  - `GET /api/v2/live/sessions/:id/turns`
  - `GET /api/v2/live/sessions/:id/items`
  - `GET /api/v2/live/stream`
- historical v2 read routes for Sessions, Search, Analytics, Projects, and Agents
- historical v2 schema/query support in Rust-backed SQLite
- Claude historical import population for:
  - `browsing_sessions`
  - `messages`
  - `tool_calls`
  - `messages_fts`
  - `watched_files`
  - `session_turns`
  - `session_items`
- Codex JSONL historical import population into the same v2 tables (`codex-jsonl` / `summary`)
- live SSE replay/filter/max-client behavior for the canonical live stream
- auto-import fanout into the Rust live SSE hub

Rust currently does not provide:

- a Rust-native live watcher beyond auto-import-driven live updates
- Codex OTEL real-time v2 projection (insufficient data fidelity from OTEL telemetry)

## Recommendation

Do not couple Rust convergence to an immediate frontend contract rewrite.

Recommended path:

1. Make Rust serve the current canonical app as it exists today.
2. Preserve the mixed-contract boot path for the first convergence slice.
3. Add v2 support in Rust in read-only slices.
4. Consider a later TS frontend cleanup to reduce Monitor's v1 dependency only after Rust can already host the app.

This keeps the runtime-convergence work scoped to runtime parity, not simultaneous product-contract redesign.

## Phases

### Phase 1: Svelte Shell Boot On Rust

Status: complete

**Objective**

Serve the built Svelte SPA from Rust at `/app` and satisfy the minimum bootstrap contract for the default Monitor tab.

**Required surface**

- Static:
  - `GET /app`
  - `GET /app/*` asset paths
  - SPA fallback to `/app/index.html`
- API:
  - existing v1 monitor endpoints already in Rust
  - `GET /api/v2/live/settings`

**Files**

- Modify: `rust-backend/src/lib.rs`
- Modify: `rust-backend/src/config.rs`
- Modify: `rust-backend/src/api/mod.rs`
- Create: `rust-backend/src/api/v2/mod.rs`
- Create: `rust-backend/src/api/v2/live.rs`
- Test: `rust-backend/tests/static_assets_api.rs`
- Test: new Rust app-shell smoke coverage

**Notes**

- Rust currently serves `public/` from `Config::default_ui_dir()`. That needs a parallel Svelte path, not a blind swap.
- Keep `/` behavior unchanged for this phase. The convergence target is `/app`.

**Done When**

- `http://127.0.0.1:3142/app` serves the Svelte app.
- The app shell mounts successfully against Rust.
- The default Monitor tab can load read-only without frontend changes.

### Phase 2: Canonical Read-Only Session/Search/Analytics Surface

Status: complete

**Objective**

Implement the non-live v2 read APIs needed for Sessions, Search, and Analytics.

**Required surface**

- `GET /api/v2/projects`
- `GET /api/v2/agents`
- `GET /api/v2/sessions`
- `GET /api/v2/sessions/:id`
- `GET /api/v2/sessions/:id/messages`
- `GET /api/v2/sessions/:id/children`
- `GET /api/v2/search`
- `GET /api/v2/analytics/summary`
- `GET /api/v2/analytics/activity`
- `GET /api/v2/analytics/projects`
- `GET /api/v2/analytics/tools`

**Schema prerequisite**

Rust needs the historical v2 tables and indexes before these routes are meaningful.

**Implemented**

- `rust-backend/src/db/schema.rs`
- `rust-backend/src/db/v2_queries.rs`
- `rust-backend/src/importer/claude_history.rs`
- `rust-backend/src/api/v2/mod.rs`
- `rust-backend/src/api/v2/history.rs`
- `rust-backend/tests/v2_queries.rs`
- `rust-backend/tests/import_pipeline.rs`
- `rust-backend/tests/v2_history_api.rs`
- `e2e/rust-v2-readonly.spec.ts`

**Done When**

- Sessions, Search, and Analytics tabs can render against Rust using the same frontend bundle.
- Rust route shapes and pagination semantics match the TypeScript contract closely enough for shared black-box testing.

### Phase 3: Canonical Live V2 Surface

Status: complete

**Objective**

Add the newer live-session API and stream contract in Rust.

**Required surface**

- `GET /api/v2/live/sessions`
- `GET /api/v2/live/sessions/:id`
- `GET /api/v2/live/sessions/:id/turns`
- `GET /api/v2/live/sessions/:id/items`
- `GET /api/v2/live/stream`

**Schema prerequisite**

Rust needs:

- `session_turns`
- `session_items`
- live-session metadata on `browsing_sessions`
- capability metadata to match TS payloads

**Done When**

- The Live tab works against Rust with honest fidelity/capability metadata.
- Rust preserves the operational behavior already expected from TS:
  - heartbeats
  - client cleanup
  - filtered streaming
  - stable item ordering and cursor behavior

**Implemented**

- `rust-backend/src/api/v2/live.rs`
- `rust-backend/src/api/v2/mod.rs`
- `rust-backend/src/sse/live.rs`
- `rust-backend/src/state.rs`
- `rust-backend/src/auto_import.rs`
- `rust-backend/tests/v2_live_api.rs`
- `rust-backend/tests/v2_live_stream_api.rs`
- `e2e/rust-live-tab.spec.ts`

### Phase 4: Canonical Parity Safety Net

Status: complete

**Objective**

Promote the canonical Svelte contract to first-class TS/Rust parity coverage.

**Work**

- add Rust coverage for `/app` static serving
- extend the v2 contract tests to run cleanly against Rust
- add a browser smoke path against the Rust runtime for:
  - app shell
  - Monitor
  - Sessions
  - at least one v2 page beyond Monitor

**Done When**

- runtime parity is measured against the canonical app contract, not just the older localhost endpoints

**Implemented**

- `rust-backend/tests/static_assets_api.rs` — 6 tests for `/app` static serving, SPA fallback, asset paths, API precedence
- `tests/parity/v2/contract.test.ts` — 3 black-box contract tests covering sessions, search, analytics, and live endpoints
- `scripts/test/run-v2-contract-rust.sh` — self-contained runner: seeds JSONL fixture, runs Rust import, starts Rust server, executes contract tests
- `pnpm test:v2:contract:rust` — npm script for Rust contract parity
- `pnpm test:v2:contract:ts` — npm script for TS contract parity (existing)
- `e2e/rust-monitor-boot.spec.ts` — browser smoke for app shell + Monitor tab
- `e2e/rust-v2-readonly.spec.ts` — browser smoke for Sessions, Search, Analytics tabs
- `e2e/rust-live-tab.spec.ts` — browser smoke for Live tab

**Bug fix during Phase 4**

- `rust-backend/src/importer.rs`: `discover_claude_code_logs` now walks project directories recursively using `walk_jsonl_files` instead of scanning one level deep, matching the TS chokidar `**/*.jsonl` discovery behavior

## Implementation Order

1. Phase 1 `/app` static serving and `GET /api/v2/live/settings`
2. Phase 1 browser smoke against Rust-backed Monitor
3. Phase 2 historical v2 schema and read routes
4. Phase 2 contract parity coverage
5. Phase 3 live v2 schema and routes
6. Phase 3 live parity coverage

## Verification Targets

During implementation, keep verification concrete:

- `pnpm rust:test`
- `pnpm rust:check`
- shared parity commands where applicable
- browser smoke against Rust once `/app` is live

New coverage should prefer black-box contract tests over implementation-specific unit assertions whenever the route shape is what matters.

## Current Verification Baseline

- `pnpm build`
- `pnpm rust:test`
- `pnpm test:v2:contract:ts`
- `pnpm test:v2:contract:rust`
- `pnpm exec playwright test e2e/rust-monitor-boot.spec.ts e2e/rust-v2-readonly.spec.ts e2e/rust-live-tab.spec.ts --project=chromium`

## Ready For Next Stage

Yes.

Phases 1–4 are complete. The canonical parity safety net covers both Claude and Codex JSONL sessions: the same 6 contract tests (3 Claude + 3 Codex) run against both TS and Rust, and browser smokes cover all five Svelte tabs against the Rust runtime.

Codex JSONL sessions are now projected into the v2 surface on both runtimes with `integration_mode: 'codex-jsonl'`, `fidelity: 'summary'`. Codex OTEL (real-time telemetry) does not have enough data fidelity for v2 projection.

Next considerations:

- Rust-native live file watcher (currently live updates depend on auto-import timer, not realtime chokidar equivalent)
- TS frontend cleanup to reduce Monitor's v1 dependency
