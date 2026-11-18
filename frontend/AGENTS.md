# Svelte 5 Frontend

Vite SPA served at `/app/` with Monitor, Analytics, Sessions, and Benchmarks tabs;
the canonical product surface for AgentMonitor. The root `AGENTS.md` holds the
project rules, gate, and Working Agreement; the tab-by-tab code map lives in
`docs/system/ARCHITECTURE.md` → Frontend (`/app/`).

**Design system:** follow `docs/system/DESIGN.md` ("Instrument Console"). Tokens live in
`src/app.css` `@theme`; use `text-text`/`text-text-muted`, `bg-surface`, `border-line`, the
`text-h1..text-meta` scale, two radii (`rounded-sm`/`rounded-lg`), `font-sans` (Mona Sans, UI) and
`font-mono` (Geist Mono, numerals/code).

## Commands and tests

Run from the repo root: `pnpm frontend:dev` (Vite at `:5173`, API proxy to
`:3141`), `pnpm frontend:build` (to `frontend/dist/`, served at `/app/`),
`pnpm frontend:check` (svelte-check; type-checks only, never runs rune code), and
`pnpm frontend:test` (Vitest over `src/**/*.test.ts`).

- Vitest covers the stores and some pure `lib/*.ts` logic. Most pure-helper tests
  are still root `node:test` files under `tests/`, run by `pnpm test` (see the
  BACKLOG entry on the split).
- Vitest runs through the Svelte plugin so `.svelte.ts` `$state` compiles as it
  does in the build. Reset module singletons per test with `vi.resetModules()`.
- Component-mount and `$derived`/`$effect` reactivity coverage is deferred (it
  would add `@testing-library/svelte` + `flushSync`).

## Store invariant

Async loads that a newer one can supersede (a filter change, another item opened,
a jump) guard their writes with `latestRequest()` (`src/lib/stores/latest-request.ts`):
`begin()` supersedes, `join()` runs beside the current request (a page appended
to it), `invalidate()` clears. Check the returned `isCurrent()` after every
`await`, before writing data, errors or loading flags.

## API consumption

The app consumes the canonical v2 API, owned by `docs/api/` (exact routes are
source-owned: `src/lib/api/client.ts` here, `src/api/v2/router.ts` on the
server). Its one v1 dependency is the shared SSE stream `GET /api/stream`
(message types `event`, `stats`, `session_update`; no replay after a reconnect).
New product-contract work goes to v2.
