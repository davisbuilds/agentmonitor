---
date: 2026-03-23
topic: live-ops-tab
stage: implementation-plan
status: draft
source: conversation
---

# Live Ops Tab Implementation Plan

## Goal

Add a read-only `Live` tab to the Svelte app that brings `claude-esp`-style live session visibility into AgentMonitor for Claude first and Codex in a passive-observability model, without regressing the existing Monitor, Sessions, Search, and Analytics flows.

## Scope

### In Scope

- New `Live` tab in the Svelte SPA with a session tree, active session list, and per-session live item stream.
- Cross-agent live data model that can represent reasoning, tool calls, tool results, command execution, file changes, plan updates, and diff snapshots.
- Claude live ingestion from the existing JSONL watcher path, upgraded to emit hierarchy and item deltas.
- Codex passive summary ingestion via OTEL, with an optional future rich exporter/sidecar path for deeper visibility.
- Read-only v2 API and SSE endpoints for live sessions, turns, and items.
- Privacy/config controls for prompt, reasoning, tool-argument, and diff capture.
- Documentation updates describing fidelity differences between Claude, Codex OTEL-only, and any future optional Codex rich-exporter mode.

### Out of Scope

- Agent control actions such as interrupt, resume, or steer.
- Rust backend and Tauri desktop parity in the same implementation pass.
- Generic OTEL trace visualization for arbitrary agents.
- Replacing the current Monitor tab or collapsing historical Sessions into the new surface.
- Multi-user auth, remote deployment, or cloud sync.

## Assumptions And Constraints

- The current Svelte shell is tab-driven and straightforward to extend, but the current `Sessions` flow is retrospective, paginated, and Claude-file-backed, not a generic live control plane.
- Claude already provides high-value raw material through `~/.claude/projects/**/*.jsonl`, including message blocks for `thinking`, `tool_use`, and `tool_result`, so Claude is the lowest-risk first integration.
- Current Claude parsing does not yet populate parent/child session links reliably, so hierarchy correctness must be treated as real implementation work rather than assumed-existing behavior.
- Current Codex OTEL support is useful for passive summary observability, but not sufficient for `claude-esp`-style plan/diff/reasoning fidelity. Any deeper Codex path must come from an explicitly installed external exporter or sidecar, not from AgentMonitor taking ownership of Codex session execution.
- Existing OTEL traces are accepted but not processed; this plan does not depend on turning OTEL traces into the primary live data source.
- Repository guardrails apply: keep v2 route handlers in `src/api/v2/router.ts`, keep v2 SQL in `src/db/v2-queries.ts`, keep TypeScript ESM import style consistent, and update `README.md` when API surface changes.
- The first implementation should remain read-only. That keeps the product boundary clear and avoids coupling UI delivery to agent-control semantics that only Codex can plausibly support.
- Feature rollout should be controlled by explicit config so existing users can stay on the current surfaces until the live tab is stable.

## Status Update

As of March 24, 2026, the shipped work covers the `Live` tab, live schema, Claude live ingestion, passive Codex summary support, live v2 APIs/SSE, privacy controls, and browser coverage.

Remaining follow-up from this plan is limited to future-facing hardening:

- optional exporter-contract expansion for richer passive Codex sources
- noisy-session UI performance work based on real traffic

## Task Breakdown

### Task 1: Define The Live Data Model And Schema

**Objective**

Introduce a normalized, cross-agent representation for live sessions so the UI does not have to infer plan, diff, tool, and reasoning state from the flat `events` table.

**Files**

- Modify: `src/db/schema.ts`
- Modify: `src/api/v2/types.ts`
- Modify: `src/db/v2-queries.ts`
- Create: `src/live/normalize.ts`
- Test: `src/live/normalize.test.ts`

**Dependencies**

None

**Implementation Steps**

1. Add additive tables for live detail, centered on `browsing_sessions` as the session root:
   - `session_turns`: one row per live or replayable turn, with `session_id`, `source_turn_id`, `status`, `title`, `started_at`, `ended_at`, and `agent_type`.
   - `session_items`: ordered items inside a turn, with `kind`, `payload_json`, `status`, `created_at`, and `source_item_id`.
2. Extend `browsing_sessions` with live-oriented metadata such as `live_status`, `last_item_at`, `integration_mode`, and `fidelity` so the UI can distinguish Claude live, Codex OTEL-only, and any future Codex rich-exporter sessions.
3. Keep large plan and diff bodies in `payload_json` for MVP rather than introducing a third artifact table. Defer artifact extraction until real payload sizes justify it.
4. Add a single normalization layer in `src/live/normalize.ts` that maps source-specific records into a small canonical vocabulary:
   - `user_message`
   - `assistant_message`
   - `reasoning`
   - `tool_call`
   - `tool_result`
   - `command_execution`
   - `file_change`
   - `plan_update`
   - `diff_snapshot`
   - `status_change`
