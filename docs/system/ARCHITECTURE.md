# Architecture

## High-Level Flow

1. Agent hooks (Claude Code) or OTEL exporters (Codex) send events via HTTP to the ingest API.
2. Events are validated, normalized, and stored in SQLite.
3. The SSE emitter broadcasts new events and stats to connected dashboard clients.
4. The canonical Svelte app at `/app/` consumes the `/api/v2/*` app contract, including Monitor reads under `/api/v2/monitor/*`.
5. The `amon` / `agentmonitor` CLI provides local runtime, maintenance, reporting, and hook-helper workflows over the same runtime and data layers.
6. The legacy vanilla JS dashboard at `/` remains a transitional compatibility surface.
7. Historical sessions can be backfilled via the import pipeline.

## Canonical Surface

- Canonical frontend: Svelte SPA served at `/app/`.
- Canonical application contract: `/api/v2/*`.
- Canonical local operator command: `amon`; `agentmonitor` is an equivalent executable alias.
- Transitional compatibility surface: legacy dashboard at `/`.
- New product work should prefer Svelte + v2, and carry forward durable v1 localhost behavior only where it still adds operator value.

## Active Decision Records

- `2026-02-24`: [Rust Backend Spike Before Desktop Packaging](../archive/adr/2026-02-24-rust-backend-spike-decision-record.md) — **superseded 2026-06-29**: the project standardized on the TypeScript runtime and removed the Rust backend. See [POSITIONING.md](../project/POSITIONING.md).

## Runtime

The TypeScript/Node runtime on `127.0.0.1:3141` is the single backend. An earlier Rust reimplementation under `rust-backend/` (axum + tokio + rusqlite) was evaluated as an alternate runtime and **removed on 2026-06-29** once the project committed to TypeScript (see [POSITIONING.md](../project/POSITIONING.md)). This app is I/O- and SQLite-bound, so the real performance wins come from schema and query design, not the host language; maintaining a second backend at parity was not worth its cost.

## API Layer

Express route handlers in `src/api/`:

| Route File | Endpoints | Purpose |
|------------|-----------|---------|
| `events.ts` | `POST /api/events`, `POST /api/events/batch`, `GET /api/events` | Event ingest (single + batch) and query |
| `stats.ts` | `GET /api/stats`, `GET /api/stats/cost` | Aggregate counters and cost breakdowns |
| `sessions.ts` | `GET /api/sessions`, `GET /api/sessions/:id` | Session listing and detail |
| `stream.ts` | `GET /api/stream` | SSE endpoint with filters and backpressure |
| `health.ts` | `GET /api/health` | Service health check |
| `otel.ts` | `POST /api/otel/v1/logs`, `POST /api/otel/v1/metrics`, `POST /api/otel/v1/traces` | OTLP JSON ingestion |
| `filter-options.ts` | `GET /api/filter-options` | Distinct values for filterable fields |
| `transcripts.ts` | `GET /api/sessions/:id` (transcript) | Session transcript aggregation |

Routes are composed in `src/api/router.ts`.
V1 routes remain important for ingest, SSE, provider quota, and legacy dashboard compatibility, but `/api/v2/*` is the canonical contract for the long-term app surface.

## TypeScript Runtime And CLI

`src/runtime.ts` owns TypeScript runtime startup: Express app construction,
server listen, watcher startup, periodic imports, provider-quota polling, stats
broadcasting, and shutdown wiring. `src/server.ts` is a thin executable wrapper
around that shared runtime. `amon serve` uses the same runtime module so CLI and
`pnpm start` do not diverge.

`src/cli.ts` is the executable entrypoint for both `amon` and `agentmonitor`.
One-shot commands avoid importing `src/server.ts`; they either call shared
service/query modules directly or, for live HTTP/SSE workflows, call the running
localhost server. CLI reads for sessions, usage, analytics, and trace quality use
the same v2 query/service layer that backs the Svelte app. `amon live watch`
connects to `/api/v2/live/stream` and exits unavailable when no server is
running.

## Database Layer

SQLite via `better-sqlite3` with WAL mode.

### Tables

