# Svelte 5 Frontend

Vite SPA served at `/app/` with Monitor, Sessions, Search, and Analytics tabs.
This is the canonical product surface for AgentMonitor.

See root `AGENTS.md` for project overview, API contract (V2 endpoints this app consumes), and shared conventions.

## Working Commands

- Build: `pnpm frontend:build` (output at `frontend/dist/`, served at `/app/`)
- Dev: `pnpm frontend:dev` (Vite dev server at `:5173` with API proxy to `:3141`)

## Code Map

- `src/lib/components/monitor/`: Monitor tab (real-time dashboard).
- `src/lib/components/sessions/`: Sessions tab (session browser + message viewer).
- `src/lib/components/search/`: Search tab (FTS5 full-text search).
- `src/lib/components/analytics/`: Analytics tab (charts, project/tool breakdowns).
- `src/lib/api/client.ts`: typed API client for v1 and v2 endpoints.
- `src/lib/stores/`: Svelte 5 reactive state (runes).

## API Consumption

This app consumes the canonical V2 REST API defined in the root `AGENTS.md` API Contract Notes section. Some `Monitor` behaviors still depend on v1 endpoints today, but new product-contract work should prefer v2. Key endpoints:

- `GET /api/v2/sessions` — session list with cursor pagination
- `GET /api/v2/sessions/:id/messages` — message viewer data
- `GET /api/v2/search?q=` — FTS5 search with snippet highlighting
- `GET /api/v2/analytics/*` — summary, activity, projects, tools
- `GET /api/stream` — SSE for live updates (event names: `event`, `stats`, `session_update`)