5. Add indexes for hot queries:
   - `session_turns(session_id, started_at DESC)`
   - `session_items(session_id, created_at, id)`
   - `session_items(turn_id, ordinal)`
   - `browsing_sessions(last_item_at DESC, live_status)`
6. Define v2 TypeScript interfaces for `LiveSession`, `LiveTurn`, `LiveItem`, `LivePlanState`, and `LiveSessionDelta`.

**Verification**

- Run: `pnpm build`
- Expect: TypeScript and frontend build pass with the new schema/types in place.
- Run: `node --import tsx --test src/live/normalize.test.ts`
- Expect: canonical item normalization tests pass for representative Claude and Codex payloads.

**Done When**

- The database can store live detail without changing the meaning of the existing `events`, `sessions`, `messages`, or `tool_calls` tables.
- The new type layer can represent Claude and Codex live data without source-specific branches in the UI.

### Task 2: Upgrade Claude Ingestion For Live Hierarchy And Item Deltas

**Objective**

Turn the existing Claude JSONL watcher into a true live adapter that emits normalized turns and items, including session relationships and incremental updates.

**Files**

- Modify: `src/parser/claude-code.ts`
- Modify: `src/watcher/index.ts`
- Modify: `src/watcher/service.ts`
- Create: `src/live/claude-adapter.ts`
- Test: `src/parser/claude-code.test.ts`
- Test: `src/live/claude-adapter.test.ts`

**Dependencies**

- Task 1

**Implementation Steps**

1. Extend the Claude parser to capture relationship fields that are currently ignored or underused, including `parentUuid`, `isSidechain`, and any subagent-identifying tool metadata available in the JSONL stream.
2. Normalize Claude message blocks into live items:
   - user and assistant text blocks map to message items
   - `thinking` maps to `reasoning`
   - `tool_use` and `tool_result` map to tool items
   - command transcript blocks remain explicit items rather than being flattened into message text
3. Add a Claude adapter that compares the latest parsed ordinals against the last stored turn/item positions and inserts only the delta rows for an updated session file.
4. Persist hierarchy and fidelity metadata onto `browsing_sessions` so the live UI can show sidechains or spawned sessions as children rather than a flat list.
5. Emit live-specific notifications when a session file changes:
   - `session_presence`
   - `turn_update`
   - `item_delta`
   These should be produced from normalized rows, not ad hoc parser payloads.
6. Preserve the current Sessions browser behavior while allowing the live layer to consume the same source files.

**Verification**

- Run: `node --import tsx --test src/parser/claude-code.test.ts src/live/claude-adapter.test.ts`
- Expect: parser and delta-emission tests pass, including parent/child session linkage cases.
- Run: `pnpm build`
- Expect: the watcher and frontend compile cleanly after adapter changes.
- Run: manual dev check with an active Claude session while tailing server logs
- Expect: a changed JSONL file results in new live items without duplicating previously stored ones.

**Done When**

- Claude sessions appear in the live model with stable hierarchy and ordered live items.
- File changes add only new turns/items instead of forcing the UI to fully reload a session.

### Task 3: Add Codex Passive Summary Mode And Define A Rich Exporter Contract

**Objective**

Make the Codex story consistent with passive observability: OTEL remains the supported passive source for summary visibility, and any future deeper Codex visibility is defined as an optional external exporter contract rather than an AgentMonitor-managed execution path.

**Files**

