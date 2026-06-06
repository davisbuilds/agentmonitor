---
date: 2026-06-06
topic: trace-quality-layer
stage: spec
status: draft
source: conversation
---

# Trace Quality Layer Spec

## Goal

Add a local, Langfuse-inspired trace quality layer to AgentMonitor that turns existing agent sessions, events, live items, messages, and tool calls into an inspectable trace/observation graph with local scores, prompt/version attribution, quality dashboards, and alertable findings, while keeping AgentMonitor local-first and independent from Langfuse, Terraform, Prometheus, Grafana, or any hosted observability platform.

## Scope

### In Scope

- Add first-class local trace and observation concepts alongside the existing `sessions`, `events`, `browsing_sessions`, `messages`, `tool_calls`, `session_turns`, and `session_items` tables.
- Preserve existing event ingest, usage, analytics, live, search, pins, and insights behavior.
- Normalize existing Claude Code and Codex data into observation types inspired by Langfuse and OpenTelemetry GenAI conventions:
  - `event`
  - `span`
  - `generation`
  - `agent`
  - `tool`
  - `evaluator`
  - `guardrail`
  - `chain`
  - `retriever`
  - `embedding`
- Add durable local scores/evaluations that can attach to sessions, traces, observations, messages, events, or session items.
- Add prompt/version attribution for agent instructions, skill prompts, task templates, and explicitly provided prompt metadata.
- Add quality and anomaly APIs under `/api/v2/*`, with coverage metadata so partial telemetry is visible.
- Add Svelte `/app/` UI surfaces for trace inspection, scoring, quality trends, and alertable findings.
- Add deterministic backfill and repair scripts so historical data can be projected into the new model.
- Add an optional, disabled-by-default Langfuse/OTLP export path after the local model is stable.
- Document semantics in system docs after implementation ships.

### Out Of Scope

- Replacing AgentMonitor's local SQLite storage with Langfuse, ClickHouse, Postgres, Prometheus, Grafana, Loki, CloudWatch, or OpenSearch.
- Importing `reaatech/terraform-mcp-observability` infrastructure, Terraform modules, AWS Managed Prometheus, CloudWatch Logs, or EKS assumptions.
- Making Langfuse a runtime dependency for core AgentMonitor features.
- Auto-sending local prompts, reasoning, tool arguments, or transcripts to any external service.
- Blocking Claude Code or Codex activity based on quality scores or alert states.
- Running LLM-as-judge evaluation by default.
- Building a generic Prometheus-compatible metrics backend.
- Changing the canonical product surface away from Svelte `/app/` and `/api/v2/*`.
- Implementing Rust backend parity in the first pass. Rust parity should be planned after the TypeScript contract is proven.

### Source And Reference Points

- Prior tokenmaxxing radar note: `/Users/dg-mac-mini/Dev/tokenmaxxing/runs/research-github-ai-devtools-radar-anon-2026-05-12/codex/github_ai_devtools_radar.md`
- AgentMonitor architecture: `docs/system/ARCHITECTURE.md`
- AgentMonitor feature/API catalog: `docs/system/FEATURES.md`
- AgentMonitor event contract: `docs/api/event-contract.md`
- Existing usage intelligence plan: `docs/plans/2026-05-13-agent-usage-intelligence-implementation.md`
- Langfuse data model: `https://langfuse.com/docs/observability/data-model`
- Langfuse observation types: `https://langfuse.com/docs/observability/features/observation-types`
- Langfuse OpenTelemetry ingestion: `https://langfuse.com/integrations/native/opentelemetry`
- Langfuse metrics: `https://langfuse.com/docs/metrics/overview`
- Langfuse custom dashboards: `https://langfuse.com/docs/metrics/features/custom-dashboards`
- Langfuse scores/evaluation concepts: `https://langfuse.com/docs/evaluation/core-concepts`
- Langfuse prompt-to-trace linking: `https://langfuse.com/docs/prompt-management/features/link-to-traces`
- Referenced observability taxonomy repo: `https://github.com/reaatech/terraform-mcp-observability`

## Assumptions And Constraints

