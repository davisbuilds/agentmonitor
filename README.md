# AgentStats

Real-time localhost dashboard for monitoring AI agent activity across sessions, tools, and projects.

## Stack

- Node.js + TypeScript + Express
- SQLite (`better-sqlite3`)
- Vanilla JS frontend + Tailwind CSS
- SSE for live updates

## Quick Start

Requirements:
- Node.js 20+
- `pnpm` 10+

Install dependencies:

```bash
pnpm install
```

Run in development:

```bash
# terminal 1
pnpm dev

# terminal 2 (for live css rebuilds)
pnpm run css:watch
```

Open `http://127.0.0.1:3141`.

## Useful Scripts

- `pnpm dev`: run server in watch mode (`tsx watch`).
- `pnpm run css:build`: one-off Tailwind build to `public/css/output.css`.
- `pnpm run css:watch`: Tailwind watch mode.
- `pnpm run build`: TypeScript build + CSS build.
- `pnpm run test`: run contract + API tests.
- `pnpm run test:watch`: watch-mode test runner.
- `pnpm start`: run compiled server from `dist/`.
- `pnpm run import`: import historical sessions from Claude Code and Codex logs.
- `pnpm run seed`: send demo events to the running server.
- `pnpm run bench:ingest`: run ingest throughput benchmark.

## Configuration

Environment variables (all optional):

- `AGENTSTATS_PORT` (default: `3141`)
- `AGENTSTATS_HOST` (default: `127.0.0.1`)
- `AGENTSTATS_DB_PATH` (default: `./data/agentstats.db`)
- `AGENTSTATS_MAX_PAYLOAD_KB` (default: `10`)
- `AGENTSTATS_SESSION_TIMEOUT` (default: `5`)
- `AGENTSTATS_MAX_FEED` (default: `200`)
- `AGENTSTATS_STATS_INTERVAL` (default: `5000`)
- `AGENTSTATS_MAX_SSE_CLIENTS` (default: `50`)
- `AGENTSTATS_SSE_HEARTBEAT_MS` (default: `30000`)

Seed script target override:

- `AGENTSTATS_URL` (default: `http://127.0.0.1:3141`)

Benchmark script environment overrides:

- `AGENTSTATS_BENCH_URL` (default: `http://127.0.0.1:3141`)
- `AGENTSTATS_BENCH_MODE` (`batch` or `single`, default: `batch`)
- `AGENTSTATS_BENCH_EVENTS` (default: `10000`)
- `AGENTSTATS_BENCH_WARMUP_EVENTS` (default: `250`)
- `AGENTSTATS_BENCH_CONCURRENCY` (default: `20`)
- `AGENTSTATS_BENCH_BATCH_SIZE` (default: `25`, ignored in `single` mode)
- `AGENTSTATS_BENCH_SESSION_CARDINALITY` (default: `100`)
- `AGENTSTATS_BENCH_DUPLICATE_RATE` (default: `0`)
- `AGENTSTATS_BENCH_TIMEOUT_MS` (default: `15000`)

Example benchmark command:

```bash
pnpm run bench:ingest -- --events=20000 --concurrency=40 --batch-size=50
```

## Agent Integration

### Claude Code (hooks)

```bash
./hooks/claude-code/install.sh
```

Restart Claude Code after installing. Events flow via hooks on `SessionStart`, `Stop`, `PostToolUse`, and `PreToolUse`. See `hooks/claude-code/README.md` for options.

To backfill historical sessions with token/cost data:

```bash
pnpm run import --source claude-code
```

### Codex CLI (OTEL)

Add to `~/.codex/config.toml`:

```toml
[otel]
log_user_prompt = true

[otel.exporter.otlp-http]
endpoint = "http://localhost:3141/api/otel/v1/logs"
protocol = "json"
```

Restart Codex after configuring. The dev server must be running before starting a Codex session (the OTEL exporter connects at startup and does not retry).

**Note:** Codex OTEL logs do not include token/cost data. To backfill cost data from Codex session files:

```bash
pnpm run import --source codex
```

See `hooks/codex/README.md` for details.

## API Summary

- `POST /api/events`: ingest one event.
- `POST /api/events/batch`: ingest many events.
- `GET /api/events`: query events with filters (`agent_type`, `event_type`, `tool_name`, `session_id`, `branch`, `model`, `source`, `since`, `until`).
- `GET /api/stats`: aggregate counters and breakdowns (includes `total_cost_usd`, `model_breakdown`).
- `GET /api/sessions`: list sessions (supports `status`, `exclude_status`, `agent_type`, `limit`).
- `GET /api/sessions/:id`: session detail + recent events.
- `GET /api/stats/cost`: cost breakdowns by model, project, and timeline.
- `GET /api/filter-options`: distinct values for all filterable fields.
- `GET /api/stream`: SSE stream (`event`, `stats`, `session_update`), returns `503` when max client limit is reached.
- `GET /api/health`: basic service health.
- `POST /api/otel/v1/logs`: OTLP JSON log ingestion (Claude Code + Codex).
- `POST /api/otel/v1/metrics`: OTLP JSON metric ingestion (token usage, cost).
- `POST /api/otel/v1/traces`: OTLP traces (stub — accepted but not processed yet).

Required fields for ingest payloads: `session_id`, `agent_type`, `event_type`.

Canonical event contract: `docs/event-contract.md`.

Batch ingest response includes:
- `received`
- `ids`
- `duplicates`
- `rejected` (with source index + validation errors)

Timestamp and truncation notes:
- `created_at` is server receive timestamp.
- `client_timestamp` is optional client-supplied timestamp.
- `payload_truncated` is `1` when metadata exceeded byte cap.

Example event:

```json
{
  "event_id": "b968f88c-bf3d-48ea-9f65-59db7e0fd035",
  "session_id": "claude-session-001",
  "agent_type": "claude_code",
  "event_type": "tool_use",
  "tool_name": "Bash",
  "status": "success",
  "tokens_in": 120,
  "tokens_out": 640,
  "client_timestamp": "2026-02-18T18:06:41.231Z",
  "branch": "feature/auth",
  "project": "myapp",
  "duration_ms": 950,
  "metadata": {
    "command": "npm test"
  }
}
```

## Documentation

- Contributor workflow and PR expectations: [CONTRIBUTING.md](CONTRIBUTING.md)
- Agent implementation guidance: [AGENTS.md](AGENTS.md)
- Architecture and code organization: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Feature and API reference: [docs/FEATURES.md](docs/FEATURES.md)
- Runtime operations (env, scripts, hooks): [docs/OPERATIONS.md](docs/OPERATIONS.md)
- Product roadmap snapshot: [docs/ROADMAP.md](docs/ROADMAP.md)
- Event contract specification: [docs/event-contract.md](docs/event-contract.md)
- Git history and branch policy: [docs/GIT_HISTORY_POLICY.md](docs/GIT_HISTORY_POLICY.md)
