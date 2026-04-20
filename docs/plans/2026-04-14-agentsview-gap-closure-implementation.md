---
date: 2026-04-14
topic: agentsview-gap-closure
stage: implementation-plan
status: in-progress
source: conversation
---

# AgentsView Gap Closure Implementation Plan

## Current Status

As of 2026-04-18, PR 1 and PR 2 for this plan have been merged.

Completed and merged:

- Task 1: Expand The Analytics Contract
- Task 2: Build A Real Analytics Store And UI
- Task 3: Add A Dedicated Usage Surface
- Task 4: Add Session Activity Minimap
- Task 5: Add Pins And Saved Review Affordances
- Task 6: Improve Search And Global Navigation

Follow-on work still remaining:

- Task 8: Selectively Backport Sync And Parser Maturity

Task 8 is currently in progress on `feat/sync-parser-maturity`:

- full historical imports now cache unchanged zero-event files instead of reparsing them every run
- the session-browser watcher now covers ongoing Codex local session changes and includes Codex in periodic resync
- configurable sync exclude patterns now apply consistently to discovery, historical import, and watcher/resync flows
- sync architecture and operations docs are being updated alongside the implementation

Merged scope notes:

- historical analytics contract and store-driven Analytics UI are in place
- dedicated Usage APIs and UI are in place
- session activity minimap and pinned review workflows are in place
- Search now supports richer result context, relevance sorting, and a global command palette
- post-merge follow-up fixes already landed for session-viewer remount behavior and orphaned pin removal

Recommended continuation point for the next session:

1. Task 8

## Goal

Close the highest-value drift between modern `agentsview` and `agentmonitor` by expanding the historical review product surface inside `agentmonitor` without weakening its real-time monitor and fidelity-aware live architecture.

The target outcome is not feature parity for its own sake. The target is a stronger `agentmonitor` that combines:

- live operator telemetry and monitor workflows
- richer session review workflows
- deeper analytics and usage analysis
- honest fidelity/capability handling across data sources

## Scope

### In Scope

- expand analytics beyond the current summary/activity/projects/tools slice
- add a dedicated historical usage surface
- improve session-browser UX with minimap and saved-review affordances
- improve global search and navigation ergonomics
- add an insights layer after the underlying analytics/usage surfaces are stronger
- harden the API and projection contracts needed to support those surfaces

### Out Of Scope

- remote auth, reverse proxy support, or multi-user deployment
- PostgreSQL sync/serve
- desktop packaging
- broad parser coverage for every agent currently supported by `agentsview`
- replacing the live monitor with an archive-centric model
- hiding fidelity limits for summary-only sessions

## Assumptions And Constraints

- The canonical product surface remains the Svelte app at `/app/` backed by `/api/v2/*`.
- The legacy `/` dashboard should not receive new product behavior unless a temporary compatibility bridge is unavoidable.
- `agentmonitor`'s split model is intentional:
  - `events/sessions/agents` for live operator monitoring
  - `browsing_sessions/messages/tool_calls/...` for historical review
  - `session_turns/session_items` plus capability/fidelity metadata for live-v2 projection
- Ports from `agentsview` must preserve `agentmonitor`'s explicit capability and fidelity semantics.
- New historical features should prefer v2 contracts over v1 monitor endpoints.
- If an API response shape changes, `README.md` and the relevant docs should be updated in the same change.
- Pre-push verification for implementation work that follows this plan should continue to respect repo guidance:
  - `pnpm build`
  - `pnpm css:build` when styles change
  - `pnpm rust:test` if Rust is touched

## Task Breakdown

### Task 1: Expand The Analytics Contract

**Status**

- Completed and merged in PR 1.

**Objective**

Grow `agentmonitor`'s analytics backend from the current minimal four-endpoint shape into a richer capability-aware analytics contract that can support modern `agentsview`-style analytics panels.

**Files**

- Modify: `src/api/v2/router.ts`
- Modify: `src/api/v2/types.ts`
- Modify: `src/db/v2-queries.ts`
- Modify: `docs/system/FEATURES.md`
- Modify: `README.md`
- Test: `tests/v2-api.test.ts`
- Test: `tests/monitor-analytics.test.ts`

**Dependencies**

- None

**Implementation Steps**

1. Define the new analytics response types needed for:
   - hour-of-week heatmap
   - top sessions
   - velocity metrics
   - agent comparison
   - optional richer activity breakdowns
