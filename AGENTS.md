# AGENTS.md

Real-time localhost dashboard and session browser for monitoring AI agent activity across Claude Code and Codex.

## Project Snapshot

- Backend: Node.js + TypeScript + Express + SQLite (`better-sqlite3`).
- Svelte 5 frontend: Vite SPA served at `/app/` — canonical product surface.
- Legacy frontend: static HTML + vanilla JS at `/` — transitional compatibility surface only.
- Rust backend (`rust-backend/`): axum + tokio + rusqlite alternate runtime under evaluation.
- Transport: HTTP ingestion + Server-Sent Events for live updates.
- Session ingestion: chokidar file-watcher discovers `~/.claude/projects/**/*.jsonl` automatically.
- Default bind: `127.0.0.1:3141` (TS), `127.0.0.1:3142` (Rust).

## Documentation Map

- `docs/system/ARCHITECTURE.md` — runtime layout, directory map, DB schema, route file map, SSE broadcasting, event contract, OTEL parser + Codex telemetry capability matrix.
- `docs/system/FEATURES.md` — product surface, full v1/v2 API endpoint catalog, SSE event types, capture/redaction controls.
- `docs/system/OPERATIONS.md` — operational runbook.
- `docs/project/ROADMAP.md`, `docs/project/GIT_HISTORY_POLICY.md` — project direction and history conventions.
- `rust-backend/AGENTS.md` — Rust backend commands, gotchas, parity tests.
- `frontend/AGENTS.md` — Svelte frontend code map, dev workflow, API consumption.

## Working Commands

- Install: `pnpm install` (workspace install — backend + `frontend/`)
- Dev server: `pnpm dev`
- Production build / start: `pnpm build` / `pnpm start`
- CSS: `pnpm css:build`, `pnpm css:watch`
- Import historical logs: `pnpm run import` (`--source`, `--from`, `--to`, `--dry-run`, `--force`)
- Reparse session-browser history: `pnpm reparse:sessions` (Claude), `pnpm reparse:codex-sessions` (Codex)
- Seed local demo data (server must be running): `pnpm seed`
- Install Claude quota bridge: `./hooks/claude-code/install-statusline-bridge.sh`

For canonical Svelte UI dev, run three terminals: `pnpm dev`, `pnpm css:watch`, `pnpm frontend:dev`.

## Implementation Guardrails

- Keep TypeScript ESM import style consistent (existing `.js` extension pattern in TS imports).
- Keep v1 SQL in `src/db/queries.ts`, v2 SQL in `src/db/v2-queries.ts`. Keep v2 route handlers in `src/api/v2/router.ts`.
- Prefer extending the Svelte `/app/` product path and v2 contracts over adding new behavior to the legacy `/` dashboard.
- Preserve logical commit history on feature branches. For PR merges, prefer merge commits and do not squash branch history.
- If API response shape changes, update `README.md` in the same change.
- Do not commit local runtime artifacts (`data/`, `*.db`, generated CSS output).
- **`performance.now()` vs `Date.now()`**: Never mix these in deadline calculations. `performance.now()` returns monotonic ms from process start; `Date.now()` returns epoch ms (~1.7 trillion). Mixing them produces instant timeouts.
- **Dashboard bootstrap hard-depends on `GET /api/events`**: `public/js/app.js` parses stats, events, and sessions together before loading cost/tool sections. If `GET /api/events` returns non-JSON (e.g. 405 HTML), `reloadData()` throws and cost/tool panels stay blank even when `/api/stats/cost` has data.
- **Codex OTEL drop-out**: if Codex terminal activity is visible but `source=otel` stops updating, verify sessions are not still exporting to `127.0.0.1:3142` from older runtime config.
- **Provider quotas**: Monitor header uses provider-native snapshots only. Codex quotas come from local `codex app-server`; Claude quotas require the statusline bridge and otherwise render as unavailable rather than estimated.

## Testing

- **Pre-push**: `pnpm build`, `pnpm css:build` (if frontend styles touched), `pnpm rust:test` (if Rust touched).
- **TDD**: red/green for new features and major changes.
- **E2E**: `pnpm exec playwright test` for browser-based UI testing.
- **Sanity**: `GET /api/health`.
