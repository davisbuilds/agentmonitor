# ADR: Rust Backend Spike Before Desktop Packaging

- Date: 2026-02-24
- Status: Accepted
- Decision Owner: AgentMonitor maintainers

## Context

AgentMonitor currently has a working TypeScript/Express/SQLite backend with stable ingest, SSE, and test coverage. A separate plan exists for macOS desktop packaging (Electron + DMG), but the team is evaluating a larger Rust direction for desktop-era architecture.

A full rewrite now would create high schedule and parity risk. Shipping desktop packaging first without architecture validation risks near-term rework if Rust is selected afterward.

## Decision

Run a time-boxed Rust backend spike first, then make a go/no-go decision before executing desktop packaging work beyond shared foundation changes.

The spike targets backend parity first (not shell/DMG first) because backend behavior carries the largest migration risk and most long-term maintenance impact.

## Phase Boundaries

### Allowed During Shared Foundation

- Architecture decision documentation.
- Host-specific config removal (`AGENTMONITOR_PROJECTS_DIR` default portability fix).
- Test coverage for config/path behavior.

### Deferred Until Post-Spike Decision

- Electron main-process scaffold and window lifecycle work.
- Native module rebuild pipeline for Electron.
- DMG packaging, signing, notarization, and release automation.
- Desktop onboarding UX and migration scripts tied to chosen runtime.

## Success Criteria For Rust Spike

All criteria must be evaluated before deciding:

1. Contract parity: scoped black-box parity suite passes for both TypeScript and Rust runtimes with no expectation forks.
2. Runtime stability: 30-minute ingest + SSE soak test completes without crashes or unbounded resource growth.
3. Performance: Rust ingest throughput is at least TypeScript baseline, or any regression is justified by a clear strategic gain and explicit approval.
4. Operability: local developer workflow is reproducible with documented commands and deterministic setup.

## Alternatives Considered

1. Continue Electron-first with TypeScript backend now.
   - Pros: shortest path to distributable DMG.
   - Cons: possible rework if Rust becomes the committed direction later.
2. Full Rust rewrite immediately.
   - Pros: avoids dual-runtime period.
   - Cons: highest delivery risk and largest parity surface without evidence gates.
3. Tauri/sidecar move now.
   - Pros: potentially smaller desktop footprint.
   - Cons: still requires backend parity work and adds packaging variability early.

## Post-Spike Decision Paths

The spike ends with one of three outcomes. Each maps to a concrete next step:

1. **Go**: Rust parity suite passes, soak is stable, runtime footprint is favorable.
   - Next step: Tauri desktop shell with Rust backend. HTTP API preserved for hook compatibility. Tauri IPC is additive for renderer communication, not a replacement for the ingest surface. The [Electron plan](../2026-02-23-macos-desktop-dmg-implementation.md) is archived.
2. **No-Go**: Parity gaps, instability, or insufficient strategic advantage.
   - Next step: Execute the [Electron + DMG plan](../2026-02-23-macos-desktop-dmg-implementation.md) as written. The black-box parity harness built during the spike transfers to the TypeScript runtime as contract regression coverage.
3. **Inconclusive**: Evidence is mixed or the time-box expired before Task 8/9 completion.
   - Next step: A second, narrower spike targeting the specific unresolved gap (e.g., SSE-only, or contract-only). Maximum one additional week. If still inconclusive, default to no-go path.

## Consequences

- Near-term effort shifts from packaging work to architecture de-risking.
- Desktop distribution work starts after explicit decision, not assumption.
- Existing TypeScript runtime remains default and shippable during the spike window.

## Source Context

- [Rust backend spike plan](../2026-02-24-rust-backend-spike-implementation.md)
- [macOS desktop + DMG plan](../2026-02-23-macos-desktop-dmg-implementation.md)
