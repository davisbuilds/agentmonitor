# Roadmap

This is a lightweight snapshot, not a release contract.

## Completed Highlights

- Real-time dashboard with agent cards, event feed, stats bar, cost dashboard, and tool analytics.
- Multi-agent ingest: Claude Code hooks (bash + Python) and Codex OTEL integration.
- SSE broadcasting with filters, backpressure, and heartbeat.
- Per-model cost tracking with JSON pricing data for Claude, Codex, and Gemini families.
- Historical import pipeline for Claude Code JSONL and Codex session files.
- Event contract with validation, normalization, deduplication, and payload truncation.
- Usage monitoring with per-agent token/cost limits and rolling windows.
- OTLP JSON parser for logs, metrics, and traces.
- Session transcript aggregation and detail views.
- Ingest throughput benchmarking.

## In Progress

- **Repo convergence**: establish the Svelte app at `/app/` and `/api/v2/*` as the canonical product path, pull forward durable localhost behavior from v1, converge Rust/Tauri on the same surface, and retire the legacy `/` dashboard behind parity gates.
  - Completed so far: convergence plan documented in `docs/plans/2026-04-08-repo-convergence-implementation.md`, Node runtime pinned to `24.13.0`, and canonical-path docs cleanup started.
  - Next: shared cross-agent v2 projection, v1 behavior carry-forward into the Svelte/live path, Rust/Tauri convergence on `/app` + `/api/v2`, and legacy cutover criteria.
- **Live Ops tab**: Claude-first live operator surface is shipped in the Svelte app with dedicated live APIs, SSE, and privacy/capture settings.
  - Completed so far: live schema, Claude live ingestion, Codex passive summary participation, live v2 endpoints, Svelte `Live` tab, and live capture/redaction controls.
  - Next: exporter-contract hardening and noisy-session performance improvements.
- **Rust + Tauri migration**: Phase 1 backend migration is complete (parity/soak/import/pricing/OTEL). Phase 2 desktop shell is in progress with internal-first sequencing.
  - Completed in Phase 2 so far: Tauri scaffold, embedded Rust lifecycle host, backend readiness gate, Rust-served dashboard assets, architectural cleanup (runtime contract boundary, deterministic desktop bind policy, runtime coordinator extraction, boundary regression tests), first functional IPC handlers (`desktop_runtime_status`, `desktop_health`), and macOS release preflight workflow for unsigned/signed/notarized builds.
  - Next in Phase 2: wire IPC handlers into renderer flows and harden signing/notarization verification automation.
  - See [spike decision](../plans/2026-02-24-rust-backend-spike-decision.md), [Phase 2 implementation plan](../plans/2026-02-26-tauri-internal-first-shell-implementation.md), and [architectural cleanup plan](../plans/2026-02-27-tauri-internal-first-shell-implementation.md).

## Planned / Open Areas

- See `docs/plans/` for active roadmap items and research.
