# Features

Product-surface reference for AgentMonitor.

## Canonical Surface

- Canonical product surface: Svelte app at `/app/`.
- Canonical application contract: `/api/v2/*`.
- Transitional compatibility surface: legacy dashboard at `/`.

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
- Claude Code `session_end` transitions to `idle` (not `ended`) so cards linger in Active Agents.
- Filter sessions by status, agent type, and project.

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
- Historical cost recalculation via `pnpm recalculate-costs`.

## Analytics

- Historical analytics live under `/api/v2/analytics/*` and are intended for the canonical Svelte app.
- Summary, activity, project, hour-of-week, top-session, velocity, and per-agent analytics aggregate across all matching sessions.
- Tool analytics remain capability-aware and intentionally exclude sessions whose projection contract does not expose tool analytics.
- Analytics responses include coverage metadata so the UI can disclose when a slice is all-session versus capability-limited.
- The Svelte `Analytics` tab now supports date ranges, project and agent filters, clickable drilldowns, and CSV export for historical review workflows.

## Historical Import

- Claude Code JSONL conversation log import.
- Codex session file import.
- File-hash tracking prevents duplicate backfills.
- Supports `--from`, `--to` date filters and `--dry-run` mode.

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
| `/api/v2/analytics/summary` | GET | Capability-aware summary totals and coverage |
| `/api/v2/analytics/activity` | GET | Daily activity series plus coverage metadata |
| `/api/v2/analytics/projects` | GET | Per-project message/session breakdowns |
| `/api/v2/analytics/tools` | GET | Tool-analytics-capable tool usage breakdowns |
| `/api/v2/analytics/hour-of-week` | GET | 7x24 historical activity heatmap data |
| `/api/v2/analytics/top-sessions` | GET | Highest-volume sessions for review workflows |
| `/api/v2/analytics/velocity` | GET | Pace metrics across active and calendar day spans |
| `/api/v2/analytics/agents` | GET | Per-agent comparison rows for analytics UI |
| `/api/health` | GET | Service health check |
| `/api/filter-options` | GET | Distinct filterable field values |
| `/api/otel/v1/logs` | POST | OTLP JSON log ingestion |
| `/api/otel/v1/metrics` | POST | OTLP JSON metric ingestion |

V1 endpoints remain active for compatibility and current monitor behavior, but the long-term product contract is `/api/v2/*`.

## SSE Event Types

- `event`: New agent event ingested.
- `stats`: Updated aggregate statistics.
- `session_update`: Session status change.
