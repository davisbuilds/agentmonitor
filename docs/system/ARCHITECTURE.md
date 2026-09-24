# Architecture

This document describes AgentMonitor's system shape, data ownership, and durable
invariants. Exact routes, columns, and module exports remain authoritative in
source.

## System Flow

```text
Claude hooks ───────┐
Codex OTLP ─────────┼─> ingest/normalization ─> SQLite ─> v1/v2 reads ─> Svelte /app/
session JSONL/DBs ──┘                         │                 └──────> amon CLI
                                              └─> SSE ─────────> Monitor / Live
```

1. Claude hooks, Codex OTLP exporters, generic clients, and historical importers
   produce normalized events or session-browser projections.
2. SQLite stores authoritative local event history, parsed session history,
   operational metrics, provider quota snapshots, and small derived summaries.
3. `/api/v2/*` serves the canonical Svelte application and agent-first CLI reads.
4. SSE carries current activity to Monitor and Live without making the stream an
   authoritative store.

## Product And Runtime Boundaries

- The Svelte SPA at `/app/` is the sole human-facing product surface. `/` redirects
  to it.
- `/api/v2/*` is the canonical application read contract. V1 remains for event and
  OTLP ingestion, provider quota bridges, shared SSE, and legacy reads still used by
  parity and ingestion-readback tests.
- `amon` is the preferred local operator command; `agentmonitor` is an equivalent
  executable alias.
- The TypeScript/Node runtime on `127.0.0.1:3141` is the single backend. The removed
  Rust spike is preserved in Git history; current positioning lives in
  [POSITIONING.md](../project/POSITIONING.md).
- `amon serve` runs that backend and normally exposes
  `https://agentmonitor.localhost` through the pinned Portless CLI. Hooks, OTLP,
  and direct API clients continue to use the fixed loopback backend.

`src/runtime.ts` owns startup and shutdown. It acquires exclusive ownership of the
canonical database path before opening HTTP or starting background work. A second
runtime targeting the same database fails early; separate database paths may run
concurrently. Bind failure and shutdown stop listeners, timers, SSE clients,
watchers, quota work, and SQLite before releasing ownership.

## API And CLI Boundaries

- V1 routes are composed in [`src/api/router.ts`](../../src/api/router.ts).
- V2 routes are composed in [`src/api/v2/router.ts`](../../src/api/v2/router.ts).
- V1 SQL stays in `src/db/queries.ts`; v2 reads and aggregates stay in
  `src/db/v2-queries.ts`. Route handlers should coordinate these modules rather
  than embed query logic.
- The external event-ingest contract is defined by
  [`src/contracts/event-contract.ts`](../../src/contracts/event-contract.ts) and
  documented in [event-contract.md](../api/event-contract.md).
- [`src/api/local-origin.ts`](../../src/api/local-origin.ts) guards every `/api`
  request: writes with a foreign `Origin` and, on a loopback bind, any request with
  a non-loopback `Host` are refused. Local clients stay trusted; web pages do not.
  Its error handler answers unhandled errors with a bare 500, never a stack trace.
- `src/cli.ts` is the executable entrypoint. One-shot commands call shared service
  or query modules directly; commands that require live HTTP or SSE contact the
  running server. This keeps CLI and UI reads on the same domain contracts.

Exact endpoint and command inventories change with source. Use the route files
above and `amon --help` rather than copying lists into this document.

## Storage Ownership

SQLite runs in WAL mode. The schema and compatible migrations live in
[`src/db/schema.ts`](../../src/db/schema.ts). The important ownership groups are:

- **Event history:** normalized events, session lifecycle, agent identity, import
  state, and deduplication.
- **Session browser:** browsing sessions, messages, turns, items, tool calls,
  watcher checkpoints, pins, and skill-context evidence derived from local
  transcript sources.
- **Operational state:** content-free OTEL metrics and provider-native quota
  snapshots. Operational metrics never enter usage or event-count aggregates.
- **Execution receipts:** opt-in host-authored launcher attempts, imported from a
  private spool into a separate ledger. They never create native sessions, usage
  events or trace summaries; see [the contract](../api/execution-receipts.md).
