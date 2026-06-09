# Trace Quality

AgentMonitor's local, Langfuse-inspired trace-quality layer. It turns existing
agent sessions, events, live items, messages, and tool calls into an inspectable
trace/observation graph with local scores, prompt/version attribution, quality
dashboards, and alertable findings.

The model is **local-first and provider-neutral**. It is inspired by Langfuse and
OpenTelemetry GenAI conventions, but the canonical source of truth is
AgentMonitor's own SQLite data. Langfuse is a reference model and an *optional,
deferred* export target — never AgentMonitor storage, UI, evaluator, prompt
store, or runtime dependency. AgentMonitor runs fully without it.

## Core Concepts

- **Trace** — one coherent unit of agent work inside a session (usually one user
  turn, one agent run, or one imported completion). Maps most closely to a
  Langfuse trace; a local session maps to a Langfuse session.
- **Observation** — one step inside a trace: an LLM generation, tool call, tool
  result, reasoning span, evaluator, guardrail, or discrete event. Observations
  form a parent/child tree where the source data supports it.
- **Score** — a durable, local quality judgment attached to a trace, observation,
  or other target. Human, deterministic code-evaluator, API, and (reserved)
  LLM-judge sources are supported.
- **Prompt ref** — a local attribution of which prompt/skill/instruction/template
  influenced a generation or agent step, tracked by content hash rather than by
  copying prompt bodies.
- **Finding** — a derived, read-only quality/cost/latency/telemetry alert computed
  from local SQLite data.

## Data Model

The layer is an additive **projection** over existing source tables. Source rows
are never removed or reinterpreted; each projected row records its provenance.

| Table | Purpose |
|-------|---------|
| `trace_quality_traces` | Projected traces with status, project/branch, aggregate window, and a `coverage_json` honesty record |
| `trace_quality_observations` | Projected observations (typed tree) with usage/cost, status/severity, and payload-policy fields |
| `trace_quality_scores` | Durable local scores by target/value/source |
| `trace_quality_prompt_refs` | Prompt/version references (content-hash based) |
| `trace_quality_observation_prompts` | Many-to-many prompt attribution join |
| `trace_quality_projection_state` | Per-source projection state for idempotent backfill |
| `trace_quality_export_state` | Provider export attempts (seam for the deferred Langfuse export; unused until export ships) |

### Observation Types

`event`, `span`, `generation`, `agent`, `tool`, `evaluator`, `guardrail`,
`chain`, `retriever`, `embedding`.

### Projection And Backfill

