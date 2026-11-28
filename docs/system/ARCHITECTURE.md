# Architecture

This document describes AgentMonitor's system shape, data ownership, and durable
invariants. Exact routes, columns, and module exports remain authoritative in
source.

## System Flow

```text
Claude hooks ───────┐
Codex OTLP ─────────┼─> ingest/normalization ─> SQLite ─> v1/v2 reads ─> Svelte /app/
session JSONL/DBs ──┘                         │                 └──────> amon CLI
                                              └─> SSE ─────────> Monitor + live stream
```

1. Claude hooks, Codex OTLP exporters, generic clients, and historical importers
   produce normalized events or session-browser projections.
2. SQLite stores authoritative local event history, parsed session history,
   operational metrics, provider quota snapshots, and small derived summaries.
3. `/api/v2/*` serves the canonical Svelte application and agent-first CLI reads.
4. SSE carries current activity to Monitor and its live stream without making the
   stream an authoritative store.

## Product And Runtime Boundaries

- The Svelte SPA at `/app/` is the sole human-facing product surface. `/` redirects
  to it.
- `/api/v2/*` is the canonical application read contract. V1 remains for event and
  OTLP ingestion, provider quota bridges, shared SSE, and legacy reads still used by
  parity and ingestion-readback tests.
- `amon` is the preferred local operator command; `agentmonitor` is an equivalent
  executable alias.
- The TypeScript/Node runtime on `127.0.0.1:3141` is the single backend. The removed
  Rust spike is preserved in Git history; product direction lives in
  [VISION.md](../project/VISION.md).
- `amon serve` runs that backend and normally exposes
  `https://agentmonitor.localhost` through the pinned Portless CLI. Hooks, OTLP,
  and direct API clients continue to use the fixed loopback backend.

Core local operation does not depend on Postgres, Langfuse, or a model-provider
API key. External exports and model-assisted features remain optional. The current
runtime and storage boundaries stand independently of the longer-term platform
possibilities described in the vision.

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
  transcript sources. A session keeps the directory it started in (`cwd`),
  which names its repository for git activity; it stays local, out of API
  responses and exports.
