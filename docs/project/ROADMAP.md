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

- **Repo convergence**: establish the Svelte app at `/app/` and `/api/v2/*` as the canonical product path, pull forward durable localhost behavior from v1, converge the Rust backend onto that same surface as an alternate runtime, and retire the legacy `/` dashboard behind parity gates.
  - Completed so far: convergence plan documented in `docs/plans/2026-04-08-repo-convergence-implementation.md`, Node runtime pinned to `24.13.0`, canonical-path docs cleanup started, Task 2 shared projection work landed, Task 3 localhost carry-forward work landed, and the Rust alternate-runtime direction is now chosen.
  - Next: execute the Rust alternate-runtime convergence plan, then define legacy cutover criteria.
- **Live Ops tab**: Claude-first live operator surface is shipped in the Svelte app with dedicated live APIs, SSE, and privacy/capture settings.
  - Completed so far: live schema, Claude live ingestion, Codex passive summary participation, live v2 endpoints, Svelte `Live` tab, and live capture/redaction controls.
  - Next: exporter-contract hardening and noisy-session performance improvements.
- **Rust runtime evaluation**: Phase 1 backend migration is complete (parity/soak/import/pricing/OTEL). The remaining question is whether Rust becomes a maintained alternate runtime for the canonical web contract.
  - Completed so far: Rust ingest/live parity work, import/pricing/OTEL support, and runtime-host invariant coverage.
  - Next: execute the Rust alternate-runtime convergence plan in `docs/plans/2026-04-10-rust-runtime-convergence.md`, starting with `/app` static serving and the minimum bootstrap contract for the Svelte app.

## Planned / Open Areas

- See `docs/plans/` for active roadmap items and research.
