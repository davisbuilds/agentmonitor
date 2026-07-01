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
part of the removed warehouse; that eval depth remains deferred to Langfuse. The
content-free aggregate now has a separate, explicit warehouse export.

## Data Model

The view is a **derived projection** over existing source tables (`events`,
`session_items`, `session_turns`, `browsing_sessions`, `messages`, `tool_calls`).
Source rows are never removed or reinterpreted. Only two tables are persisted:

| Table | Purpose |
|-------|---------|
| `session_trace_summary` | One **content-free, export-shaped** row per session: counts, tokens, cost, latency, telemetry coverage, a derived quality scalar, and a stable `trace_id`/`project`. It feeds the optional `agentmonitor.runs` warehouse export. No message text. |
| `trace_quality_export_state` | Dormant seam for the deferred Langfuse depth export (`langfuse` in the provider enum). |

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

## Warehouse Aggregate Export

The content-free aggregate export ships as `amon warehouse publish`. It writes to
AgentMonitor's own Postgres schema, not medallion's bronze/silver/gold schemas:

- `agentmonitor.runs` — one row per `(account, session_id)`, upserted on that key.
  Columns include account, session, model, token/cost/latency counts, quality,
  project, agent type, `started_at`, `day`, and `published_run_id`.
- `agentmonitor.publish_run` — one lineage row per invocation with run id,
  account, date window, published/suppressed counts, `min_batch`, AgentMonitor
  version, and BI grant status.

Identity follows medallion's `silver.assistant_runs` semantics: `account` is a
configured personal/account label, not an org-wide employee utilization signal.
The export intentionally stays out of medallion's `silver.agent_runs` and
`gold.adoption_kpis_daily` path. A future medallion-owned conforming view may
read `agentmonitor.runs` into an assistant/coding-agent usage surface, but it
should remain adoption-KPI-excluded.

The publish path is optional and standalone. `pg` is installed as a normal
dependency but imported only by the sink when the live command runs. `--dry-run`
requires no DSN and prints planned SQL/counts. Live publish requires
`AGENTMONITOR_WAREHOUSE_DSN`; `AGENTMONITOR_WAREHOUSE_SCHEMA` defaults to
`agentmonitor`, `AGENTMONITOR_WAREHOUSE_ACCOUNT` defaults to `local`, and
`AGENTMONITOR_WAREHOUSE_BI_ROLE` defaults to `medallion_bi`. The BI grant is an
intentional extension of the shared Metabase read role to AgentMonitor's schema,
mirroring prism's `insight.*` grant; the command checks `pg_roles` first and
reports `grant_skipped` if the role is absent.

Content-free enforcement has two layers before anything is planned or published:
the mapped row's keys must exactly match the `WarehouseRunRow` allowlist, and
text-like values must fit field-specific shapes (short labels, opaque IDs,
ISO/date timestamps, numeric metrics). `--min-batch` is only an operator guard
against accidental tiny publishes; it is not a privacy control for a row-level
per-session fact. Re-publish is idempotent for `(account, session_id)`, but it
does not retract rows if a local session is later removed.

## Deferred Langfuse Export

The trace/observation/eval depth export is still deferred. That future path will
forward the on-demand projection through `trace_quality_export_state`
(`provider = langfuse`) for users who want deep eval/trace tooling. It remains
separate from the aggregate warehouse export.

## Related Docs

- Positioning (collector-not-backend, why the depth is deferred): [../project/POSITIONING.md](../project/POSITIONING.md)
- Product surface and endpoint catalog: [FEATURES.md](FEATURES.md)
- Schema and data flow: [ARCHITECTURE.md](ARCHITECTURE.md#trace-quality)
- Reframe spec: [../specs/2026-06-29-trace-quality-reframe-spec.md](../specs/2026-06-29-trace-quality-reframe-spec.md)
