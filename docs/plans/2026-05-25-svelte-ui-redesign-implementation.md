---
date: 2026-05-25
topic: svelte-ui-redesign
stage: implementation-plan
status: phase-1-complete
source: conversation
---

## Implementation Status

As of 2026-05-25, **Phase 1 (Foundation) is complete** on branch
`feat/ui-redesign-instrument-console`. Phases 2–6 remain.

- Task 1.0 — Tailwind wired into Vite (`@tailwindcss/vite` + `import './app.css'`); dropped the
  `/css` proxy and `output.css` link. Dev (`:5173`) and built (`:3141`) `/app/` both render styled.
- Task 1.1 — `@theme` token system authored in `frontend/src/app.css` (surfaces, AA text ramp,
  scarce semantic accents, 1.25 type scale, two radii, motion defaults, focus-visible base).
- Task 1.2 — Mona Sans (UI / `font-sans`) + Geist Mono (data / `font-mono`) self-hosted via Fontsource.
- Task 1.3 — Shell collapsed from four stacked bars to one command bar + contextual filter sub-bar;
  `QuotaPill` (compact + popover) replaces the full-width quota bar; `StatsBar` moved into Monitor;
  shell/`ConnectionStatus`/`FilterBar` tokenized.
- Task 1.4 — `docs/system/DESIGN.md` authored; doc map + frontend guidance updated.

Verification: `pnpm lint`, `pnpm build`, `pnpm test` (445 pass / 0 fail). Visual baselines and
post-Phase-1 captures in git-ignored `.design-audit/shots/`.

Remaining: Phase 2 (shared primitives), Phase 3 (Monitor), Phase 4 (Sessions/Search/Pinned),
Phase 5 (Analytics consolidation), Phase 6 (Live + responsive + motion + docs).


# Svelte UI Redesign Implementation Plan

## Goal

Redesign the canonical Svelte `/app/` surface from an unpolished, crowded, mono-everything
dashboard into a calm, information-dense **"Instrument Console"**: a real design-token system,
a proportional UI typeface paired with mono for data, a panel/bento layout language for dense
data, and a single command bar that replaces today's four stacked chrome rows. No backend API
or data-contract changes — this is a frontend design-system effort.

The redesign is driven by a category-by-category design critique (slop-catalog walk) and a
committed aesthetic direction (frontend-design). Screenshots of the current state are archived
under `.design-audit/shots/` (git-ignored).

## Decisions (locked with stakeholder)

- **Aesthetic:** Instrument Console — near-monochrome cool-dark canvas, structure carried by
  hairlines + tint + type weight, color used as *signal* (status/provider) not decoration, one
  interactive accent. Calm power-user cockpit, not a marketing page.
- **Information architecture:** Consolidate the three overlapping analytics tabs
  (**Usage + Analytics + Insights → one `Analytics` tab with sub-views**) as part of the work,
  alongside the visual redesign.
- **Scope/sequencing:** Foundation-first and phased. Phase 1 lands tokens + type + shell;
  later phases migrate tabs. Each phase is independently shippable and behavior-preserving.

## Critique findings this plan must resolve

From the slop-catalog audit (high → low):

- `monospace-as-technical`, `single-font-everywhere` — entire app in `ui-monospace` incl. headings/prose.
- `flat-type-hierarchy` — `h1` (`text-lg`) ≈ body (`text-sm`); section titles same size as body.
- `low-contrast-text` — `text-gray-700/600/500` metadata fails AA on the `gray-950` canvas.
- `tiny-body-text` — `text-[10px]`/`text-[11px]`/`text-xs` for real content.
- `everything-in-cards`, `identical-card-grids` — card-per-metric walls; uniform 9-up stat grids.
- `line-length-too-long` — coverage/capability banners run full container width.
- `nested-cards`, `monotonous-spacing`, `cramped-padding` — compounding containers; one 16px gap for everything.
- `redundant-information` — stacked heading + subtitle + banner + pill all re-explaining the same concept.
- `amputated-mobile` — Tokens stat and 7d/30d/90d quick-ranges hidden below breakpoints with no replacement.
- Out-of-catalog root causes: **no design tokens** (`app.css` is just `@import "tailwindcss"`),
  radius sprawl (5 radii), surface sprawl (`bg-gray-900` vs `/40` `/50` `/70`), accent-hue sprawl
  (blue/sky/emerald/green/amber/orange/purple/red/yellow), and **chrome overload** (4 stacked top bars).

## Scope

### In Scope

- A Tailwind v4 `@theme` token system in `frontend/src/app.css` (color, type, space, radius, shadow, motion).
- Self-hosted proportional UI face (**Mona Sans**) + data/mono face (**Geist Mono**), with tabular numerals.
- A small set of shared Svelte primitives (Panel, Button, Field/Select, Stat, DataTable, Badge/StatusDot,
  Bar, EmptyState, Toolbar/FilterBar, Popover, SubTabs) that replace ad-hoc utility clusters.
