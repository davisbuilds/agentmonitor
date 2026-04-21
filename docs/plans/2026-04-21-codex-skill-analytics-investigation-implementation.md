---
date: 2026-04-21
topic: codex-skill-analytics-investigation
stage: implementation-plan
status: draft
source: conversation
---

# Codex Skill Analytics Investigation Implementation Plan

## Goal

Determine how Codex skill usage is emitted in local or OTEL-fed sessions, then add a reliable ingestion and analytics path in AgentMonitor that can power a Codex-style daily skill invocations chart.

## Scope

### In Scope

- Trace the current Codex data path from local session file and OTEL export into AgentMonitor storage.
- Prove whether skill usage is emitted as a structured event, inferable from session metadata, or absent from the current local pipeline.
- Implement normalized skill analytics ingestion for the TypeScript runtime once the signal is proven.
- Mirror the same ingestion and analytics contract in the Rust runtime if the TS implementation is accepted.
- Add a V2 analytics endpoint and Svelte analytics panel for daily skill invocations with tooltip breakdown.

### Out of Scope

- Reproducing OpenAI’s private admin backend behavior exactly.
- Building a generic event warehouse for every Codex internal event.
- Shipping speculative skill analytics based only on free-text prompt matches.
- Legacy `/` dashboard work unless a shared API change forces compatibility work.

## Assumptions And Constraints

- The current local Codex session JSONL for this conversation shows structured `function_call` records for `exec_command`, but no explicit `Skill` tool calls yet.
- AgentMonitor already supports Codex OTEL ingest and historical Codex JSONL import, so the missing piece is likely parser coverage or a second signal source rather than an entirely new transport.
- The first implementation should prefer existing V2 analytics conventions in `src/db/v2-queries.ts`, `src/api/v2/router.ts`, and `frontend/src/lib/components/analytics/`.
- No destructive changes to existing session data should be required; backfill should come from re-import where possible.
- If the real skill signal does not exist in current local Codex outputs, the plan must stop at a proven limitation instead of inventing fake analytics.

## Task Breakdown

### Task 1: Prove The Codex Skill Signal Source

**Objective**

Identify the exact structured source of Codex skill usage for local sessions: session JSONL, OTEL logs, derived metadata, or no emitted signal.

**Files**

- Inspect: `~/.codex/sessions/**/*.jsonl`
- Inspect: `hooks/codex/README.md`
- Inspect: `src/import/codex.ts`
- Inspect: `src/otel/parser.ts`
- Inspect: `src/live/codex-adapter.ts`

**Dependencies**

None

**Implementation Steps**

1. Inspect current and prior Codex session JSONL files using structure-aware extraction for `response_item`, `event_msg`, and tool-like payloads rather than free-text grep alone.
2. Inspect the Codex OTEL parser to see which Codex event names, payload types, and metadata keys are already recognized or dropped.
3. Compare a live or recent Codex session against the imported DB rows to determine whether any skill-like signal was lost during import.
4. Record one of three outcomes: explicit skill event found, inferable skill metadata found, or no skill signal emitted by current local Codex.

**Verification**

- Run: `jq -r 'select(.type=="response_item" and .payload.type=="function_call") | .payload.name' ~/.codex/sessions/YYYY/MM/DD/*.jsonl | sort | uniq -c`
- Expect: deterministic list of actual structured tool names in local Codex sessions.
- Run: `rg -n "codex\\.|payload.type|event_kind|tool_name" src/otel/parser.ts src/import/codex.ts hooks/codex/README.md -S`
- Expect: concrete mapping points for Codex telemetry and import behavior.
- Run: `sqlite3 ./data/agentmonitor.db "select bs.agent, tc.tool_name, count(*) from tool_calls tc join browsing_sessions bs on bs.id=tc.session_id group by bs.agent, tc.tool_name order by bs.agent, count(*) desc;"`
- Expect: evidence of what Codex currently stores versus Claude.

**Done When**

- The exact candidate source for Codex skill analytics is documented.
- We know whether implementation should extend JSONL import, OTEL parsing, or both.
- We have a clear stop condition if no usable local skill signal exists.

### Task 2: Normalize Skill Invocation Storage

**Objective**

Add a durable storage path for skill invocations that works for Claude today and Codex once the signal is proven.

**Files**

- Modify: `src/db/schema.ts`
- Modify: `src/import/codex.ts`
- Modify: `src/parser/claude-code.ts`
- Modify: `src/db/v2-queries.ts`
- Modify: `rust-backend/src/db/schema.rs`
- Modify: `rust-backend/src/importer/codex_history.rs`
- Modify: `rust-backend/src/db/v2_queries.rs`

**Dependencies**

- Task 1

**Implementation Steps**

1. Choose the storage shape based on Task 1: either a dedicated `skill_invocations` table or a strict query layer over `tool_calls` if that is sufficient.
2. Preserve existing Claude `tool_name='Skill'` records while normalizing the extracted skill name and timestamp source.
3. Extend Codex ingestion only if Task 1 proves a stable structured field or event.
4. Ensure imported or live Codex sessions that truly lack a skill signal are marked as unavailable rather than silently omitted.

**Verification**

- Run: `pnpm run import --source codex --dry-run`
- Expect: no parser regressions and explicit visibility into detected skill records.
- Run: `sqlite3 ./data/agentmonitor.db "<query against new storage or normalized view>"`
- Expect: skill rows for Claude immediately, and Codex only when the signal is genuinely present.

**Done When**

- Skill invocations have a single queryable representation.
- Claude data remains intact.
- Codex ingestion behavior is explicit for both positive and negative cases.

### Task 3: Add V2 Skill Analytics Endpoint

**Objective**

Expose daily skill-usage timeseries and tooltip-ready breakdown data through the V2 API.

**Files**

