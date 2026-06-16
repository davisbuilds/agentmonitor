# Features

Product-surface reference for AgentMonitor.

## Canonical Surface

- Canonical product surface: Svelte app at `/app/`.
- Canonical application contract: `/api/v2/*`.
- Transitional compatibility surface: legacy dashboard at `/`.
- Local operator CLI: `amon`, with `agentmonitor` as an equivalent executable alias.

## Operator CLI

- Runtime commands cover server startup, health checks, status reporting, and opening the canonical app.
- Maintenance commands cover historical import, session-browser sync, cost recalculation, and trace-quality backfill.
- Read commands cover sessions, pinned messages, live views, usage, analytics, and trace-quality reports.
- Hook helpers print Codex OTEL configuration and wrap the Claude Code hook installer.
- Human output is terminal-safe; `--json` is available for scripts and automation.

## Real-Time Dashboard

- The Svelte `Monitor` tab is the canonical real-time operator surface.
- The legacy dashboard at `/` remains available for compatibility, but should not define new product behavior.
- Agent cards showing active sessions, tool usage, and token counts.
- Live event feed with filtering by agent type, event type, tool name, model, and branch.
- Stats bar with aggregate counters and cost totals.
- Cost dashboard with breakdowns by model, project, and timeline.
- Tool analytics showing usage patterns across sessions.
- Usage monitor with per-agent token/cost limits and rolling windows.

## Session Management

- Session lifecycle: `active` → `idle` (5 min) → `ended` (10 min).
- Session detail view with event timeline and transcript.
- The Svelte `Sessions` viewer includes a transcript activity minimap that can jump into long conversations without requiring the full transcript to be preloaded.
- Transcript turns are attributed as `You` (human input), the agent name (`Claude`/`Codex`, for assistant turns), or `Tool` (tool-result turns, which Claude Code stores under the `user` role). An author dropdown filters the loaded window to any one of these (or all), with a "loaded" count making the windowing explicit.
- Messages can be pinned for later review. Pinned moments live in the **Pinned sub-view of the Sessions tab** (Browse / Pinned SubTabs); "Open In Session" reopens them on Browse at the corresponding transcript ordinal. Legacy `#pinned` deep links redirect to `#sessions?view=pinned`.
- Claude Code `session_end` transitions to `idle` (not `ended`) so cards linger in Active Agents.
- Filter sessions by status, agent type, and project.
- The Browse list requests `GET /api/v2/sessions?exclude_empty=true`, hiding telemetry-only sessions with no browsable transcript (history capability `none`) — these previously surfaced as "Local command activity" rows that opened to an empty viewer. The `exclude_empty` param is opt-in and adjusts both the result set and the `total` count.

## Live Ops Tab

- Svelte `Live` tab with a dedicated session tree, live item stream, and inspector panel.
- Live item model supports message, reasoning, tool call, and tool result records today.
- Dedicated live SSE stream at `/api/v2/live/stream` separate from the Monitor SSE contract.
- Live settings endpoint at `/api/v2/live/settings` exposes whether the tab is enabled, the current Codex mode, and capture/redaction settings.
- Claude live mode is full-fidelity relative to current AgentMonitor sources because it is driven by Claude JSONL session files.
- Codex `otel-only` mode is summary-only and should not be treated as equivalent to Claude live fidelity.

## Multi-Agent Support

| Agent | Integration | Token/Cost Data |
|-------|------------|-----------------|
| Claude Code | Shell/Python hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`) | Yes (via hooks) |
| Codex | OTEL JSON exporter (`logs`, `metrics`) | Via import backfill |
| Generic | HTTP API (`POST /api/events`) | If provided in payload |

## Privacy And Capture Controls

- `AGENTMONITOR_ENABLE_LIVE_TAB` controls whether the `Live` tab is exposed in the Svelte app.
- `AGENTMONITOR_LIVE_CAPTURE_PROMPTS=false` redacts live user-message payloads.
- `AGENTMONITOR_LIVE_CAPTURE_REASONING=false` redacts live reasoning payloads.
- `AGENTMONITOR_LIVE_CAPTURE_TOOL_ARGUMENTS=false` redacts tool-call input arguments while retaining the tool name.
- `AGENTMONITOR_LIVE_DIFF_PAYLOAD_MAX_BYTES` is the payload cap for diff-style live records as richer agents are added.

## Cost Tracking

- Per-model pricing tables (JSON data files for Claude, Codex, Gemini families).
- Automatic cost calculation on ingest from token counts.
- Cost breakdowns by model, project, and time period.
- Historical cost recalculation via `amon costs recalc`; `pnpm recalculate-costs` remains a compatibility wrapper.

## Analytics

> The Svelte app consolidates historical Analytics, Usage, and Insights into a **single `Analytics` tab** with **Overview / Usage / Insights** sub-views (SubTabs). A shared filter bar drives `date / project / agent` across all three sub-views; per-view specialized filters stay local (Usage: model/provider/tier; Insights: kind + authoring provider/model). Deep links use one `#analytics?view=…` hash; legacy `#usage` / `#insights` links redirect. The backend `/api/v2/analytics/*`, `/api/v2/usage/*`, and `/api/v2/insights/*` contracts are unchanged.

