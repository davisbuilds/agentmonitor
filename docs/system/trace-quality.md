# Trace Quality

AgentMonitor provides one lean, inspectable trace per session. It projects detail
from existing local sources on demand and persists a small content-free summary.
This keeps local observability useful without maintaining a second trace warehouse.

The product is a collector and local console. Persisted observation/eval storage,
scoring systems, and prompt management remain deferred to an external depth sink;
see [POSITIONING.md](../project/POSITIONING.md).

## Model And Ownership

- A **trace** is one agent session.
- An **observation** is an event, generation, tool call/result, reasoning span, or
  session item inside that trace. Parent/child structure is emitted only when a
  source supports it.
- `session_trace_summary` stores one content-free, export-shaped rollup per session:
  counts, tokens, cost, latency, coverage, quality scalar, stable trace identity,
  and project/agent metadata.
- `trace_quality_export_state` is the dormant cursor for deferred Langfuse depth
  export.
- Trace detail and observation trees are projected in memory from events, browsing
  sessions, messages, turns, items, and tool calls. They are never persisted as a
  second content store.

The summary updates on ingest and session synchronization. Startup self-heals stale
summary versions or rows missing stable trace identity. The old trace, observation,
score, prompt, and projection tables are no longer created; operators may reclaim
them through the explicit procedure in [OPERATIONS.md](OPERATIONS.md).

## Coverage And Fidelity

Historical sources expose different evidence. Claude session files may support a
full transcript and tool tree, while Codex OTEL may expose summary usage without
the underlying transcript. Trace responses declare transcript, tool, usage, cost,
parent/child, projection-source, and confidence coverage rather than inventing
missing structure.

List and detail responses summarize matching traces, included traces, observations
with usage, and observations missing usage over the complete filtered set rather
than the current page alone. Missing evidence remains unavailable, not zero.

## Privacy And Payload Policy

Summary rows and aggregate warehouse rows are content-free. Raw prompts, reasoning,
tool arguments, and transcript text are not copied into them.

On-demand observations obey existing capture/redaction controls and carry a payload
policy such as summary-only, hash-only, source-reference, or raw-allowed. Prefer
summaries, hashes, and source references whenever raw payload is unnecessary.

## Product Surface

The v2 trace-quality family provides session-level lists, trace detail, and
paginated observation trees. The CLI exposes the same reads under `amon quality`.
Exact routes and flags live in source and CLI help.

The Svelte Quality view sits under Analytics. It presents coverage badges, aggregate
stats, and an expandable observation tree. Deep links from Usage, Analytics, Live,
Sessions, and Search scope the explorer to the relevant session or trace.

Local score editing, prompt rollups, persisted findings, and aggregate eval
dashboards were removed with the old warehouse.

## Aggregate Warehouse Export

`amon warehouse publish` writes the content-free session summary to
`agentmonitor.runs` with one row per `(account, session_id)` and records invocation
lineage in `agentmonitor.publish_run`. The schema stays separate from medallion's
bronze/silver/gold ownership and should remain excluded from adoption KPIs unless a
medallion-owned view explicitly models personal coding-agent usage.

Before publication, mapped keys must match the `WarehouseRunRow` allowlist and
text-like values must satisfy bounded field shapes. Dry-run performs no network
connection. Live publication is opt-in, idempotent for the account/session key, and
does not retract rows when local sessions are later removed. A minimum batch is an
operator guard, not a privacy mechanism.

Configuration and recovery procedures live in [OPERATIONS.md](OPERATIONS.md).

## Deferred Depth Export

The trace/observation/eval depth export remains deferred. A future implementation
may forward the on-demand projection through `trace_quality_export_state` for users
who want Langfuse-style eval and trace tooling. It must remain optional,
redaction-aware, and independent of local operation and the aggregate warehouse
export.