- **Lean trace quality:** one content-free `session_trace_summary` per session and
  `trace_quality_export_state`. Observation trees are projected from source rows on
  demand; the removed trace/observation/score/prompt warehouse is not recreated.
- **Persisted insight output:** generated insights retain the scope and coverage
  evidence used to create them.

Source events and parsed session rows remain authoritative. Derived summaries must
be rebuildable and must never silently replace their inputs.

### Database Safety

- Current-schema reads use SQLite's WAL read path while the server may hold the
  writer. Missing or older databases initialize under an immediate transaction and
  use `PRAGMA user_version` as the readiness marker.
- `amon database backup` uses SQLite's online backup API through a separate
  connection, validates the staged database, and publishes it atomically. Copying
  the live main/WAL/SHM files is not a supported backup procedure.
- Event import state and session-browser watcher state protect different tables.
  Re-importing events cannot reconstruct missing messages or tool calls when
  watcher hashes say files were already parsed. The recovery path is
  `amon sync sessions --source all --force` after preserving the database.

Operational procedures live in [OPERATIONS.md](OPERATIONS.md).

## Ingestion And Session Projection

### Events

Event producers pass through `normalizeIngestEvent` before insertion; that
includes events derived from OTLP logs and usage metrics. The contract
enforces required identifiers, closed event/status/source enums, finite
non-negative usage fields, timestamp normalization, UTF-8-safe payload limits,
and optional `event_id` deduplication. OTLP records get a derived `event_id` so
exporter retries collapse. `created_at` is server receive time;
`client_timestamp` is producer time.

`insertEvent` writes the agent, session, and event in one transaction, so a
failed insert never leaves a session with no event. The Codex live projection
runs after that commit; if it fails, the failure is logged and the stored event
still stands.

Codex summary projections preserve producer timestamps when present. Their
fallback is the event's database creation time: the known SQLite UTC format is
rendered with an explicit `Z` before projecting sessions, turns and items. That
fallback denotes observation time, not necessarily when work began. Existing
offset-free projections are not rewritten automatically, and arbitrary naive
producer timestamps must not be relabeled UTC based on appearance alone.

### Historical Sources

`src/import/` maps Claude Code JSONL, Codex session JSONL, Antigravity conversation
databases, and explicit benchmark results into the local model. Import hashes make
normal reruns idempotent; `--force` is the deliberate recovery path. Benchmark
events use `source='benchmark'` and remain excluded from normal activity and usage
aggregates unless a benchmark-aware read explicitly includes them.

A Codex rollout owns its session's `import-cdx-` rows. Their ids are positions
in the rollout, and Codex can rewrite a rollout. So a changed file is not
insert-only: the session's import rows are reconciled to the parse in one
transaction, together with its summary projection, trace summary, invocation
mode and import hash. Rows from other producers for the same session are never
touched. A date-scoped import only appends, and so does a rollout with a line
that does not parse (for example one read mid-write), because a missing line
would make the rows after it look stale. A session projected as a full
transcript is left alone.

A `thread_spawn` subagent rollout can open with a copy of its parent's history,
re-stamped at spawn time. The subagent's own activity starts at its first
`turn_context` whose UUIDv7 `turn_id` time is at or after the session id's time.
Copied counters and file edits before that line advance the event index but
emit nothing, so the child's own ids are unchanged. A subagent with no datable
turn is billed as before and flagged `_subagent_boundary: unresolved`.
`amon costs repair-codex-usage` applies both rules to rows stored earlier (see
OPERATIONS).

### Session Browser And Live

`src/watcher/` discovers and reparses supported local session files. Parsed session
history is persisted independently from event import so transcripts, turns, tool
calls, search, and skill analytics can be rebuilt from their source files.

Codex browser history has two existing identities: JSONL rollout basenames and
native UUIDs from import/OTEL and API/hook-generated `codex-summary` rows.
Session-list reads reconcile recognized aliases
without rewriting either projection, messages, pins, or detail links. The JSONL
representative wins; multiple JSONL projections use message count then ID as the
tie-breaker. Reconciliation precedes date/project/message filters and pagination,
so a later summary observation cannot reintroduce a second session. Other reads
retain their own projection/usage semantics; this is not a storage migration or
a universal identity reconciliation across Analytics, Live, and Search.

