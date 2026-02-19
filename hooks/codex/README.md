# AgentStats: Codex CLI Integration

Codex CLI integrates with AgentStats via its native OpenTelemetry (OTLP) export. Events, token usage, and cost data flow directly into the AgentStats dashboard.

## Setup

Add this to `~/.codex/config.toml`:

```toml
[otel]
log_user_prompt = true
exporter = { otlp-http = { endpoint = "http://localhost:3141/api/otel/v1/logs", protocol = "json" } }
```

Start AgentStats (`pnpm dev`), then use Codex as normal. Events appear in the dashboard at `http://127.0.0.1:3141`.

## What Gets Captured

| Codex Activity | AgentStats Event |
|---|---|
| API request to model | `llm_request` |
| API response | `llm_response` |
| Tool execution (shell, file edit) | `tool_use` |
| Session start/end | `session_start` / `session_end` |
| Errors | `error` |

All events are tagged with `source=otel` and `agent_type=codex`.

## Filtering

View only Codex events in the API:

```bash
# All Codex events
curl http://localhost:3141/api/events?agent_type=codex

# Only OTel-sourced events
curl http://localhost:3141/api/events?source=otel

# Combined filters
curl http://localhost:3141/api/events?agent_type=codex&source=otel
```

## Notes

- Only JSON OTLP format is supported. Set `protocol = "json"` in the config.
- Codex uses the service name `codex_cli_rs` in its OTLP exports, which AgentStats maps to `agent_type=codex`.
- Token usage and cost metrics are captured when Codex exports them via OTLP metrics.

## Alternative: Seed Script

To generate demo Codex events without a real Codex instance:

```bash
pnpm run seed
```
