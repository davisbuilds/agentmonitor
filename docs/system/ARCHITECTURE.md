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

- `2026-02-24`: [Rust Backend Spike Before Desktop Packaging](../archive/adr/2026-02-24-rust-backend-spike-decision-record.md) — **GO decision reached** for continued Rust backend evaluation. See [spike decision](../archive/plans/rust-spike/2026-02-24-rust-backend-spike-decision.md).
## Rust Backend

An isolated Rust service (`rust-backend/`) reimplements ingest and live-stream behavior using axum, tokio, and rusqlite. The current Rust runtime now covers:
- `POST /api/events`, `POST /api/events/batch` — ingest with dedup and batch rejection
- `GET /api/stats`, `GET /api/stats/tools`, `GET /api/stats/cost`, `GET /api/stats/usage-monitor` — aggregate counters, analytics, and provider-quota compatibility reads
- `GET /api/provider-quotas`, `POST /api/provider-quotas/:provider`, `POST /api/provider-quotas/claude/statusline` — provider-native quota snapshot ingest/read endpoints
- `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/transcript`, `GET /api/filter-options`
- `POST /api/otel/v1/logs`, `/api/otel/v1/metrics`, `/api/otel/v1/traces`
- `GET /api/stream` — SSE fan-out via tokio::broadcast
- `GET /api/health` — service health with SSE client count
- Import pipeline + runtime auto-import scheduling parity
- Pricing auto-cost parity on ingest
- historical `/api/v2` parity for sessions, activity, pins, search sorting/context, advanced analytics, usage, and insights

Runs on port 3142 by default. Current verification includes the full Rust test suite, route/query integration coverage for the new `/api/v2` families, and shared parity tests over the historical `/api/v2` contract.
The Rust runtime remains an alternate runtime under evaluation rather than the default server. TypeScript on port 3141 is still the canonical runtime until the rollout decision changes.

Guardrail coverage for the Rust runtime host remains:
- `rust-backend/tests/runtime_invariants.rs` validates dedup persistence, session lifecycle transitions, and SSE delivery/client-count invariants.

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
- `model-classification.ts` maps raw model names to provider, family, provider-neutral tier, lifecycle, and pricing-status metadata for v2 usage reporting.
- Cost computed from `tokens_in`, `tokens_out`, `cache_read_tokens`, `cache_write_tokens`.
- **Token-bucket invariant**: `tokens_in` is the uncached (full-rate) prompt portion and `cache_read_tokens` the cached portion — additive, never overlapping. Anthropic reports `input_tokens` already net, but OpenAI/Codex report it cache-inclusive (cached is a subset), so the Codex importer (`src/import/codex.ts`) and the OTEL log-record path (`src/otel/parser.ts`) subtract the cached count before storing `tokens_in`. Violating this double-bills the cached bulk at the full input rate (~10x), the cause of historically inflated Codex/gpt-5.x spend.
- Historical rows predating that fix are repaired once by the `user_version`-guarded data migration in `src/db/schema.ts` (`runDataMigrations` → `backfillCacheInclusiveInputTokens`), which re-normalizes OpenAI/Google `tokens_in` and recomputes `cost_usd` atomically on next startup.
- The Rust runtime mirrors all of the above: `rust-backend/src/importer.rs`, `rust-backend/src/otel/parser.rs`, and the `user_version`-guarded `run_data_migrations` in `rust-backend/src/db/schema.rs` (provider lookup via `pricing::resolve_provider`).
- Costs stored as `cost_usd` on each event row.
- V2 usage keeps stored `cost_usd` authoritative. Cache hit rate, estimated cache savings, classification filters, tier rollups, top-session enrichment, and prior-period deltas are derived at query time from filtered usage rows and current pricing metadata.
- Read-only usage budgets are evaluated from an optional local JSON config through the same v2 usage summary/filter path. They report alert states only; no hook enforcement or request blocking is implemented.
- Tier feedback is generated from usage summaries, model attribution, and top-session metadata only. It does not inspect private message content and returns advisory findings for human review rather than executable model changes.

## Import Pipeline

`src/import/` supports historical backfill:

- `claude-code.ts`: Parses Claude Code JSONL conversation logs.
- `codex.ts`: Parses Codex session JSON files.
- `import_state` tracks full-file hashes for completed imports, including files that produced zero events, so unchanged non-importable files are skipped on later full imports.
- Date-scoped imports intentionally do not update `import_state`, because they only represent a partial view of the file.
- Import discovery can exclude configured path patterns before hashing or parsing, so known junk subtrees never enter the historical backfill pipeline.
- `amon import` is the primary operator entrypoint. The older `pnpm run import` script remains a compatibility wrapper.

## Session Sync

`src/watcher/` maintains the v2 session browser from local JSONL history:

- Startup sync scans both `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`.
- Chokidar watches both roots for ongoing file additions and changes.
- The same exclude-pattern matcher is applied to discovery, watcher events, and periodic resync so ignored paths behave consistently.
- `watched_files` caches parsed, skipped, and error states by file hash so unchanged files are not reparsed on every periodic resync.
- Periodic resync still runs as a safety net for missed file-system events and now covers both Claude and Codex history roots.
- `amon sync sessions` is the primary manual resync entrypoint. The older reparse scripts remain compatibility wrappers.

## Trace Quality

A local, provider-neutral trace-quality layer projects existing sources
(`events`, `session_items`, `session_turns`, `messages`, `tool_calls`) into a
trace/observation graph with local scores, prompt attribution, and derived
findings. It is **additive**: source rows are never removed or reinterpreted, and
each projected row records provenance.

- **Projection:** `src/trace-quality/` holds projection mappers, source readers,
  the projection service, v2 queries, the score model, prompt attribution, and the
  findings engine. New data is projected incrementally on ingest/import;
  historical data is projected/rebuilt out of band via `amon quality backfill`.
  `scripts/backfill-trace-quality.ts` (`pnpm run trace-quality:backfill`) remains
  a compatibility wrapper.
  `trace_quality_projection_state` keeps backfill idempotent.
- **Honesty:** every trace carries a `coverage_json` flag set and aggregate reads
  carry read-coverage metadata, so summary-only telemetry (e.g. Codex OTEL) is
  never presented as full transcript fidelity. Observation `payload_policy`
  governs whether raw content, a hash, or only a summary is retained.
- **Read APIs:** the full surface is under `/api/v2/trace-quality/*` (handlers in
  `src/api/v2/router.ts`, SQL in `src/trace-quality/queries.ts` and
  `findings.ts`). Findings are read-only and computed from SQLite — no Prometheus
  or Grafana.
- **Export seam:** `trace_quality_export_state` and the `langfuse` export-provider
  enum exist as a seam for the optional, **deferred** Langfuse export adapter
  (spec Task 10). The chosen transport is the Langfuse ingestion API (batch);
  nothing leaves localhost until that adapter is built.

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