2. Add new `/api/v2/analytics/*` endpoints or extend the existing analytics endpoints where doing so keeps the contract coherent.
3. Implement the supporting SQLite queries in `src/db/v2-queries.ts`.
4. Make capability/fidelity handling explicit in any analytics that exclude summary-only sessions.
5. Update product docs to describe what analytics are history-backed versus capability-limited.

**Verification**

- Run: `pnpm test -- --test-name-pattern "v2|analytics"`
- Expect: analytics and v2 route tests cover the new contract and pass.
- Run: `pnpm build`
- Expect: API/type changes compile cleanly.

**Done When**

- `agentmonitor` exposes the backend data needed for modern analytics panels.
- The API contract makes it clear when metrics are capability-limited.

### Task 2: Build A Real Analytics Store And UI

**Status**

- Completed and merged in PR 1.

**Objective**

Replace the current one-shot analytics page with a stateful analytics subsystem closer to modern `agentsview`, including date ranges, filter sync, drilldowns, and export.

**Files**

- Create: `frontend/src/lib/stores/analytics.svelte.ts`
- Modify: `frontend/src/lib/components/analytics/AnalyticsPage.svelte`
- Create or modify under `frontend/src/lib/components/analytics/`:
  - `DateRangePicker.svelte`
  - `ActiveFilters.svelte`
  - `HourOfWeekHeatmap.svelte`
  - `TopSessions.svelte`
  - `VelocityMetrics.svelte`
  - `AgentComparison.svelte`
- Modify: `frontend/src/lib/api/client.ts`
- Modify: `frontend/src/App.svelte`

**Dependencies**

- Task 1

**Implementation Steps**

1. Introduce a dedicated analytics store modeled on the current `agentmonitor` frontend patterns, not a direct file transplant.
2. Add shared date-range and filter state for analytics, including explicit project/agent/fidelity-aware filter behavior.
3. Replace the current analytics page bootstrap with store-driven fetch and refresh flows.
4. Add export support for at least CSV summaries of the analytics data.
5. Keep the UI honest about partial coverage when some sources only support summary fidelity.

**Verification**

- Run: `pnpm build`
- Expect: Svelte app builds with the new analytics components.
- Run: `pnpm test`
- Expect: existing frontend-adjacent tests continue to pass.
- Manual:
  - start the app with `pnpm dev` and `pnpm frontend:dev`
  - open `/app`
  - confirm Analytics renders and refreshes without blocking other tabs

**Done When**

- Analytics supports date-range exploration and multiple derived panels.
- The analytics page feels like a first-class product area, not a static summary page.

### Task 3: Add A Dedicated Usage Surface

**Status**

- Completed and merged in PR 1.

**Objective**

Introduce a historical `Usage` tab in `agentmonitor` for cost and token analysis over time, using `agentmonitor`'s data model rather than copying `agentsview` blindly.

**Files**

- Modify: `src/api/v2/router.ts`
- Modify: `src/api/v2/types.ts`
- Modify: `src/db/v2-queries.ts` or create dedicated usage query helpers
- Create: `frontend/src/lib/stores/usage.svelte.ts`
- Create: `frontend/src/lib/components/usage/UsagePage.svelte`
- Create usage subcomponents under `frontend/src/lib/components/usage/`
- Modify: `frontend/src/lib/api/client.ts`
- Modify: `frontend/src/App.svelte`
- Modify: `docs/system/FEATURES.md`

**Dependencies**

- Task 1

**Implementation Steps**

1. Define a `Usage` API contract for daily totals, model attribution, project attribution, and top sessions.
2. Decide and document inclusion rules:
   - transcript-derived history
   - event-derived live cost rows
   - capability-limited sessions
3. Implement the backend queries and expose them under `/api/v2/usage/*`.
4. Build a dedicated `Usage` store and page with date controls and filter state.
5. Add clear UI language where usage is complete, partial, or source-dependent.

**Verification**

- Run: `pnpm test -- --test-name-pattern "usage|pricing|v2"`
- Expect: usage and pricing tests cover the new query behavior and pass.
- Run: `pnpm build`
- Expect: backend and frontend usage additions compile.
- Manual:
  - verify a `Usage` tab appears in `/app`
  - verify the date range and filters change the results

**Done When**

- `agentmonitor` has a dedicated historical usage workflow instead of only monitor cost widgets.
- Usage results are source-aware and documented.

### Task 4: Add Session Activity Minimap

**Status**

- Completed and merged in PR 1.

**Objective**

Bring the `agentsview` session activity minimap concept into `agentmonitor`'s session viewer to improve transcript navigation for long sessions.

**Files**

