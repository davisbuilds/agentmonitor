# Activity read contracts

These content-free activity reads are consumed by external clients. Route and
query implementations remain authoritative for exact executable behavior.

## Daily conversation activity

`GET /api/v2/activity/daily?since=2026-09-01&until=2026-09-15` returns
`schema_version: daily-conversations.v1`, the echoed inclusive dates,
`timezone` (the reporting zone; see `AGENTMONITOR_TIMEZONE`), `capture_coverage: unknown`,
`unresolved_timestamps`, and `data` rows of `{date, agent, classification, count}`.
Only `since` and `until` are accepted, with at most 31 days; invalid queries
return 400. An empty successful result has `data: []`. A query exceeding the
evidence cap returns a sanitized 503; narrow the window and retry.

Counts are distinct identities with dated messages, user prompts, tool activity
or usage evidence that day, not identities created that day or hours worked.
Recognized aliases contribute evidence once per identity/day. Native source and
lineage separate `conversation`, `delegated`, `internal`, and `unclassified`;
conversation classification also requires retained user-message evidence.
Creation/startup alone is not activity. Unknown identities do not become user
conversations, and inherited messages before native creation do not backdate work.
Undated evidence is excluded from daily counts and reported independently of the
requested dates. Empty counts do not prove complete capture or no work. No IDs,
prompts, transcript text or paths are exposed. Existing inventory APIs are unchanged.
Unrecognized harness labels are grouped as `unknown` without merging their identities.
For historical Codex lineage, follow the
[reparse procedure](../system/OPERATIONS.md#source-development).

## Observed session inventory

Independent launcher attempts are available at `/api/v2/activity/executions`.
See [host execution receipts](execution-receipts.md) for the opt-in
filesystem contract and why these counts must not be added to native sessions.

`GET /api/v2/activity/sessions` is a content-free, read-only inventory across
ordinary events and session-browser projections. It does not replace the Sessions
browser. `agent`, inclusive local calendar `date_from`/`date_to`, `limit` (1–500,
default 200) and `offset` (0–1,000,000) are supported; invalid/unknown parameters
return 400 with `code: invalid_query`. Empty inventories return 200 with `data: []`.
Responses carry `schema_version: observed-sessions.v1`, `total`, `next_offset`
(null at the end), `unresolved_timestamps`, and `capture_coverage: unknown`.

Rows expose harness-scoped `id`, source `session_id`, `agent`, UTC `started_at`
(null for unresolved timezone), `time_basis` (`projected_start` or `first_event`),
`has_browser_history`, `has_events`, `has_usage`, `transcript_available`, and nullable
`integration_mode`/`fidelity`. Transcript availability means retained readable
message content, not that the original source file still exists. Counts include
separately identified subagents and are neither execution counts nor usage totals.
Known Codex aliases, including API/hook-generated `codex-summary` UUIDs,
reconcile before filtering; benchmark events are excluded.
Dates use the selected browser start when present, otherwise first timed event
evidence—not necessarily the actual beginning of work. Unresolved timestamps are
counted across the requested agent's inventory, independently of date filters.

Ordering is descending start instant (unresolved last), then ascending identity.
Pagination is not a cross-request snapshot: retry enumeration if totals change;
same-count concurrent changes remain possible. This endpoint shares amon's local
server boundary and does not add authentication or expose the service remotely.
