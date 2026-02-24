# Event Contract (v1)

Canonical ingest contract for `POST /api/events` and `POST /api/events/batch`.

## Required Fields

- `session_id` (string, non-empty)
- `agent_type` (string, non-empty)
- `event_type` (enum):
  - `tool_use`
  - `session_start`
  - `session_end`
  - `response`
  - `error`

## Optional Fields

- `event_id` (string)
- `tool_name` (string)
- `status` (enum): `success`, `error`, `timeout`
  - default: `success`
  - default for `event_type=error`: `error`
- `tokens_in` (non-negative integer, default `0`)
- `tokens_out` (non-negative integer, default `0`)
- `branch` (string)
- `project` (string)
- `duration_ms` (non-negative integer)
- `metadata` (any JSON value or string)
- `client_timestamp` (ISO timestamp string)

## Timestamp Semantics

- `created_at`: server receive timestamp (set by API at ingest time)
- `client_timestamp`: optional client-provided timestamp (normalized to ISO-8601 UTC)

Both are persisted on events so ingestion latency and client-vs-server ordering can be analyzed later.

## Batch Semantics

`POST /api/events/batch` returns:

- `received`: number of inserted events
- `ids`: inserted DB ids
- `duplicates`: count of dropped duplicate `event_id` items
- `rejected`: validation failures with source index and error list

## Deduplication

- `event_id` is optional.
- If provided, it is unique.
- Duplicate `event_id` records are acknowledged and skipped (idempotent ingest).

## Payload Truncation

- Metadata is capped by `AGENTMONITOR_MAX_PAYLOAD_KB` (default 10KB).
- Truncation is UTF-8 byte-safe.
- `payload_truncated` is stored on events (`0` or `1`).
- For large object metadata, key fields (for example `command`, `file_path`) are preserved in a compact summary.

## Canonical Examples

### Claude Code Example

```json
{
  "event_id": "e0d43a5f-2c9a-4e2a-b145-334fa6f0b51f",
  "session_id": "claude-session-001",
  "agent_type": "claude_code",
  "event_type": "tool_use",
  "tool_name": "Bash",
  "status": "success",
  "tokens_in": 118,
  "tokens_out": 460,
  "project": "myapp",
  "branch": "feature/auth",
  "duration_ms": 840,
  "client_timestamp": "2026-02-18T18:06:41.231Z",
  "metadata": {
    "command": "pnpm test"
  }
}
```

### Codex Example

```json
{
  "event_id": "c0618b2c-6a5d-4de5-a69a-98f90f1b1550",
  "session_id": "codex-session-008",
  "agent_type": "codex",
  "event_type": "response",
  "status": "success",
  "tokens_in": 640,
  "tokens_out": 2104,
  "project": "frontend",
  "branch": "redesign-nav",
  "client_timestamp": "2026-02-18T18:06:45.019Z",
  "metadata": {
    "type": "turn_complete"
  }
}
```