New event/session data is projected incrementally during ingest/import.
Historical data is projected (or rebuilt) out of band with
`pnpm run trace-quality:backfill` — see [OPERATIONS.md](OPERATIONS.md#trace-quality-backfill)
for flags (`--source`, `--session-id`, `--from`/`--to`, `--force`, `--dry-run`).
Projection is deterministic: repeated runs produce stable trace/observation ids
and do not duplicate rows.

## Coverage And Honesty

Some historical data — especially Codex OTEL summary telemetry — cannot be
perfectly reconstructed. The layer never invents structure or makes summary-only
data look like full transcript fidelity. Instead it records coverage explicitly.

Each trace carries `coverage_json` flags: `has_full_transcript`,
`has_tool_details`, `has_token_usage`, `has_cost`, `has_parent_child_structure`,
`has_raw_input`, `has_raw_output`, `has_reasoning`, `has_prompt_refs`,
`projection_source`, and `projection_confidence`.

Aggregate API responses include read coverage: `matching_traces`,
`included_traces`, `excluded_low_coverage_traces`, `observations_with_usage`,
`observations_missing_usage`, `score_coverage`, and a human-readable `note`. The
UI surfaces these so partial telemetry never looks authoritative.

## Privacy And Payload Policy

Raw prompts, reasoning, tool arguments, and transcript text are **not** duplicated
into trace-quality rows by default. Each observation has a `payload_policy`
(`summary_only`, `hash_only`, `source_ref`, or `raw_allowed`), and the layer
respects existing capture/redaction settings — preferring summaries, content
hashes, or source references over raw content.

## Scores

- **Targets:** `session`, `trace`, `observation`, `message`, `event`,
  `session_item`.
- **Value types:** `numeric`, `categorical`, `boolean`, `text`.
- **Sources:** `human`, `code_evaluator`, `llm_judge` (reserved; no default
  execution), `api`, `system`.

Scores are created/updated/deleted without mutating source event or session rows.
The Quality **Explorer** score panel is the human-review surface and shows
human-authored scores only; machine-written scores (evaluator/judge/api/system)
surface in the **Dashboards** score trends instead, so generated rows can't be
deleted from the human-review panel. Rollups are available by trace, session,
model, tool, prompt, and day.

## Prompt And Version Attribution

Prompt refs link explicit prompt metadata (`prompt_name`/`prompt_version`/
`prompt_label`/`prompt_hash`), deterministic task-template refs, Claude `Skill`
tool calls, and inferred Codex `skills/.../SKILL.md` reads — without copying
prompt bodies. Explicit metadata wins over inference; ambiguous refs are omitted
with a coverage warning rather than guessed. Rollups expose generation count,
median duration, total cost, token totals, score count, median numeric score, and
last seen, grouped by prompt version. This is **local attribution only** — there
is no remote Langfuse prompt management.

## Quality Findings

Findings are deterministic, read-only, and computed from SQLite (no Prometheus or
Grafana). They never notify, page, block, or mutate agent behavior.

**Severity:** `info`, `warning`, `high`, `critical`.

**Taxonomy:** `high_error_rate`, `tool_failure_rate`, `model_error_rate`,
`rate_limit_events`, `high_latency_p95`, `latency_spike`, `token_spike`,
`cost_anomaly`, `daily_budget_risk`, `unknown_pricing`, `low_trace_coverage`,
`collector_or_otel_dropoff`, `low_quality_score`, and per-observation
`observation_error`.

Each finding carries evidence: metric value, threshold, comparator, window,
sample size, baseline, impacted ids, a coverage caveat, and a next-inspection
target. Minimum-sample and baseline gates prevent false positives on sparse data.
Thresholds default in-code and are overridable via a local JSON file
(`AGENTMONITOR_TRACE_QUALITY_FINDINGS_PATH`); numeric fields deep-merge over the
defaults and malformed files fall back to defaults. The findings endpoint accepts
optional `kind` and `severity` filters.

## API Surface

All endpoints live under `/api/v2/trace-quality/*` and are isolated from legacy
monitor endpoints. See the endpoint catalog in
[FEATURES.md](FEATURES.md#api-surface) (traces, trace detail, observations,
observation detail, scores CRUD, score-summary, score-rollups, prompts,
findings).

## UI Surface

The Svelte app exposes a **Quality** sub-view under Analytics with two panels:

- **Explorer** — trace list with coverage badges; a selected-trace inspector
  (aggregate stats, expandable observation tree, payload-policy-safe input/output
  summaries); local human-review score controls. Deep-linkable via
  `#analytics?view=quality&trace=<id>`. Drill-in links from Usage/Analytics top
  sessions, Live detail, the Session browser, and Search open the explorer scoped
  to a session (`&session=<id>`).
- **Dashboards** — aggregate read-only panels over the shared date/project/agent
  window: finding cards (with `kind`/`severity` filters and Inspect-into-explorer),
  prompt-version rollups, and score trends. Loaded lazily on first open.

## Optional Langfuse Export — Deferred

An optional, disabled-by-default Langfuse export adapter is **specced but not yet
implemented** (spec Task 10). The data-model seam exists today
(`trace_quality_export_state`, `langfuse` in the export-provider enum), but no
adapter, script, or config flags ship yet — nothing leaves localhost.

When it is built, the following decisions are already settled:

- **Transport: the Langfuse ingestion API (batch HTTPS POST + Basic auth).**
  AgentMonitor projects traces from SQLite after the fact rather than owning the
  Claude/Codex execution graph, so it already holds complete trace/observation
  trees — the natural fit for batch ingestion. OTLP is rejected for v1 (we don't
  emit complete live root spans, risking incomplete traces); the Langfuse SDK is
  rejected for v1 (it risks exporting unrelated process spans unless wired to an
  isolated OpenTelemetry provider).
- **Manual-first:** a `scripts/export-langfuse-traces.ts` script, no auto-export
  during ingest.
- **Disabled by default:** `AGENTMONITOR_LANGFUSE_EXPORT_ENABLED=false`, with
  per-payload include flags (`..._INCLUDE_PROMPTS/REASONING/TOOL_ARGUMENTS/
  TRANSCRIPTS`) defaulting false.
- **Redaction-aware:** honor each observation's `payload_policy` and existing
  capture/redaction settings before serialization.
- **Dry-run preview** reporting exact counts and dropped/redacted fields before
  any network request, with `trace_quality_export_state` rows recorded for
  successes and failures.

Export will remain optional, reversible, and never a dependency for local
functionality.

## Related Docs

- Product surface and full endpoint catalog: [FEATURES.md](FEATURES.md)
- Schema and data flow: [ARCHITECTURE.md](ARCHITECTURE.md#trace-quality)
- Backfill and operations: [OPERATIONS.md](OPERATIONS.md#trace-quality-backfill)
- Implementation spec: [../specs/2026-06-06-trace-quality-layer-spec.md](../specs/2026-06-06-trace-quality-layer-spec.md)