- Modify or create backend support in:
  - `src/api/v2/router.ts`
  - `src/db/v2-queries.ts`
  - `src/api/v2/types.ts`
- Create: `frontend/src/lib/components/sessions/ActivityMinimap.svelte`
- Modify: `frontend/src/lib/components/sessions/SessionViewer.svelte`
- Modify: `frontend/src/lib/api/client.ts`

**Dependencies**

- None if implemented off existing message timestamps
- Benefits from Task 1 type work

**Implementation Steps**

1. Define a lightweight session-activity endpoint based on message timestamps and ordinals.
2. Build a minimap component that visualizes message density across the session timeline.
3. Wire minimap clicks to jump to the corresponding transcript area.
4. Gracefully handle sessions with missing timestamps or no history capability.

**Verification**

- Run: `pnpm test`
- Expect: existing session and message tests continue to pass.
- Run: `pnpm build`
- Expect: session viewer compiles with the minimap component.
- Manual:
  - open a long session in `/app`
  - confirm minimap renders and clicking a bucket jumps within the transcript

**Done When**

- Long-session navigation is materially faster.
- Sessions without timestamp data degrade cleanly.

### Task 5: Add Pins And Saved Review Affordances

**Status**

- Completed and merged in PR 1.

**Objective**

Make `agentmonitor` sessions reviewable over time by adding pinned messages and, optionally, starred sessions as persistent user curation features.

**Files**

- Modify: `src/db/schema.ts`
- Modify: `src/api/v2/router.ts`
- Modify: `src/db/v2-queries.ts`
- Create or modify:
  - `frontend/src/lib/stores/pins.svelte.ts`
  - `frontend/src/lib/components/pinned/PinnedPage.svelte`
  - `frontend/src/lib/components/sessions/MessageBlock.svelte`
- Modify: `frontend/src/App.svelte`

**Dependencies**

- Task 4 is independent
- May share state/navigation patterns with Task 7

**Implementation Steps**

1. Add persistence for pinned messages, and optionally starred sessions, in the v2 data model.
2. Expose list/add/remove APIs under the v2 surface.
3. Add pin controls in the session viewer.
4. Add a dedicated page or panel for reviewing saved pins.
5. Preserve session/message navigation context when jumping from a saved view into a transcript.

**Verification**

- Run: `pnpm test`
- Expect: database and API tests cover pin persistence.
- Run: `pnpm build`
- Expect: session viewer and saved-review UI compile.
- Manual:
  - pin a message
  - confirm it appears in the saved-review surface
  - navigate back to the source message successfully

**Done When**

- Users can persist and revisit important transcript moments.
- Saved-review navigation is reliable.

### Task 6: Improve Search And Global Navigation

**Status**

- Completed and merged in PR 1.

**Objective**

Upgrade `agentmonitor` search ergonomics with debounced search, richer ranking/sorting, and a command palette for fast session/message navigation.

**Files**

- Modify: `frontend/src/lib/components/search/SearchPage.svelte`
- Create: `frontend/src/lib/stores/search.svelte.ts`
- Create: `frontend/src/lib/components/command-palette/CommandPalette.svelte`
- Modify: `frontend/src/lib/stores/router.svelte.ts`
- Modify: `frontend/src/App.svelte`
- Modify: `src/db/v2-queries.ts` if search ranking or sort support is extended

**Dependencies**

- None

**Implementation Steps**

1. Move search behavior into a dedicated store with debounce and cancellation.
2. Add sort modes such as relevance versus recency when the backend supports them.
3. Add a global command palette that can search recent sessions and transcript matches.
4. Preserve current capability-aware messaging for non-searchable sessions.
5. Ensure search-to-session navigation keeps ordinal scroll behavior intact.

**Verification**

- Run: `pnpm build`
- Expect: search and command palette compile.
- Run: `pnpm test`
- Expect: router/search behavior remains stable.
- Manual:
  - use Search normally
  - use the command palette to jump to sessions and message hits
  - confirm scroll targeting still works

**Done When**

- Search feels immediate and navigational instead of form-based.
- Users can jump across the app quickly without context loss.

### Task 7: Add Insights On Top Of Analytics And Usage

**Status**

- Completed on branch, pending PR.

**Objective**

Add AI-generated insights only after the analytics and usage substrate is strong enough to make the results meaningful.

**Files**

- Modify: `src/db/schema.ts`
- Modify: `src/api/v2/router.ts`
- Create: backend insight generation helpers under `src/`
- Create: `frontend/src/lib/stores/insights.svelte.ts`
- Create: `frontend/src/lib/components/insights/InsightsPage.svelte`
- Modify: `frontend/src/App.svelte`
- Modify: `docs/system/FEATURES.md`