The additive `/api/v2/activity/sessions` read reconciles ordinary event evidence
with browser identities without requiring a transcript. It normalizes the known
`claude_code` event / `claude` browser labels, reuses the conservative Codex alias
grammar, and exposes usage, event, browser and readable-transcript evidence
separately. No new persistent summary is created. It preserves projected browser
starts where present; otherwise it uses first timed event evidence. Unknown
timezone evidence remains unresolved. This observed inventory includes subagents
and does not claim complete capture, execution counts, or billing completeness.

Daily activity is a separate aggregate read, not another session inventory.
It uses dated work on each local day, canonicalizes recognized aliases, and keeps
native conversations, delegated agents, internal jobs and unclassified evidence
distinct. Codex parsing retains native source/parent lineage and honors creation
time despite inherited fork history. Positive user-message evidence is required
for conversation classification; telemetry-only identities stay unclassified.
Unknown timestamp counts and capture limitations travel with the response. The
bounded daily read does not change billing, delete projections, or export content.

Live adapters under `src/live/` normalize current sessions and declare fidelity:

- Claude JSONL provides transcript-capable live detail where the local file exposes
  it.
- Codex `otel-only` is summary-oriented. It must not be presented as transcript
  parity with Claude.
- Antigravity is historical import only.

Context occupancy uses the latest request's prompt size, so it may drop after
compaction. Codex uses its reported context window when present and otherwise a
configured default; Claude uses the guarded default documented in
[DECISIONS.md](../project/DECISIONS.md). Missing evidence renders as unavailable,
not zero.

## Usage, Pricing, And Analytics

Stored `cost_usd` is authoritative for an event, and `cost_source` says whose
figure it is: `reported` by the producer, which a recalc never rewrites, or
`estimated` from pricing metadata, which a recalc re-derives when rates change.
Pricing metadata supplies estimates at ingestion/recalculation time and supports
model aliases, date-aware schedules, and prompt-size tiers. Rates load once from
the build, and startup prices any usage rows stored while their model had no
rate. Claude Code reports cost on its own cost metric, so a token-metric row whose
export also carries that cost gets a reported zero rather than a second,
estimated cost. A token-only export is still estimated. The build must copy pricing data into `dist/`; the built
asset check protects this source-versus-runtime boundary.

The token-bucket invariant is load-bearing: `tokens_in` stores uncached prompt
tokens, while `cache_read_tokens` and `cache_write_tokens` are separate additive
buckets. Codex sources that report cache-inclusive input are normalized before
storage to prevent cached tokens from being billed twice.

Codex can produce both live OTEL usage and later imported JSONL usage for the same
session. Usage and stats reconcile that overlap at read time: imported usage is
authoritative for matching timestamps, overlapping OTEL usage is excluded from
rollups, and raw rows remain available to monitoring and session history.

Usage, analytics, skill health, budgets, tier feedback, benchmarks, and insights
are derived from shared v2 query/service boundaries. Responses carry coverage
metadata when a provider or source cannot support the full requested analysis.

## Trace Quality And Export

Trace quality is a lean view over existing event and session-browser rows. It
persists a content-free session summary, projects observations on demand, and
labels source coverage so summary telemetry cannot masquerade as a complete trace.
The optional aggregate warehouse export publishes allowlisted summary fields to
AgentMonitor's own Postgres schema. Deeper trace/eval export remains deferred.

See [trace-quality.md](trace-quality.md) for the semantic and privacy contract.

## Streaming

The shared SSE broadcaster carries `event`, `stats`, and `session_update` messages.
The Live surface has a separate v2 stream. Both enforce connection limits,
heartbeats, disconnect cleanup, and backpressure behavior; neither replaces stored
state. Exact stream routes and payload wiring live in their route and emitter
modules.

## Runtime Path Resolution

- The default database follows the package installation, so invoking `amon` from a
  different working directory does not silently select a new database.
- `AGENTMONITOR_DB_PATH` explicitly selects another database.
- `AGENTMONITOR_PROJECTS_DIR` controls the workspace root used for git identity.
- `AGENTMONITOR_CLAUDE_DIR` controls Claude discovery and import independently.

Current configuration parsing and defaults live in
[`src/config.ts`](../../src/config.ts); common operator settings are explained in
[OPERATIONS.md](OPERATIONS.md).