- Modify: `src/api/v2/types.ts`
- Modify: `src/db/v2-queries.ts`
- Modify: `src/api/v2/router.ts`
- Modify: `frontend/src/lib/api/client.ts`
- Modify: `rust-backend/src/db/v2_queries.rs`
- Modify: `rust-backend/src/api/v2/history.rs`
- Modify: `rust-backend/src/api/v2/mod.rs`

**Dependencies**

- Task 2

**Implementation Steps**

1. Define the response shape for daily stacked-skill analytics, including per-day totals and skill breakdown rows.
2. Implement the TS query and route under `/api/v2/analytics/skills/daily`.
3. Mirror the same contract in Rust for parity.
4. Include capability or coverage metadata so the UI can distinguish “no data” from “not supported.”

**Verification**

- Run: `curl "http://127.0.0.1:3141/api/v2/analytics/skills/daily"`
- Expect: JSON with daily buckets and skill breakdowns.
- Run: `pnpm build`
- Expect: TS types and route wiring compile cleanly.
- Run: `pnpm rust:test`
- Expect: Rust contract changes do not break parity tests.

**Done When**

- The endpoint returns deterministic daily skill analytics.
- Both runtimes agree on response shape.
- Empty or unsupported Codex data is represented honestly.

### Task 4: Build The Analytics Panel

**Objective**

Render a Codex-style daily skill invocation chart with stacked bars and hover breakdowns in the canonical Svelte analytics UI.

**Files**

- Modify: `frontend/src/lib/stores/analytics.svelte.ts`
- Modify: `frontend/src/lib/api/client.ts`
- Modify: `frontend/src/lib/components/analytics/AnalyticsPage.svelte`
- Create: `frontend/src/lib/components/analytics/SkillUsageTimeline.svelte`
- Modify: `frontend/src/lib/analytics-state.ts`

**Dependencies**

- Task 3

**Implementation Steps**

1. Add client types and store fetch logic for the new skill analytics endpoint.
2. Create a stacked-bar component with stable color assignment per skill and a hover panel showing date, per-skill counts, and total.
3. Add capability-aware empty states that distinguish unsupported Codex sessions from real zero-usage days.
4. Place the panel in the Analytics tab without displacing higher-value existing panels unnecessarily.

**Verification**

- Run: `pnpm frontend:build`
- Expect: Svelte app compiles with the new analytics component.
- Run: `pnpm dev` and manually open `http://127.0.0.1:3141/app/#analytics`
- Expect: chart renders, hover breakdown is readable, and unsupported states are explicit.

**Done When**

- The Analytics tab shows daily skill invocations with tooltip breakdowns.
- The panel works for existing Claude skill data immediately.
- Codex presentation reflects the true ingestion state rather than an assumption.

### Task 5: Backfill And Document Runtime Limits

**Objective**

Make the feature operable for existing data and document what is and is not currently possible for Codex local sessions.

**Files**

- Modify: `README.md`
- Modify: `hooks/codex/README.md`
- Modify: `rust-backend/AGENTS.md`
- Modify: `frontend/AGENTS.md`

**Dependencies**

- Task 4

**Implementation Steps**

1. Document the new endpoint and UI panel in `README.md`.
2. Document any required Codex OTEL or importer expectations if skill analytics depends on telemetry not currently enabled by default.
3. Add one operator note explaining the difference between “skill analytics unavailable” and “zero invocations.”
4. Re-import local history if needed to populate backfilled skill analytics.

**Verification**

- Run: `pnpm run import --source codex --force`
- Expect: backfill completes without schema or parser errors.
- Run: `rg -n "skills/daily|skill invocation|unsupported" README.md hooks/codex/README.md frontend/AGENTS.md rust-backend/AGENTS.md -S`
- Expect: docs reflect the shipped contract and limitation language.

**Done When**

- Users can understand how the feature works and why Codex may or may not populate.
- Historical data can be backfilled without manual SQL edits.

## Risks And Mitigations

- Risk: Local Codex does not emit skill usage as a structured signal.
  Mitigation: stop at a proven limitation, ship Claude-backed skill analytics first if useful, and keep Codex marked unsupported.
- Risk: Skill-like data appears only in OTEL and not in session JSONL.
  Mitigation: prioritize OTEL parser coverage and keep historical import limitations explicit in the UI and docs.
- Risk: Multiple runtimes diverge on analytics shape.
  Mitigation: define the TS response contract first, then mirror it exactly in Rust and verify with parity tests.
- Risk: Tooltip-rich chart work expands into charting-library churn.
  Mitigation: start with a lightweight custom stacked bar in Svelte using existing styling patterns.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Identify actual Codex skill emitter | `jq -r 'select(.type=="response_item" and .payload.type=="function_call") | .payload.name' ~/.codex/sessions/YYYY/MM/DD/*.jsonl | sort | uniq -c` | Structured tool list proves whether `Skill` exists in local session files |
| Confirm OTEL/import candidate fields | `rg -n "codex\\.|payload.type|event_kind|tool_name" src/otel/parser.ts src/import/codex.ts hooks/codex/README.md -S` | Concrete parser and telemetry mapping locations |
| Query normalized skill data | `sqlite3 ./data/agentmonitor.db "<skill analytics query>"` | Daily rows with skill names and counts |
| TS analytics route compiles | `pnpm build` | Build succeeds |
| Svelte panel compiles | `pnpm frontend:build` | Frontend build succeeds |
| Rust parity holds | `pnpm rust:test` | Rust tests pass |
| Runtime endpoint works | `curl "http://127.0.0.1:3141/api/v2/analytics/skills/daily"` | JSON response with buckets and coverage metadata |

## Handoff

1. Execute in this session, task by task.
2. Open a separate execution session.
3. Refine this plan before implementation.