- Shell/chrome rework: 4 stacked bars → 1 command bar + 1 contextual sub-bar; quota → compact popover;
  stats moved out of the global header; filter overflow behind a popover.
- IA consolidation: `Usage` + `Analytics` + `Insights` merged into one `Analytics` tab with sub-views;
  router/tab updates; deep-link/hash preservation.
- Per-tab visual migration (Monitor, Sessions, Search, Pinned, Analytics group, Live) onto tokens + primitives.
- Responsive pass so all features remain reachable on mobile (no amputated features).
- Restrained motion (`transform`/`opacity` only), contrast/a11y verification, and Playwright visual capture.
- Fix the frontend dev-CSS pipeline so `/app/` is styled at `:5173` (see Assumptions / Phase 1, Task 1.0).
- Documentation: a human-readable token reference (`docs/system/DESIGN.md`) and updates to
  `ARCHITECTURE.md` / `FEATURES.md` / `ROADMAP.md` where the surface changes.

### Out Of Scope

- Any backend, `/api/v2/*`, SSE, pricing, or DB change. Response shapes are unchanged.
- Rust backend changes. Rust serves the built `dist/`; no parity work is required by this plan.
- The legacy `/` vanilla dashboard. It stays on the existing `public/css/output.css` build untouched.
- New product features, new metrics, or new data sources. This is presentation only.
- Auth, theming beyond the single dark Instrument Console theme (a light theme is a later, optional follow-up).
- Replacing Tailwind or introducing a component library (Skeleton, shadcn-svelte, etc.).

## Assumptions And Constraints

- Canonical surface is the Svelte `/app/` SPA; all work lives under `frontend/`.
- Tailwind v4 stays. Tokens are defined with `@theme` so they generate utilities and CSS vars; no JS config file.
- **Dev-CSS bug (must fix in Phase 1):** today the frontend has no `@tailwindcss/vite` plugin and `main.ts`
  never imports `app.css`; styling depends entirely on `<link href="/css/output.css">` proxied to the backend.
  Vite's `base: '/app/'` rewrites that href to `/app/css/output.css`, which the `:5173` proxy does not match,
  so the dev server serves the SPA fallback as the stylesheet and renders **unstyled**. The built app at
  `:3141/app/` is styled correctly. Fix by adding `@tailwindcss/vite` and `import './app.css'` in `main.ts`
  so Vite compiles Tailwind itself (this also fixes Tailwind content-scanning of `.svelte` files — e.g.
  `xl:grid-cols-12` is currently missing from the backend-built `output.css`). The legacy `/` dashboard keeps
  its own `pnpm css:build` output; only the frontend decouples.
- Behavior, deep links (Sessions hash state, `navigateToSession`), keyboard shortcuts (⌘K), and SSE live
  updates must be preserved across every phase. Redesign is visual + structural, not behavioral.
- Fonts are self-hosted woff2 under `frontend/public/fonts/` (Mona Sans + Geist Mono are SIL OFL). Preload to
  avoid FOUT; provide a system fallback stack.
- Accessibility floor: body/secondary text ≥ 4.5:1, large/numeric ≥ 3:1, all interactive controls keyboard
  reachable and focus-visible. Verify against rendered surfaces, not assumed values.
- Each phase ends green on the project gates and leaves `/app/` shippable.

## Design Foundation Reference

These are the target token values (final names/tuning happen in Task 1.1). OKLCH for perceptual consistency.

```
/* Surfaces — cool-tinted near-black, never #000 */
--canvas       oklch(0.15 0.010 250)   /* page            */
--surface      oklch(0.19 0.012 250)   /* panels          */
--surface-2    oklch(0.23 0.014 250)   /* raised / hover  */
--line         oklch(0.30 0.012 250)   /* hairline border */
--line-strong  oklch(0.38 0.012 250)

/* Text — all clear AA on --canvas */
--text         oklch(0.96 0.000 0)     /* primary  ~16:1            */
--text-muted   oklch(0.78 0.010 250)   /* secondary ~6:1  (replaces gray-500/600/700) */
--text-faint   oklch(0.62 0.010 250)   /* meta floor ~3.5:1 — large/numeric only      */

/* Signal accents — scarce, semantic */
--accent       oklch(0.70 0.150 235)   /* the ONE interactive/brand hue */
--ok           oklch(0.72 0.150 155)   /* healthy / added — retire green↔emerald split */
--warn         oklch(0.80 0.140 85)
--danger       oklch(0.65 0.200 25)
--provider-claude oklch(0.78 0.120 65) /* warm amber, identity only */
--provider-codex  var(--text-muted)    /* neutral */

/* Type scale (1.25) */
display 30 / h1 24 / h2 19 / h3 16 / body 14 / meta 12.5   /* 12.5 is the hard floor */
--font-ui   "Mona Sans", ui-sans-serif, system-ui, sans-serif
--font-num  "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace  /* tabular-nums */

/* Space — 3 deliberate steps */
--space-tight 8 / --space-group 16 / --space-section 32

/* Radius — collapse 5 → 2 */
--r-sm 6px   /* controls, chips, bars */
--r    10px  /* panels */
/* rounded-full reserved for dots/pills only */

/* Elevation — borders carry structure; shadow only for floating layers */
--shadow-overlay  (command palette, inspector, popover only)

/* Motion */
--ease ease-out; --dur 140ms;  transform/opacity only
```

