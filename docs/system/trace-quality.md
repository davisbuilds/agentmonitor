# Trace Quality

AgentMonitor's **lean, local** trace-quality view: one inspectable trace per
session, derived on demand from existing source data, plus a tiny content-free
per-session rollup. It lets you understand a session's shape, cost, and telemetry
fidelity locally — without persisting a second warehouse.

This is the result of the **trace-quality reframe** (2026-06). AgentMonitor is a
**collector, not a backend** (see [POSITIONING.md](../project/POSITIONING.md)):
deep trace/observation **storage, eval/scoring, and prompt management** are what
Langfuse already nails, so that depth is **deferred to the export** rather than
reinvented locally. The earlier persisted `trace_quality_*` warehouse (~half the
DB, mis-grained at one trace per event) was removed.

## Core Concepts

- **Trace** — one coherent unit of agent work. The lean view presents **one trace
  per session**.
- **Observation** — one step inside a trace (LLM generation, tool call, tool
  result, reasoning span, discrete event). Observations form a parent/child tree
  where the source data supports it, and are projected **on demand** — never
  stored.

Scores, prompt-version attribution, findings, and the aggregate dashboards were
part of the removed warehouse; that eval depth now lives in the deferred export
(Langfuse for trace/score depth; medallion for the content-free aggregate).

## Data Model

The view is a **derived projection** over existing source tables (`events`,
`session_items`, `session_turns`, `browsing_sessions`, `messages`, `tool_calls`).
Source rows are never removed or reinterpreted. Only two tables are persisted:

| Table | Purpose |
|-------|---------|
| `session_trace_summary` | One **content-free, export-shaped** row per session: counts, tokens, cost, latency, telemetry coverage, a derived quality scalar, and a stable `trace_id`/`project`. Columns map to medallion's `silver.agent_runs`. No message text. |
| `trace_quality_export_state` | Dormant seam for the deferred export (`langfuse` in the provider enum). Unused until export ships. |

Per-session **detail** (the trace + its observation tree) is projected in memory
on request by `src/trace-quality/on-demand.ts` using `projectTraceQuality(...)`
and is never written. `deriveSessionTraceSummary` rolls usage up from `events`
(authoritative) so live/Codex sessions keep correct token/cost totals.

The summary is maintained incrementally on ingest (`bumpSessionTraceSummaryForEvent`)
and re-derived on session sync (`maintainSessionTraceSummary`). A startup guard
(`ensureSessionTraceSummaryBackfill`) self-heals incomplete migrations — it
re-backfills when any row is at a stale version **or** has a NULL `trace_id`.

The old persisted warehouse (`trace_quality_traces`, `_observations`, `_scores`,
`_prompt_refs`, `_observation_prompts`, `_projection_state`) is no longer created.
Existing databases reclaim that space with an explicit, opt-in one-shot:

```bash
pnpm reclaim:trace-quality            # DROP the warehouse tables + VACUUM
pnpm reclaim:trace-quality --dry-run  # report what would be dropped, no changes
```

It is never run at startup, so a normal upgrade never rewrites a live DB.

## Coverage And Honesty

Some historical data — especially Codex OTEL summary telemetry — cannot be
perfectly reconstructed. The view never invents structure or makes summary-only
data look like full-transcript fidelity; it records coverage explicitly.

Each on-demand trace carries `coverage_json` flags (`has_full_transcript`,
`has_tool_details`, `has_token_usage`, `has_cost`, `has_parent_child_structure`,
`projection_source`, `projection_confidence`, …) and the summary stores merged
coverage. List/detail responses include read coverage: `matching_traces`,
`included_traces`, `observations_with_usage`, `observations_missing_usage`, and a
human-readable `note` (computed over the full filtered set, not just the page).

## Privacy And Payload Policy

Raw prompts, reasoning, tool arguments, and transcript text are **not** copied
into trace-quality rows. The summary is content-free; on-demand observations carry
a `payload_policy` (`summary_only`, `hash_only`, `source_ref`, `raw_allowed`) and
respect existing capture/redaction settings — preferring summaries, content
hashes, or source references over raw content.

## API Surface

Three endpoints under `/api/v2/trace-quality/*`:

- `GET /traces` — one row per session from `session_trace_summary` (filters:
  `session_id`, `project`, `agent`, `date_from`/`date_to`, `limit`/`offset`).
- `GET /traces/:id` — summary-backed detail for one session trace.
- `GET /traces/:id/observations` — the session's observation tree, projected
  on-demand (one trace, every event/item an observation).

See the catalog in [FEATURES.md](FEATURES.md#api-surface). The CLI exposes the
lean list as `amon quality traces`.

## UI Surface

The Svelte app's **Quality** sub-view under Analytics is the per-trace
**Explorer**: a trace list with coverage badges and a selected-trace inspector
(aggregate stats, expandable observation tree read from the loaded detail,
payload-policy-safe input/output summaries). Deep-linkable via
`#analytics?view=quality&trace=<id>`; drill-in links from Usage/Live/Sessions/
Search open it scoped to a session (`&session=<id>`). The aggregate Dashboards
(findings / prompt rollups / score trends) and the human-review score editor were
removed with the warehouse.

## Deferred Export

The export is the home for the depth that was removed locally, and is its own
later spec — nothing leaves localhost until it ships. Two sinks, two purposes:

- **medallion** (content-free aggregate) — publish `session_trace_summary` to
  `silver.agent_runs`. Near-free: the row is already shaped to that contract,
  mirroring prism's `insight` pattern (reuse `medallion_bi` grant + delete-then-
  insert idempotency).
- **Langfuse** (trace/observation/eval depth) — forward the on-demand projection
  through the dormant `trace_quality_export_state` seam (`provider = langfuse`)
  for users who want deep eval/trace tooling.

Export stays optional, reversible, and never a runtime dependency.

## Related Docs

- Positioning (collector-not-backend, why the depth is deferred): [../project/POSITIONING.md](../project/POSITIONING.md)
- Product surface and endpoint catalog: [FEATURES.md](FEATURES.md)
- Schema and data flow: [ARCHITECTURE.md](ARCHITECTURE.md#trace-quality)
- Reframe spec: [../specs/2026-06-29-trace-quality-reframe-spec.md](../specs/2026-06-29-trace-quality-reframe-spec.md)
