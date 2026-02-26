# AGENTS.md

Guidance for coding agents working in this repository.

## Project Snapshot

- App: `agentmonitor` real-time localhost dashboard for AI agent activity.
- Backend: Node.js + TypeScript + Express + SQLite (`better-sqlite3`).
- Frontend: static HTML + vanilla JS + Tailwind-generated CSS.
- Transport: HTTP ingestion + Server-Sent Events (SSE) for live updates.
- Default bind: `127.0.0.1:3141`.

## Working Commands

- Install: `pnpm install`
- Dev server: `pnpm dev`
- CSS one-off build: `pnpm css:build`
- CSS watch mode: `pnpm css:watch`
- Production build: `pnpm build`
- Production start: `pnpm start`
- Import historical logs: `pnpm import` (supports `--source`, `--from`, `--to`, `--dry-run`, `--force`)
- Seed local demo data (server must be running): `pnpm seed`

For UI work in dev, use two terminals:
- Terminal 1: `pnpm dev`
- Terminal 2: `pnpm css:watch`

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
- `metadata` payload is capped by `AGENTMONITOR_MAX_PAYLOAD_KB`.
- OTEL endpoints: `POST /api/otel/v1/logs`, `POST /api/otel/v1/metrics` (JSON only, no protobuf).
- SSE endpoint: `GET /api/stream`.
- SSE event names used by clients: `event`, `stats`, `session_update`.
- Session timeout: 5 min idle → `idle`, 10 min idle → auto `ended`.
- Claude Code `session_end` transitions to `idle` (not `ended`) so cards linger in Active Agents.
- Codex OTEL logs carry no token/cost data; use `pnpm import --source codex` for cost backfill.

## Implementation Guardrails

- Keep TypeScript ESM import style consistent (existing `.js` extension pattern in TS imports).
- Keep SQL in `src/db/queries.ts` (avoid ad-hoc DB logic in route handlers).
- If API response shape changes, update `README.md` in the same change.
- Do not commit local runtime artifacts (`data/`, `*.db`, generated CSS output).

## Rust Backend (`rust-backend/`)

The Rust service reimplements core ingest and live-stream behavior (axum + tokio + rusqlite). Spike complete with GO decision — phased migration in progress.

### Working Commands

- Dev server: `pnpm rust:dev` (binds `127.0.0.1:3142`)
- Release build: `pnpm rust:build`
- Run tests: `pnpm rust:test`
- Import historical logs via Rust: `pnpm rust:import --source all` (supports `--source`, `--from`, `--to`, `--dry-run`, `--force`, `--claude-dir`, `--codex-dir`)
- Parity tests (TS): `pnpm test:parity:ts` (needs TS server running on 3141)
- Parity tests (Rust): `pnpm test:parity:rust` (needs Rust server running on 3142)
- Benchmark comparison: `pnpm bench:compare`

### Rust-Specific Gotchas

- **`cargo` not in PATH**: Shell sessions from Claude Code don't inherit cargo. Prefix commands with `export PATH="$HOME/.cargo/bin:$PATH"` or use the `pnpm rust:*` scripts.
- **Lib + bin crate structure**: Integration tests can't import from a binary crate. The crate is split into `src/lib.rs` (all modules + `build_router()`) and a thin `src/main.rs`. Always add new modules to `lib.rs`.
- **`async_stream::stream!` capture semantics**: Variables must be **referenced inside** the stream block to be captured by the macro. A `let _guard = guard;` outside the block will drop immediately when the enclosing function returns, even if the stream is still alive. Move it inside.
- **ManuallyDrop for types with Drop**: You can't destructure a struct that implements `Drop`. Use `ManuallyDrop::new(self)` + `ptr::read` to extract fields without running Drop, then manage cleanup via a separate guard type.
- **`Path::new(":memory:")` in tests**: `db::initialize` expects `&Path`, not `&str`. Use `Path::new(":memory:")` for in-memory test databases.
- **TS validates `agent_type` as required string only, not enum**: Parity tests must match the looser TypeScript behavior. Don't assert enum rejection for `agent_type` in shared parity tests.
- **tsx-in-tsx spawn failure**: Spawning a child process that uses tsx from a parent tsx process fails silently (no output, no error). Use `/bin/sh -c 'exec node --import tsx ...'` with a clean environment instead.
- **`performance.now()` vs `Date.now()`**: Never mix these in deadline calculations. `performance.now()` returns monotonic ms from process start (~small number); `Date.now()` returns epoch ms (~1.7 trillion). Mixing them produces instant timeouts.

## Validation Checklist

When code behavior changes, run:
- `pnpm build`
- `pnpm css:build` (if frontend styles touched)
- `pnpm exec playwright test` for browser-based end-to-end UI testing
- `pnpm rust:test` (if Rust code touched)
- Manual sanity check: `GET /api/health`
