# AgentStats: Post-MVP Adoption Roadmap

Phased plan for evolving AgentStats from its current MVP into a comprehensive local-first agent observability hub, informed by research analysis of the open-source ecosystem (AI Observer, CodexMonitor, claude-code-hooks-multi-agent-observability) and validated against the existing codebase.

**Design decisions captured:**
- OTLP format: JSON-only initially (protobuf deferred)
- Hook scripts: Ship both shell/curl (default) and Python (alternative)
- Cost calculation: Compute at ingestion time, store `cost_usd`; support recalculation CLI
- Historical import scope: Claude Code + Codex CLI

---

## Current State Assessment

### What the MVP Has
- HTTP ingest (`POST /api/events`, `POST /api/events/batch`) with contract validation
- SQLite (WAL mode) with `agents`, `sessions`, `events` tables
- SSE real-time broadcast with per-client filters, heartbeats, backpressure
- Web dashboard: agent cards, event feed, stats bar (vanilla JS + Tailwind)
- Event deduplication via optional `event_id`
- Payload truncation with priority-key preservation
- Session lifecycle management (active/idle/ended with auto-timeout)

### What the MVP Lacks (Gaps from Research)
1. No cost calculation or model awareness
2. No OTLP ingestion (Codex/Claude Code native telemetry can't reach us)
3. No hook scripts or integration templates (users must hand-roll POSTs)
4. Flat event type taxonomy (missing `file_change`, `llm_request`, `plan_step`, etc.)
5. No historical import from existing session logs
6. No filter-options endpoint for dashboard dropdowns
7. No session transcript or conversation reconstruction
8. Key fields (`model`, `cost_usd`, `cache_read_tokens`, `cache_write_tokens`) missing from schema

---

## Prerequisite Phase: Schema & Contract Evolution

**Why this comes first:** Phases 1-4 all need schema fields that don't exist yet. Adding them incrementally per-phase would create repeated migrations and contract churn. Better to land the structural changes once, preserving backward compatibility.

### P0-A: Schema additions (events table)

New columns with defaults (non-breaking migration):

```sql
ALTER TABLE events ADD COLUMN model TEXT;
ALTER TABLE events ADD COLUMN cost_usd REAL;
ALTER TABLE events ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE events ADD COLUMN cache_write_tokens INTEGER DEFAULT 0;
ALTER TABLE events ADD COLUMN source TEXT DEFAULT 'api';
  -- 'api' | 'hook' | 'otel' | 'import' — tracks how the event entered the system
```

New index:

```sql
CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);
```

**Implementation notes:**
- Follow the existing migration pattern in `schema.ts:57-68` (check column existence with `PRAGMA table_info`, add if missing).
- All new columns are nullable or have defaults — existing events are unaffected.
- The `source` column enables distinguishing hook-ingested events from OTLP-ingested events from historical imports in queries and dashboard filters.

### P0-B: Event contract expansion

Update `src/contracts/event-contract.ts`:

```
New optional fields on NormalizedIngestEvent:
  model?: string           -- "claude-sonnet-4-5-20250929", "o3-mini", etc.
  cost_usd?: number        -- pre-computed by client or server pricing engine
  cache_read_tokens?: number
  cache_write_tokens?: number
  source?: string          -- injected by the ingestion pathway, not client-supplied
```

Expand `event_type` enum:

```
Current:  'tool_use' | 'session_start' | 'session_end' | 'response' | 'error'
Proposed: 'tool_use' | 'session_start' | 'session_end' | 'response' | 'error'
        | 'llm_request' | 'llm_response' | 'file_change' | 'git_commit' | 'plan_step'
```

**Backward compatibility:** The CHECK constraint on `event_type` in the current schema (`schema.ts:34`) must be updated. Since SQLite doesn't support `ALTER TABLE ... ALTER CONSTRAINT`, the migration strategy is:
1. For new databases: create with the expanded CHECK.
2. For existing databases: drop the CHECK constraint by recreating the table (or simply remove the CHECK and rely on application-level validation, which already happens in `event-contract.ts`).

**Recommendation:** Remove the SQL-level CHECK on `event_type` entirely. The contract normalizer already enforces valid values, and SQL CHECKs prevent the schema from evolving without table recreation. Keep the CHECK on `status` (it's a stable, closed enum) and on `payload_truncated`.

### P0-C: Query layer updates

Update `src/db/queries.ts`:
- `insertEvent()`: accept and persist the new fields.
- `getStats()`: add `cost_usd` aggregation (`SUM(cost_usd)` as `total_cost_usd`).
- `getEvents()`: add `model` filter parameter.
- New function: `getFilterOptions()` — returns distinct values for dashboard dropdowns:
  ```ts
  function getFilterOptions(): {
    agent_types: string[];
    event_types: string[];
    tool_names: string[];
    models: string[];
    projects: string[];
    branches: string[];
  }
  ```

### P0-D: Stats contract update

Update the `Stats` interface in `queries.ts`:
```ts
export interface Stats {
  // ... existing fields ...
  total_cost_usd: number;
  model_breakdown: Record<string, number>; // model -> event count
}
```

Update `StatsBar` component and SSE stats broadcast to display cost.

### P0-E: Filter options API endpoint

New route: `GET /api/filter-options`
- Returns output of `getFilterOptions()`.
- Called once on dashboard load to populate filter dropdowns.
- Lightweight (6 `SELECT DISTINCT` queries, all indexed).

### Verification
- `pnpm run build` succeeds.
- Existing seed script still works (new fields are optional).
- `GET /api/stats` returns `total_cost_usd: 0` and `model_breakdown: {}` for legacy data.
- `GET /api/filter-options` returns populated arrays.

---

## Phase 1: Hook Scripts & Integration Templates

**Goal:** Ship drop-in scripts that connect Claude Code to AgentStats with zero custom code. This is the single highest-impact feature for adoption — it turns AgentStats from "a server you can POST to" into "a tool that works out of the box."

**Source reference:** Adapted from `disler/claude-code-hooks-multi-agent-observability` (MIT).

### 1.1: Shell hook scripts (primary)

Create `hooks/claude-code/` directory with:

```
hooks/
  claude-code/
    send_event.sh          -- shared POST helper (curl to localhost:3141)
    session_start.sh       -- maps SessionStart hook → session_start event
    session_end.sh         -- maps Stop hook → session_end event
    post_tool_use.sh       -- maps PostToolUse hook → tool_use event
    pre_tool_use.sh        -- maps PreToolUse hook → tool_use event (with blocking)
    notification.sh        -- maps Notification hook → response event
    install.sh             -- adds hooks to ~/.claude/settings.json
    uninstall.sh           -- removes hooks from settings
    README.md              -- setup instructions
```

**Hook data flow:**
```
Claude Code fires hook
  → pipes JSON to stdin (contains session_id, tool_name, tool_input, cwd)
  → shell script reads stdin with `cat`
  → script maps fields to AgentStats contract
  → `curl -s -X POST localhost:3141/api/events -H 'Content-Type: application/json' -d "$payload"` &
  → fire-and-forget (backgrounded, no blocking the agent)
```

**Field mapping (Claude Code hooks → AgentStats events):**

| Hook event | `event_type` | `tool_name` | `session_id` | `project` | Notes |
|---|---|---|---|---|---|
| `SessionStart` | `session_start` | — | from stdin `.session_id` | from stdin `.cwd` basename | |
| `Stop` | `session_end` | — | from stdin `.session_id` | from stdin `.cwd` basename | |
| `PostToolUse` | `tool_use` | from stdin `.tool_name` | from stdin `.session_id` | from stdin `.cwd` basename | duration_ms if available |
| `PreToolUse` | `tool_use` | from stdin `.tool_name` | from stdin `.session_id` | from stdin `.cwd` basename | optional safety blocking |
| `Notification` | `response` | — | from stdin `.session_id` | from stdin `.cwd` basename | |
| `SubagentStart` | `session_start` | — | generated sub-ID | from stdin `.cwd` basename | sets metadata.parent_session_id |
| `SubagentStop` | `session_end` | — | from sub-ID | from stdin `.cwd` basename | |

**Safety hooks (from disler's project):**

`pre_tool_use.sh` should include optional safety checks:
- Block `rm -rf /`, `rm -rf ~`, `rm -rf /etc` patterns in Bash tool args.
- Warn on `.env`, `.pem`, credential file reads (log a security event, don't block by default).
- Exit 0 = allow, exit non-zero = block.

### 1.2: Python hook scripts (alternative)

Create `hooks/claude-code/python/` with equivalent Python scripts. These are more readable and extensible for power users:

```
hooks/
  claude-code/
    python/
      send_event.py        -- shared POST helper (urllib or requests)
      session_start.py
      session_end.py
      post_tool_use.py
      pre_tool_use.py       -- includes safety blocking logic
      requirements.txt      -- empty (stdlib only) or minimal
```

The Python scripts should use only stdlib (`json`, `sys`, `urllib.request`, `subprocess`) to avoid dependency issues.

### 1.3: Install script

`hooks/claude-code/install.sh`:
- Reads `~/.claude/settings.json` (or creates it).
- Adds hook entries for `SessionStart`, `Stop`, `PostToolUse`, `PreToolUse`, `Notification`.
- Backs up the existing settings file before modifying.
- Supports `--python` flag to use Python scripts instead of shell.
- Supports `--url` flag to override the AgentStats endpoint (default: `http://127.0.0.1:3141`).
- Prints a summary of what was configured.

### 1.4: Codex CLI integration guide

Codex doesn't have a hooks system, so integration is via OTLP (Phase 2) or config file. For now, ship a `hooks/codex/README.md` explaining:
- How to configure `~/.codex/config.toml` to send OTLP to AgentStats (once Phase 2 lands).
- The `otel` section format required.

### Verification
- Run `install.sh` → `~/.claude/settings.json` has hook entries.
- Start AgentStats, start Claude Code in a project → events appear in dashboard.
- `pre_tool_use.sh` blocks a test `rm -rf /` command (exit non-zero).
- `uninstall.sh` cleanly removes hook entries.

---

## Phase 2: OTLP JSON Receiver

**Goal:** Accept native OpenTelemetry telemetry from Claude Code and Codex CLI without custom hook scripts. This is the second integration pathway — complementary to hooks, not a replacement.

**Source reference:** Adapted from AI Observer's OTLP ingestion layer (MIT).

### 2.1: OTLP endpoint routes

New routes on the existing Express server (no separate port — simpler for localhost):

```
POST /api/otel/v1/logs     -- OTLP logs (primary for Claude Code + Codex)
POST /api/otel/v1/metrics   -- OTLP metrics (token usage, cost counters)
POST /api/otel/v1/traces    -- OTLP traces (span data — lower priority)
```

**JSON-only initially.** The Content-Type check accepts `application/json`. Return 415 for `application/x-protobuf` with a message indicating protobuf support is planned.

### 2.2: OTLP log parser

Create `src/otel/parser.ts`:

The parser extracts AgentStats-compatible events from OTLP log records. Key attribute mappings:

**Claude Code OTel logs:**
| OTel attribute | AgentStats field |
|---|---|
| `gen_ai.session.id` or resource `session.id` | `session_id` |
| resource `service.name` = `"claude_code"` | `agent_type` |
| event name `claude_code.tool_result` | `event_type: "tool_use"` |
| event name `claude_code.api_request` | `event_type: "llm_request"` |
| `gen_ai.tool.name` | `tool_name` |
| `gen_ai.request.model` | `model` |
| `gen_ai.usage.input_tokens` | `tokens_in` |
| `gen_ai.usage.output_tokens` | `tokens_out` |
| body JSON | `metadata` |

**Codex OTel logs:**
| OTel attribute | AgentStats field |
|---|---|
| body `session_id` | `session_id` |
| resource `service.name` = `"codex_cli_rs"` | `agent_type: "codex"` |
| event name `codex.tool_result` | `event_type: "tool_use"` |
| event name `codex.api_request` | `event_type: "llm_request"` |
| body `tool_name` | `tool_name` |
| body `model` | `model` |
| body `input_tokens` | `tokens_in` |
| body `output_tokens` | `tokens_out` |

### 2.3: OTLP metric parser

Create metric extraction in `src/otel/parser.ts`:

Focus on these metric names:
- `claude_code.token.usage` → extract `type` attribute (input/output/cacheRead/cacheCreation), `model` attribute
- `claude_code.cost.usage` → extract USD cost value
- `codex_cli_rs.token.usage` → same pattern
- `codex_cli_rs.cost.usage` → same pattern

**Cumulative-to-delta conversion** (ported from AI Observer):
- Maintain an in-memory Map of `metricKey → lastValue` (keyed by metric name + service + model).
- On each ingestion: `delta = currentValue - lastValue`.
- Skip if delta ≤ 0 (counter reset).
- This map resets on server restart (acceptable — slight overcount on first metric after restart).

### 2.4: OTLP route handler

Create `src/api/otel.ts`:

```ts
// POST /api/otel/v1/logs
// 1. Parse OTLP JSON body (resourceLogs → scopeLogs → logRecords)
// 2. For each log record, call parser to extract NormalizedIngestEvent
// 3. Set source = 'otel' on each event
// 4. Call insertEvent() for each
// 5. Broadcast via SSE
// 6. Return OTLP-compliant empty response: {}

// POST /api/otel/v1/metrics
// 1. Parse OTLP JSON body (resourceMetrics → scopeMetrics → metrics)
// 2. For each data point, extract token/cost deltas
// 3. Update session aggregates (or emit synthetic events)
// 4. Return {}
```

Mount in `src/api/router.ts`:
```ts
apiRouter.use('/otel', otelRouter);
```

### 2.5: Integration documentation

Update `hooks/codex/README.md` with working config:

```toml
# ~/.codex/config.toml
[otel]
log_user_prompt = true
exporter = { otlp-http = { endpoint = "http://localhost:3141/api/otel/v1/logs", protocol = "json" } }
```

Add `hooks/claude-code/README.md` section for OTel mode:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3141/api/otel
```

### Prerequisites from the codebase
- The Express JSON body parser (`app.ts:16`) has a 1MB limit. OTLP payloads with verbose logs can exceed this. Increase to `5mb` for the `/api/otel` routes specifically, or add a route-specific middleware.
- Consider gzip decompression middleware for OTLP routes (agents may compress payloads). Use `express` built-in or a lightweight middleware.

### Verification
- Configure Claude Code OTel env vars → events appear in AgentStats.
- Configure Codex `config.toml` → events appear in AgentStats.
- `GET /api/events?source=otel` filters to OTel-ingested events.
- Metric data updates session token/cost aggregates.

---

## Phase 3: Pricing Engine & Cost Tracking

**Goal:** Calculate USD cost for every event that has a model + token counts, display cumulative cost per session and globally.

**Source reference:** Ported from AI Observer's pricing engine (MIT). Their JSON pricing data files and cost formulas are directly reusable.

### 3.1: Pricing data files

Create `src/pricing/` directory:

```
src/pricing/
  index.ts              -- PricingRegistry class, lookup, calculate
  data/
    claude.json         -- 13 models (from AI Observer, MIT)
    codex.json          -- 47 models (from AI Observer, MIT)
    gemini.json         -- 10 models (from AI Observer, MIT)
```

JSON structure (per AI Observer):
```json
{
  "provider": "anthropic",
  "lastUpdated": "2026-01-02T00:00:00Z",
  "models": {
    "claude-sonnet-4-5-20250929": {
      "aliases": ["claude-sonnet-4-5", "claude-sonnet-4-5-latest"],
      "inputCostPerMTok": 3,
      "outputCostPerMTok": 15,
      "cacheReadCostPerMTok": 0.3,
      "cacheWriteCostPerMTok": 3.75,
      "deprecated": false
    }
  }
}
```

### 3.2: PricingRegistry implementation

```ts
// src/pricing/index.ts

interface ModelPricing {
  inputCostPerToken: number;    // pre-divided by 1_000_000
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheWriteCostPerToken: number;
  deprecated: boolean;
}

class PricingRegistry {
  private models: Map<string, ModelPricing>;      // canonical name → pricing
  private aliases: Map<string, string>;            // alias → canonical name

  constructor() {
    // Load all three JSON files at init
    // Convert per-MTok to per-token (divide by 1_000_000)
    // Build alias map
  }

  lookup(model: string): ModelPricing | null {
    // Normalize: strip "anthropic/", "openai/" prefixes
    // Check canonical map, then alias map
  }

  calculate(model: string, tokens: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  }): number | null {
    const pricing = this.lookup(model);
    if (!pricing) return null;

    return (tokens.input * pricing.inputCostPerToken)
         + (tokens.output * pricing.outputCostPerToken)
         + ((tokens.cacheRead ?? 0) * pricing.cacheReadCostPerToken)
         + ((tokens.cacheWrite ?? 0) * pricing.cacheWriteCostPerToken);
  }
}

export const pricingRegistry = new PricingRegistry();
```

### 3.3: Integrate into ingestion pipeline

In `src/db/queries.ts` `insertEvent()`:

```ts
// After normalizing the event, before inserting:
if (event.model && (event.tokens_in > 0 || event.tokens_out > 0)) {
  if (event.cost_usd === undefined || event.cost_usd === null) {
    event.cost_usd = pricingRegistry.calculate(event.model, {
      input: event.tokens_in,
      output: event.tokens_out,
      cacheRead: event.cache_read_tokens,
      cacheWrite: event.cache_write_tokens,
    });
  }
}
```

Logic: if the client already provided `cost_usd` (e.g., from OTel `cost.usage` metric), respect it. Otherwise, calculate from tokens + model. This implements the "both — store + recalculate" design decision.

### 3.4: Recalculation CLI command

Add `scripts/recalculate-costs.ts`:

```ts
// Iterates all events with model != null and tokens > 0
// Recalculates cost_usd using current pricing data
// Updates in-place
// Useful when pricing JSON is updated or historical data lacks costs
```

Add script to `package.json`:
```json
"recalculate-costs": "tsx scripts/recalculate-costs.ts"
```

### 3.5: Dashboard cost display

Update `StatsBar` to show total cost:
```
Events: 1,547  Sessions: 3  Cost: $4.23  Tokens: 245K in / 890K out
```

Update `AgentCards` to show per-session cost in the card header:
```
myapp / feature/auth
● Active · 47 events · $1.82 · 12m
```

### 3.6: Pricing data maintenance

The JSON files should be treated as data, not code. To update:
1. Edit the JSON files manually when new models are announced.
2. Or: add a `scripts/fetch-pricing.ts` that scrapes provider pricing pages (AI Observer has a `claude_fetcher.go` — the approach is portable but fragile, so keep it as a dev tool, not a runtime feature).

### Verification
- Seed script with `model: "claude-sonnet-4-5-20250929"` → events have `cost_usd` populated.
- `GET /api/stats` returns `total_cost_usd` > 0.
- `pnpm run recalculate-costs` updates historical events.
- Dashboard shows cost in stats bar and agent cards.

---

## Phase 4: Historical Import

**Goal:** Backfill AgentStats from existing Claude Code and Codex session logs, so users get immediate value from historical data.

**Source reference:** Adapted from AI Observer's import command (MIT).

### 4.1: Claude Code log parser

Create `src/import/claude-code.ts`:

Claude Code stores session logs at:
```
~/.claude/projects/<encoded-directory>/<session-uuid>.jsonl
```

Each line is a typed JSON object with fields like:
- `type`: `"user"`, `"assistant"`, `"tool_use"`, `"tool_result"`
- `costUSD`: cumulative cost
- `usage`: `{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }`
- `model`: model ID string
- `sessionId`: session identifier
- `timestamp`: ISO timestamp

Session index at `~/.claude/projects/<dir>/sessions-index.json`.
Global history at `~/.claude/history.jsonl`.

**Parser logic:**
1. Discover all `.jsonl` files matching the path pattern.
2. For each file, parse line-by-line.
3. Map `tool_use` lines → `event_type: "tool_use"` with tool name from `name` field.
4. Map `tool_result` lines → update the preceding tool_use event with duration/status.
5. Map `assistant` lines → `event_type: "response"`.
6. Extract `model`, token counts, cost from `usage` block.
7. Generate deterministic `event_id` from `sessionId + line number` (for dedup on re-import).
8. Set `source = "import"` on all events.

### 4.2: Codex CLI log parser

Create `src/import/codex.ts`:

Codex stores sessions at:
```
~/.codex/sessions/YYYY/MM/DD/<session-id>.jsonl
```

Each line contains structured JSON-RPC-style events. Parse for:
- `tool/execution` → `event_type: "tool_use"`
- `file/diff` → `event_type: "file_change"`
- Token usage updates → aggregate per-turn

### 4.3: Import state tracking

Add table (or use `import_state` concept from AI Observer):

```sql
CREATE TABLE IF NOT EXISTS import_state (
  source TEXT NOT NULL,         -- 'claude_code' | 'codex'
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,      -- SHA-256 of file contents
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  record_count INTEGER DEFAULT 0,
  PRIMARY KEY (source, file_path)
);
```

On re-import: check if file_hash changed. If unchanged, skip. If changed, re-import (dedup via `event_id` prevents duplicates).

### 4.4: Import CLI

Create `scripts/import.ts`:

```bash
# Import Claude Code sessions from last 30 days
pnpm run import -- --source claude-code --from 2026-01-18

# Import Codex sessions
pnpm run import -- --source codex --from 2026-01-01

# Import all sources
pnpm run import -- --source all

# Dry run (show what would be imported)
pnpm run import -- --source all --dry-run
```

**Flags:**
- `--source`: `claude-code`, `codex`, `all`
- `--from`: ISO date, only import sessions after this date
- `--to`: ISO date, only import sessions before this date
- `--dry-run`: show file count and estimated event count without importing
- `--force`: re-import even if file hash matches

### 4.5: Import progress output

The import script should print progress:

```
Scanning ~/.claude/projects/ ...
Found 47 session files (31 new, 16 unchanged)

Importing: [====================] 31/31 sessions
  Events: 2,847 inserted, 0 duplicates
  Cost: $47.82 (calculated from token usage)

Done. Run `pnpm start` to see historical data in the dashboard.
```

### Verification
- Import Claude Code sessions → events appear with `source: "import"`.
- Import Codex sessions → events appear.
- Re-run import → 0 new events (dedup works).
- `--dry-run` prints counts without inserting.
- Dashboard shows historical sessions with cost data.

---

## Phase 5: Dashboard Enhancements

**Goal:** Leverage the richer data from Phases 1-4 to build a more useful dashboard.

### 5.1: Filter bar

Add a filter bar above the event feed with dropdowns populated from `GET /api/filter-options`:
- Agent type (Claude Code, Codex, etc.)
- Event type (tool_use, llm_request, etc.)
- Tool name (Bash, Edit, Read, etc.)
- Project
- Branch
- Time range (last 1h, 6h, 24h, 7d, custom)

Filters apply to both the event feed and the stats bar. SSE stream filters update to match.

### 5.2: Cost dashboard section

New dashboard section below agent cards (or as a togglable tab):
- **Total spend**: large number, today + all-time
- **Spend by session**: bar chart (horizontal bars, per-session)
- **Spend by model**: pie/donut chart
- **Spend over time**: simple time-series (requires bucketing events by hour/day)

Implementation: pure vanilla JS with CSS-based charts (no charting library). Horizontal bars are trivially done with `width: ${percentage}%` divs. Time-series can use a simple SVG polyline.

### 5.3: Session detail view

Clicking an agent card opens a full session detail panel (slide-over or new section):
- Full event timeline for that session
- Token usage breakdown (input/output/cache)
- Cost breakdown by model
- Tool usage distribution
- Duration timeline (which tools took longest)

Data source: `GET /api/sessions/:id` (already exists, may need richer event data).

### 5.4: Tool analytics

New `GET /api/stats/tools` endpoint:
- Tool call frequency (already in stats, but add time-series)
- Tool error rate (errors / total per tool)
- Average duration per tool
- Tool usage by agent type

### 5.5: Responsive layout improvements

- Collapse agent cards to a compact list on narrow viewports.
- Make the event feed full-width on mobile.
- Add a "compact mode" toggle that reduces card size for users with 6+ sessions.

### Verification
- Filters work across all dashboard components.
- Cost section shows accurate per-session and per-model breakdowns.
- Session detail view shows complete event history.

---

## Phase 6: Session Transcripts & Conversation Replay

**Goal:** Reconstruct and display full agent conversations for post-hoc debugging.

**Source reference:** Adapted from AI Observer's session transcript feature (MIT).

### 6.1: Transcript reconstruction

Create `src/api/transcripts.ts`:

New endpoint: `GET /api/sessions/:id/transcript`

Reconstructs a conversation from events:
- `session_start` → session began
- `llm_request` / `response` → user/assistant messages
- `tool_use` → tool call with arguments and result
- `error` → error events
- `session_end` → session ended

Returns structured JSON:
```json
{
  "session_id": "...",
  "entries": [
    { "role": "system", "type": "session_start", "timestamp": "..." },
    { "role": "assistant", "type": "tool_use", "tool_name": "Read", "detail": "src/auth.ts", "timestamp": "..." },
    { "role": "assistant", "type": "response", "timestamp": "..." },
    ...
  ]
}
```

### 6.2: Transcript UI

New panel in the dashboard accessible from session detail view. Renders as a vertical timeline with:
- Tool calls shown as compact blocks (icon + name + key argument)
- Responses shown as message bubbles
- Errors highlighted in red
- Timestamps on the left margin

### 6.3: Data enrichment from imports

Historical imports (Phase 4) can include richer data from JSONL logs:
- Full assistant message text (if available and within payload limits)
- Tool input/output pairs
- Planning steps and reasoning traces

This makes transcripts most valuable for imported sessions where the full conversation history is available.

### Verification
- `GET /api/sessions/:id/transcript` returns ordered conversation entries.
- Transcript UI renders a readable session replay.
- Imported sessions have richer transcripts than hook-sourced sessions.

---

## Phase 7: Future Considerations (Unscheduled)

These are tracked but not planned for immediate implementation:

### 7.1: Protobuf OTLP support
Add `application/x-protobuf` support to the OTLP endpoints. Requires an npm protobuf library and the OTLP proto definitions. Unlocks agents that don't support JSON mode.

### 7.2: Gemini CLI support
Add Gemini CLI as a third agent type. Gemini has OTel support but sends all signals to `/` (root) — need the root-handler routing logic from AI Observer.

### 7.3: MCP server
Expose AgentStats data via Model Context Protocol so agents can query their own history. `GET /api/sessions` and `GET /api/events` already provide the data; wrapping them in MCP tool definitions is straightforward.

### 7.4: Anomaly detection
- Session cost exceeding a configurable threshold → SSE alert event
- Agent stuck in error loop (N consecutive errors) → alert
- Session duration exceeding threshold → alert

### 7.5: Data retention & export
- Configurable retention period (delete events older than N days)
- Export to Parquet for archival (via DuckDB's `sqlite_scanner` or a custom exporter)
- Export to Langfuse/Phoenix for richer visualization

### 7.6: Planning visibility
Parse Claude Code's `--output-format stream-json` for reasoning traces. Map `plan_step` events with `goal`, `plan_step`, `plan_index` fields. This is the hardest layer from the research but the most differentiating.

### 7.7: Process-level session discovery
Poll `ps aux | grep -E 'claude|codex'` every N seconds to auto-detect running agents without waiting for hook/OTLP events. Combined with tmux `list-panes` for richer context.

---

## Implementation Order & Dependencies

```
P0 (Prerequisite)
  P0-A: Schema additions ──┐
  P0-B: Contract expansion ─┤
  P0-C: Query updates ──────┤─── All are prerequisites for Phases 1-4
  P0-D: Stats update ───────┤
  P0-E: Filter options API ──┘

Phase 1: Hook Scripts ─────────── No code dependencies; can start immediately after P0
Phase 2: OTLP Receiver ───────── Depends on P0 (needs model, cost_usd, source columns)
Phase 3: Pricing Engine ──────── Depends on P0 (needs model, cost_usd columns)
                                  Enhances Phase 1 & 2 (auto-calculates cost on ingest)
Phase 4: Historical Import ────── Depends on P0 + Phase 3 (needs pricing for cost calc)
Phase 5: Dashboard Enhancements ─ Depends on P0-E (filter options), Phase 3 (cost data)
Phase 6: Session Transcripts ──── Depends on Phase 4 (richest data from imports)

Parallelizable:
  Phase 1 and Phase 2 can be built in parallel after P0.
  Phase 3 can be built in parallel with Phase 1.
  Phase 5 can start as soon as P0-E is done (filters), with cost features added when Phase 3 lands.
```

```
Timeline estimate (sequential):
  P0:      2-3 days
  Phase 1: 2-3 days
  Phase 2: 3-4 days
  Phase 3: 2-3 days
  Phase 4: 3-4 days
  Phase 5: 3-5 days
  Phase 6: 2-3 days

Timeline estimate (parallelized, 2 agents):
  P0:                    2-3 days
  Phase 1 + Phase 3:     3 days (parallel)
  Phase 2:               3-4 days
  Phase 4:               3-4 days
  Phase 5 + Phase 6:     4-5 days (parallel)
  Total:                 ~3 weeks
```

---

## Risk Register

| Risk | Mitigation |
|---|---|
| OTLP JSON format differences between Claude Code and Codex | Build separate parser branches per `service.name`; test with real telemetry from both agents |
| Claude Code hook stdin schema changes between versions | Pin to documented fields only; log unknown fields to metadata for forward compatibility |
| Pricing data goes stale as new models release | JSON data files are easy to update; `recalculate-costs` script handles retroactive fixes |
| SQLite performance with large historical imports | Batch inserts in transactions (1000 events per transaction); imports are one-time, not latency-sensitive |
| OTLP payload size exceeds Express JSON limit | Route-specific body size limit (5MB) for `/api/otel` routes |
| Cumulative-to-delta conversion loses data on server restart | Acceptable — first metric batch after restart may overcount; document this behavior |

---

## Open Questions (Resolved)

| Question | Decision |
|---|---|
| OTLP format support | JSON-only initially; protobuf deferred to Phase 7 |
| Hook script language | Ship both shell (default) and Python (alternative) |
| Cost calculation timing | At ingestion (stored); with recalculate CLI for corrections |
| Historical import scope | Claude Code + Codex in Phase 4; Gemini deferred to Phase 7 |
| SQL CHECK constraint on event_type | Remove from SQL; enforce in application contract layer only |
