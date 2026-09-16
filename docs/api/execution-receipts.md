# Host execution receipts

An execution is a host launcher attempt, not a native conversation. It does not
establish tokens, spend, or a one-to-one session relationship.

## Opt-in collection

Set `AGENTMONITOR_EXECUTIONS_DIR` to a private, launcher-owned receipt directory
when starting amon. The watcher imports at startup and every fifteen minutes.
No HTTP write endpoint, network client, credential or worker authority is added.
Do not place the spool inside a worker-writable directory. Same-user unrestricted
host tools remain trusted; ownership is not authentication against those tools.

The root must be owned, non-symlink, and have no group/other permissions. Receipt
files must be owned regular files with no group/other permissions, named
`<execution_id>.json`. Symlinks, files over 4096 bytes, unknown fields, and identity
conflicts are rejected. A scan admits at most 10,000 candidates. Errors are logged
as counts, never payloads. Amon does not delete or archive producer files.

## Producer contract

Every field is required; no extras are accepted:

```json
{
  "schema_version": "execution.v1",
  "execution_id": "11111111-2222-4333-8444-555555555555",
  "run_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "producer": "example-launcher",
  "agent": "antigravity",
  "role": "judge",
  "started_at": "2026-03-01T09:00:00.000Z",
  "finished_at": null,
  "exit_code": null
}
```

Execution IDs are lowercase UUID-shaped identifiers generated per attempt.
`run_id` is an opaque 64-character lowercase hex producer grouping key, not a
native session ID. Producer names are bounded lowercase slugs. Agent is `claude`,
`codex` or `antigravity`; role is `worker`, `judge` or `validation`. Timestamps are
UTC with milliseconds (`Z` or `+00:00`). Completion supplies both finish time
(not before start) and integer launcher exit code (-255 to 255). Zero means the
launcher reported success, not verified task quality. An initial receipt proves
an attempted launch, not successful exec.

The trusted parent atomically publishes start evidence before invoking the
provider, then replaces it with completion evidence after cleanup. It uses its
own in-memory identity and outcome, never worker-authored files. The worker must
not be able to modify the spool. No prompts, paths, credentials, model output,
token estimates or guessed session links belong in receipts.

## Persistence and failure

The independent `execution_receipts` ledger is keyed by producer and execution ID.
Replay is idempotent; an old start cannot reverse completion. Changed immutable
fields or a conflicting completion are errors, not last-write-wins overwrites.
Each receipt commits atomically; the next scan retries after interruption. Missing
terminal evidence stays `unconfirmed`, not inferred running/successful/failed.
A hard kill before publication can leave no receipt. Coverage remains unknown.

Schema version 8 adds the ledger and observed-identity index without rewriting
events or transcripts. Preserve an online backup before live upgrade; first
startup builds the covering index transactionally.

## Reads

`GET /api/v2/activity/executions` uses the same validated agent/date/limit/offset
parameters as observed sessions. It returns `schema_version: observed-executions.v1`,
`data`, `total`, `next_offset`, `limit`, `offset`, `capture_coverage: unknown`.
Rows contain receipt fields except the input schema version, `id` (producer plus
execution ID), and `outcome`: `unconfirmed`, `succeeded`, or `failed`. Ordering is
descending start, then producer and execution ID. Executions never enter Sessions,
Usage, trace summaries or native-session counts.

Historical launches require a separately reviewed provenance/backfill procedure.