- Historical analytics live under `/api/v2/analytics/*` and are intended for the canonical Svelte app.
- Summary, activity, project, hour-of-week, top-session, velocity, and per-agent analytics aggregate across all matching sessions.
- Tool analytics remain capability-aware and intentionally exclude sessions whose projection contract does not expose tool analytics.
- Skill analytics now include explicit Claude `Skill` tool calls plus inferred Codex skill reads from `.../SKILL.md` commands captured through OTEL or Codex JSONL fallback.
- Analytics responses include coverage metadata so the UI can disclose when a slice is all-session versus capability-limited.
- The `Overview` sub-view supports date ranges, project and agent filters, clickable drilldowns, and CSV export for historical review workflows.

## Usage

- Historical usage lives under `/api/v2/usage/*` and is event-derived rather than transcript-derived.
- Summary totals, daily series, project/model/tier/agent attribution, and top-session views all use cost/token-bearing event rows as their source of truth.
- Usage models are classified at query time into canonical model, provider, family, tier, lifecycle, and pricing-status fields. Unknown and deprecated models remain visible in responses.
- Usage endpoints accept optional `model`, `provider`, and `tier` filters in addition to date, project, and agent filters. Classification filters are applied consistently before summary, daily, attribution, tier, agent, and top-session panels aggregate.
- Usage summary includes `prior_total_cost_usd` and `cost_delta_pct` for the immediately preceding same-length date range when a valid current range is supplied.
- Usage budget reports live at `/api/v2/usage/budgets`. They read an optional local JSON config, reuse usage filters to compute current spend, and return alert states without blocking or enforcing agent activity.
- Usage tier feedback lives at `/api/v2/usage/tier-feedback`. It returns deterministic, evidence-bearing advisory findings for human review and does not auto-apply model or tier changes.
- Stored `cost_usd` is authoritative for event cost. Cache hit rate and estimated cache savings are derived estimates from current pricing metadata and are coverage-limited when pricing is unknown.
- Usage responses include coverage metadata so the UI can disclose when matching events exist but carry no cost or token data.
- The `Usage` sub-view supports the shared date/project/agent filters plus provider, tier, and model facets, session drill-in when transcript history exists, and CSV export.

## Trace Quality