- Create: `src/live/codex-adapter.ts`
- Modify: `src/db/queries.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `tests/codex-adapter.test.ts`

**Dependencies**

- Task 1

**Implementation Steps**

1. Define passive Codex fidelity modes in config:
   - `otel-only`: supported passive summary visibility for the `Live` tab and Monitor
   - `exporter`: reserved for a future external Codex exporter/sidecar that pushes richer live items into AgentMonitor
2. Keep OTEL logs and metrics feeding the existing `events` path for counters, session presence, and cost/token rollups. Do not overload OTEL into pretending it is a full turn/item stream.
3. Implement or refine the Codex OTEL adapter so summary-only Codex sessions appear in the live model with explicit fidelity markers and stable empty-state behavior.
4. Define a canonical external-export contract for future richer Codex records, centered on normalized turn/item ingestion rather than AgentMonitor launching Codex itself.
5. Extend the historical Codex importer only enough to backfill summary continuity into the same live tables where feasible, without implying parity with Claude live sessions.
6. Explicitly document that OTEL alone remains insufficient for full `claude-esp` parity and that any deeper Codex visibility requires an optional external exporter/sidecar installed by the user.

**Verification**

- Run: `node --import tsx --test tests/codex-adapter.test.ts`
- Expect: fixture-based normalization tests pass for supported Codex summary records and for the reserved rich-export contract shapes.
- Run: `node --import tsx --test tests/otel.test.ts`
- Expect: OTEL-backed Codex sessions appear in `/api/v2/live/*` with `fidelity='summary'`.
- Run: `pnpm build`
- Expect: config, API, and import paths compile with the new Codex mode.
- Run: manual dev check with Codex in `otel-only` mode
- Expect: existing Monitor data still appears and no live-tab failures occur.

**Done When**

- Codex sessions can participate in the live tab with an explicit fidelity level while remaining fully passive to observe.
- The product no longer implies that OTEL-only Codex sessions have the same depth as Claude live sessions or any future exporter-backed Codex sessions.

### Task 4: Add Read-Only Live APIs And A Dedicated Live SSE Stream

**Objective**

Expose the new live model through stable v2 endpoints and a dedicated streaming channel without destabilizing the existing `/api/stream` contract.

**Files**

- Modify: `src/api/v2/router.ts`
- Modify: `src/db/v2-queries.ts`
- Create: `src/api/v2/live-stream.ts`
- Test: `tests/v2-api.test.ts`
- Test: `tests/v2-live-stream.test.ts`

**Dependencies**

- Task 1
- Task 2
- Task 3

**Implementation Steps**

1. Add v2 read APIs:
   - `GET /api/v2/live/sessions`
   - `GET /api/v2/live/sessions/:id`
   - `GET /api/v2/live/sessions/:id/turns`
   - `GET /api/v2/live/sessions/:id/items`
2. Add optional filters for project, agent, live status, fidelity, and active-only views.
3. Add `GET /api/v2/live/stream` as a dedicated SSE endpoint that supports replay-from-id or cursor-based bootstrap so the live tab can reconnect without a full refresh.
4. Keep `/api/stream` unchanged for existing Monitor consumers. Do not mix live-item payloads into the current top-level event stream.
5. Ensure live endpoints degrade gracefully:
   - summary-only Codex sessions still list
   - missing exporter-backed details return an empty items list plus fidelity metadata, not a server error
6. Add response shapes that make frontend rendering simple, including a compact session tree view and a stream-friendly item delta payload.

**Verification**

- Run: `node --import tsx --test tests/v2-api.test.ts tests/v2-live-stream.test.ts`
- Expect: endpoint contract tests pass for sessions, items, replay, and degraded summary-only cases.
- Run: `pnpm build`
- Expect: API changes compile and the server starts normally.
- Run: `curl -sf http://127.0.0.1:3141/api/v2/live/sessions`
- Expect: JSON response with `data` array and fidelity metadata fields.

**Done When**

- The frontend can build the live tab entirely from documented v2 contracts.
- Existing `/api/stream` consumers do not need to change to keep current Monitor behavior.

### Task 5: Build The Svelte Live Tab And State Stores

**Objective**

Add a new Svelte surface optimized for live operator awareness rather than retrospective browsing.

**Files**

- Modify: `frontend/src/App.svelte`
- Modify: `frontend/src/lib/stores/router.svelte.ts`
- Modify: `frontend/src/lib/api/client.ts`
- Create: `frontend/src/lib/stores/live.svelte.ts`
- Create: `frontend/src/lib/stores/live-sse.ts`
- Create: `frontend/src/lib/components/live/LivePage.svelte`
- Create: `frontend/src/lib/components/live/SessionTree.svelte`
- Create: `frontend/src/lib/components/live/ItemStream.svelte`
- Create: `frontend/src/lib/components/live/InspectorPanel.svelte`
- Test: `e2e/live-tab.spec.ts`

**Dependencies**

- Task 4

**Implementation Steps**

1. Add a top-level `Live` tab to the SPA router and tab bar, keeping the existing pages intact.
2. Build a three-pane layout:
   - left: live session tree and filters
   - center: ordered item stream for the selected session
   - right: inspector for plan state, diff body, tool inputs, and other item details
3. Show fidelity and status badges prominently so users understand whether a session is full-fidelity, summary-only, or historical replay.
4. Use a dedicated live store fed by `GET /api/v2/live/*` plus the dedicated live SSE stream rather than reusing the Monitor store.
5. Optimize for noisy sessions:
   - virtualize or window long item lists
   - collapse reasoning and large diff/tool payloads by default
   - preserve scroll position on incremental item insertion
6. Provide bridges into existing experiences:
   - jump from a live session into the historical `Sessions` viewer
   - deep-link to the `Live` tab via location hash

**Verification**

- Run: `pnpm build`
- Expect: frontend build includes the new tab with no type or bundling errors.
- Run: `pnpm exec playwright test e2e/live-tab.spec.ts --project=chromium`
- Expect: the live tab renders, loads session data, and reacts to simulated live item deltas.

**Done When**

- The Svelte app has a stable `Live` tab that can follow an active session without full-page reloads.
- The new UI is clearly different from the historical `Sessions` view and does not depend on Monitor-only stores.

### Task 6: Add Privacy Controls, Product Messaging, And Final Verification

**Objective**

Make the new live surface safe to enable, operationally understandable, and accurately documented.

**Files**

- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/system/FEATURES.md`
- Modify: `docs/system/OPERATIONS.md`
- Modify: `docs/project/ROADMAP.md`

**Dependencies**

- Task 5

**Implementation Steps**

1. Add config flags for:
   - enabling the live tab
   - reserved Codex exporter mode
   - prompt capture
   - reasoning capture
   - diff retention window or payload cap
2. Add UI and API-visible metadata so users can tell when sensitive capture is enabled.
3. Resolve the current Codex documentation ambiguity by stating exactly what OTEL-only mode provides and what would require a future exporter mode.
4. Document setup and troubleshooting for Claude live mode and Codex passive OTEL mode, including degraded behavior when only OTEL is configured.
5. Add a final manual verification checklist covering:
   - Claude active session
   - Codex OTEL-only session
   - reserved exporter-backed Codex session
   - empty-state behavior
   - reconnect behavior after SSE disconnect

**Verification**

- Run: `pnpm build`
- Expect: docs-referenced API and config names match the codebase and the app still builds.
- Run: `pnpm run test`
- Expect: automated verification completes without new regressions.
- Run: `curl -sf http://127.0.0.1:3141/api/health`
- Expect: 200 response after enabling live-tab config.

**Done When**

- Users can understand the fidelity and privacy implications of the live tab from docs and the UI itself.
- README and system docs describe the live surface and Codex passive-versus-rich-exporter mode differences accurately.

## Risks And Mitigations

- Risk: A future Codex rich exporter depends on an external source contract whose shape may evolve.
  Mitigation: isolate it behind a source adapter, define a narrow exporter contract, use fixture-based tests, and keep OTEL-only mode as the supported passive fallback.
- Risk: Reasoning, diffs, and tool inputs can create large payloads and SQLite growth.
  Mitigation: use payload caps, collapse large bodies by default in the UI, and keep retention/config knobs explicit.
- Risk: The live tab drifts into an orchestration/control-plane feature before the observability layer is stable.
  Mitigation: keep the first pass strictly read-only and defer interrupt/resume actions to a later plan.
- Risk: Claude hierarchy expectations exceed what the current JSONL parser actually models.
  Mitigation: treat relationship detection as a first-class task with fixture coverage, not as an incidental UI detail.
- Risk: Users assume Codex OTEL-only sessions have full parity with Claude live sessions.
  Mitigation: surface fidelity badges in API and UI, and document the distinction in setup docs and empty states.
- Risk: A noisy live stream harms responsiveness in the browser.
  Mitigation: use a dedicated SSE stream, window large lists, and send item deltas instead of full-session payloads.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Live schema supports cross-agent turns and items | `node --import tsx --test tests/live-normalize.test.ts tests/v2-live-schema.test.ts` | Canonical item normalization and live schema tests pass |
| Claude live ingestion emits hierarchy-aware deltas | `node --import tsx --test tests/v2-parser.test.ts tests/live-claude-adapter.test.ts tests/v2-watcher.test.ts` | Parser and delta tests pass, including parent/child cases |
| Codex passive adapter and reserved exporter contract remain coherent | `node --import tsx --test tests/codex-adapter.test.ts tests/otel.test.ts` | Fixture-driven Codex adapter tests pass for OTEL summary and reserved exporter shapes |
| Live v2 endpoints are stable and read-only | `node --import tsx --test tests/v2-api.test.ts tests/v2-live-stream.test.ts` | Endpoint tests pass for sessions, turns, items, replay, and degraded summary-only behavior |
| Svelte app renders the new Live tab | `pnpm build` | Backend and frontend build complete without errors |
| Live UI handles real-time deltas | `pnpm exec playwright test e2e/live-tab.spec.ts --project=chromium` | Browser test passes for render, selection, and streamed updates |
| Existing app health remains intact after enabling the feature | `curl -sf http://127.0.0.1:3141/api/health` | HTTP 200 response |
| Existing regression suite stays green | `pnpm run test` | Test suite exits successfully |

## Handoff

Plan complete and saved to `docs/plans/2026-03-23-live-ops-tab-implementation.md`.

1. Execute in this session, task by task.
2. Open a separate execution session.
3. Refine this plan before implementation.