- AgentMonitor remains a localhost, account-free product by default.
- TypeScript/Express/SQLite remains the first implementation target.
- The Svelte `/app/` frontend and `/api/v2/*` API are the canonical product surface.
- Existing `events.cost_usd` remains authoritative for event cost. The trace-quality layer may aggregate cost, but should not silently recompute stored costs.
- Existing `events.metadata`, `session_items.payload_json`, and transcript content may contain sensitive local data. The new model must respect current live capture/redaction settings and should prefer summaries or hashes when full payload retention is not needed.
- The trace-quality layer must not make Codex OTEL look more complete than it is. Current Codex OTEL is useful for prompts, tool decisions/results, and completion usage, but remains summary-oriented for full transcript reconstruction.
- A local AgentMonitor session maps most closely to a Langfuse session. A local trace should represent one coherent unit of agent work inside that session, usually one user turn, one agent run, or one imported completion.
- A local observation should represent one step inside a trace: an LLM generation, tool call, tool result, reasoning span, evaluator, guardrail, or discrete event.
- Some historical data cannot be perfectly reconstructed. Projection code must record provenance and coverage instead of inventing parent-child structure.
- Scores should be durable and local. LLM-as-judge can be layered later through explicit user action, but the first scoring system should support human scores, API scores, and deterministic code evaluator scores.
- The optional Langfuse export path should export only data the user explicitly enables, should be easy to disable, and should make filtering explicit to avoid noisy or expensive traces.
- If API response shapes change, update `README.md`, `docs/system/FEATURES.md`, and `docs/system/ARCHITECTURE.md` in the same implementation change.
- For non-trivial UI implementation, run Playwright when available and include screenshots or test output in handoff.

## Task Breakdown

### Task 1: Add Trace Quality Schema And Types

**Objective**

Add backward-compatible SQLite tables and shared TypeScript types for traces, observations, scores, prompt references, and projection state.

**Files**

- Modify: `src/db/schema.ts`
- Create: `src/trace-quality/types.ts`
- Create: `src/trace-quality/constants.ts`
- Test: `tests/trace-quality-schema.test.ts`
- Reference: `src/db/schema.ts`
- Reference: `src/api/v2/types.ts`

**Dependencies**

None

**Implementation Steps**

1. Add a `trace_quality_traces` table:
   - `id TEXT PRIMARY KEY`
   - `session_id TEXT NOT NULL`
   - `browsing_session_id TEXT`
   - `source_trace_id TEXT`
   - `agent_type TEXT NOT NULL`
   - `name TEXT NOT NULL`
   - `status TEXT`
   - `project TEXT`
   - `branch TEXT`
   - `started_at TEXT`
   - `ended_at TEXT`
   - `duration_ms INTEGER`
   - `metadata_json TEXT NOT NULL DEFAULT '{}'`
   - `tags_json TEXT NOT NULL DEFAULT '[]'`
   - `coverage_json TEXT NOT NULL DEFAULT '{}'`
   - `created_at TEXT NOT NULL DEFAULT (datetime('now'))`
2. Add a `trace_quality_observations` table:
   - `id TEXT PRIMARY KEY`
   - `trace_id TEXT NOT NULL`
   - `parent_observation_id TEXT`
   - `session_id TEXT NOT NULL`
   - `source_kind TEXT NOT NULL`
   - `source_id TEXT`
   - `source_item_id TEXT`
   - `observation_type TEXT NOT NULL`
   - `name TEXT NOT NULL`
   - `status TEXT`
   - `model TEXT`
   - `tool_name TEXT`
   - `started_at TEXT`
   - `ended_at TEXT`
   - `duration_ms INTEGER`
   - `tokens_in INTEGER DEFAULT 0`
   - `tokens_out INTEGER DEFAULT 0`
   - `cache_read_tokens INTEGER DEFAULT 0`
   - `cache_write_tokens INTEGER DEFAULT 0`
   - `cost_usd REAL`
   - `input_summary TEXT`
   - `output_summary TEXT`
   - `metadata_json TEXT NOT NULL DEFAULT '{}'`
   - `created_at TEXT NOT NULL DEFAULT (datetime('now'))`
3. Add a `trace_quality_scores` table:
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `target_type TEXT NOT NULL`
   - `target_id TEXT NOT NULL`
   - `name TEXT NOT NULL`
   - `value_type TEXT NOT NULL`
   - `numeric_value REAL`
   - `categorical_value TEXT`
   - `boolean_value INTEGER`
   - `text_value TEXT`
   - `source TEXT NOT NULL`
   - `evaluator_name TEXT`
   - `comment TEXT`
   - `metadata_json TEXT NOT NULL DEFAULT '{}'`
   - `created_at TEXT NOT NULL DEFAULT (datetime('now'))`
