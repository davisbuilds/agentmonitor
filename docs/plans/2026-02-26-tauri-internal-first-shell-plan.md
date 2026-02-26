---
date: 2026-02-26
topic: tauri-internal-first-shell
stage: brainstorm
---

# Tauri Internal-First Shell

## What We Are Building
Build a Tauri desktop shell that runs AgentMonitor with the Rust backend as the primary runtime, optimized for a fast internal working app first. Phase 1 is complete (`39/39` parity passing across TS and Rust, import/pricing/OTEL parity done), so this phase starts desktop integration rather than more backend parity work.

## Why This Direction
You are the only user, breakage is acceptable, and velocity plus learning is the top priority. An internal-first Tauri shell gets real desktop behavior quickly, then hardens around observed usage, instead of spending time preserving compatibility guarantees you do not need yet.

## Key Decisions
- Desktop direction is Rust + Tauri (GO decision remains in force).
- Use internal-first sequencing: fastest end-to-end desktop loop before compatibility hardening.
- Keep HTTP ingest and dashboard flows available on localhost as an adapter boundary, so compatibility can be tightened later without rewriting core runtime.
- Add guardrail invariants (event persistence, session lifecycle, stream delivery) to keep speed from eroding correctness.
- Archive superseded Electron execution plan and keep spike/ADR docs as active project history.

## Constraints
- No implementation in this step; produce approved docs first.
- Tauri is new for this project, so the plan should favor low-complexity scaffolding and measurable checkpoints.
- Existing Rust backend remains the source of truth for ingest/state logic.

## Success Criteria
- A clear, execution-ready implementation plan exists for Phase 2 desktop scaffolding.
- The plan explicitly references the Rust/Tauri decision and current completed state.
- Superseded desktop plan is archived with links still valid.
- Verification gates are defined before any code changes.

## Open Questions
- Desktop default bind policy: keep `3141` for hook continuity or use desktop-specific dynamic port with surfaced status.
- First desktop iteration scope: window + embedded backend only, or include minimal IPC commands for app metadata.
- Earliest packaging checkpoint: smoke-only app bundle vs signed/notarized path in the same slice.

## Next Step
Proceed to planning.
