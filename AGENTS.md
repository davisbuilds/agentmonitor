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

- `docs/system/ARCHITECTURE.md` — high-level flow, canonical surface, Rust runtime status, route map, DB schema, SSE broadcasting, event contract, pricing engine, import pipeline, session sync, OTEL parser + Codex telemetry capability matrix, runtime path resolution, directory map.
- `docs/system/FEATURES.md` — product surface, full v1/v2 API endpoint catalog, SSE event types, capture/redaction controls, analytics/usage/insights/search.
- `docs/system/OPERATIONS.md` — local dev, full command catalog, all `AGENTMONITOR_*` env vars, Claude Code + Codex hook install, historical import, CI gates, runtime artifacts, manual live verification.
- `docs/system/DESIGN.md` — Svelte `/app/` design system ("Instrument Console"): color/type/space/radius tokens, layout language, accessibility floor. Tokens live in `frontend/src/app.css` `@theme`.
- `docs/api/` — API navigation reference.
- `docs/project/ROADMAP.md` — direction (legacy `/` reduction, Live fidelity, Rust convergence).
- `docs/project/GIT_HISTORY_POLICY.md` — merge-commit-only policy and rationale.
- `rust-backend/AGENTS.md`, `frontend/AGENTS.md` — domain-specific guidance.
- `hooks/claude-code/README.md`, `hooks/codex/README.md` — hook setup details.

## Command Quickstart

```bash
pnpm install
pnpm dev          # terminal 1: server in watch mode
pnpm frontend:dev # terminal 2: Svelte at :5173 with API proxy
pnpm css:watch    # terminal 3: shared Tailwind output (optional)
```

Full command catalog (build, test, parity, import, reparse, seed, bench) is in `docs/system/OPERATIONS.md`.

## Implementation Guardrails

- Keep TypeScript ESM import style consistent (existing `.js` extension pattern in TS imports).
- Keep v1 SQL in `src/db/queries.ts`, v2 SQL in `src/db/v2-queries.ts`. Keep v2 route handlers in `src/api/v2/router.ts`.
- Prefer extending the Svelte `/app/` product path and v2 contracts over adding new behavior to the legacy `/` dashboard.
- If API response shape changes, update `README.md` in the same change.
- **`performance.now()` vs `Date.now()`**: Never mix these in deadline calculations. `performance.now()` returns monotonic ms from process start; `Date.now()` returns epoch ms (~1.7 trillion). Mixing them produces instant timeouts.
- **Dashboard bootstrap hard-depends on `GET /api/events`**: `public/js/app.js` parses stats, events, and sessions together before loading cost/tool sections. If `GET /api/events` returns non-JSON (e.g. 405 HTML), `reloadData()` throws and cost/tool panels stay blank even when `/api/stats/cost` has data.
- **Codex OTEL drop-out**: if Codex terminal activity is visible but `source=otel` stops updating, verify sessions are not still exporting to `127.0.0.1:3142` from older runtime config.
- **Provider quotas**: Monitor header uses provider-native snapshots only. Codex from local `codex app-server`; Claude requires the statusline bridge or renders as unavailable rather than estimated.

## Testing

- **Pre-push** (matches required CI): `pnpm lint`, `pnpm build`, `pnpm test`. Run `pnpm rust:test` if Rust touched, `pnpm css:build` if frontend styles touched.
- **TDD**: red/green for new features and major changes.
- **E2E**: `pnpm exec playwright test`.
- **Sanity**: `GET /api/health`.

## Working Agreement

- **Push back before building.** If a request is incoherent or self-contradictory, or a spec/plan is vague or skips key decisions, stop and interview me — ask clarifying questions and confirm intent before writing code or changing files. Don't guess at scope or comply silently. (Clear, well-scoped requests don't need this.)
- **Keep docs current.** After a significant change, PR, or completed spec/plan, update any now-stale reference docs under `docs/system/` (and `docs/project/ROADMAP.md`) so they match shipped behavior. Skip this for trivial changes.