| Table | Purpose |
|-------|---------|
| `agents` | Registered agent identities and last-seen timestamps |
| `sessions` | Session lifecycle (active → idle → ended) with metadata |
| `events` | Individual tool use, prompt, and lifecycle events with cost data |
| `import_state` | Tracks imported files to prevent duplicate backfills |
| `watched_files` | Tracks session-browser sync state for parsed, skipped, and erroring JSONL files |
| `trace_quality_*` | Local trace-quality projection: traces, observations, scores, prompt refs + join, projection state, and export state (see [Trace Quality](#trace-quality)) |

### Key Patterns

- All SQL lives in `src/db/queries.ts` (no ad-hoc DB logic in route handlers).
- Schema initialization and backward-compatible migrations in `src/db/schema.ts`.
- Indexes on `created_at`, `session_id`, `event_type`, `tool_name`, `agent_type`, `model`.

## SSE Broadcasting

`src/sse/emitter.ts` manages connected clients:

- Fan-out of `event`, `stats`, and `session_update` messages.
- Configurable max client limit (`AGENTMONITOR_MAX_SSE_CLIENTS`).
- Heartbeat keep-alive (`AGENTMONITOR_SSE_HEARTBEAT_MS`).
- Returns `503` when max client limit is reached.

## Event Contract

Defined in `src/contracts/event-contract.ts` and documented in `docs/api/event-contract.md`:

- Required fields: `session_id`, `agent_type`, `event_type`.
- Optional `event_id` for deduplication (unique constraint).
- `metadata` payload capped by `AGENTMONITOR_MAX_PAYLOAD_KB` with UTF-8 safe truncation.
- `client_timestamp` for client-supplied timing; `created_at` is server receive time.

## Pricing Engine

`src/pricing/` calculates per-event costs:

- `PricingRegistry` loads JSON pricing data files for each model family (Claude, Codex, Gemini).
- `PricingRegistry.resolve(model)` returns canonical model IDs after provider-prefix stripping and alias lookup.
- **Prompt-size tiers**: a model may carry an optional `tiers` array (higher rate bands keyed by `abovePromptTokens`). `calculate()` selects the effective rates by the request's prompt size (uncached `input` + `cacheRead`, applying the highest band strictly exceeded), then bills every token class at those rates — matching Google's long-context tiering (e.g. Gemini 3.1 Pro / 2.5 Pro double all rates above 200K prompt tokens). Flat models (no `tiers`) are unchanged; current Claude models bill their full 1M window at standard rate and carry no tiers. New tiers change only newly-computed costs — existing `cost_usd` rows update on `amon reparse` / the maintenance recalc.
- `model-classification.ts` maps raw model names to provider, family, provider-neutral tier, lifecycle, and pricing-status metadata for v2 usage reporting.
- `context-windows.ts` resolves a session's context-window size (denominator) and computes occupancy (`used`/`window`/`pct`) for the live occupancy gauge: Claude defaults to 1M, Codex uses its reported `model_context_window` else a configurable `AGENTMONITOR_CODEX_CONTEXT_WINDOW` (~256K), with an over-window guard so `pct` never exceeds 100. The numerator (most recent request's prompt size) is extracted by the parsers onto `ParsedSessionMetadata` and persisted on `browsing_sessions` (`context_used_tokens`/`context_window_tokens`) by the live adapters; `mapBrowsingSessionRow` surfaces it (plus derived `context_pct`) on `/api/v2/live/sessions`. Occupancy is a live-sync quantity — historical/bulk import does not populate it.
- Cost computed from `tokens_in`, `tokens_out`, `cache_read_tokens`, `cache_write_tokens`.
- **Token-bucket invariant**: `tokens_in` is the uncached (full-rate) prompt portion and `cache_read_tokens` the cached portion — additive, never overlapping. Anthropic reports `input_tokens` already net, but OpenAI/Codex report it cache-inclusive (cached is a subset), so the Codex importer (`src/import/codex.ts`) and the OTEL log-record path (`src/otel/parser.ts`) subtract the cached count before storing `tokens_in`. Violating this double-bills the cached bulk at the full input rate (~10x), the cause of historically inflated Codex/gpt-5.x spend.
- Historical rows predating that fix are repaired once by the `user_version`-guarded data migration in `src/db/schema.ts` (`runDataMigrations` → `backfillCacheInclusiveInputTokens`), which re-normalizes OpenAI/Google `tokens_in` and recomputes `cost_usd` atomically on next startup.
- Costs stored as `cost_usd` on each event row.
- V2 usage keeps stored `cost_usd` authoritative. Cache hit rate, estimated cache savings, classification filters, tier rollups, top-session enrichment, and prior-period deltas are derived at query time from filtered usage rows and current pricing metadata.
- Codex can produce both live OTEL usage and later imported JSONL usage for the same session. Aggregate usage/stat queries reconcile that overlap at read time: imported Codex usage is authoritative, overlapping Codex OTEL usage rows are excluded from token/cost rollups, and the raw event rows remain intact for monitor/session history.
- Read-only usage budgets are evaluated from an optional local JSON config through the same v2 usage summary/filter path. They report alert states only; no hook enforcement or request blocking is implemented.
- Tier feedback is generated from usage summaries, model attribution, and top-session metadata only. It does not inspect private message content and returns advisory findings for human review rather than executable model changes.

## Import Pipeline

`src/import/` supports historical backfill:

- `claude-code.ts`: Parses Claude Code JSONL conversation logs.
- `codex.ts`: Parses Codex session JSON files.
- `antigravity.ts`: Parses Antigravity CLI conversation SQLite DBs (`~/.gemini/antigravity-cli/conversations/**/*.db`). Blobs are plaintext protobuf decoded with descriptor-pinned + empirically-pinned field maps (`src/import/antigravity/`, see `docs/specs/baselines/antigravity-proto-fieldmap.md`). `agent_type="antigravity"`; models classify google/gemini; real per-turn usage/cost comes from the private `CortexGeneratorMetadata` record (cache-inclusive token invariant honored).
- Invocation mode: `claude-code.ts`/`parser/claude-code.ts` read each line's `entrypoint`/`promptSource` and `codex.ts`/`parser/codex-sessions.ts` read `session_meta.originator` (see `src/util/invocation-mode.ts`) to derive an `interactive`/`headless` mode, surfaced as a derived `mode` column by the monitor session queries. The live Claude Monitor stream is hook-sourced (hooks carry no `entrypoint`) and Codex is OTEL-sourced, so `mode` is stamped onto `sessions.metadata.mode` from the session files by three complementary writers, all funneling through `setSessionMode` (a guarded, idempotent UPDATE that never fabricates a row):
  - the **file watcher** (`syncSessionFileDetailed`/`syncCodexSessionFileDetailed`) stamps it as soon as it parses the JSONL, so a live session gets marked within the debounce window (for Codex it resolves the session UUID from the rollout filename, since the Monitor row is keyed by UUID, not the filename);
  - the **import path** (`upsertSession` on fresh events, plus `setSessionMode` once per session per file) covers historical backfill and works even when every event is a duplicate, so `amon import --force` fixes sessions imported before this feature existed;
  - the periodic **auto-import** (`runImport`, 5s after boot then on interval) is the backstop; when it imports new events it broadcasts `session_update {type:'auto_import'}` and the Monitor refetches, so the pill appears without a manual reload.
  A short headless run can finish before its Monitor row exists (hook POST vs. watcher parse race); that window is closed by the next auto-import. Antigravity has no equivalent signal and is left unmarked.
- `import_state` tracks full-file hashes for completed imports, including files that produced zero events, so unchanged non-importable files are skipped on later full imports.
- Date-scoped imports intentionally do not update `import_state`, because they only represent a partial view of the file.
- Import discovery can exclude configured path patterns before hashing or parsing, so known junk subtrees never enter the historical backfill pipeline.
- `amon import` is the primary operator entrypoint. The older `pnpm run import` script remains a compatibility wrapper.

## Session Sync

`src/watcher/` maintains the v2 session browser from local JSONL history:

- Startup sync scans `~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl`, and `~/.gemini/antigravity-cli/conversations/**/*.db`.
- Chokidar watches the Claude and Codex JSONL **directories** (recursively) and the handler filters to `.jsonl`. chokidar dropped glob support in v4, so the earlier `root/**/*.jsonl` patterns matched nothing and no live file events fired — live tailing had silently degraded to startup + periodic resync only. Antigravity DBs are **not** live-tailed yet — they are picked up on startup and each periodic resync (file-watch tailing deferred).
- The Antigravity browser projection is two writers per session (`src/parser/antigravity-sessions.ts` → `insertParsedSession`, then `src/live/antigravity-adapter.ts` → projector), producing `browsing_sessions`/`messages`/`session_items` at `integration_mode=antigravity-sqlite`, `fidelity=summary` (step-kind labels until per-kind payload internals are decoded).
- The same exclude-pattern matcher is applied to discovery, watcher events, and periodic resync so ignored paths behave consistently.
- `watched_files` caches parsed, skipped, and error states by file hash so unchanged files are not reparsed on every periodic resync.
- Periodic resync still runs as a safety net for missed file-system events and now covers the Claude, Codex, and Antigravity history roots.
- `amon sync sessions` is the primary manual resync entrypoint. The older reparse scripts remain compatibility wrappers.

## Trace Quality

A **lean**, provider-neutral trace-quality view (reframe, 2026-06): one trace per
session, derived on demand from existing sources (`events`, `session_items`,
`session_turns`, `messages`, `tool_calls`) plus a tiny content-free per-session
rollup. It is **additive**: source rows are never removed or reinterpreted. The
persisted trace/observation/score/prompt warehouse was removed — that eval depth
is deferred to Langfuse, while the content-free aggregate exports through the
explicit warehouse CLI (collector-not-backend; see POSITIONING.md).

- **Storage:** only `session_trace_summary` (one content-free, export-shaped row
  per session that feeds optional `agentmonitor.runs` publish) and the dormant
  `trace_quality_export_state` Langfuse seam are persisted. `src/trace-quality/` holds the
  projection (`projection.ts`), source readers, the on-demand read layer
  (`on-demand.ts`), the summary derivation/maintenance (`summary.ts`), and the
  ingest hooks (`service.ts`).
- **Detail on-demand:** `on-demand.ts` projects a single session's trace +
  observation tree in memory per request and never stores it; the list is served
  straight from the summary. Ingest maintains the summary incrementally; a startup
  guard self-heals incomplete migrations (stale version or NULL `trace_id`).
- **Honesty:** traces carry a `coverage_json` flag set and reads carry
  read-coverage metadata (over the full filtered set), so summary-only telemetry
  (e.g. Codex OTEL) is never presented as full fidelity. Observation
  `payload_policy` governs raw vs hash vs summary retention.
- **Read APIs:** `/api/v2/trace-quality/{traces, traces/:id, traces/:id/observations}`
  (handlers in `src/api/v2/router.ts`, reads in `src/trace-quality/on-demand.ts`).
- **Reclaim:** existing DBs drop the old warehouse tables and VACUUM via the
  explicit, opt-in `pnpm reclaim:trace-quality` (never run at startup).
- **Export seam:** `trace_quality_export_state` (+ `langfuse` provider enum) is the
  seam for the **deferred** export — medallion for the summary aggregate, Langfuse
  for trace/eval depth. Nothing leaves localhost until that adapter is built.

See [trace-quality.md](trace-quality.md) for the full model, taxonomy, and
semantics.

## OTEL Parser

`src/otel/parser.ts` converts OTLP JSON payloads (logs, metrics) into normalized events for the standard ingest pipeline.

### Codex Telemetry Capability Matrix

Codex should be thought of as having multiple telemetry surfaces, not one monolithic "OTEL only" story.

| Surface | Upstream source | Current AgentMonitor status | Notes |
|---------|------------------|-----------------------------|-------|
| Session bootstrap metadata | `codex.conversation_starts` OTEL event | Captured | Startup metadata such as provider, reasoning effort, sandbox policy, and MCP server list can now flow into normalized events. |
| User prompts | `codex.user_prompt`, `codex.user_message`, `codex.response` user items | Captured | Prompt text is retained when present and projected into live summary sessions. |
| Tool decisions and tool results | `codex.tool_decision`, `codex.tool_result` OTEL events | Captured | Tool call metadata, call ids, parsed arguments, outputs, success state, and MCP origin metadata are now preserved and projected more honestly. |
| Response completion usage | `codex.sse_event` with `event.kind=response.completed` | Captured | Response-complete token usage and related metadata can populate `llm_response` rows without waiting for backfill. |
| Response item typing | `codex.response`, `codex.event_msg` payload types | Partially captured | Assistant messages, reasoning, shell-call style responses, and tool-result style outputs can be projected when the OTEL payload includes enough structure. |
| Websocket request and response lifecycle | `codex.websocket_request`, `codex.websocket_event` | Partially captured | Request/error/response classification is available, and low-value websocket lifecycle markers are now filtered at ingest, but this is still not full transcript-grade data. |
| Provider quota state | `codex app-server` JSON-RPC | Captured | AgentMonitor polls the local app-server for native Codex quota windows and reset times for the monitor header. |
| Full Thread/Turn/Item lifecycle | `codex app-server` JSON-RPC | Not integrated yet | App-server quota polling now exists, but transcript-grade Codex parity is still not using the richer item lifecycle stream. |
| Persisted local rollout state | Codex local session/state files | Import-only today | Local Codex session import exists, but the live v2 path still centers on OTEL rather than direct local-state projection. |

Planning implication: current AgentMonitor Codex fidelity limits should be treated as implementation limits of the current parser/projector, not as the hard ceiling of Codex telemetry itself.

### Codex Live Validation Notes

On April 9, 2026, AgentMonitor was pointed at active local Codex sessions exporting to `/api/otel/v1/logs` on the TypeScript runtime. That live validation pass changed the practical assessment of the current OTEL path:

- The current OTEL stream is materially useful for `codex.user_prompt`, `codex.tool_decision`, `codex.tool_result`, `codex.sse_event`, and `codex.websocket_request`.
- The dominant live volume is still `codex.websocket_event`, especially `response.output_text.delta` and related response lifecycle events.
- In the sampled local stream, websocket delta rows did not carry transcript text, response item typing, or client timestamps that would let AgentMonitor reconstruct a reliable Thread/Turn/Item transcript from OTEL alone.
- AgentMonitor now drops the known empty websocket lifecycle markers at ingest instead of storing them as generic `response` rows, while keeping `response.failed` errors and `codex.sse_event response.completed` usage signals.
- The widened parser/live adapter is therefore still worthwhile because it improves prompt, tool, and completion-summary fidelity, but the remaining transcript ceiling is now a source-data ceiling for the current OTEL export, not just a parser omission.
- The practical follow-up for transcript-grade Codex parity is app-server or richer local-state integration, not continued stretching of the current websocket-event summary path.

## Runtime Path Resolution

- `AGENTMONITOR_PROJECTS_DIR` controls the workspace root used for git branch lookups.
- If unset, config auto-detects the AgentMonitor repo root from `process.cwd()` ancestry and uses its parent directory.
- If no repo root is detected, config falls back to the current working directory.

## Directory Map

```text
src/api/                  # HTTP route handlers
src/cli/                  # Local operator CLI command modules
src/cli.ts                # CLI executable entrypoint for amon and agentmonitor
src/contracts/            # TypeScript event types and validation
src/db/                   # Schema, queries, connection management
src/import/               # Historical log importers
src/otel/                 # OTLP JSON parser
src/trace-quality/        # Local trace-quality projection, scores, prompts, findings
src/pricing/              # Cost calculation + JSON pricing data
src/runtime.ts            # Shared TS runtime startup used by server and CLI
src/sse/                  # SSE client management and fan-out
src/util/                 # Utilities (git branch detection)
frontend/dist/            # Built Svelte SPA served at /app by the TS runtime
public/                   # Dashboard HTML, JS components, CSS
hooks/claude-code/        # Claude Code integration hooks (bash + Python)
hooks/codex/              # Codex OTEL integration docs
scripts/                  # Seed, import, benchmark, cost recalculation
tests/                    # Node test runner suite
```
