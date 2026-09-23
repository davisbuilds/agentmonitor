# Event Contract (v1)

Canonical ingest contract for `POST /api/events` and `POST /api/events/batch`.

## Required Fields

- `session_id` (string, non-empty)
- `agent_type` (string, non-empty)
- `event_type` (enum):
  - `tool_use`
  - `session_start`
  - `session_end`
  - `error`
  - `llm_request`
  - `llm_response`
  - `response`
  - `file_change`
  - `git_commit`
  - `plan_step`
  - `user_prompt`
  - `instruction_load`

## Optional Fields

- `event_id` (string)
- `tool_name` (string)
- `status` (enum): `success`, `error`, `timeout`
  - default: `success`
  - default for `event_type=error`: `error`
- `tokens_in` (non-negative integer, default `0`)
- `tokens_out` (non-negative integer, default `0`)
- `cache_read_tokens` (non-negative integer, default `0`)
- `cache_write_tokens` (non-negative integer, default `0`)
- `model` (string)
- `cost_usd` (finite non-negative number)
- `branch` (string)
- `project` (string)
- `duration_ms` (non-negative integer)
- `metadata` (any JSON value or string)
- `client_timestamp` (ISO timestamp string)
- `source` (enum): `api`, `hook`, `otel`, `import`, `benchmark`

String values are trimmed. Empty optional strings become absent; empty required
strings are rejected. Unknown enum values and negative numeric values are
rejected with field-specific validation errors.

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
- Claude `InstructionsLoaded` hooks intentionally omit `event_id`, so repeated
  loads of the same file remain separate observations.

## Payload Truncation

- Metadata is capped by `AGENTMONITOR_MAX_PAYLOAD_KB` (default 10KB).
- Truncation is UTF-8 byte-safe.
- `payload_truncated` is stored on events (`0` or `1`).
- For large object metadata, key fields (for example `command`, `file_path`) are preserved in a compact summary.

## OTLP Ingestion

Events derived from OTLP logs and usage metrics are held to this same contract
before they are stored. A record that fails it (for example a negative token
count or a non-finite cost) is dropped on its own, and the rest of the batch is
stored. A usage metric datapoint with a negative or non-finite value is refused
the same way, before cumulative-to-delta conversion, so it never becomes the
baseline the next sample is diffed against. The reply is OTLP's partial-success shape, e.g.
`{"partialSuccess":{"rejectedLogRecords":1,"errorMessage":"..."}}` for logs or
`rejectedDataPoints` for metrics, and `{}` when nothing was refused. A
fractional OTLP latency is rounded to whole milliseconds rather than refused.

Exporters resend a batch on timeout or reset, so each OTLP log record and usage
data point gets a derived `event_id` (`otel-log-…`/`otel-metric-…`, a hash of the
record with its resource and instrumentation scope, keys sorted) and a resend is stored once. A record
with no time at all (no `timeUnixNano`, `observedTimeUnixNano`, or
`event.timestamp` attribute) gets no key, because a retry and a genuine repeat
would be indistinguishable.

## Browser Requests

Ingest clients (hooks, OTLP exporters, the CLI) send no `Origin` header. A write
to any `/api` route that carries a foreign `Origin`, or the opaque `null` origin,
is refused with `403 {"error":"forbidden","reason":"origin"}`, so a web page
cannot forge events. The app's own page (loopback or `*.localhost`, or the
server's own host when bound beyond loopback) is allowed. A loopback-bound server
also refuses any request whose `Host` is not a loopback name
(`"reason":"host"`), which defeats DNS rebinding.

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
  "cache_read_tokens": 82,
  "cache_write_tokens": 12,
  "model": "claude-sonnet-4-6",
  "cost_usd": 0.0045,
  "project": "myapp",
  "branch": "feature/auth",
  "source": "hook",
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
  "model": "gpt-5.6-sol",
  "project": "frontend",
  "branch": "redesign-nav",
  "source": "otel",
  "client_timestamp": "2026-02-18T18:06:45.019Z",
  "metadata": {
    "type": "turn_complete"
  }
}
```

### Claude Instruction-Load Example

```json
{
  "session_id": "claude-session-001",
  "agent_type": "claude_code",
  "event_type": "instruction_load",
  "status": "success",
  "project": "myapp",
  "source": "hook",
  "metadata": {
    "file_path": "/Users/me/Dev/myapp/CLAUDE.md",
    "memory_type": "Project",
    "load_reason": "session_start"
  }
}
```

Instruction-load metadata may also contain `globs`, `trigger_file_path`, and
`parent_file_path` when Claude supplies them. The hook never reads or emits the
instruction file's contents. Delivery is asynchronous and best-effort; a
configured SessionStart marker without any received load event does not prove
an observed-empty instruction set.
