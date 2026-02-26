---
date: 2026-02-26
topic: tauri-internal-first-shell
stage: implementation-plan
status: draft
source: conversation
---

# Tauri Internal-First Shell Implementation Plan

## Goal
Ship the first working internal Tauri desktop shell that runs AgentMonitor with the Rust backend as the runtime core, while preserving a thin HTTP adapter boundary and adding correctness guardrails. This plan assumes Phase 1 backend migration is complete (`39/39` parity passing, soak complete, OTEL/pricing/import parity landed) and focuses on desktop integration.

## Scope

### In Scope
- Tauri project scaffold and local desktop dev workflow.
- Embedded Rust backend runtime lifecycle inside Tauri app startup/shutdown.
- Dashboard delivery path that does not require a separate Node runtime at desktop run time.
- Minimal desktop configuration and data-path handling for local-first persistence.
- Guardrail verification for core invariants (event persistence, session lifecycle, SSE delivery).
- Documentation updates for the new execution path.

### Out Of Scope
- Full API/IPC redesign.
- Cross-platform packaging polish beyond initial macOS desktop viability.
- Strict external compatibility commitments for this phase.
- Feature expansion unrelated to desktop bootstrap.

## Assumptions And Constraints
- Single-user internal app; short-term breakage is acceptable.
- Existing Rust backend remains the source of truth for ingest/state behavior.
- HTTP endpoints stay available as adapter boundary for hooks and transition safety.
- Tauri integration should minimize moving parts and avoid introducing a second backend runtime.
- Existing project guardrails still apply (no committed runtime artifacts, keep docs in sync with behavior).

## Task Breakdown

### Task 1: Establish Tauri Scaffold And Dev Entry Points
**Objective**
Create a minimal Tauri shell scaffold that can boot a native window and provide a stable place to wire backend startup.

**Files**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/tauri.conf.json`
- Modify: `package.json`
- Modify: `.gitignore` (if Tauri-generated artifacts need ignores)

**Dependencies**
None

**Implementation Steps**
1. Initialize Tauri v2 scaffold aligned to current workspace tooling.
2. Add `pnpm tauri:dev` and `pnpm tauri:build` scripts.
3. Confirm the shell launches a blank/placeholder window before backend integration.

**Verification**
- Run: `pnpm tauri:dev`
- Expect: native Tauri window opens and process remains healthy.

**Done When**
- Tauri shell launches locally with reproducible command.
- Scripts are documented and runnable from project root.

### Task 2: Create Reusable Rust Backend Host Lifecycle For Desktop Embedding
**Objective**
Expose a start/stop API from the Rust backend crate so Tauri can run the backend in-process with deterministic shutdown.

**Files**
- Modify: `rust-backend/src/lib.rs`
- Create: `rust-backend/src/runtime_host.rs` (or equivalent module)
- Modify: `rust-backend/src/main.rs`
- Test: `rust-backend/tests/runtime_host.rs`

**Dependencies**
- Task 1

**Implementation Steps**
1. Introduce a backend host API that returns a shutdown handle and readiness signal.
2. Refactor standalone `main.rs` to call the same host API used by Tauri.
3. Add test coverage for startup, health readiness, and clean shutdown.

**Verification**
- Run: `pnpm rust:test`
- Expect: new runtime-host tests pass and existing tests remain green.
- Run: `pnpm rust:dev` then `curl -sf http://127.0.0.1:3142/api/health`
- Expect: health endpoint returns JSON.

**Done When**
- Backend can be started/stopped programmatically without process kill semantics.
- CLI and embedded execution paths use shared lifecycle code.

### Task 3: Wire Embedded Backend Into Tauri App Lifecycle
**Objective**
Start backend automatically on Tauri app boot, wait for readiness before loading UI, and shut down cleanly on exit.

**Files**
- Modify: `src-tauri/src/main.rs`
- Create: `src-tauri/src/backend.rs`
- Modify: `src-tauri/Cargo.toml`

**Dependencies**
- Task 2

**Implementation Steps**
1. Add Tauri setup hook that launches backend host on app startup.
2. Block window navigation until backend health is reachable.
3. Add shutdown hook for backend teardown on app exit.
4. Define deterministic behavior for port collisions (clear error and exit, or configured fallback).

**Verification**
- Run: `pnpm tauri:dev`
- Expect: window loads only after backend is healthy.
- Negative path: occupy backend port, run `pnpm tauri:dev`
- Expect: explicit startup error with actionable message (no silent hang).

**Done When**
- Tauri startup/shutdown controls backend lifecycle end to end.
- Failure modes are explicit and diagnosable.

