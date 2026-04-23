# AGENTS.md

Real-time localhost dashboard and session browser for monitoring AI agent activity across Claude Code and Codex.

## Project Snapshot

- App: `agentmonitor` real-time localhost dashboard + session browser for AI agent activity.
- Backend: Node.js + TypeScript + Express + SQLite (`better-sqlite3`).
- Svelte 5 frontend: Vite SPA served at `/app/` with Monitor, Sessions, Search, Analytics tabs. This is the canonical product surface.
- Legacy frontend: static HTML + vanilla JS + Tailwind-generated CSS (at `/`). Treat this as transitional compatibility surface only.
- Rust backend: axum + tokio + rusqlite alternate runtime under evaluation for the same `/app` + `/api/v2` surface.
- Transport: HTTP ingestion + Server-Sent Events (SSE) for live updates.
- Session ingestion: chokidar file-watcher discovers `~/.claude/projects/**/*.jsonl` automatically.
- Default bind: `127.0.0.1:3141` (TS), `127.0.0.1:3142` (Rust).

## Nested Guidance

Subdirectories have their own `AGENTS.md` (with `CLAUDE.md` symlinks) for domain-specific commands, code maps, and gotchas:

- `rust-backend/AGENTS.md` — Rust backend commands, gotchas, parity tests.
- `frontend/AGENTS.md` — Svelte frontend code map, dev workflow, API consumption.

## Working Commands

- Install: `pnpm install`
- Dev server: `pnpm dev`
- CSS one-off build: `pnpm css:build`
- CSS watch mode: `pnpm css:watch`
- Production build: `pnpm build`
- Production start: `pnpm start`
- Import historical logs: `pnpm run import` (supports `--source`, `--from`, `--to`, `--dry-run`, `--force`)
- Force reparse session-browser history: `pnpm reparse:sessions` (Claude), `pnpm reparse:codex-sessions` (Codex)
- Seed local demo data (server must be running): `pnpm seed`
- Install Claude quota bridge: `./hooks/claude-code/install-statusline-bridge.sh`

`pnpm install` at the repo root uses a workspace and installs both the backend package and the Svelte frontend package under `frontend/`.

For canonical Svelte UI work in dev, use three terminals:
- Terminal 1: `pnpm dev`
- Terminal 2: `pnpm css:watch`
- Terminal 3: `pnpm frontend:dev`

For legacy compatibility work on `/`, use two terminals:
- Terminal 1: `pnpm dev`
- Terminal 2: `pnpm css:watch`

## Code Map

- `src/` — TS backend (Express, SQLite, SSE, JSONL parser, OTEL, importers, pricing).
- `rust-backend/` — Rust backend reimplementation (axum, tokio, rusqlite).
- `frontend/` — Svelte 5 SPA (Monitor, Sessions, Search, Analytics tabs).
- `public/` — Legacy dashboard (static HTML + vanilla JS).
- `hooks/` — Claude Code hook scripts and Codex OTEL integration docs.
- `scripts/` — CLI utilities (import, seed).

## API Contract Notes

- Ingest endpoints:
  - `POST /api/events`
  - `POST /api/events/batch`
- Required event fields: `session_id`, `agent_type`, `event_type`.
- Optional `event_id` is used for deduplication (unique constraint).
- `metadata` payload is capped by `AGENTMONITOR_MAX_PAYLOAD_KB`.
- OTEL endpoints: `POST /api/otel/v1/logs`, `POST /api/otel/v1/metrics` (JSON only, no protobuf).
- Provider quota endpoints:
  - `GET /api/provider-quotas`
  - `POST /api/provider-quotas/:provider`
  - `POST /api/provider-quotas/claude/statusline`
- SSE endpoint: `GET /api/stream`.
- SSE event names used by clients: `event`, `stats`, `session_update`.
- Session timeout: 5 min idle → `idle`, 10 min idle → auto `ended`.
- Claude Code `session_end` transitions to `idle` (not `ended`) so cards linger in Active Agents.
- Codex OTEL logs carry no token/cost data; use `pnpm run import --source codex` for cost backfill.
- If Codex terminal activity is visible but `source=otel` stops updating, verify sessions are not still exporting to `127.0.0.1:3142` from older runtime config.
- V1 endpoints remain active for legacy compatibility and current monitor behaviors, but they are not the long-term canonical product contract.
- The Monitor header uses provider-native quota snapshots only. Codex quotas are polled from the local `codex app-server`; Claude quotas require the Claude statusline bridge and otherwise render as unavailable instead of estimated.
- V2 API is the canonical app contract: all endpoints under `/api/v2/`.
  - `GET /api/v2/sessions`: list browsing sessions (cursor pagination, project/agent filters).
  - `GET /api/v2/sessions/:id`: single session detail.
  - `GET /api/v2/sessions/:id/messages`: messages with offset pagination.
  - `GET /api/v2/sessions/:id/children`: sub-sessions.
  - `GET /api/v2/search?q=`: FTS5 full-text search with snippet highlighting.
  - `GET /api/v2/analytics/summary|activity|projects|tools`: analytics endpoints.
  - `GET /api/v2/projects`, `GET /api/v2/agents`: filter option lists.
- V2 DB tables: `browsing_sessions`, `messages`, `tool_calls`, `messages_fts` (FTS5), `watched_files`.
- File-watcher auto-discovers `~/.claude/projects/**/*.jsonl`, parses messages/tool_calls, deduplicates by file hash.

## Implementation Guardrails

- Keep TypeScript ESM import style consistent (existing `.js` extension pattern in TS imports).
- Keep v1 SQL in `src/db/queries.ts`, v2 SQL in `src/db/v2-queries.ts`.
- Keep v2 route handlers in `src/api/v2/router.ts`.
- Prefer extending the Svelte `/app/` product path and v2 contracts over adding new behavior to the legacy `/` dashboard.
- Preserve logical commit history on feature branches. For PR merges, prefer merge commits and do not squash branch history.
- If API response shape changes, update `README.md` in the same change.
- Do not commit local runtime artifacts (`data/`, `*.db`, generated CSS output).
- **`performance.now()` vs `Date.now()`**: Never mix these in deadline calculations. `performance.now()` returns monotonic ms from process start (~small number); `Date.now()` returns epoch ms (~1.7 trillion). Mixing them produces instant timeouts.
- **Dashboard bootstrap hard-depends on `GET /api/events`**: `public/js/app.js` parses stats, events, and sessions together before loading cost/tool sections. If `GET /api/events` returns non-JSON (for example 405 HTML), `reloadData()` throws and cost/tool panels stay blank even when `/api/stats/cost` has data.

## Testing

**Pre-push check**: Before pushing updates to the remote, run `pnpm build`, `pnpm css:build` (if frontend styles touched), and `pnpm rust:test` (if Rust code touched).

**TDD**: Use red/green TDD for new features and major changes.

**Key patterns**:
- `pnpm exec playwright test` for browser-based end-to-end UI testing
- Manual sanity check: `GET /api/health`
