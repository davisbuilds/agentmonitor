# AGENTS.md

Guidance for coding agents working in this repository.

## Project Snapshot

- App: `agentstats` real-time localhost dashboard for AI agent activity.
- Backend: Node.js + TypeScript + Express + SQLite (`better-sqlite3`).
- Frontend: static HTML + vanilla JS + Tailwind-generated CSS.
- Transport: HTTP ingestion + Server-Sent Events (SSE) for live updates.
- Default bind: `127.0.0.1:3141`.

## Working Commands

- Install: `pnpm install`
- Dev server: `pnpm dev`
- CSS one-off build: `pnpm run css:build`
- CSS watch mode: `pnpm run css:watch`
- Production build: `pnpm run build`
- Production start: `pnpm start`
- Import historical logs: `pnpm run import` (supports `--source`, `--from`, `--to`, `--dry-run`, `--force`)
- Seed local demo data (server must be running): `pnpm run seed`

For UI work in dev, use two terminals:
- Terminal 1: `pnpm dev`
- Terminal 2: `pnpm run css:watch`

## Code Map

- `src/server.ts`: app bootstrap, middleware, route mounting, graceful shutdown.
- `src/config.ts`: environment-driven runtime config.
- `src/api/`: HTTP route handlers.
- `src/db/schema.ts`: schema and indexes.
- `src/db/queries.ts`: all DB reads/writes and stats aggregation.
- `src/sse/emitter.ts`: SSE client management and fan-out.
- `public/index.html`: dashboard shell.
- `public/js/`: dashboard client code/components.
- `src/otel/parser.ts`: OTLP JSON log/metric parsing for Claude Code and Codex.
- `src/import/`: historical log importers (Claude Code JSONL, Codex).
- `src/pricing/`: per-model cost calculation with JSON pricing data.
- `hooks/claude-code/`: hook scripts for real-time Claude Code integration.
- `hooks/codex/`: Codex OTEL integration docs.
- `scripts/import.ts`: CLI for historical log import.
- `scripts/seed.ts`: sample traffic generator.

## API Contract Notes

- Ingest endpoints:
  - `POST /api/events`
  - `POST /api/events/batch`
- Required event fields: `session_id`, `agent_type`, `event_type`.
- Optional `event_id` is used for deduplication (unique constraint).
- `metadata` payload is capped by `AGENTSTATS_MAX_PAYLOAD_KB`.
- OTEL endpoints: `POST /api/otel/v1/logs`, `POST /api/otel/v1/metrics` (JSON only, no protobuf).
- SSE endpoint: `GET /api/stream`.
- SSE event names used by clients: `event`, `stats`, `session_update`.
- Session timeout: 5 min idle → `idle`, 10 min idle → auto `ended`.
- Claude Code `session_end` transitions to `idle` (not `ended`) so cards linger in Active Agents.
- Codex OTEL logs carry no token/cost data; use `pnpm run import --source codex` for cost backfill.

## Implementation Guardrails

- Keep TypeScript ESM import style consistent (existing `.js` extension pattern in TS imports).
- Keep SQL in `src/db/queries.ts` (avoid ad-hoc DB logic in route handlers).
- If API response shape changes, update `README.md` in the same change.
- Do not commit local runtime artifacts (`data/`, `*.db`, generated CSS output).

## Validation Checklist

When code behavior changes, run:
- `pnpm run build`
- `pnpm run css:build` (if frontend styles touched)
- Manual sanity check: `GET /api/health`
