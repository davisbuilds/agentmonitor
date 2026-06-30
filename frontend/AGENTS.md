# Svelte 5 Frontend

Vite SPA served at `/app/` with Monitor, Live, Sessions, Analytics, and Search tabs.
This is the canonical product surface for AgentMonitor.

See root `AGENTS.md` for project overview, API contract (V2 endpoints this app consumes), and shared conventions.

**Design system:** follow `docs/system/DESIGN.md` ("Instrument Console"). Tokens live in
`src/app.css` `@theme`; use `text-text`/`text-text-muted`, `bg-surface`, `border-line`, the
`text-h1..text-meta` scale, two radii (`rounded-sm`/`rounded-lg`), `font-sans` (Mona Sans, UI) and
`font-mono` (Geist Mono, numerals/code). Redesign is phased — see
`docs/plans/2026-05-25-svelte-ui-redesign-implementation.md`.

## Working Commands

- Build: `pnpm frontend:build` (output at `frontend/dist/`, served at `/app/`)
- Dev: `pnpm frontend:dev` (Vite dev server at `:5173` with API proxy to `:3141`)

## Code Map

- `src/lib/components/monitor/`: Monitor tab (real-time dashboard).
- `src/lib/components/sessions/`: Sessions tab. `SessionsShell.svelte` renders Browse | Pinned SubTabs (Pinned folded in from its old top-level tab); Browse = `SessionsPage` (list + `SessionViewer`), Pinned = `components/pinned/PinnedPage`. `view` rides the `#sessions?view=…` hash; legacy `#pinned` redirects to `#sessions?view=pinned`.
- `src/lib/components/search/`: Search tab (FTS5 full-text search).
- `src/lib/components/analytics/`: Analytics tab. `AnalyticsShell.svelte` hosts the shared filter bar + SubTabs and renders four sub-views — Overview (these components), Usage (`components/usage/`), Insights (`components/insights/`), and Quality (`components/trace-quality/`). Shared filter state + the `#analytics?view=…` hash live in `stores/analytics-filters.svelte.ts`; the `analytics`/`usage`/`insights`/`trace-quality` data stores read filters from it and subscribe for refetch.
- `src/lib/components/trace-quality/`: lean Quality sub-view (one trace per session, summary-backed list + on-demand detail). `TraceQualityPage` (list + inspector), `TraceTree` (recursive observation tree, read straight from the loaded detail), `TraceCoverageBadge`, `TraceDrillInLink` (session drill-in from Usage/Analytics/Live/Sessions/Search). Backed by `stores/trace-quality.svelte.ts`; `?session=`/`?trace=` ride the analytics hash. The eval/dashboards depth (scores, findings, prompt rollups, score trends) was removed in the trace-quality reframe — that depth is deferred to the export (Langfuse/medallion); see `docs/project/POSITIONING.md`.
- `src/lib/api/client.ts`: typed API client for v1 and v2 endpoints.
- `src/lib/stores/`: Svelte 5 reactive state (runes).

## API Consumption

This app consumes the canonical V2 REST API defined in the root `AGENTS.md` API Contract Notes section. Some `Monitor` behaviors still depend on v1 endpoints today, but new product-contract work should prefer v2. Key endpoints:

- `GET /api/v2/sessions` — session list with cursor pagination
- `GET /api/v2/sessions/:id/messages` — message viewer data
- `GET /api/v2/search?q=` — FTS5 search with snippet highlighting
- `GET /api/v2/analytics/*` — summary, activity, projects, tools
- `GET /api/stream` — SSE for live updates (event names: `event`, `stats`, `session_update`)