4. Add a `trace_quality_prompt_refs` table:
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `name TEXT NOT NULL`
   - `version TEXT`
   - `label TEXT`
   - `source TEXT NOT NULL`
   - `content_hash TEXT`
   - `file_path TEXT`
   - `metadata_json TEXT NOT NULL DEFAULT '{}'`
   - `created_at TEXT NOT NULL DEFAULT (datetime('now'))`
5. Add a `trace_quality_observation_prompts` join table for many-to-many prompt attribution.
6. Add a `trace_quality_projection_state` table keyed by source table and source id so projection/backfill is idempotent.
7. Add indexes for trace/session lookup, observation tree lookup, observation type, model, tool name, score target, score name, and prompt name/version.
8. Define TypeScript enums/unions for observation type, source kind, score target type, score value type, score source, and projection coverage.
9. Keep table creation additive. Do not migrate or rewrite existing rows.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-schema.test.ts`
- Expect: in-memory schema initialization creates all new tables and indexes.
- Run: `pnpm build`
- Expect: new trace-quality types compile cleanly.

**Done When**

- Fresh and existing databases initialize without destructive migration.
- Invalid enum values are rejected or normalized before persistence.
- The schema can represent nested observations, scores, prompt refs, and projection provenance.

### Task 2: Build Projection Mappers For Existing Sources

**Objective**

Convert existing AgentMonitor source rows into local trace and observation records without changing source data.

**Files**

- Create: `src/trace-quality/projection.ts`
- Create: `src/trace-quality/source-readers.ts`
- Modify: `src/db/queries.ts`
- Modify: `src/db/v2-queries.ts`
- Test: `tests/trace-quality-projection.test.ts`
- Reference: `src/otel/parser.ts`
- Reference: `src/live/codex-adapter.ts`
- Reference: `src/live/claude-adapter.ts`
- Reference: `src/parser/claude-code.ts`
- Reference: `src/parser/codex-sessions.ts`

**Dependencies**

Task 1

**Implementation Steps**

1. Define a `ProjectionInput` shape for source rows from:
   - `events`
   - `session_items`
   - `session_turns`
   - `messages`
   - `tool_calls`
2. Define source-to-observation mapping rules:
   - `events.event_type=response` with model or token data -> `generation`
   - `events.event_type=tool_use` -> `tool`
   - `events.event_type=session_start/session_end` -> `event`
   - `events.event_type=error` -> `event` with error status
   - `session_items.kind=message` -> `generation` or `event`, depending on role and payload
   - `session_items.kind=reasoning` -> `span`
   - `session_items.kind=tool_call` -> `tool`
   - `session_items.kind=tool_result` -> child `tool` observation or paired output update when possible
   - `tool_calls` rows -> `tool` observations when no equivalent live/session item exists
3. Define trace grouping rules:
   - Prefer `session_turns` as trace roots when present.
   - Fall back to one trace per response/completion event when only event rows exist.
   - Fall back to one trace per browsing session for legacy or low-fidelity imported data.
4. Preserve source provenance in each observation:
   - `source_kind`
   - `source_id`
   - `source_item_id`
   - source capability/fidelity metadata
5. Populate `coverage_json` on each trace:
   - `has_full_transcript`
   - `has_tool_details`
   - `has_token_usage`
   - `has_cost`
   - `has_parent_child_structure`
   - `projection_source`
   - `projection_confidence`
6. Add deterministic ids from source identity and projection version so repeated projection is idempotent.
7. Add unit fixtures for Claude full-fidelity JSONL, Codex OTEL summary rows, Codex imported session rows, and generic API events.
8. Keep projection pure where possible so tests can validate mapping without touching SQLite.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-projection.test.ts`
- Expect: fixture rows produce stable trace and observation ids, correct observation types, correct parent-child links where source data supports them, and honest coverage flags.
- Run: `pnpm test`
- Expect: existing ingest, import, usage, analytics, and live tests still pass.

**Done When**

- Projection can run repeatedly without duplicate traces or observations.
- Codex summary-only telemetry remains visibly summary-only.
- Existing event-derived usage metrics are unchanged.

### Task 3: Add Incremental Projection And Backfill Commands

**Objective**

Persist projected traces and observations during ingest/import and provide a deterministic historical backfill command.

**Files**

