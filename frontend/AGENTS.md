# Svelte 5 Frontend

Vite SPA served at `/app/` with Monitor, Sessions, Analytics, and Benchmarks tabs. An agent card on Monitor opens that session's live stream (`components/monitor/MonitorStream.svelte`).
This is the canonical product surface for AgentMonitor.

See root `AGENTS.md` for project overview, API contract (V2 endpoints this app consumes), and shared conventions.

**Design system:** follow `docs/system/DESIGN.md` ("Instrument Console"). Tokens live in
`src/app.css` `@theme`; use `text-text`/`text-text-muted`, `bg-surface`, `border-line`, the
`text-h1..text-meta` scale, two radii (`rounded-sm`/`rounded-lg`), `font-sans` (Mona Sans, UI) and
`font-mono` (Geist Mono, numerals/code).

## Working Commands

- Build: `pnpm frontend:build` (output at `frontend/dist/`, served at `/app/`)
- Dev: `pnpm frontend:dev` (Vite dev server at `:5173` with API proxy to `:3141`)
- Unit test: `pnpm frontend:test` (Vitest, run from root) — covers the stores
  and some pure `lib/*.ts` logic. Most pure-helper tests are still root
  `node:test` files under `tests/`, run by `pnpm test` (see the BACKLOG entry
  on the split). Vitest runs through the Svelte plugin so `.svelte.ts` `$state`
  compiles as it does in the build. Test files are `src/**/*.test.ts`; module
  singletons are reset per test with `vi.resetModules()`. Component-mount +
  `$derived`/`$effect` reactivity coverage is deferred (would add
  `@testing-library/svelte` + `flushSync`).

## Code Map

- `src/lib/components/monitor/`: Monitor tab (real-time dashboard). An agent card opens `MonitorStream` (the followed session's live stream at `#monitor?session=…`, built from `components/live/ItemStream` + `InspectorPanel` and `stores/live.svelte.ts`); legacy `#live` redirects to Monitor. With the live view off, cards open the `SessionDetail` drawer.
- `src/lib/components/sessions/`: Sessions tab. `SessionsPage` owns the `#sessions?…` hash (`q`, `sort`, `project`, `agent`, `pinned`, `session`, `message`) and shows the `SessionViewer`, or one of three list bodies picked by `sessionsListMode` (`lib/sessions-browse.ts`): the session list; `SearchResults` (FTS5 message search via a page-local `createSearchStore`) while a query is entered; `PinnedMessages` while the Pinned filter is on (pins filtered client-side by `filterPinnedMessages`). The Search tab and the Pinned sub-view folded in here: legacy `#search?…`, `#pinned` and `#sessions?view=pinned` links redirect via `canonicalizeLegacy*Hash` in `route-state.ts`.
- `src/lib/components/analytics/`: Analytics tab. `AnalyticsShell.svelte` hosts the shared filter bar + SubTabs and renders five sub-views — Overview, Usage (`components/usage/`), Skills (the filterable consultation evidence ledger), Insights (`components/insights/`), and Quality (`components/trace-quality/`). Overview holds activity panels only: top sessions live in Usage (by cost), and every skill panel (daily invocation volume + the consultation explorer) lives in Skills. Insights is listed only once a provider key is configured (`analytics-views.ts`, fed by `insights.availability`); an Insights deep link without one renders Overview. Shared filter state + the `#analytics?view=…` hash live in `stores/analytics-filters.svelte.ts`; the `analytics`/`usage`/`insights`/`trace-quality` data stores read filters from it and subscribe for refetch.
- `src/lib/components/trace-quality/`: lean Quality sub-view (one trace per session, summary-backed list + on-demand detail). `TraceQualityPage` (list + inspector), `TraceTree` (recursive observation tree, read straight from the loaded detail), `TraceCoverageBadge`, `TraceDrillInLink` (session drill-in from Usage's top sessions, the live stream's inspector, and Sessions: viewer and search results). Backed by `stores/trace-quality.svelte.ts`; `?session=`/`?trace=` ride the analytics hash. The persisted eval/dashboard depth (scores, findings, prompt rollups, score trends) was removed in the trace-quality reframe. Current local projection and deferred export boundaries live in `docs/system/trace-quality.md`; broader direction lives in `docs/project/VISION.md`.
- `src/lib/components/benchmarks/`: Benchmarks tab (segregated bake-off comparison). `BenchmarksPage.svelte` renders the studies list → study detail (arm ladder with verdict Badges + auto-generated honesty panel). Selected study rides `#benchmarks?study=<study_id>`; data via `stores/benchmarks.svelte.ts` off `GET /api/v2/benchmarks[/:studyId]`. Study detail also renders `BenchmarkFrontier.svelte` — a cost×score Pareto scatter on the shared `ui/chart/` primitives (`scales.ts`, `layout.ts`, `PlotFrame.svelte`) with pure geometry in `frontier-geometry.ts`; markers click-drill to the matching ladder row.
- `src/lib/api/client.ts`: typed API client for v1 and v2 endpoints.
- `src/lib/stores/`: Svelte 5 reactive state (runes).

## API Consumption

This app consumes the canonical V2 REST API defined in the root `AGENTS.md` API Contract Notes section. Some `Monitor` behaviors still depend on v1 endpoints today, but new product-contract work should prefer v2. Key endpoints:

- `GET /api/v2/sessions` — session list with cursor pagination
- `GET /api/v2/sessions/:id/messages` — message viewer data
- `GET /api/v2/search?q=` — FTS5 search with snippet highlighting
- `GET /api/v2/analytics/*` — summary, activity, projects, tools
- `GET /api/stream` — SSE for live updates (event names: `event`, `stats`, `session_update`)
