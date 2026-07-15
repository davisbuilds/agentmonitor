# AGENTS.md

Real-time localhost dashboard and session browser for monitoring AI agent activity across Claude Code and Codex.

## Project Snapshot

- Backend: Node.js + TypeScript + Express + SQLite (`better-sqlite3`).
- Svelte 5 frontend: Vite SPA served at `/app/` — canonical product surface.
- Legacy frontend: static HTML + vanilla JS at `/` — transitional compatibility surface only.
- Transport: HTTP ingestion + Server-Sent Events for live updates.
- Session ingestion: chokidar file-watcher discovers `~/.claude/projects/**/*.jsonl` automatically.
- Default bind: `127.0.0.1:3141`.

## Documentation Map

- `docs/system/ARCHITECTURE.md` — high-level flow, canonical surface, route map, DB schema, SSE broadcasting, event contract, pricing engine, import pipeline, session sync, OTEL parser + Codex telemetry capability matrix, runtime path resolution, directory map.
- `docs/system/FEATURES.md` — product surface, full v1/v2 API endpoint catalog, SSE event types, capture/redaction controls, analytics/usage/insights/search.
- `docs/system/OPERATIONS.md` — local dev, full command catalog, all `AGENTMONITOR_*` env vars, Claude Code + Codex hook install, historical import, CI gates, runtime artifacts, manual live verification.
- `docs/system/DESIGN.md` — Svelte `/app/` design system ("Instrument Console"): color/type/space/radius tokens, layout language, accessibility floor. Tokens live in `frontend/src/app.css` `@theme`.
- `docs/system/trace-quality.md` — local trace-quality layer: trace/observation model, observation taxonomy, coverage/payload-policy honesty, scores, prompt attribution, findings taxonomy, UI surface, and the deferred (ingestion-API) Langfuse export.
- `docs/api/` — API navigation reference.
- `docs/project/POSITIONING.md` — what the product is (Archetype B: local-first observability console for coding agents); scope, the Langfuse "collector not backend" stance, and the architectural implications that anchor the foundations work.
- `docs/project/ROADMAP.md` — direction (legacy `/` reduction, Live fidelity).
- `docs/project/CURRENT_STATE.md` — high-change product/runtime notes moved out of the root README.
- `docs/project/GIT_HISTORY_POLICY.md` — merge-commit + rebase policy (squash disabled) and rationale.
- `frontend/AGENTS.md` — domain-specific guidance.
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
- **Codex OTEL drop-out**: if Codex terminal activity is visible but `source=otel` stops updating, verify Codex is exporting OTLP to `127.0.0.1:3141` and not a stale endpoint (e.g. an old `:3142` runtime config).
- **Provider quotas**: Monitor header uses provider-native snapshots only. Codex from local `codex app-server`; Claude requires the statusline bridge or renders as unavailable rather than estimated.
- **Every gate reads `src/`; only the built server reads `dist/`**: `pnpm test` (tsx), `pnpm dev` (tsx) and `pnpm lint` all run from source. `amon serve` — how the tool is actually used — loads `dist/`. So a bug in what the build *emits* passes lint, build, and test simultaneously. This shipped stale pricing tables for five months (`cp -r` nesting into `dist/pricing/data/data/`), and an unpriced model bills as **$0 rather than raising**, so the dashboard stayed plausible while under-reporting the top models. `scripts/check-pricing-dist.mjs` guards that one case; the class is wider — any non-TS asset the build copies has this shape. If a bug reproduces for the user but not in tests, check whether they run the built path while you are testing `src/`.

## Testing

- **Pre-push** (matches required CI): `pnpm lint`, `pnpm build`, `pnpm test`. Run `pnpm frontend:check` (svelte-check) if Svelte/frontend TS touched.
- **TDD**: red/green for new features and major changes.
- **E2E**: `pnpm exec playwright test`.
- **Sanity**: `GET /api/health`.
- **Never trust a test you haven't watched fail.** Before claiming a test or CI guard covers a bug, reintroduce the bug and confirm it goes red. The failures worth guarding here are the silent ones — wrong costs, two chart series sharing a color, a test reading the real DB — and they all still render a plausible-looking result, so green on fixed code proves nothing on its own. A Top Models color test once passed against the broken implementation because the fixture had 6 models and the palette has 6 colors.
- **Tests cannot open the install database**: `getDb()` throws under the test runner if the resolved path is `<install-root>/data/agentmonitor.db`. Point `AGENTMONITOR_DB_PATH` at a temp file *before* importing anything that reads `config` — `config.ts` snapshots the env when it is imported, so an early import silently pins the default. Destructive fixtures must also assert that the opened database handle resolves to their intended temp path immediately before any table-wide delete.
- **Session-browser recovery is separate from event import**: `import_state`
  protects `events`, while `watched_files` protects
  `browsing_sessions`/`messages`/`tool_calls`. If those browser tables are lost
  but `watched_files` survives, normal startup skips unchanged JSONLs and leaves
  analytics plausibly sparse. Startup warns when a currently discoverable
  Claude/Codex file is cached as parsed but has no browser projection. Preserve
  the DB first, then run
  `amon sync sessions --source all --force`; `amon import --force` alone does not
  rebuild tool-call or inferred-skill history.

## Working Agreement

- **Push back before building.** If a request is incoherent or self-contradictory, or a spec/plan is vague or skips key decisions, stop and interview me — ask clarifying questions and confirm intent before writing code or changing files. Don't guess at scope or comply silently. (Clear, well-scoped requests don't need this.)
- **Keep docs current.** After a significant change, PR, or completed spec/plan, update any now-stale reference docs under `docs/system/` (and `docs/project/ROADMAP.md`) so they match shipped behavior. Skip this for trivial changes.
- **Commit logically.** Commit completed work in coherent chunks as you proceed. Push only when explicitly asked.
- **Log findings in `BACKLOG.md`.** Note design gaps, tech debt, or better approaches you spot mid-task in `docs/project/BACKLOG.md`; fix simple/quick ones inline and call them out.
- **Re-ground after compaction.** A compaction summary loses precise paths, context, and verification state — before continuing, re-read this project's `AGENTS.md`, its reference docs, and recent commits.
