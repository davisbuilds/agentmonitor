# Features

Product-surface reference for AgentMonitor.

## Real-Time Dashboard

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

## Multi-Agent Support

| Agent | Integration | Token/Cost Data |
|-------|------------|-----------------|
| Claude Code | Shell/Python hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`) | Yes (via hooks) |
| Codex | OTEL JSON exporter (`logs`, `metrics`) | Via import backfill |
| Generic | HTTP API (`POST /api/events`) | If provided in payload |

## Cost Tracking

- Per-model pricing tables (JSON data files for Claude, Codex, Gemini families).
- Automatic cost calculation on ingest from token counts.
- Cost breakdowns by model, project, and time period.
- Historical cost recalculation via `pnpm recalculate-costs`.

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
| `/api/health` | GET | Service health check |
| `/api/filter-options` | GET | Distinct filterable field values |
| `/api/otel/v1/logs` | POST | OTLP JSON log ingestion |
| `/api/otel/v1/metrics` | POST | OTLP JSON metric ingestion |

## SSE Event Types

- `event`: New agent event ingested.
- `stats`: Updated aggregate statistics.
- `session_update`: Session status change.
