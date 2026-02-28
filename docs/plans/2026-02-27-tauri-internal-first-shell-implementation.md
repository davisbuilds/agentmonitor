---
date: 2026-02-27
topic: tauri-internal-first-shell
stage: implementation-plan
status: completed
source: conversation
---

# Tauri Internal-First Shell Architectural Cleanup Implementation Plan

## Execution Status (2026-02-27)

- Completed in current implementation slice.
- Task 1 complete: explicit `runtime_contract` boundary introduced and adopted by Tauri embedding path.
- Task 2 complete: deterministic desktop bind policy added (`AGENTMONITOR_DESKTOP_HOST` / `AGENTMONITOR_DESKTOP_PORT` overrides).
- Task 3 complete: startup/shutdown orchestration extracted to `src-tauri/src/runtime_coordinator.rs`.
- Task 4 complete: boundary-focused tests added in `src-tauri/tests/runtime_boundary.rs`.
- Task 5 complete: IPC-ready typed seam scaffolded in `src-tauri/src/ipc/mod.rs`.
- Task 6 complete: architecture, roadmap, and agent guidance docs updated.

## Goal
Perform a focused architectural cleanup pass before IPC and packaging work so desktop runtime ownership, configuration boundaries, and startup behavior are explicit, testable, and low-friction for the next Phase 2 slices.

## Scope

### In Scope
- Clarify and enforce runtime boundaries between `src-tauri` (desktop shell) and `rust-backend` (service core).
- Normalize desktop startup configuration and port policy for embedded runtime.
- Refactor startup/shutdown orchestration into minimal, reusable interfaces.
- Add regression tests for boundary contracts and negative startup paths.
- Update docs to reflect the cleaned architecture and developer workflow.

### Out Of Scope
- New feature development in dashboard UI.
- Replacing HTTP ingest/SSE with IPC.
- DMG signing/notarization automation.
- Cross-platform packaging changes.

## Assumptions And Constraints
- Current Phase 2 slices are already landed: Tauri scaffold, embedded runtime host, Rust static asset serving, and desktop invariants.
- HTTP endpoints remain the adapter boundary for hooks and parity coverage.
- Internal-first velocity remains the priority, but cleanup must reduce future rework.
- Cleanup should be incremental and verifiable, not a broad rewrite.

## Task Breakdown

### Task 1: Define And Enforce Desktop Runtime Boundary Contracts
**Objective**
Create explicit contracts for what `src-tauri` may control (app lifecycle, windowing, desktop UX) vs what `rust-backend` owns (HTTP/API/SSE/data/runtime tasks).

**Files**
- Modify: `src-tauri/src/backend.rs`
- Modify: `rust-backend/src/runtime_host.rs`
- Modify: `rust-backend/src/lib.rs`
- Create: `rust-backend/src/runtime_contract.rs` (or equivalent boundary module)

**Dependencies**
None

**Implementation Steps**
1. Introduce a small shared runtime contract type (startup result, bind address, shutdown semantics).
2. Restrict `src-tauri` to contract-level calls instead of reaching backend internals.
3. Ensure `rust-backend` remains independently runnable (`pnpm rust:dev`) through the same host APIs.

**Verification**
- Run: `pnpm rust:test`
- Expect: existing runtime host and API tests remain green.
- Run: `cargo test --manifest-path src-tauri/Cargo.toml`
- Expect: Tauri lifecycle tests compile against the contract API with no private backend coupling.

**Done When**
- `src-tauri` uses only explicit contract APIs.
- `rust-backend` host internals are not directly depended on by Tauri modules.

### Task 2: Normalize Desktop Config And Port Ownership Policy
**Objective**
Eliminate ambiguous startup behavior by defining one deterministic policy for bind address/port resolution and collisions in desktop mode.

**Files**
- Modify: `rust-backend/src/config.rs`
- Modify: `src-tauri/src/backend.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/backend_lifecycle.rs`
- Test: `rust-backend/tests/runtime_host.rs`

**Dependencies**
- Task 1

**Implementation Steps**
1. Define explicit precedence for desktop runtime bind config (desktop override, env, default).
2. Surface backend base URL from startup contract (single source of truth for window navigation).
3. Keep collision behavior explicit and deterministic (clear user-facing startup error + clean exit).
4. Add tests for the selected policy and failure path.

**Verification**
- Run: `cargo test --manifest-path src-tauri/Cargo.toml --test backend_lifecycle`
- Expect: healthy startup and bind-collision tests pass.
- Negative path: run `pnpm rust:dev` then `pnpm tauri:dev`
- Expect: Tauri exits with clear bind-collision message, no panic backtrace.

**Done When**
- Port policy is documented in code and tests.
- Desktop startup behavior is reproducible across runs.

### Task 3: Isolate Window Navigation And Readiness Gate Logic
**Objective**
Move startup gating and navigation behavior into a dedicated desktop runtime coordinator so future IPC wiring does not tangle setup logic.

**Files**
- Create: `src-tauri/src/runtime_coordinator.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/backend.rs`
- Test: `src-tauri/tests/backend_lifecycle.rs`

**Dependencies**
- Task 2