### Task 4: Implement Dashboard Delivery Without Node Runtime
**Objective**
Serve the dashboard for desktop runtime without requiring `pnpm dev` so Tauri app is self-contained.

**Files**
- Modify: `rust-backend/src/lib.rs`
- Create: `rust-backend/src/api/static.rs` (or equivalent)
- Modify: `public/index.html` (only if origin/base-path adjustments are required)
- Modify: `public/js/*` (only if API base resolution needs explicit absolute URL handling)

**Dependencies**
- Task 3

**Implementation Steps**
1. Add static asset serving in Rust backend for dashboard paths.
2. Keep API routes and UI under one origin during desktop runtime.
3. Ensure renderer API calls target the embedded backend consistently.

**Verification**
- Run: `pnpm tauri:dev`
- Expect: dashboard loads with live data path operational.
- Run: `curl -sf http://127.0.0.1:<desktop-port>/api/health`
- Expect: health endpoint responds while UI is open.

**Done When**
- Desktop app runs UI + backend without Node server dependency.
- API and UI routing work from a clean startup command.

### Task 5: Add Internal-First Guardrail Tests
**Objective**
Protect core behavior with a minimal invariant suite so rapid desktop iteration does not regress fundamentals.

**Files**
- Create: `rust-backend/tests/desktop_invariants.rs`
- Modify: `tests/parity/**/*.test.ts` (only if runner wiring changes)
- Modify: `package.json`

**Dependencies**
- Task 4

**Implementation Steps**
1. Add invariant tests for event persistence and dedup behavior.
2. Add invariant tests for session lifecycle transitions (`active` -> `idle` -> `ended` rules).
3. Add invariant tests for SSE delivery on ingest and health-client count behavior.
4. Keep parity suite runnable against Rust runtime for HTTP adapter confidence.

**Verification**
- Run: `pnpm rust:test`
- Expect: invariant tests pass.
- Run: `pnpm test:parity:rust`
- Expect: parity suite remains green.

**Done When**
- Core correctness guardrails run in CI/local workflow.
- Desktop integration changes can be validated quickly before commit.

### Task 6: Document New Desktop Path And Update Status References
**Objective**
Make project docs reflect the internal-first Phase 2 plan and operational commands.

**Files**
- Modify: `AGENTS.md`
- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `docs/project/ROADMAP.md`
- Modify: `docs/plans/2026-02-24-rust-backend-spike-decision.md`

**Dependencies**
- Tasks 1-5

**Implementation Steps**
1. Document desktop dev/build commands and runtime model.
2. Record adapter-boundary policy (HTTP preserved, strict compatibility deferred).
3. Update roadmap phase status and link this implementation plan.

**Verification**
- Run: `rg -n \"tauri|desktop|internal-first|adapter\" AGENTS.md docs/system/ARCHITECTURE.md docs/project/ROADMAP.md docs/plans/2026-02-24-rust-backend-spike-decision.md`
- Expect: docs contain current phase intent, commands, and guardrails.

**Done When**
- A zero-context engineer can run and understand the new desktop path.
- Plan and status docs are aligned with implemented behavior.

## Risks And Mitigations
- Tauri startup complexity may create brittle app boot ordering.
  - Mitigation: enforce readiness gate before window load and add explicit startup failure paths.
- Static asset serving differences (file vs HTTP origin) can break frontend fetch assumptions.
  - Mitigation: run UI and API under one origin and test from clean desktop launch.
- Port contention during local dev can cause intermittent failures.
  - Mitigation: define one deterministic policy and test negative path explicitly.
- Fast iteration may hide regressions in core ingest/state behavior.
  - Mitigation: keep invariant tests mandatory before commits.

## Verification Matrix

| Requirement | Proof command | Expected signal |
|---|---|---|
| Tauri shell scaffold launches | `pnpm tauri:dev` | Native window opens; no crash on boot |
| Embedded backend lifecycle is deterministic | `pnpm rust:test` | Runtime host tests pass |
| Desktop integrated boot gates on health | `pnpm tauri:dev` then health check | UI loads only after backend readiness |
| Port collision behavior is explicit | pre-bind port, then `pnpm tauri:dev` | Clear startup error, no hang |
| Core invariants stay correct | `pnpm rust:test` | Persistence/session/SSE invariants pass |
| HTTP adapter boundary still works | `pnpm test:parity:rust` | Existing parity suite remains green |
| Workspace build remains healthy | `pnpm build` | TypeScript workspace builds cleanly |

## Handoff
Plan complete and saved to `docs/plans/2026-02-26-tauri-internal-first-shell-implementation.md`.

1. Execute in this session, task by task.
2. Open a separate execution session.
3. Refine the plan before implementation.
