# AgentMonitor: Claude Code Hook Scripts

Drop-in hook scripts that connect Claude Code to AgentMonitor. Events flow from Claude Code into the dashboard in real-time with zero custom code.

## Quick Start

```bash
# From the agentmonitor project root:
./hooks/claude-code/install.sh
```

This registers hooks in `~/.claude/settings.json` that fire on:

| Claude Code Event | AgentMonitor Event | Mode |
|---|---|---|
| `SessionStart` | `session_start` | async (non-blocking) |
| `Stop` | `session_end` | async |
| `PostToolUse` | `tool_use` | async |
| `PreToolUse` (Bash only) | safety check | sync (can block destructive commands) |
| `UserPromptSubmit` | `user_prompt` | async (non-blocking) |

Start AgentMonitor (`pnpm dev`), then use Claude Code as normal. Events appear in the dashboard at `http://127.0.0.1:3141`.

## Options

```bash
# Use Python scripts instead of shell
./hooks/claude-code/install.sh --python

# Custom AgentMonitor URL
./hooks/claude-code/install.sh --url http://localhost:9000

# Remove hooks
./hooks/claude-code/install.sh --uninstall
```

## How It Works

```
Claude Code fires hook
  -> pipes JSON to stdin (session_id, tool_name, tool_input, cwd)
  -> hook script reads stdin, maps fields to AgentMonitor contract
  -> curl POST to localhost:3141/api/events (fire-and-forget)
  -> event appears in dashboard via SSE
```

All telemetry hooks run **async** (non-blocking) so they don't slow down Claude Code. The only sync hook is `PreToolUse` for safety checks on Bash commands.

## Safety Checks

The `pre_tool_use` script includes optional safety checks:

- **Blocks** destructive commands: `rm -rf /`, `rm -rf ~`, `rm -rf $HOME`
- **Logs** sensitive file access: `.env`, `.pem`, `.key`, `.credentials`, `.secret` files

Safety checks are enabled by default. To disable:

```bash
export AGENTMONITOR_SAFETY=0
```

## Scripts

### Shell (default)

| Script | Purpose |
|---|---|
| `send_event.sh` | Shared helper (sourced, not executed directly) |
| `session_start.sh` | Maps `SessionStart` -> `session_start` event |
| `session_end.sh` | Maps `Stop` -> `session_end` event |
| `post_tool_use.sh` | Maps `PostToolUse` -> `tool_use` event |
| `pre_tool_use.sh` | Safety checks + event on block |
| `user_prompt_submit.sh` | Maps `UserPromptSubmit` -> `user_prompt` event |
| `notification.sh` | Maps `Notification` -> `response` event |

### Python (alternative)

Located in `python/` subdirectory. Uses only Python stdlib (no pip dependencies).

| Script | Purpose |
|---|---|
| `python/send_event.py` | Shared module (imported, not executed) |
| `python/session_start.py` | Maps `SessionStart` -> `session_start` event |
| `python/session_end.py` | Maps `Stop` -> `session_end` event |
| `python/post_tool_use.py` | Maps `PostToolUse` -> `tool_use` event |
| `python/pre_tool_use.py` | Safety checks + event on block |

## Manual Installation

If you prefer to configure hooks manually, add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/agentmonitor/hooks/claude-code/session_start.sh",
            "timeout": 10,
            "async": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/agentmonitor/hooks/claude-code/session_end.sh",
            "timeout": 10,
            "async": true
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/agentmonitor/hooks/claude-code/post_tool_use.sh",
            "timeout": 10,
            "async": true
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/agentmonitor/hooks/claude-code/pre_tool_use.sh",
            "timeout": 10,
            "async": false,
            "statusMessage": "AgentMonitor: checking safety..."
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/agentmonitor` with the actual path to your AgentMonitor checkout.

## Alternative: OpenTelemetry Mode

Instead of hook scripts, you can use Claude Code's native OTel export. This sends telemetry directly to AgentMonitor without any hook configuration.

Set these environment variables before launching Claude Code:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3141/api/otel
```

Or add them to your shell profile (`~/.bashrc`, `~/.zshrc`):

```bash
# AgentMonitor OTel integration
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3141/api/otel
```

**OTel vs Hooks:** Both integration paths can run simultaneously. OTel captures richer data (token counts, model info, cost) automatically, while hooks give you safety checks (PreToolUse) and custom event shaping. Use both for full coverage.

**Note:** Only JSON format is currently supported. Protobuf support is planned.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AGENTMONITOR_URL` | `http://127.0.0.1:3141` | AgentMonitor server URL |
| `AGENTMONITOR_SAFETY` | `1` | Set to `0` to disable safety checks |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | (unset) | Set to `1` to enable OTel export |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset) | AgentMonitor OTLP endpoint base URL |

## Requirements

- **Shell scripts**: `bash`, `curl`. Optional: `jq` (for richer field extraction; falls back to grep without it).
- **Python scripts**: Python 3.6+ (stdlib only).
- **Install script**: `jq` (required for JSON manipulation of settings.json).