**Dependencies**

- Task 1
- Task 2
- Task 3

**Implementation Steps**

1. Define the persistence model for generated insights.
2. Define the prompt/input contract using the improved analytics and usage filters.
3. Build the backend generation endpoint with clear source and scope metadata.
4. Add an insights page that supports date, project, and agent targeting.
5. Keep the output explicitly tied to the underlying data coverage and time range.

**Verification**

- Run: `pnpm build`
- Expect: insights backend/frontend compile.
- Run: `pnpm test`
- Expect: DB/API paths remain stable.
- Manual:
  - generate an insight for a bounded date range
  - reload the app
  - confirm the insight persists and renders

**Done When**

- Insights are generated from a strong underlying dataset.
- The UI communicates scope and limitations clearly.

### Task 8: Selectively Backport Sync And Parser Maturity

**Status**

- Remaining.

**Objective**

Adopt only the parts of `agentsview`'s sync/parser maturity that improve `agentmonitor`'s archive reliability without turning the repo into a broad parser-coverage project by accident.

**Files**

- Modify: `src/watcher/service.ts`
- Modify: `src/import/index.ts`
- Modify: `src/parser/*.ts`
- Modify: `src/db/schema.ts`
- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `docs/system/OPERATIONS.md`

**Dependencies**

- None

**Implementation Steps**

1. Audit the current watcher/import logic against `agentsview`'s skip-cache, exclude-pattern, and incremental-sync behavior.
2. Port only the reliability improvements that fit `agentmonitor`'s hybrid monitor/history model.
3. Avoid broad parser expansion unless a specific integration is product-priority.
4. Add docs for any new exclude patterns, sync semantics, or recovery flows.

**Verification**

- Run: `pnpm test -- --test-name-pattern "import|watcher|parser"`
- Expect: importer/watcher/parser tests continue to pass.
- Run: `pnpm build`
- Expect: sync-related changes compile.
- Manual:
  - modify a watched session file
  - verify the app updates correctly
  - restart the server and confirm unchanged files are skipped

**Done When**

- Historical ingestion is more durable and predictable.
- The sync architecture is improved without broadening product scope accidentally.

## Risks And Mitigations

- Risk: analytics and usage metrics become misleading when summary-only sessions are mixed with transcript-backed sessions.
  Mitigation: make capability/fidelity limits explicit in both API types and UI copy.

- Risk: ports from `agentsview` flatten `agentmonitor`'s live and historical models into one muddy contract.
  Mitigation: preserve the split between monitor/event data and history/session data.

- Risk: the frontend grows faster than the v2 API can support cleanly.
  Mitigation: land Task 1 before major frontend ports and add route/type tests first.

- Risk: usage work duplicates cost logic already implemented elsewhere.
  Mitigation: centralize inclusion rules and pricing semantics before the UI is built.

- Risk: session workflow ports increase complexity without enough review value.
  Mitigation: prioritize minimap, pins, and navigation before broader session management.

- Risk: sync/parser improvements expand scope into full multi-agent archive parity.
  Mitigation: explicitly treat parser/sync breadth as selective, not parity-driven.

## Verification Matrix

| Requirement | Proof command | Expected signal |
|---|---|---|
| API and shared backend changes remain stable | `pnpm test` | Existing TS tests stay green and new route/query tests cover added behavior |
| Frontend integration compiles | `pnpm build` | Svelte app and backend compile together |
| Shared CSS output remains buildable when touched | `pnpm css:build` | Legacy/shared CSS output still builds successfully |
| Browser-level sanity holds for new flows | `pnpm exec playwright test` | Key app flows render and navigate correctly when E2E coverage is added or updated |
| Rust mirror stays safe when touched | `pnpm rust:test` | Rust runtime remains green if any shared contracts are mirrored there |
| Canonical app still works manually | `pnpm dev` and `pnpm frontend:dev` | `/app` loads, Monitor remains intact, and new tabs/features behave as intended |

## Handoff

Recommended execution order from the current state:

1. Task 7
2. Task 8

Tasks 1 through 6 are already merged. The remaining order keeps the product-facing insights work ahead of lower-level sync/parser maturity work.

Plan complete and saved to `docs/plans/2026-04-14-agentsview-gap-closure-implementation.md`.

Next options:

1. Execute in this session, task by task.
2. Open a separate execution session.
3. Refine the plan before implementation.