- **Git activity:** commits in those repositories, or for a directory that
  is not one, the repositories directly inside it (`git_commits`, with
  `git_repos` recording each one's last read), read from local git by a
  background child process: hashes, times, authors, subjects, co-author
  trailers and changed paths, never contents. Configured Git directory
  exclusions filter local collection before the log is read, including linked
  worktrees resolved to an excluded common repository. Existing local cache
  rows can be pruned separately using the same exclusions. Merge commits are
  kept with `is_merge` to record merged pull requests. Each commit's `landing` says
  whether it reached a main branch: any remote's default, since a fork's
  `origin` is upstream. GitHub's answer for each pull request sessions opened,
  and for each the signed-in user merged in the last year, is cached in
  `github_pull_requests` (state, times, size, author kind), with its commits in
  `github_pull_request_commits`; `github_pull_request_search` records which
  months of merges were read, per GitHub login. These are asked read-only through `gh` only with
  `AGENTMONITOR_GITHUB_LOOKUPS=1`, the only git activity that leaves the
  machine, naming only repositories, numbers and merge dates. Without it, a
  local merge commit gives its pull request's commits (`source = 'local'`),
  which GitHub's list replaces when one arrives. Attributing a commit to the
  session that made it, and allocating spend to what it produced (cost per
  outcome), happen at read time; neither is stored.
- **Operational state:** content-free OTEL metrics and provider-native quota
  snapshots, with a sampled quota history (`provider_quota_samples`): a row per
  changed reading at most every five minutes, each held until `observed_until`,
  so an idle stretch reads as flat. A failed refresh stores its error but keeps
  the last good windows with their read time (`windows_observed_at`), and reads
  report them as `stale`. Operational metrics never enter usage or
  event-count aggregates.
  Each OTLP point carries the same retry key as usage points, so an exporter
  resend is stored once.
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
- Growth is bounded without rewriting the live file: connections cap the WAL a
  checkpoint leaves behind, and the server merges the FTS index in short steps so
  dead entries from deleted messages do not accumulate. Reclaiming free pages
  (`VACUUM`) is never automatic; `amon database compact` does it only under runtime
  ownership and after a validated backup. See
  [Storage Maintenance](OPERATIONS.md#storage-maintenance).
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

Codex exports one OTLP log per streamed chunk (deltas and lifecycle markers such
as `response.created` or `response.output_item.done`). These records carry no
content, usage or error. The parser drops them on both transports,
`codex.sse_event` and `codex.websocket_event`. It keeps `response.completed`
(usage), `response.failed` (error) and every other response kind.

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
normal reruns idempotent; `--force` is the deliberate recovery path. A Claude or
Codex file whose size and nanosecond mtime match the state recorded with its hash
is skipped without a read; a cleared hash (how migrations force a re-import) still
reads it. Antigravity importer and watcher share one read-only SQLite snapshot
reader with bounded `SQLITE_BUSY` retries (`src/import/antigravity/snapshot.ts`)
and one WAL-aware hash token folding `.db`, `.db-wal`, `.db-shm`,
`conversation_summaries.db` (+ `-wal`), and `transcript_full.jsonl` /
`transcript.jsonl`, so WAL-only writes update both browser and event/usage
projections without waiting for a checkpoint. Antigravity generation events key
by stable identity (`messageId`, then `providerAssignedMessageId`, then
`gen_metadata.idx`) while bridging legacy ordinal `gen:i` IDs against duplicates,
and `amon costs repair-antigravity-usage` atomically reconciles legacy rows,
`sessions` totals, and `session_trace_summary`. Benchmark
events use `source='benchmark'` and remain excluded from normal activity and usage
aggregates unless a benchmark-aware read explicitly includes them.

Codex's native thread identity (`session_meta.payload.id`) can span several
physical rollout files after pagination or revert. The physical rollout UUID
comes from the filename; a `history_base.thread_id` names that physical UUID,
despite the field's name. Its decoded-byte offset and exclusive ordinal select
an exact ancestor prefix. The shared history resolver validates ownership,
complete-record boundaries and ordinals, rejects cycles and ambiguous or missing
sources, and bounds depth and decoded bytes. Compressed files use decoded bytes
for the same bookmarks. Repeated metadata envelopes remain context: the first
header owns the physical file, and a copied parent's header is accepted only
inside an explicitly marked subagent prefix that names that parent.

The native session owns its `import-cdx-` ledger across all discoverable physical
members. Each member reads its bounded ancestors to initialize counters, request
totals and model context, then emits only its own usage. Positional continuation
ids include the physical rollout identity; native request ids retain their
`response_id`. The ledger preserves requests actually billed in an old rollout's
suffix even when a revert excludes them from the current conversation. An opening
counter that repeats the ancestor total bills nothing anew.
For a full replacement without a bookmark, an exact copied record prefix from
an older same-thread rollout also initializes accounting without being billed
again. This compatibility check preserves timestamps and nested record values;
equal cumulative totals alone do not establish copied history.

A changed family is reconciled once, independently of file discovery order.
Its import rows, summary projection, trace summary, invocation mode and every
owned member's import hash commit in one transaction from the same source reads.
Rows from other producers for the same session are never touched. A date-scoped
import only appends. An ordinary rollout with an unparseable line also takes the
append-only path, because a missing line would make later rows look stale.
Paginated history requires complete source records: malformed records or invalid
or missing references fail before any ledger replacement or successful hash
commit; the last complete stored history remains.
A session projected as a full transcript is left alone.

A `thread_spawn` subagent rollout can open with a copy of its parent's history,
re-stamped at spawn time. The subagent's own activity starts at its first
`turn_context` whose UUIDv7 `turn_id` time is at or after the session id's time.
Copied counters and file edits before that line advance the event index but
emit nothing, so the child's own ids are unchanged. A subagent with no datable
turn is billed as before and flagged `_subagent_boundary: unresolved`.
`amon costs repair-codex-usage` applies both rules to rows stored earlier (see
OPERATIONS).
The session browser uses the same boundary: a subagent's transcript, tool calls
and context observations start at its own first turn, keeping only the
instruction preamble written before the copy; the parent session shows the
copied turns. Only inherited turns or requests mark a copy, so a child's own
compaction before its first surviving turn stays. Plain forks (`forked_from_id` without `thread_spawn`) and
unresolved subagents keep their whole rollout.

The boundary rests on how Codex lays out subagent rollouts and mints turn ids
today. On 2026-09-24 every `thread_spawn` rollout from Codex 0.94.0 to 0.156.1
had a datable turn and a boundary. A layout change would make the parse fall
back to billing the whole rollout. Re-measure when `amon costs
repair-codex-usage` reports `subagent_boundaries_unresolved` above 0, when a
new subagent's import/OTEL ratio leaves 0.95-1.02, or on a Codex minor version
that changes subagent behaviour.

Codex 0.154+ writes a `token_usage_record` per API request, with the
request's usage and the thread's running total. When a rollout's own records
cover its usage from the resolved ancestor baseline (zero for an original
rollout), the import bills one row per record, as the Claude import bills one row
per assistant message. A continuation's first request can therefore be billed
before its next cumulative counter arrives:

- each row is keyed by the request's `response_id`;
- it is priced with its own turn's model, one request at a time;
- its `_usage_source` is `compaction` when a `compacted` line names it by
  `compaction_response_id`, and `request` otherwise.

Counter lines then bill nothing but keep their place in the event index, so
file-change ids do not move. This covers the requests the cumulative
`token_count` leaves out (compactions, and requests of turns later aborted), so
the rows add up to Codex's own total for that physical member's span. Across a
reverted family, the ledger is checked against the sum of those spans, which can
exceed the current leaf's conversation total.

A rollout without records, or whose records start mid-thread (a session begun
before 0.154), bills from the cumulative counter instead. So does one whose
records may be incomplete: their usage does not add up to the last record's
thread total, the counter grows past that total (it leaves requests out but
adds none), or a line with lines after it does not parse (a partial last line
is a write still in progress). On that path a
compaction is billed as its own row when both of these hold:
- the named record is this thread's own;
- the counter's gap to the thread total grew by exactly that record's usage
  since the previous counter.

When the gap check fails, nothing is billed: for example, the counter already
includes the compaction, it reset, or other unrecorded usage landed in the same
window. The miss is counted on `session_end` as `_compactions_unbilled`.
`session_end` names the instrument used in `_usage_instrument` (`request` or
`counter`), and carries Codex's `total_thread_tokens`, which the repair checks
against.

Codex import event ids are positional: `src/import/codex.ts` derives them from a
counter over *emitted* events, so skipped, malformed and zero-delta lines do not
shift them, and rewritten rollout content is reconciled under the same ids.
Changing which events are emitted, or their order, re-keys every stored row; the
next import would stop matching them and duplicate the history. Unlike the
Claude importer, Codex import has no legacy-id bridge to absorb such a change.
Compaction rows are keyed by the request's `response_id` and advance no counter.
A switch to the producer's `ordinal` was evaluated and rejected on 2026-09-22:
the counter and the ordinal agreed across 120 real rollouts, and no rollout
shared a `session_meta` id, so it would have re-keyed every stored row for no
measured gain. Tests in `tests/import.test.ts` (`pins the Codex event-id
derivation against accidental re-keying`, `skipped, malformed and zero-delta
lines do not shift later event ids`) and `tests/codex-import-usage.test.ts`
(`counter rows keep the ids they had before compactions were billed`) pin this.
A derivation change needs a legacy-id bridge first, mirroring
`src/import/index.ts`'s ownership rule; do not simply update the pinned
expectation.

### Session Browser And Live

`src/watcher/` discovers and reparses supported local session files. Parsed session
history is persisted independently from event import so transcripts, turns, tool
calls, search, and skill analytics can be rebuilt from their source files. A
re-sync keeps the stored messages and tool calls that match the new parse and
rewrites from the first difference, so an appended transcript writes only its new
rows while a rewritten or truncated one is still replaced where it changed. The
live turn projection is rebuilt from the start when an earlier message changed.

A session's live status says how recently it was active: live within five
minutes, active within fifteen, ended after that (`src/live/live-status.ts`).
Writers store the status they derive, but a row that stops receiving writes
keeps it, so a producer that goes quiet (most often a session known only from
telemetry) would read as live indefinitely. Readers (session rows, the live
list's filters, the skill-context `active` flag, Skills date windows) re-derive
a stored live or active status from the last activity; an explicit end, or any
other stored status, is read as stored. The SQL and TypeScript readings agree,
and both read an offset-free activity time as UTC, as SQLite does.

Search indexes the text of the stored content blocks. The FTS5 index's content
table is the `messages_search` view, which extracts every string value except
block bookkeeping keys outside a tool's input with `json_tree`, and the
`messages` triggers derive the same text, so no text is stored twice and any
writer keeps the index current. The schema guard rebuilds the index whenever
the stored view differs from the current rule.
FTS5 cannot scan that view from inside the index, so its `rebuild` command and
rank-1 `integrity-check` fail; `rebuildMessageSearchIndex` refills the index, and
the tests compare it with one built from the view.

The server also parses only what was appended. After each Claude or Codex parse
it keeps an in-memory checkpoint: the bytes parsed, their hash, and the parser's
running state. The next sync hashes the file and continues from the checkpoint
only when the file still starts with exactly those bytes and the stored session
still matches what that parse wrote. Otherwise, after a restart, under `--force`,
or when the file ends inside a line, it parses the whole file. A Codex parse
leaves no checkpoint while a later line could still change what it produced:
before `session_meta`, before a subagent's own first turn, or after a catalog
recorded a model or window that only a later line would give.

For paginated Codex history, the watcher selects the newest unreferenced leaf by
its creation timestamp, resolves its bounded ancestors, and writes the current
conversation under the original root rollout's browser identity. Syncing an old
physical file still selects that current leaf; it cannot restore a reverted
conversation tail. Missing or invalid dependencies preserve the previous browser
projection and report an error. This conversation projection intentionally differs
from the usage ledger, which keeps the costs of discarded requests.

Codex browser history has two existing identities: JSONL rollout basenames and
native UUIDs from import/OTEL and API/hook-generated `codex-summary` rows.
Session-list reads reconcile recognized aliases
without rewriting either projection, messages, pins, or detail links. The JSONL
representative wins; multiple JSONL projections use message count then ID as the
tie-breaker. Reconciliation precedes date/project/message filters and pagination,
so a later summary observation cannot reintroduce a second session. Analytics
counts from the same reconciled rows (`listed_sessions`), so its session and
message totals count such a session once, and the warehouse export publishes
one trace summary per session (the UUID one when both exist). Other reads
retain their own projection/usage semantics; this is not a storage migration or
a universal identity reconciliation across Live and Search. New continuation
writes use the root browser identity, but preexisting continuation aliases remain
stored: deleting or merging them requires a migration that preserves pins and
detail links.
The selected representative's fields and dates are the ones listed. Summary-only
sessions stay listed unless a caller passes `exclude_empty=true`. Unknown ID formats
and integrations are left as they are rather than guessed into an alias. List totals
are not usage-session totals: usage counts distinct usage-bearing event session IDs
in the event-time window, while browser history can include subagents and omit
transcripts that were never projected.
Trace-quality lists apply the same grammar to session summaries: a summary is
event-backed when its session has events, so a Codex session holds a
transcript-only summary under its rollout basename and an event-backed one
under its UUID, and one per rollout file. Lists and the warehouse export keep
one summary per session, the UUID one first, else the rollout with the most
observations; all stay stored, and publishing a summary retracts the ids it
supersedes that were published earlier.

The additive `/api/v2/activity/sessions` read reconciles ordinary event evidence
with browser identities without requiring a transcript. It normalizes the known
`claude_code` event / `claude` browser labels, reuses the conservative Codex alias
grammar (for events, which carry no integration mode, the exact rollout or UUID
grammar alone, as one expression shared with daily activity), and exposes usage, event, browser and readable-transcript evidence
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
- Antigravity's watcher sync uses the shared snapshot reader to project
  `antigravity-transcript` from
  `brain/<uuid>/.system_generated/logs/transcript_full.jsonl` (preferred, `full`
  fidelity when complete with no `truncated_fields`) or `transcript.jsonl`
  (marking `truncated_fields` visibly at `summary` fidelity), correlating
  parallel tool calls with native SQLite `ChatToolCall` IDs (`planner_response`
  field 7 and `steps.metadata` field 4), preserving any trailing unflushed
  SQLite `steps`, and falling back to `summary`-fidelity (`antigravity-sqlite`)
  from SQLite `steps` when absent. Verified skill-file reads under recognized
  skill roots and `CHECKPOINT` compactions feed `session_context_observations`
  and the skill invocation ledger; parent/subagent lineage combines
  `conversation_summaries.db` (`parent_conversation_id`, `nesting_depth`,
  `agent_name`) with explicitly correlated `invoke_subagent` result
  `conversationId` fields; and Antigravity Git/PR commands enter Git
  attribution only with confirming correlated results. The same sync also
  ingests Antigravity `events` (promoting `generic` steps with SQLite
  `ChatToolCall` metadata to named `tool_use` / `file_change` events) and
  reconciles `sessions` (`active` within the activity timeout window, `ended`
  otherwise) so active root and subagent conversations reach **Monitor -> Active
  Agents** live and follow standard `active -> idle -> ended` sweep transitions.
  When a `full`-fidelity transcript exists alongside ingested events,
  `session_trace_summary` preserves `has_full_transcript` coverage and records
  explicit `usage_coverage`, `cost_coverage`, `cost_provenance`,
  `timestamp_coverage`, and `tool_outcome_coverage` signals (rebuilt atomically
  on import, sync, usage repair, and cost recalculation, and carried into the
  content-free warehouse export). `amon sync sessions` supports
  `--source claude|codex|antigravity|all` with `--antigravity-dir`.

Context occupancy uses the latest request's prompt size, so it may drop after
compaction. Codex uses its reported context window when present and otherwise a
configured default; Claude uses the guarded default documented in
[DECISIONS.md](../project/DECISIONS.md); Antigravity uses its reported window or
its 1 MiB default (1,048,576 tokens) from `gen_metadata` prompt usage and
statusline payloads. Missing evidence renders as unavailable, not zero.

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
storage to prevent cached tokens from being billed twice. `cache_write_1h_tokens`
is not a further bucket: it is the share of `cache_write_tokens` written to
Anthropic's 1-hour cache, which bills at 2x input rather than 1.25x, so adding it
to the other buckets counts those tokens twice.

Claude and Codex can each produce both live OTEL usage and later imported
transcript usage for the same session. Usage and stats reconcile that overlap at
read time, by one rule for every source:
- an OTEL usage row is excluded from rollups (the Monitor's per-session token
  and cost totals among them) when the session's import holds usage of the same
  agent at or after the row's time;
- OTEL usage the import has not reached yet, the live tail, still counts;
- raw rows remain available to monitoring and session history.

The rule matches rows by session id. Claude Code names the session on each
metric point and log record (`session.id`), not on the resource, so the parser
reads it there before falling back to the resource; a metric with neither is
stored under `unknown`, which no import can cover.

A Codex OTEL row is dated at its request. A metric usage row, such as Claude
Code's cost and token metrics, is dated at the start of the interval it covers:
a delta point's start time, a cumulative point's previous point. The first
point amon sees of a cumulative series is dated at its own time, since the
series may have started long before (amon restarted). A point exported after a
transcript's last request is therefore still covered when its interval began
before that request. Dating shifts a metric row earlier by at most one export
interval; a row whose interval straddles the import's latest row is left out
whole until the next import bills the rest, rather than counting the imported
part twice.

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
The live stream (Monitor's drill-in) has a separate v2 SSE stream. Both enforce connection limits,
heartbeats, disconnect cleanup, and backpressure behavior; neither replaces stored
state. Exact stream routes and payload wiring live in their route and emitter
modules.

A periodic auto-import that changes anything sends a `session_update` of
`{ type: 'auto_import', imported, refreshed, removed }`. Those fields count the rows
it inserted, rewrote, and removed because their Codex rollout no longer produces
them. The app's Monitor store treats it as a refresh signal, not as a delta to
apply.

The server owns the Monitor's session lifecycle (`sessions.status`: `active`,
`idle`, `ended`; vocabulary in `src/contracts/session-lifecycle.ts`). The idle
sweep runs every minute and before Monitor reads, and every sweep that moves a
session sends `{ type: 'idle_check', idled, ended, transitions, timeout_minutes }`,
where each transition names a session and the status it was left in. The
Monitor applies those statuses and drops ended sessions, as its reload would.
A sweep run by a separate `amon` process is not broadcast, so on each
`idle_check` the Monitor also idles any active card quiet past
`timeout_minutes`; a session that process ended stays listed until a reload.

## Frontend (`/app/`)

Paths are relative to `frontend/`. Source is authoritative when this map drifts;
`frontend/AGENTS.md` holds the working rules for the app.

- `src/lib/components/monitor/`: Monitor tab (real-time dashboard). An agent card opens `MonitorStream` at `#monitor?session=…`: `SessionSummary` (the card's figures, from the Monitor store's row merged with the session's own `GET /api/v2/monitor/sessions/:id` read via `followedSessionSummary`), then the live stream (`components/live/ItemStream` + `InspectorPanel`, `stores/live.svelte.ts`). The Inspector's Events view and the no-live-record / live-view-off fallback both render `SessionEvents` (`sessionRecentEvents` in `lib/monitor-session-view.ts` merges that read with live SSE events). Legacy `#live` redirects to Monitor. `MonitorPage` renders its own `ui/FilterBar` (the Agent select, the only Monitor filter, beside `StatsBar`); `monitor.svelte.ts` applies the agent filter to live SSE events too (`applyLiveEvent`). The live stream opens at its newest page (`tail`), loads earlier pages as you reach the bottom (`before`), and reads new items after the newest one held (`cursor`); `ItemStream` renders newest first and, while you are scrolled down, pins the first visible row by its layout offset (not total height: a result folds into its call's row, which may sit above or below you), so the rows you are reading stay put (browser scroll anchoring is off on its scroller). `MonitorStream` holds the followed session's live events itself, since the Monitor's global feed keeps only its newest 200.
- `src/lib/components/sessions/`: Sessions tab. `SessionsPage` owns the `#sessions?…` hash (`q`, `sort`, `project`, `agent`, `pinned`, `session`, `message`) and shows the `SessionViewer`, or one of three list bodies picked by `sessionsListMode` (`lib/sessions-browse.ts`): the session list, a `ui/DataTable` laid out like the Benchmarks studies table (a row opens its session; the title stays a button, and a parent's subagents open in the table's `detail` row); `SearchResults` (FTS5 message search via a page-local `createSearchStore`) while a query is entered; `PinnedMessages` while the Pinned filter is on (pins filtered client-side by `filterPinnedMessages`). The Search tab and the Pinned sub-view folded in here: legacy `#search?…`, `#pinned` and `#sessions?view=pinned` links redirect via `canonicalizeLegacy*Hash` in `route-state.ts`.
- `src/lib/components/analytics/`: Analytics tab. `AnalyticsShell.svelte` hosts the tab's `ui/FilterBar` (SubTabs, date range with quick ranges, Project, Agent, and Usage's facets behind `MoreFilters`) and renders five sub-views — Overview, Usage (`components/usage/`), Skills (the filterable consultation evidence ledger), Insights (`components/insights/`), and Quality (`components/trace-quality/`). Overview holds activity panels only: top sessions live in Usage (by cost), and every skill panel (daily invocation volume + the consultation explorer) lives in Skills. Insights is listed once a provider key is configured or any insight is saved (`analytics-views.ts`, fed by `insights.availability`; an empty filtered slice does not hide it); an Insights deep link with neither renders Overview, and generating stays disabled without a key. Shared filter state + the `#analytics?view=…` hash live in `stores/analytics-filters.svelte.ts`, which the shell seeds from the URL (`attachHash`) before its first render so a sub-view deep link mounts only that view; the `analytics`/`usage`/`insights`/`trace-quality` data stores read filters from it and subscribe for refetch.
- `src/lib/components/trace-quality/`: lean Quality sub-view (one trace per session, summary-backed list + on-demand detail). `TraceQualityPage` (list + inspector), `TraceTree` (recursive observation tree, read straight from the loaded detail), `TraceCoverageBadge`, `TraceDrillInLink` (session drill-in from Usage's top sessions, the live stream's inspector, and Sessions: viewer and search results). Backed by `stores/trace-quality.svelte.ts`; `?session=`/`?trace=` ride the analytics hash. The persisted eval/dashboard depth (scores, findings, prompt rollups, score trends) was removed in the trace-quality reframe. Current local projection and deferred export boundaries live in `docs/system/trace-quality.md`; broader direction lives in `docs/project/VISION.md`.
- `src/lib/components/benchmarks/`: Benchmarks tab (segregated bake-off comparison). `BenchmarksPage.svelte` renders the studies list → study detail (arm ladder with verdict Badges + auto-generated honesty panel). Selected study rides `#benchmarks?study=<study_id>`; data via `stores/benchmarks.svelte.ts` off `GET /api/v2/benchmarks[/:studyId]`. Study detail also renders `BenchmarkFrontier.svelte` — a cost×score Pareto scatter on the shared `ui/chart/` primitives (`scales.ts`, `layout.ts`, `PlotFrame.svelte`) with pure geometry in `frontier-geometry.ts`; markers click-drill to the matching ladder row.
- `src/lib/api/client.ts`: typed client for the v2 endpoints; the v1 SSE stream is opened in `src/lib/stores/sse.ts`.
- `src/lib/stores/`: Svelte 5 reactive state (runes). Superseding async loads follow the `latestRequest()` rule in `frontend/AGENTS.md`.

## Source Layout

```text
src/cli.ts            CLI entrypoint for `amon` and `agentmonitor`
src/cli/              CLI command modules, help, output, launchd and Portless wrappers
src/runtime.ts        Long-running startup/shutdown shared by `amon serve` and `pnpm start`
src/runtime-ownership.ts  Per-database runtime lock
src/app.ts            Express app: `/api`, the `/` redirect, and the `/app/` static build
src/api/              v1 and v2 route handlers and the local-origin guard
src/contracts/        Event-ingest contract types and validation
src/db/               Schema, migrations, v1/v2 queries, connection, storage maintenance
src/import/           Claude Code, Codex, Antigravity, and benchmark importers
src/watcher/          Session-file discovery and session-browser projection
src/live/             Live session adapters and normalization
src/otel/             OTLP JSON parsing
src/pricing/          Pricing tables (copied into `dist/` by the build) and cost math
src/provider-quotas/  Provider-native quota polling and bridges
src/sse/              SSE client management and fan-out
frontend/             Svelte 5 `/app/` (map above; rules in frontend/AGENTS.md); static files in frontend/public/
hooks/                Claude Code, Codex, and Antigravity integration setup
scripts/              Package-script tools, the verification CLI, and test runners
tests/, e2e/          Node test suite and Playwright end-to-end tests
```

The remaining `src/` directories hold the domain services behind the v2 reads they
are named for (`analytics/`, `usage/`, `insights/`, `skills/`, `trace-quality/`,
`warehouse/`), plus shared transcript parsing (`parser/`) and helpers (`util/`).
Source is authoritative when this map drifts.

## Runtime Path Resolution

- The default database follows the package installation, so invoking `amon` from a
  different working directory does not silently select a new database.
- `AGENTMONITOR_DB_PATH` explicitly selects another database.
- `AGENTMONITOR_PROJECTS_DIR` controls the workspace root used for git identity.
- `AGENTMONITOR_CLAUDE_DIR` controls Claude discovery and import independently.

Current configuration parsing and defaults live in
[`src/config.ts`](../../src/config.ts); common operator settings are explained in
[OPERATIONS.md](OPERATIONS.md).