- Local trace-quality APIs live under `/api/v2/trace-quality/*` and are isolated from legacy monitor endpoints.
- Trace lists support date, project, agent, status, observation type, model, tool, score, and low-coverage filters with deterministic pagination.
- Trace detail exposes parsed metadata, coverage, aggregate token/cost/duration totals, prompt attribution, and score summaries.
- Prompt attribution links explicit prompt metadata, deterministic task-template refs, Claude `Skill` calls, and Codex `skills/.../SKILL.md` reads without copying prompt bodies into trace-quality prompt refs.
- Local human/API review scores can be created, updated, and deleted without mutating source event or session rows.
- Observation APIs expose both flat deterministic ordering and nested parent/child trees.
- Score, prompt, and findings endpoints provide local review rollups for future evaluation workflows. Prompt rollups include generation count, median duration, total cost, token totals, score count, median numeric score, and last seen.
- Local quality/alert findings are deterministic, read-only, and computed from SQLite (no Prometheus/Grafana). The taxonomy covers `high_error_rate`, `tool_failure_rate`, `model_error_rate`, `rate_limit_events`, `high_latency_p95`, `latency_spike`, `token_spike`, `cost_anomaly`, `daily_budget_risk`, `unknown_pricing`, `low_trace_coverage`, `collector_or_otel_dropoff`, `low_quality_score`, and per-observation `observation_error`. Each finding carries severity (`info`/`warning`/`high`/`critical`), evidence (metric value, threshold, window, sample size, impacted ids, coverage caveat), and a next-inspection target. Minimum-sample and baseline gates prevent false positives on sparse data; thresholds default in-code and are overridable via `AGENTMONITOR_TRACE_QUALITY_FINDINGS_PATH`. The findings endpoint accepts optional `kind` and `severity` query filters.
- Aggregate trace-quality responses include coverage metadata so the UI can disclose matching traces, included traces, low-coverage exclusions, usage-bearing observations, missing-usage observations, and score coverage.
- The Svelte app exposes a **Quality** sub-view under Analytics with two panels (Explorer | Dashboards toggle):
  - **Explorer** — a trace list with coverage badges, a selected-trace inspector (aggregate stats, expandable observation tree, payload-policy-safe input/output summaries), and local human-review score controls (pass/fail, numeric, label, note). The score panel only lists human-authored scores; machine-written rows surface in the dashboards instead. Deep-linkable via `#analytics?view=quality&trace=<id>`. Drill-in links from Usage/Analytics top sessions, Live session detail, the Session browser, and Search results open the explorer scoped to a session (`&session=<id>`, which overrides the date filter and auto-opens a lone trace); the trace list supports a `session_id` filter for this.
  - **Dashboards** — aggregate read-only panels over the shared date/project/agent window: finding cards (severity badge, evidence, coverage caveat, `kind`/`severity` filters, and an **Inspect** action that jumps into the explorer at the impacted trace/session), prompt-version rollups, and score trends (summary by score name plus rollups by day/model/tool/prompt/session/trace). Loaded lazily on first open.

## Insights

- Historical insights live under `/api/v2/insights/*` and persist generated outputs rather than recalculating them on page load.
- Each saved insight carries its generation scope: kind, date range, project filter, and agent filter.
- Each saved insight also persists the analytics summary, usage summary, and both coverage contracts used to generate it.
- The `Insights` sub-view supports the shared date/project/agent filters plus authoring provider/model and insight-kind targeting, with optional prompt steering.
- New insight generation supports OpenAI, Anthropic, and Gemini providers with provider-specific API keys and model overrides.
- The UI keeps scope and coverage visible so generated text is never detached from the underlying data limits.

## Search And Navigation

- Historical search lives under `/api/v2/search` and now supports both recency and relevance sort modes.
- Search responses include session agent/project/timestamp context in addition to the transcript snippet and ordinal target.
- The Svelte `Search` tab debounces queries, falls back to recent sessions when the query is empty, and keeps ordinal-based session navigation intact.
- The Svelte app exposes a global command palette on `Cmd/Ctrl+K` for jumping into recent sessions or transcript matches from any tab.

## Historical Import

- Claude Code JSONL conversation log import.
- Codex session file import.
- File-hash tracking prevents duplicate backfills.
- Supports `--from`, `--to` date filters and `--dry-run` mode.
- CLI entrypoints are `amon import` for event history and `amon sync sessions` for session-browser rows. Existing package scripts remain compatibility wrappers.