## Implementation Phases

### Phase 1 — Foundation: tokens, type, dev-CSS, shell chrome

Goal: a working token system, the new type pairing, a styled dev server, and a de-cluttered shell.
After this phase the app looks different and calmer even before per-tab migration.

- **Task 1.0 — Fix the frontend dev-CSS pipeline.** Add `@tailwindcss/vite` to `frontend/`,
  `import './app.css'` in `main.ts`, remove the `/css/output.css` `<link>` from `frontend/index.html`,
  drop the now-unneeded `/css` proxy in `vite.config.ts`. Verify `/app/` is styled at both `:5173` (dev)
  and `:3141` (built). Confirm `frontend:build` emits a bundled CSS asset. Leave root `css:build` (legacy `/`) intact.
- **Task 1.1 — Author the token system.** Define the `@theme` block in `app.css` from the Foundation Reference.
  Verify every `--text-*` token against its surface with a contrast check before committing values.
- **Task 1.2 — Self-host the type pairing.** Add Mona Sans + Geist Mono woff2 under `public/fonts/`, `@font-face`
  + preload, set `--font-ui` on `<body>`, add a `tabular-nums` numeric utility. Replace the body `font-mono`.
- **Task 1.3 — Shell chrome rework (`App.svelte`).** Collapse the four stacked bars into:
  (1) a persistent command bar (~52px): wordmark · primary tabs · spacer · compact quota pill · ⌘K search · connection dot;
  (2) a contextual sub-bar that only renders on tabs that filter. Move the global StatsBar metrics out of the header.
  Convert `UsageMonitor` from a permanent full-width bar into the compact quota pill + popover.
- **Task 1.4 — Token reference doc.** Write `docs/system/DESIGN.md` documenting the tokens, type roles, spacing
  steps, radius rules, and "color = signal" principle as the human-readable source of truth.

Verify: `pnpm lint && pnpm build && pnpm test`; styled at `:5173` and `:3141`; capture Phase-1 screenshots for diff.

### Phase 2 — Shared primitives

Goal: a small primitive layer so per-tab migration is composition, not utility-copying. Build with stories/smoke
usage; no behavior beyond presentation.

- **Task 2.1 — Structure primitives:** `Panel` + `PanelHeader` (hairline panel, optional header row, optional
  actions slot), `SubTabs` (sub-view switcher for the Analytics group), `Toolbar`/`FilterBar` (with overflow `Popover`).
- **Task 2.2 — Control primitives:** `Button` (primary / neutral / ghost variants — enforce one primary per surface),
  `Field` + `Select` (single control height, `--r-sm`, ≥ `px-3 py-2`), `Popover`.
- **Task 2.3 — Data primitives:** `Stat` (number-led, `tabular-nums`, optional delta), `DataTable` (breathing rows
  `py-2.5`, hairline row separators, sticky header, right-aligned numerics), `Bar` (inline value bar), `Badge` +
  `StatusDot` (demoted capability/status indicators — tinted dot + label, not loud pills), `EmptyState`.

Verify: gates green; primitives render in isolation; no tab wired yet (or wire one trivially as a smoke test).

### Phase 3 — Monitor tab

Migrate `monitor/*` onto tokens + primitives. `AgentCards` → `Panel` + breathing rows; `CostDashboard` /
`ToolAnalytics` → `Panel` + `DataTable`/`Bar`; reintroduce the global stats as a slim inline strip on Monitor only
(`StatsBar`); `SessionDetail` drawer onto tokens; tame the filter bar with overflow popover. Resolve
`everything-in-cards`/`nested-cards` here.

Verify: gates green; live SSE updates still flow; ⌘K, drawer, filters behave; screenshot diff vs baseline.

### Phase 4 — Sessions, Search, Pinned

- `sessions/SessionsPage` list: breathing rows, demoted capability badges (`Badge`/`StatusDot`), preserve hash
  deep-links and back-stack. `SessionViewer` / `MessageBlock` / `ActivityMinimap` onto tokens + `Panel`.
