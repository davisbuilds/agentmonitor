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

## Planned / Open Areas

- See `docs/plans/` for active roadmap items and research.
