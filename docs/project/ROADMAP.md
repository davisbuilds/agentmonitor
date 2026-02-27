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

- **Rust + Tauri migration**: Phase 1 backend migration is complete (parity/soak/import/pricing/OTEL). Phase 2 desktop shell is in progress with internal-first sequencing.
  - Completed in Phase 2 so far: Tauri scaffold, embedded Rust lifecycle host, backend readiness gate, and Rust-served dashboard assets.
  - Next in Phase 2: packaging/signing path and additive IPC cleanup.
  - See [spike decision](../plans/2026-02-24-rust-backend-spike-decision.md) and [Phase 2 implementation plan](../plans/2026-02-26-tauri-internal-first-shell-implementation.md).

## Planned / Open Areas

- See `docs/plans/` for active roadmap items and research.