**Implementation Steps**
1. Extract readiness gate + URL navigation logic from `lib.rs` into coordinator module.
2. Keep `lib.rs` as thin composition root (plugin setup + coordinator invocation).
3. Preserve current behavior: navigate to backend origin only after health readiness.

**Verification**
- Run: `cargo test --manifest-path src-tauri/Cargo.toml`
- Expect: lifecycle tests pass with coordinator module in place.
- Run: `pnpm tauri:dev`
- Expect: desktop shell boots and backend origin is loaded after readiness.

**Done When**
- Startup orchestration is separated from Tauri app bootstrap glue.
- Behavior is unchanged but easier to extend with IPC.

### Task 4: Add Cleanup-Focused Regression Tests For Boundary Invariants
**Objective**
Add tests that specifically protect architectural boundaries and startup contracts from drift.

**Files**
- Create: `src-tauri/tests/runtime_boundary.rs`
- Modify: `src-tauri/tests/backend_lifecycle.rs`
- Modify: `rust-backend/tests/desktop_invariants.rs` (if needed for new contract checks)

**Dependencies**
- Task 3

**Implementation Steps**
1. Add tests asserting startup contract includes usable base URL/address metadata.
2. Add tests asserting shutdown always releases runtime resources and allows restart.
3. Add tests for desktop config precedence and expected fallback behavior.

**Verification**
- Run: `cargo test --manifest-path src-tauri/Cargo.toml`
- Expect: boundary and lifecycle suites pass.
- Run: `pnpm rust:test`
- Expect: backend invariant suites remain green.

**Done When**
- Contract regressions fail fast in local and CI runs.
- Boundary behavior is covered by tests, not just docs.

### Task 5: Prepare IPC-Ready Seams Without Enabling IPC Yet
**Objective**
Create explicit extension points for future IPC handlers while keeping current HTTP adapter flow intact.

**Files**
- Create: `src-tauri/src/ipc/mod.rs` (stub module and typed command DTOs)
- Modify: `src-tauri/src/lib.rs`
- Modify: `docs/system/ARCHITECTURE.md`

**Dependencies**
- Task 4

**Implementation Steps**
1. Add minimal IPC module scaffold with no behavioral path changes.
2. Register placeholder command surface behind clear TODO boundaries.
3. Ensure current runtime remains HTTP-first with no feature regressions.

**Verification**
- Run: `cargo test --manifest-path src-tauri/Cargo.toml`
- Expect: all tests pass with IPC seam present.
- Run: `pnpm tauri:build --no-bundle`
- Expect: release build succeeds.

**Done When**
- IPC extension seam exists and is type-safe.
- No runtime behavior changes from current desktop operation.

### Task 6: Update Operational Docs And Cleanup Plan Status
**Objective**
Document the cleaned architecture and update plan/status artifacts so the next slice can start IPC work directly.

**Files**
- Modify: `AGENTS.md`
- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `docs/project/ROADMAP.md`
- Modify: `docs/plans/2026-02-26-tauri-internal-first-shell-implementation.md`

**Dependencies**
- Tasks 1-5

**Implementation Steps**
1. Record runtime boundary decisions and port policy in `AGENTS.md`.
2. Update architecture docs to reflect coordinator + contract layout.
3. Mark cleanup completion and handoff readiness for IPC slice.

**Verification**
- Run: `rg -n "runtime boundary|port policy|coordinator|IPC seam|internal-first" AGENTS.md docs/system/ARCHITECTURE.md docs/project/ROADMAP.md docs/plans/2026-02-26-tauri-internal-first-shell-implementation.md`
- Expect: docs consistently describe cleaned architecture and next slice.

**Done When**
- A zero-context engineer can start IPC implementation from docs alone.
- Cleanup outcomes and remaining work are explicit and current.

## Risks And Mitigations
- Cleanup may accidentally change runtime behavior while refactoring module boundaries.
  - Mitigation: keep behavior-preserving refactors with pre/post lifecycle test parity.
- Port policy changes may break existing local workflows.
  - Mitigation: add precedence tests and explicit startup diagnostics before rollout.
- IPC seam work may expand scope.
  - Mitigation: treat IPC as scaffold only; no runtime behavior changes in this slice.

## Verification Matrix

| Requirement | Proof command | Expected signal |
|---|---|---|
| Runtime boundaries are explicit and compilable | `cargo test --manifest-path src-tauri/Cargo.toml` | Tauri lifecycle + boundary tests pass |
| Backend host behavior remains stable | `pnpm rust:test` | Runtime host + invariants remain green |
| Port collision path is deterministic | `pnpm rust:dev` then `pnpm tauri:dev` | Clear collision error and clean Tauri exit |
| Desktop boot remains healthy | `pnpm tauri:dev` | App boots and navigates to backend origin after readiness |
| Release path still works | `pnpm tauri:build --no-bundle` | Build succeeds |
| HTTP adapter confidence is preserved | `pnpm test:parity:rust` | Shared parity suite remains green |
| Workspace integrity remains intact | `pnpm build` | TS build and CSS build pass |

## Handoff
Plan complete and saved to `docs/plans/2026-02-27-tauri-internal-first-shell-implementation.md`.

1. Execute in this session, task by task.
2. Open a separate execution session.
3. Refine the plan before implementation.