## API Surface

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/events` | POST | Ingest single event |
| `/api/events/batch` | POST | Ingest event batch |
| `/api/events` | GET | Query events with filters |
| `/api/stats` | GET | Aggregate counters and breakdowns |
| `/api/stats/cost` | GET | Cost breakdowns by model/project/timeline |
| `/api/sessions` | GET | List sessions with filters |
| `/api/sessions/:id` | GET | Session detail + transcript |
| `/api/stream` | GET | SSE stream (event, stats, session_update) |
| `/api/v2/live/settings` | GET | Live-tab enablement and capture metadata |
| `/api/v2/live/sessions` | GET | Live session index with fidelity/status fields |
| `/api/v2/live/sessions/:id/turns` | GET | Normalized live turns |
| `/api/v2/live/sessions/:id/items` | GET | Normalized live items |
| `/api/v2/live/stream` | GET | Dedicated live SSE stream |
| `/api/v2/pins` | GET | List pinned transcript moments, optionally filtered by project |
| `/api/v2/sessions/:id/pins` | GET | List pinned messages for a specific session |
| `/api/v2/sessions/:id/messages/:messageId/pin` | POST | Pin a transcript message using ordinal-stable persistence |
| `/api/v2/sessions/:id/messages/:messageId/pin` | DELETE | Remove a saved transcript pin |
| `/api/v2/sessions/:id/activity` | GET | Bucketed transcript activity for session-viewer minimap navigation |
| `/api/v2/search` | GET | FTS search with recency/relevance sort and session-context metadata |
| `/api/v2/analytics/summary` | GET | Capability-aware summary totals and coverage |
| `/api/v2/analytics/activity` | GET | Daily activity series plus coverage metadata |
| `/api/v2/analytics/projects` | GET | Per-project message/session breakdowns |
| `/api/v2/analytics/tools` | GET | Tool-analytics-capable tool usage breakdowns |
| `/api/v2/analytics/skills/daily` | GET | Daily explicit/inferred skill invocation breakdowns |
| `/api/v2/analytics/hour-of-week` | GET | 7x24 historical activity heatmap data |
| `/api/v2/analytics/top-sessions` | GET | Highest-volume sessions for review workflows |
| `/api/v2/analytics/velocity` | GET | Pace metrics across active and calendar day spans |
| `/api/v2/analytics/agents` | GET | Per-agent comparison rows for analytics UI |
| `/api/v2/usage/summary` | GET | Event-derived usage totals, prior-period comparison, and coverage metadata |
| `/api/v2/usage/daily` | GET | Daily event-derived usage series plus coverage metadata |
| `/api/v2/usage/projects` | GET | Usage attribution grouped by project |
| `/api/v2/usage/models` | GET | Usage attribution grouped by model |
| `/api/v2/usage/tiers` | GET | Usage attribution grouped by provider-neutral model tier |
| `/api/v2/usage/agents` | GET | Usage attribution grouped by agent type |
| `/api/v2/usage/top-sessions` | GET | Highest-cost usage sessions with browsing-session availability |
| `/api/v2/usage/budgets` | GET | Read-only budget state from optional local budget config |
| `/api/v2/usage/tier-feedback` | GET | Human-reviewed advisory tier feedback from usage evidence |
| `/api/v2/trace-quality/traces` | GET | Trace-quality trace list with filters, aggregates, pagination, and coverage |
| `/api/v2/trace-quality/traces/:id` | GET | Trace detail with parsed metadata, prompt refs, score summary, and coverage |
| `/api/v2/trace-quality/traces/:id/observations` | GET | Flat and nested observation data for a trace |
| `/api/v2/trace-quality/observations/:id` | GET | Observation detail with prompt refs and local scores |
| `/api/v2/trace-quality/scores` | GET | Local trace-quality scores with filters and coverage |
| `/api/v2/trace-quality/scores` | POST | Create a local human/API/code-evaluator/LLM-judge score after validating target and value shape |
| `/api/v2/trace-quality/scores/:id` | PATCH | Update a local trace-quality score and clear stale value columns when value type changes |
| `/api/v2/trace-quality/scores/:id` | DELETE | Delete a local trace-quality score |
| `/api/v2/trace-quality/score-summary` | GET | Score rollups grouped by score name and value type |
| `/api/v2/trace-quality/score-rollups` | GET | Score rollups grouped by trace, session, model, tool, prompt, and day |
| `/api/v2/trace-quality/prompts` | GET | Prompt-version attribution rollups with generation, duration, cost, token, score, and last-seen metrics |
| `/api/v2/trace-quality/findings` | GET | Read-only quality/cost/latency/telemetry findings with severity, evidence, and next-inspection targets; optional `kind`/`severity` filters |
| `/api/v2/insights` | GET | List persisted insights for the current historical slice |
| `/api/v2/insights/:id` | GET | Fetch a single persisted insight |
| `/api/v2/insights/generate` | POST | Generate and persist a new insight from analytics + usage data |
| `/api/v2/insights/:id` | DELETE | Remove a persisted insight |
| `/api/health` | GET | Service health check |
| `/api/filter-options` | GET | Distinct filterable field values |
| `/api/otel/v1/logs` | POST | OTLP JSON log ingestion |
| `/api/otel/v1/metrics` | POST | OTLP JSON metric ingestion |

V1 endpoints remain active for ingest, SSE, provider quota, and legacy dashboard compatibility, but the long-term product contract is `/api/v2/*`.

## SSE Event Types

- `event`: New agent event ingested.
- `stats`: Updated aggregate statistics.
- `session_update`: Session status change.