- Create: `src/trace-quality/service.ts`
- Create: `scripts/backfill-trace-quality.ts`
- Modify: `src/import/index.ts`
- Modify: `src/watcher/service.ts`
- Modify: `src/api/events.ts`
- Modify: `src/api/otel.ts`
- Test: `tests/trace-quality-backfill.test.ts`
- Test: `tests/ingest.test.ts`

**Dependencies**

Task 2

**Implementation Steps**

1. Add a `projectTraceQualityForSource()` service that takes source identity and writes projected rows in a transaction.
2. Hook event ingest so newly inserted `events` rows can be projected.
3. Hook session watcher/import paths so newly parsed `session_turns`, `session_items`, `messages`, and `tool_calls` can be projected.
4. Add `scripts/backfill-trace-quality.ts` with flags:
   - `--source events|sessions|all`
   - `--session-id <id>`
   - `--from <iso-date>`
   - `--to <iso-date>`
   - `--force`
   - `--dry-run`
5. Add projection state rows after successful writes.
6. Make `--force` delete and rebuild projected rows for the selected source scope without touching source tables.
7. Emit a concise summary:
   - sources scanned
   - traces created/updated
   - observations created/updated
   - skipped unchanged sources
   - projection warnings
8. Add package script only if it will be used by maintainers, for example `trace-quality:backfill`.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-backfill.test.ts`
- Expect: dry-run makes no writes, default backfill is idempotent, force rebuild replaces projected rows for selected scope only.
- Run: `pnpm run import -- --dry-run`
- Expect: import dry-run behavior remains unchanged.
- Run: `pnpm test`
- Expect: existing import and ingest coverage remains green.

**Done When**

- New data can be projected incrementally.
- Historical data can be projected or rebuilt safely.
- Projection failures do not block primary event/session ingest unless a transaction would corrupt source state.

### Task 4: Add V2 Trace Quality Read APIs

**Objective**

Expose stable read APIs for trace lists, trace detail, observation trees, score summaries, prompt attribution, and quality findings.

**Files**

- Modify: `src/api/v2/router.ts`
- Modify: `src/api/v2/types.ts`
- Modify: `src/db/v2-queries.ts`
- Create: `src/trace-quality/queries.ts`
- Test: `tests/v2-trace-quality-api.test.ts`
- Reference: `frontend/src/lib/api/client.ts`

**Dependencies**

Task 3

**Implementation Steps**

1. Add `GET /api/v2/trace-quality/traces` with filters:
   - date range
   - project
   - agent
   - status
   - observation type
   - model
   - tool
   - score name
   - min/max score
   - `exclude_low_coverage`
2. Add `GET /api/v2/trace-quality/traces/:id` returning:
   - trace metadata
   - coverage
   - aggregate tokens/cost/duration
   - prompt refs
   - score summary
3. Add `GET /api/v2/trace-quality/traces/:id/observations` returning a stable tree plus flat ordering.
4. Add `GET /api/v2/trace-quality/observations/:id`.
5. Add `GET /api/v2/trace-quality/scores` and `GET /api/v2/trace-quality/score-summary`.
6. Add `GET /api/v2/trace-quality/prompts` and prompt-version rollup data.
7. Add `GET /api/v2/trace-quality/findings` for derived alertable findings.
8. Include coverage metadata in all aggregate responses:
   - matching traces
   - included traces
   - excluded low-coverage traces
   - observations with usage
   - observations missing usage
   - score coverage
9. Add pagination and deterministic ordering for trace lists and observation lists.
10. Keep API responses additive and isolated under the new route family.

**Verification**

- Run: `node --import tsx --test tests/v2-trace-quality-api.test.ts`
- Expect: all new endpoints return stable JSON shapes, coverage metadata, pagination, and correct filtering.
- Run: `pnpm test:v2:contract:ts`
- Expect: existing v2 contract tests still pass.
- Run: `pnpm build`
- Expect: frontend and backend TypeScript compile with new API types.

**Done When**

- The frontend can build a complete trace-quality view without reaching into legacy endpoints.
- Coverage and partial-data semantics are visible in response payloads.
- Existing `/api/v2/usage/*`, `/api/v2/analytics/*`, and `/api/v2/live/*` contracts remain compatible.

### Task 5: Add Local Scores And Human Review Workflow

**Objective**

Allow users and deterministic evaluators to create, update, delete, and query local scores attached to trace-quality targets.

**Files**

- Create: `src/trace-quality/scores.ts`
- Modify: `src/api/v2/router.ts`
- Modify: `src/api/v2/types.ts`
- Modify: `src/db/v2-queries.ts`
- Test: `tests/trace-quality-scores.test.ts`
- Test: `tests/v2-trace-quality-api.test.ts`

**Dependencies**

Task 4

**Implementation Steps**

1. Add score validation:
   - `target_type`: `session`, `trace`, `observation`, `message`, `event`, `session_item`
   - `value_type`: `numeric`, `categorical`, `boolean`, `text`
   - `source`: `human`, `code_evaluator`, `llm_judge`, `api`
2. Add `POST /api/v2/trace-quality/scores`.
3. Add `PATCH /api/v2/trace-quality/scores/:id`.
4. Add `DELETE /api/v2/trace-quality/scores/:id`.
5. Add deterministic code evaluator helpers for first-pass local checks:
   - tool success/failure score
   - high-cost session flag
   - missing pricing flag
   - low-fidelity trace flag
   - rate-limit/error flag
6. Store evaluator provenance in `evaluator_name` and `metadata_json`.
7. Do not add LLM-as-judge execution in this task. Reserve `source=llm_judge` for future explicit integrations.
8. Add score rollups by trace, session, model, tool, prompt, and time bucket.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-scores.test.ts`
- Expect: score validation rejects invalid target/value combinations and persists valid numeric, categorical, boolean, and text scores.
- Run: `node --import tsx --test tests/v2-trace-quality-api.test.ts`
- Expect: score CRUD endpoints are idempotent where appropriate and update rollups.
- Run: `pnpm test`
- Expect: no existing API behavior regresses.

**Done When**

- A user can attach a local quality judgment to a trace or observation.
- Deterministic evaluator scores can be regenerated safely.
- Score rollups can support quality dashboards without inspecting private message content unnecessarily.

### Task 6: Add Prompt And Version Attribution

**Objective**

Track which prompt, skill, system instruction, task template, or explicit prompt reference influenced a generation or agent step, and expose rollups by prompt version.

**Files**

- Create: `src/trace-quality/prompts.ts`
- Modify: `src/trace-quality/projection.ts`
- Modify: `src/parser/claude-code.ts`
- Modify: `src/parser/codex-sessions.ts`
- Modify: `src/otel/parser.ts`
- Test: `tests/trace-quality-prompts.test.ts`
- Reference: `src/db/v2-queries.ts`

**Dependencies**

Task 5

**Implementation Steps**

1. Define prompt reference sources:
   - `metadata`
   - `skill_file`
   - `agent_instruction`
   - `task_template`
   - `system_prompt`
   - `manual`
2. Parse explicit prompt metadata when present in events or session item payloads:
   - `prompt_name`
   - `prompt_version`
   - `prompt_label`
   - `prompt_hash`
3. Infer skill prompt references from existing explicit Claude `Skill` tool calls and inferred Codex `.../SKILL.md` reads.
4. Infer tokenmaxxing task template references only when metadata or file paths make the mapping deterministic.
5. Store prompt refs using content hashes where full prompt text should not be persisted.
6. Link prompt refs to generation, agent, evaluator, and guardrail observations through the join table.
7. Expose prompt rollups by version:
   - generation count
   - median duration
   - total cost
   - input/output tokens
   - score count
   - median numeric score
   - last seen
8. Do not implement remote Langfuse prompt management. The feature is local attribution only.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-prompts.test.ts`
- Expect: explicit metadata wins over inference, inferred skill refs are stable, ambiguous refs are omitted with coverage warnings.
- Run: `node --import tsx --test tests/v2-trace-quality-api.test.ts`
- Expect: prompt rollup endpoint returns versioned metrics and score coverage.

**Done When**

- Prompt/version attribution can explain cost, latency, and scores by local prompt reference.
- Ambiguous prompt attribution is not guessed.
- No prompt body is persisted unless the source already stores it and redaction settings allow it.

### Task 7: Add Quality Findings And Alert Taxonomy

**Objective**

Borrow the useful dashboard/alert vocabulary from Langfuse and `terraform-mcp-observability` as local, read-only findings that help operators detect quality, cost, latency, and telemetry problems.

**Files**

- Create: `src/trace-quality/findings.ts`
- Modify: `src/api/v2/router.ts`
- Modify: `src/api/v2/types.ts`
- Test: `tests/trace-quality-findings.test.ts`
- Reference: `src/usage/budgets.ts`
- Reference: `src/usage/tier-feedback.ts`

**Dependencies**

Task 6

**Implementation Steps**

1. Define finding severity:
   - `info`
   - `warning`
   - `high`
   - `critical`
2. Define first-pass finding kinds:
   - `high_error_rate`
   - `tool_failure_rate`
   - `model_error_rate`
   - `rate_limit_events`
   - `high_latency_p95`
   - `latency_spike`
   - `token_spike`
   - `cost_anomaly`
   - `daily_budget_risk`
   - `unknown_pricing`
   - `low_trace_coverage`
   - `collector_or_otel_dropoff`
   - `low_quality_score`
3. Keep findings read-only. Do not notify, page, block, or mutate agent behavior.
4. Use existing usage budget logic for cost-budget finding semantics where possible.
5. Compute findings from local SQLite data, not PromQL.
6. Make thresholds configurable through a local JSON file only after defaults are covered by tests.
7. Return evidence in each finding:
   - impacted session/trace/observation ids
   - metric value
   - threshold
   - time window
   - coverage caveat
   - suggested next inspection link target
8. Add `GET /api/v2/trace-quality/findings`.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-findings.test.ts`
- Expect: fixtures trigger each finding kind, boundary values are handled correctly, and missing data produces coverage caveats instead of false positives.
- Run: `node --import tsx --test tests/usage-budgets.test.ts`
- Expect: usage budget behavior remains compatible if shared helpers are touched.

**Done When**

- AgentMonitor can surface local quality and anomaly findings without Prometheus or Grafana.
- Findings provide evidence and next inspection targets.
- Threshold behavior is deterministic and documented.

### Task 8: Build Svelte Trace Quality UI

**Objective**

Expose trace quality inspection in the canonical Svelte app with a trace list, trace tree, score controls, prompt rollups, and quality findings.

**Files**

- Modify: `frontend/src/lib/api/client.ts`
- Modify: `frontend/src/lib/components/analytics/`
- Modify: `frontend/src/lib/components/live/`
- Modify: `frontend/src/lib/components/sessions/`
- Create: `frontend/src/lib/components/trace-quality/TraceQualityPage.svelte`
- Create: `frontend/src/lib/components/trace-quality/TraceTree.svelte`
- Create: `frontend/src/lib/components/trace-quality/ScoreEditor.svelte`
- Create: `frontend/src/lib/components/trace-quality/QualityFindings.svelte`
- Create: `frontend/src/lib/components/trace-quality/PromptRollups.svelte`
- Create: `frontend/src/lib/stores/trace-quality.svelte.ts`
- Test: add or extend frontend component/store tests if this repo has a local pattern available
- Reference: `docs/system/DESIGN.md`
- Reference: `frontend/src/app.css`

**Dependencies**

Task 7

**Implementation Steps**

1. Add typed client helpers for the new `/api/v2/trace-quality/*` endpoints.
2. Add a `trace-quality` store that handles filters, loading states, errors, selected trace, selected observation, and score editing.
3. Add a Quality sub-view under the consolidated Analytics tab unless product review chooses a separate top-level tab.
4. Add trace drill-in links from:
   - Usage top sessions
   - Analytics top sessions
   - Live session detail
   - Session browser detail
   - Search result context where a trace id can be derived
5. Render trace coverage visibly:
   - full transcript
   - summary-only
   - tool-capable
   - usage-capable
   - score-covered
6. Render a stable trace tree:
   - observation type icon
   - name
   - status
   - model/tool
   - duration
   - token/cost summary
   - score badges
7. Add score controls only for local human review:
   - boolean pass/fail
   - numeric score
   - categorical label
   - text note
8. Add quality findings cards with severity, evidence, and links into trace/session detail.
9. Follow the Instrument Console design language: dense, utilitarian, no marketing hero, no nested cards.
10. Keep mobile readable, but continue the repo's laptop-first product stance.

**Verification**

- Run: `pnpm frontend:check`
- Expect: Svelte and frontend TypeScript checks pass.
- Run: `pnpm build`
- Expect: full backend and frontend build passes.
- Run: `pnpm exec playwright test`
- Expect: canonical app navigation and trace-quality workflows pass. If no dedicated trace-quality tests exist yet, add a smoke test for loading the Quality view and opening a seeded trace.
- Manual check: open `/app/`, inspect Analytics Quality view, open a trace, add/remove a score, verify no overlapping text or unstable layout at desktop and narrow widths.

**Done When**

- Operators can find a high-cost or low-quality trace, inspect its observation tree, and attach a local score without leaving AgentMonitor.
- The UI makes partial telemetry clear.
- Existing Monitor, Live, Sessions, Search, Usage, and Insights views still work.

### Task 9: Add Optional Langfuse OTLP Export

**Objective**

Provide a disabled-by-default export path that can send selected local trace-quality data to a Langfuse OTLP endpoint for users who explicitly want external Langfuse analysis.

**Files**

- Create: `src/trace-quality/langfuse-export.ts`
- Create: `scripts/export-langfuse-traces.ts`
- Modify: `src/config.ts`
- Modify: `docs/system/OPERATIONS.md`
- Test: `tests/trace-quality-langfuse-export.test.ts`
- Reference: `hooks/codex/README.md`

**Dependencies**

Task 8

**Implementation Steps**

1. Add config flags:
   - `AGENTMONITOR_LANGFUSE_EXPORT_ENABLED=false`
   - `AGENTMONITOR_LANGFUSE_OTLP_ENDPOINT`
   - `AGENTMONITOR_LANGFUSE_PUBLIC_KEY`
   - `AGENTMONITOR_LANGFUSE_SECRET_KEY`
   - `AGENTMONITOR_LANGFUSE_EXPORT_INCLUDE_PROMPTS=false`
   - `AGENTMONITOR_LANGFUSE_EXPORT_INCLUDE_REASONING=false`
   - `AGENTMONITOR_LANGFUSE_EXPORT_INCLUDE_TOOL_ARGUMENTS=false`
2. Keep export manual at first through `scripts/export-langfuse-traces.ts`. Do not auto-export during ingest in the first pass.
3. Convert local traces and observations into OTLP spans with Langfuse-compatible attributes:
   - trace/session identifiers
   - observation type
   - model
   - token usage
   - cost
   - prompt reference metadata
   - score metadata where safe
4. Apply explicit filtering so only LLM-relevant observations are exported.
5. Apply redaction settings before serialization.
6. Add `--dry-run` output that shows counts and field inclusion without sending network requests.
7. Add test coverage using a local fake HTTP server. Do not require real Langfuse credentials in tests.
8. Document that this is optional, user-triggered, and externalizes local telemetry.

**Verification**

- Run: `node --import tsx --test tests/trace-quality-langfuse-export.test.ts`
- Expect: dry-run sends no requests, export sends expected OTLP payload to fake server, redaction flags remove prompt/reasoning/tool-argument payloads.
- Run: `pnpm lint`
- Expect: no new lint errors.
- Run: `pnpm build`
- Expect: export script and config compile.

**Done When**

- AgentMonitor can optionally export selected trace-quality data to Langfuse without depending on Langfuse for local functionality.
- Export is explicit, reversible, and redaction-aware.
- Tests never require external network or real credentials.

### Task 10: Update System Docs, Roadmap, And Release Notes

**Objective**

Document shipped semantics after implementation so future agents do not confuse the local trace-quality model with Langfuse itself.

**Files**

- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `docs/system/FEATURES.md`
- Modify: `docs/system/OPERATIONS.md`
- Modify: `docs/project/ROADMAP.md`
- Create: `docs/system/trace-quality.md`

**Dependencies**

Tasks 1 through 9 as applicable

**Implementation Steps**

1. Add `docs/system/trace-quality.md` covering:
   - local trace/session/observation semantics
   - observation type taxonomy
   - score model
   - prompt attribution
   - quality findings
   - coverage caveats
   - optional Langfuse export
2. Update `docs/system/ARCHITECTURE.md` with schema and data-flow changes.
3. Update `docs/system/FEATURES.md` with new API endpoint catalog entries.
4. Update `docs/system/OPERATIONS.md` with backfill and optional export commands.
5. Update `README.md` only for high-level product/API summary changes.
6. Update `docs/project/ROADMAP.md` to move trace quality from planned to shipped or follow-up, depending on implementation state.
7. Keep docs explicit that AgentMonitor remains local-first and Langfuse-independent.

**Verification**

- Run: `rg -n "trace-quality|Langfuse|observation|score" README.md docs/system docs/project docs/README.md`
- Expect: references are consistent and do not imply Langfuse is required.
- Run: `pnpm lint`
- Expect: code changes still pass lint after docs-adjacent imports or scripts.
- Run: `pnpm test`
- Expect: all TypeScript tests pass.

**Done When**

- A zero-context engineer can understand the trace-quality model from docs alone.
- Operational commands are documented.
- The roadmap reflects what shipped and what remains deferred.

## Risks And Mitigations

- Risk: The new trace/observation tables duplicate existing `events`, `session_items`, and `tool_calls` in confusing ways.
  Mitigation: Treat trace-quality rows as a projection with explicit source provenance and projection state. Never remove or reinterpret source rows during projection.

- Risk: Codex OTEL summary data could be presented as full transcript fidelity.
  Mitigation: Carry coverage flags into every trace and aggregate response, and render summary-only caveats in the UI.

- Risk: Sensitive prompt, reasoning, or tool argument content could leak into scores, prompt refs, or optional export.
  Mitigation: Reuse existing capture/redaction settings, prefer content hashes and summaries, and make external export disabled by default.

- Risk: Trace projection could slow down ingest or session watchers.
  Mitigation: Keep projection transactional and incremental, add projection state for idempotency, and allow backfill/rebuild to run out of band.

- Risk: A score model could become too generic to query efficiently.
  Mitigation: Keep score target/value/source vocabularies small, index target and score names, and add rollup queries only around known product workflows.

- Risk: Quality findings could create noisy false positives.
  Mitigation: Start with read-only findings, expose evidence and coverage caveats, and avoid notifications or blocking behavior in the first implementation.

- Risk: Optional Langfuse export could pull in heavy dependencies or cloud assumptions.
  Mitigation: Implement export as a manual script using OTLP payloads and local config. Do not add Langfuse SDK as a core server dependency unless a later implementation proves the benefit.

- Risk: The TypeScript and Rust runtime contracts diverge further.
  Mitigation: Defer Rust implementation but document the new v2 contract clearly. Add parity tests once the TypeScript surface stabilizes.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Schema is additive and initializes cleanly | `node --import tsx --test tests/trace-quality-schema.test.ts` | New tables/indexes exist in a fresh DB and existing schema tests still pass |
| Source projection is deterministic | `node --import tsx --test tests/trace-quality-projection.test.ts` | Fixtures produce stable trace/observation ids, types, parent links, and coverage flags |
| Historical backfill is safe | `node --import tsx --test tests/trace-quality-backfill.test.ts` | Dry-run writes nothing, default backfill is idempotent, force rebuild scopes deletes correctly |
| V2 APIs are stable | `node --import tsx --test tests/v2-trace-quality-api.test.ts` | Trace, observation, score, prompt, and finding endpoints return expected JSON shapes |
| Existing v2 contracts remain compatible | `pnpm test:v2:contract:ts` | Current v2 contract fixtures pass unchanged except for explicitly additive new endpoints |
| Score validation is correct | `node --import tsx --test tests/trace-quality-scores.test.ts` | Invalid score payloads fail and valid score types persist with provenance |
| Prompt attribution is deterministic | `node --import tsx --test tests/trace-quality-prompts.test.ts` | Explicit metadata wins, stable skill refs are inferred, ambiguous refs are omitted |
| Findings are evidence-bearing | `node --import tsx --test tests/trace-quality-findings.test.ts` | Each finding includes severity, value, threshold, window, impacted ids, and coverage caveat |
| Svelte UI compiles | `pnpm frontend:check` | Svelte check passes |
| Full app builds | `pnpm build` | Backend, CSS, and frontend build pass |
| Existing test suite remains green | `pnpm test` | All Node tests pass |
| UI workflow is usable | `pnpm exec playwright test` | Quality view smoke test opens seeded trace and score controls without regressions |
| Optional Langfuse export is safe | `node --import tsx --test tests/trace-quality-langfuse-export.test.ts` | Fake-server export works, dry-run sends no request, redaction flags remove sensitive fields |
| Docs reflect shipped behavior | `rg -n "trace-quality|Langfuse|observation|score" README.md docs/system docs/project docs/README.md` | References are discoverable and do not describe Langfuse as required |

## Handoff

1. Execute in this session, task by task.
2. Open a separate execution session.
3. Refine this spec before implementation.