- `search/SearchPage`: tokens + `DataTable`/result rows; keep FTS snippet highlighting.
- `pinned/PinnedPage`: tokens + primitives.

Verify: gates green; deep-link/hash, snippet highlighting, pin/unpin all work; screenshot diff.

### Phase 5 — Analytics consolidation (Usage + Analytics + Insights → one `Analytics`)

The IA change plus visual migration of the densest surfaces.

- **Task 5.1 — Router/tab model.** Update `router.svelte.ts` (`Tab` type) and `App.svelte` tabs: replace
  `analytics`/`usage`/`insights` with a single `analytics` tab; add a sub-view dimension (`overview` | `usage` |
  `insights`) rendered via `SubTabs`. Map old deep links/anchors to the new sub-views (preserve existing entry points).
- **Task 5.2 — Migrate components** under one `analytics/` group: shared filter bar (date + project + agent, overflow
  popover for provider/tier/model), shared coverage affordance. Resolve `redundant-information` — collapse stacked
  heading+subtitle+banner+pill into one heading + a single `ⓘ` coverage tooltip.
- **Task 5.3 — Bento weighting.** Replace the uniform 9-up stat grid (`UsageSummaryCards`) with a weighted bento:
  promote Total Cost + Cache Hit Rate to large cells; collapse the rest into a compact `Stat` strip with vertical
  dividers (no per-tile borders). Charts (`ActivityTimeline`, `SkillUsageTimeline`, `HourOfWeekHeatmap`,
  `UsageTimeline`, breakdown tables) → `Panel` + `DataTable`/`Bar`. Constrain any remaining prose to `max-w-[65ch]`.

Verify: gates green; CSV export, date ranges, prior-period comparison, filters intact; old deep links resolve;
screenshot diff for each sub-view.

### Phase 6 — Live, responsive, motion, polish, docs

- **Task 6.1 — Live tab.** Migrate `live/*` (three-pane operator view) onto tokens + `Panel`; flatten the nested
  capture card (`nested-cards`); raise the `text-[10px]/[11px]` meta to the 12.5 floor; keep the conditional-tab gate.
- **Task 6.2 — Responsive pass.** Eliminate `amputated-mobile`: quick-ranges become a visible segmented control/select
  on mobile; Tokens stat stays reachable (wrap/expander, not `hidden`). Filter sub-bar collapses to a "Filters"
  popover/drawer on small screens. Re-capture `mobile-monitor.png`-equivalents for all tabs.
- **Task 6.3 — Motion + a11y.** Add the one orchestrated moment (live event rows fade+slide via transform/opacity);
  ensure focus-visible rings on all controls; final contrast sweep across rendered tabs (target the catalog's
  `low-contrast-text` / `tiny-body-text` to zero findings).
- **Task 6.4 — Docs + cleanup.** Update `docs/system/ARCHITECTURE.md` (route/tab map), `docs/system/FEATURES.md`
  (tab catalog incl. the Analytics consolidation), `docs/project/ROADMAP.md` (mark the redesign), and the frontend
  `CLAUDE.md` tab list. Confirm `.design-audit/` stays git-ignored or remove it.

Verify: gates green; full manual regression (deep links, long transcripts, live updates, drawer/nav, mobile);
final design-critique re-walk should show the top findings resolved.

## Verification (every phase)

- `pnpm lint`
- `pnpm build`  (runs `tsc`, `css:build` for legacy, and `frontend:build`)
- `pnpm test`
- `pnpm css:build` if legacy-shared styles touched; `pnpm exec playwright test` for affected flows.
- Manual: `GET /api/health`; load `/app/` at `:3141` and `:5173`; smoke the migrated tab incl. live SSE.
- Visual: re-run `.design-audit/capture.mjs` (point at `:3141/app/`) and diff against the prior phase's shots.

## Risks & Mitigations

- **Dev-CSS migration breaks the build** → Task 1.0 is isolated and verified at both ports before any visual work;
  legacy `css:build` is left untouched so `/` is unaffected.
- **IA consolidation breaks deep links** → Task 5.1 explicitly maps old `usage`/`insights`/`analytics` entry points
  to new sub-views; covered by the manual deep-link regression.
- **Scope creep into backend/Rust** → hard out-of-scope; response shapes frozen; Rust just serves `dist/`.
- **Font FOUT / licensing** → self-host woff2 + preload + fallback stack; both faces are SIL OFL.
- **Per-phase regressions** → behavior-preserving constraint + per-phase gates + screenshot diffs keep each phase shippable.

## Open Questions (resolve during execution, not blocking)

- Final accent hue tuning (235° blue is the starting point; confirm against provider amber so the two never clash).
- Whether `Pinned` stays a top-level tab or folds into a Sessions filter (defer; keep top-level for now).
- Light theme: explicitly deferred to a follow-up once tokens exist (tokens make it cheap later).
