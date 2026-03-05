---
date: 2026-03-05
topic: context-window-tracking
stage: implementation-plan
status: draft
source: conversation
---

# Context Window Tracking Implementation Plan

## Goal

Surface real-time and historical context window usage (% remaining) for both Claude Code and Codex sessions on the agentmonitor dashboard, enabling users to see at a glance how close each session is to its context limit.

## Scope

### In Scope

- Schema additions to store context window data per session.
- Live ingestion of context window data from Claude Code (status line hook) and Codex (OTEL/JSONL).
- Historical import of context window data from session logs (both agents).
- Dashboard display of context % remaining on session cards.
- SSE broadcast of context updates to live clients.

### Out of Scope

- Rate limit quota tracking (Codex `rate_limits.primary.used_percent`) — separate feature.
- PR link ingestion (`pr-link` events from Claude Code JSONL) — separate feature.
- Rust backend parity for context tracking — deferred to next migration phase.
- Fixing Claude Code's cumulative `used_percentage` bug upstream.

## Background Research

### Data Sources Discovered

| Agent | Source | Data Available | Realtime? |
|-------|--------|---------------|-----------|
| **Codex** | JSONL `token_count` events | `last_token_usage`, `model_context_window` (258,400 for GPT-5.3) | No (file-based) |
| **Codex** | OTEL `codex.sse_event` | Per-turn `input_token_count`, `output_token_count` — no `model_context_window` | Yes |
| **Claude Code** | Debug log `autocompact:` lines | `tokens`, `effectiveWindow` (180,000 for opus 4.6), `threshold` | No (file-based) |
| **Claude Code** | Status line JSON | `context_window.used_percentage`, `remaining_percentage`, `context_window_size`, `current_usage.*` | Yes (per-turn) |
| **Claude Code** | JSONL `assistant.usage` | Per-turn `input_tokens`, `cache_*` — no context window size | No (file-based) |
| **Claude Code** | JSONL `compact_boundary` | `preTokens`, `trigger` (auto/manual) | No (file-based) |

### Known Issues

- **Claude Code `used_percentage` is cumulative, not current** ([#13783](https://github.com/anthropics/claude-code/issues/13783)): The status line's `used_percentage` uses session-cumulative token totals, not actual context window contents. After compaction, it doesn't reset, so it drifts above 100% in long sessions.
- **Codex OTEL lacks `model_context_window`** ([#12913](https://github.com/openai/codex/issues/12913)): The OTEL metrics pipeline doesn't emit context window size.

### Codex Context % Formula (from source)

```
BASELINE_TOKENS = 12,000
effective_window = model_context_window - BASELINE_TOKENS
used = last_token_usage.total_tokens - last_token_usage.reasoning_output_tokens
remaining = effective_window - used
percent_left = (remaining * 100) / effective_window
```

Uses `last_token_usage` (current turn), not `total_token_usage` (cumulative).

### Claude Code Context % Formula (from debug log)

```
percent_used = tokens / effectiveWindow * 100
percent_left = 100 - percent_used
```

Where `tokens` and `effectiveWindow` come from `autocompact:` debug lines.

## Assumptions And Constraints

- The status line approach for Claude Code is the simplest live path but inherits the cumulative bug. We must work around this by using `current_usage.input_tokens + cache_creation_input_tokens + cache_read_input_tokens` as the actual context fill, and `context_window_size` as the denominator — recomputing the percentage ourselves rather than trusting `used_percentage`.
- Model context window sizes can be hardcoded as a fallback lookup table (180k for claude-opus-4-6, 200k for claude-sonnet-4-6, 258,400 for gpt-5.3-codex) when the source doesn't provide it directly.
- The Codex JSONL `token_count` event fires after every API turn (102 events in a single session), providing granular historical data.
- The Claude Code debug log fires `autocompact:` after every turn, but parsing debug logs is fragile and couples to an internal format.
- Sessions table `metadata` column (JSON) is the natural place to store context state without schema migration.

## Approach Options Analysis

### Option A: Session metadata column (JSON, no schema migration)

Store context window state in the existing `sessions.metadata` JSON column:

```json
{
  "context_window_size": 200000,
  "context_tokens_used": 73879,
  "context_pct_remaining": 63,
  "context_updated_at": "2026-03-05T04:00:00Z"
}
```

**Pros**: No ALTER TABLE, backward compatible, works today.
**Cons**: Can't index or query efficiently, JSON extraction in SQL is slower.

### Option B: Dedicated columns on `sessions` table

Add `context_window_size INTEGER`, `context_tokens_used INTEGER`, `context_pct_remaining REAL`, `context_updated_at TEXT` columns.

**Pros**: Clean queries, indexable, type-safe.
**Cons**: Requires ALTER TABLE migration (trivial in SQLite — just `ADD COLUMN`), Rust backend needs matching migration later.

### Option C: Separate `context_snapshots` table

A time-series table: `(session_id, timestamp, tokens_used, window_size, pct_remaining)`.

**Pros**: Full history of context usage over time, enables sparkline/chart UI.
**Cons**: More storage, more complex queries for "current state", overkill if we just want current %.

### Recommendation: Option B (columns) + Option A (metadata for extras)

Use dedicated session columns for the hot-path data the dashboard needs (current context %), and stash supplementary data (compact events, turn durations) in event metadata. This gives us clean SQL for the dashboard query without overcomplicating the schema. If sparkline history is desired later, we can add Option C as an additive layer.

## Ingestion Strategy Options

### For Claude Code (Live)

| Strategy | Mechanism | Accuracy | Complexity |
|----------|-----------|----------|------------|
| **CL-1: Status line script** | Status line script POSTs to `/api/events` after each turn | Medium (cumulative bug, but we recompute) | Low |
| **CL-2: Debug log watcher** | File watcher tails `~/.claude/debug/<session>.txt` for `autocompact:` lines | High (actual current tokens) | High (separate watcher process, fragile format) |
| **CL-3: PostToolUse hook enrichment** | Extend existing `post_tool_use.sh` to include context data | N/A — hooks don't receive context_window data | Not viable |

**Recommendation: CL-1 (status line)** with self-computed percentage. The status line receives `context_window.current_usage` (actual last-turn tokens) and `context_window_size`, which is enough to compute an accurate fill percentage without the cumulative bug. The recomputed formula is:

```
actual_used = current_usage.input_tokens + current_usage.cache_creation_input_tokens + current_usage.cache_read_input_tokens
pct_remaining = max(0, (context_window_size - actual_used) / context_window_size * 100)
```

This is accurate for the current turn but doesn't account for output tokens still in context. It's the best available without debug log parsing.

**Fallback consideration**: CL-2 (debug log watcher) is the most accurate option but fragile. Could be offered as an opt-in "precision mode" later.

### For Codex (Live)

| Strategy | Mechanism | Accuracy | Complexity |
|----------|-----------|----------|------------|
| **CDX-1: Unstop `codex.sse_event` in OTEL parser** | Stop skipping `codex.sse_event`, extract token counts per turn | Low (no `model_context_window` in OTEL) | Low |
| **CDX-2: JSONL watcher** | Tail active `~/.codex/sessions/**/*.jsonl` for `token_count` events | High (has `model_context_window` + `last_token_usage`) | Medium (file watcher, active session detection) |
| **CDX-3: Codex status line** | Codex has `features.runtime_metrics` config for TUI status — but no external hook API like Claude Code | N/A | Not viable (TUI-internal only) |

**Recommendation: CDX-2 (JSONL watcher)** for live sessions. The `token_count` event has everything needed. The watcher can be a lightweight interval that checks for new lines in active session files.

**Fallback for import**: Already have the JSONL importer reading `token_count` events — just need to extract `model_context_window` and `last_token_usage` alongside the existing token delta logic.

### For Historical Import (Both Agents)

| Strategy | Agent | Source | Notes |
|----------|-------|--------|-------|
| Extend Codex JSONL importer | Codex | `token_count` events | `model_context_window` already in type definition, just not extracted |
| Extend Claude Code JSONL importer | Claude Code | `assistant.usage` + per-model lookup | No `effectiveWindow` in JSONL; use hardcoded model table |
| Parse Claude Code debug logs | Claude Code | `~/.claude/debug/*.txt` | Most accurate but separate file, fragile format |
| Ingest `compact_boundary` events | Claude Code | JSONL system events | Gives compaction points, not continuous fill |

**Recommendation**: Extend both JSONL importers to extract context data. For Claude Code, use per-model window lookup since the JSONL doesn't contain window size. For Codex, extract the already-typed `model_context_window` field.

## Task Breakdown

### Task 1: Add context window columns to sessions schema

**Objective**

Add columns to the `sessions` table to store current context window state. Use the same backward-compatible `ALTER TABLE ADD COLUMN` pattern already established in `schema.ts`.

**Files**

- Modify: `src/db/schema.ts`

**Dependencies**

None

**Implementation Steps**

1. Add four new columns to the `sessions` CREATE TABLE statement (for fresh databases): `context_window_size INTEGER`, `context_tokens_used INTEGER`, `context_pct_remaining REAL`, `context_updated_at TEXT`.
2. Add backward-compatible ALTER TABLE migrations in the existing column-check pattern:
   ```typescript
   const sessionColumns = new Set<string>(
     (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(col => col.name)
   );
   if (!sessionColumns.has('context_window_size')) {
     db.exec('ALTER TABLE sessions ADD COLUMN context_window_size INTEGER');
   }
   // ... same for the other three columns
   ```
3. Add an index on `context_pct_remaining` for sessions with low remaining context (useful for dashboard alerts).

**Verification**

- Run: `pnpm build`
- Expect: clean compile, no errors.
- Run: start dev server, confirm `GET /api/health` returns 200 and database initializes with new columns.

**Done When**

- Fresh database has all four new columns on `sessions`.
- Existing database auto-migrates to add the columns.

---

### Task 2: Add context update query functions

**Objective**

Add database query functions to update and read context window state on sessions.

**Files**

- Modify: `src/db/queries.ts`

**Dependencies**

Task 1

**Implementation Steps**

1. Add `updateSessionContext(sessionId: string, windowSize: number, tokensUsed: number, pctRemaining: number): void` — updates the four context columns on the session row.
2. Modify existing session query functions (used by `/api/events` and the stats endpoint) to include the context columns in their SELECT output so the dashboard can render them.
3. Add a helper `getSessionContext(sessionId: string)` that returns `{ context_window_size, context_tokens_used, context_pct_remaining, context_updated_at } | null`.

**Verification**

- Run: `pnpm build`
- Expect: clean compile.

**Done When**

- `updateSessionContext` writes all four columns.
- Session list queries include context fields in their response.

---

### Task 3: Add `context_update` event type and API handling

**Objective**

Create a new `context_update` event type that ingestion endpoints can accept, and wire it to update the session's context state.

**Files**

- Modify: `src/contracts/event-contract.ts` — add `'context_update'` to `EVENT_TYPES`.
- Modify: `src/api/events.ts` (or wherever the POST handler is) — on `context_update` events, call `updateSessionContext`.
- Modify: `src/sse/emitter.ts` — broadcast `session_update` with context data when context changes.

**Dependencies**

Task 2

**Implementation Steps**

1. Add `'context_update'` to the `EVENT_TYPES` array in `event-contract.ts`.
2. In the event ingestion handler, after inserting a `context_update` event, extract `context_window_size`, `context_tokens_used`, and `context_pct_remaining` from the event's metadata and call `updateSessionContext`.
3. Broadcast a `session_update` SSE event with the context state so live dashboard clients can update without polling.

**Verification**

- Run: `pnpm build`
- Expect: clean compile.
- Run: `curl -X POST http://127.0.0.1:3141/api/events -H 'Content-Type: application/json' -d '{"session_id":"test","agent_type":"claude_code","event_type":"context_update","metadata":{"context_window_size":200000,"context_tokens_used":80000,"context_pct_remaining":60}}'`
- Expect: 201 response, session row updated with context fields.

**Done When**

- `context_update` events are accepted by the API.
- Session context columns are updated on ingest.
- SSE broadcasts context changes to live clients.

---

### Task 4: Model context window lookup table

**Objective**

Create a lookup table mapping model IDs to their effective context window sizes. This is needed for Claude Code (where the JSONL doesn't include window size) and as a fallback for Codex.

**Files**

- Create: `src/pricing/context-windows.ts`

**Dependencies**

None

**Implementation Steps**

1. Create a simple `Record<string, number>` mapping model ID patterns to effective context window sizes:
   ```typescript
   const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
     'claude-opus-4-6': 180_000,
     'claude-opus-4-5': 180_000,
     'claude-sonnet-4-6': 200_000,
     'claude-sonnet-4-5': 200_000,
     'claude-haiku-4-5': 200_000,
     'gpt-5.3-codex': 258_400,
     'gpt-5-codex': 258_400,
     'o4-mini': 200_000,
   };
   ```
2. Export a `getModelContextWindow(model: string): number | undefined` function that does prefix matching (e.g., `claude-opus-4-6-20251101` matches `claude-opus-4-6`).
3. Keep the file small and focused — this is a data file, not a service.

**Verification**

- Run: `pnpm build`
- Expect: clean compile.

**Done When**

- `getModelContextWindow('claude-opus-4-6')` returns `180_000`.
- Unknown models return `undefined`.

---

### Task 5: Claude Code status line integration script

**Objective**

Create a status line script that displays context % to the user AND posts context data to agentmonitor in real-time. This is the live ingestion path for Claude Code.

**Files**

- Create: `hooks/claude-code/statusline.sh`
- Modify: `hooks/claude-code/README.md` — document the status line setup.

**Dependencies**

Task 3

**Implementation Steps**

1. Create `statusline.sh` that:
   - Reads JSON from stdin (Claude Code status line contract).
   - Extracts `context_window.current_usage`, `context_window.context_window_size`, and `session_id`.
   - Computes actual context fill: `used = current_usage.input_tokens + current_usage.cache_creation_input_tokens + current_usage.cache_read_input_tokens`.
   - Computes `pct_remaining = max(0, (window_size - used) / window_size * 100)`.
   - Prints a display line for the user (e.g., `[Opus] 63% left | $0.42`).
   - Fire-and-forget POSTs a `context_update` event to agentmonitor.
2. Make the display output configurable via environment variables (optional: `AGENTMONITOR_STATUSLINE_FORMAT`).
3. Ensure the curl POST is backgrounded and doesn't block the status line response.

**Verification**

- Run: `echo '{"session_id":"test","context_window":{"context_window_size":200000,"current_usage":{"input_tokens":80000,"cache_creation_input_tokens":5000,"cache_read_input_tokens":2000},"used_percentage":43},"model":{"display_name":"Opus"},"cost":{"total_cost_usd":0.42}}' | bash hooks/claude-code/statusline.sh`
- Expect: prints formatted status line, context POST sent to agentmonitor.

**Done When**

- Status line script computes and displays context %.
- Context data is POSTed to agentmonitor on every turn.
- README documents how to enable the status line.

---

### Task 6: Codex JSONL watcher for live context updates

**Objective**

Add a lightweight file watcher that tails active Codex session JSONL files for `token_count` events and posts context updates to agentmonitor.

**Files**

- Create: `hooks/codex/context-watcher.ts` (or `.sh`)
- Modify: `hooks/codex/README.md`

**Dependencies**

Task 3

**Implementation Steps**

1. The watcher script:
   - Discovers the active Codex session file by finding the most recently modified JSONL in `~/.codex/sessions/YYYY/MM/DD/`.
   - Tails new lines (using `fs.watch` + read offset, or a simple poll loop).
   - Parses `token_count` events with `payload.info.model_context_window` and `payload.info.last_token_usage`.
   - Computes `pct_remaining` using the Codex formula (with 12,000 baseline).
   - POSTs `context_update` to agentmonitor.
2. Keep it as a standalone script that can be run alongside the monitor (`pnpm codex:context-watch` or similar).
3. Handle session rollover (new file appears) by re-scanning the directory.

**Verification**

- Run: start the watcher, then run a Codex session.
- Expect: context updates appear in agentmonitor sessions within seconds of each Codex turn.

**Done When**

- Watcher detects new `token_count` events in active Codex sessions.
- Context updates POST to agentmonitor correctly.
- Session file rollover is handled.

---

### Task 7: Extend Codex JSONL importer for context data

**Objective**

Extend the existing Codex historical importer to extract `model_context_window` and compute final context state per session.

**Files**

- Modify: `src/import/codex.ts`

**Dependencies**

Task 2, Task 4

**Implementation Steps**

1. In the `token_count` event parsing block (around line 183), also extract:
   - `payload.info.model_context_window`
   - `payload.info.last_token_usage.total_tokens`
   - `payload.info.last_token_usage.reasoning_output_tokens`
2. Track the latest `model_context_window` and last-turn tokens per session.
3. After processing all events for a session, call `updateSessionContext` with the final context state.
4. Optionally emit a `context_update` event for the last known state.

**Verification**

- Run: `pnpm run import --source codex --force` on a session with known context usage.
- Expect: session row has `context_window_size = 258400`, `context_tokens_used` and `context_pct_remaining` populated.
- Run: `sqlite3 data/agentmonitor.db "SELECT id, context_window_size, context_tokens_used, context_pct_remaining FROM sessions WHERE agent_type = 'codex' LIMIT 5"`
- Expect: non-null values for imported Codex sessions.

**Done When**

- Codex import populates context columns on sessions.
- Values match manual calculation from raw JSONL.

---

### Task 8: Extend Claude Code JSONL importer for context data

**Objective**

Extend the Claude Code historical importer to compute context state from per-turn token usage and model window lookup.

**Files**

- Modify: `src/import/claude-code.ts`

**Dependencies**

Task 2, Task 4

**Implementation Steps**

1. When processing `assistant` type lines, extract `message.usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`.
2. Track the latest turn's total input tokens as `context_tokens_used = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
3. Look up `context_window_size` from the model context window table (Task 4) using the session's model.
4. After processing all lines, call `updateSessionContext` with the final context state.
5. Also parse `compact_boundary` system events — store `preTokens` and `trigger` in event metadata as a `context_update` event with `tool_name = 'compact'`.

**Verification**

- Run: `pnpm run import --source claude --force` on a session with known token usage.
- Expect: session row has context columns populated.
- Run: check a session that had auto-compaction — should have `context_update` events with compact metadata.

**Done When**

- Claude Code import populates context columns.
- Compact events are ingested with `preTokens` data.

---

### Task 9: Dashboard context display on session cards

**Objective**

Show context % remaining on each active session card in the dashboard UI.

**Files**

- Modify: `public/js/components/agent-cards.js`
- Modify: `public/js/sse-client.js` — handle context updates via SSE.
- Modify: `public/css/` or Tailwind classes — styling for context indicator.

**Dependencies**

Task 3 (API returns context data), Task 5 or 6 (live data flowing)

**Implementation Steps**

1. In the session card rendering, add a context bar or percentage indicator:
   - If `context_pct_remaining` is available, show a small progress bar (green > 50%, yellow 20-50%, red < 20%).
   - If null/undefined, show nothing (graceful degradation for sessions without context data).
2. On `session_update` SSE events containing context data, update the relevant session card without full reload.
3. Keep the display compact — a small bar or `63% ctx` label beneath the session status badge.

**Verification**

- Run: `pnpm dev` + `pnpm css:watch`, seed a session with context data.
- Expect: session card shows context bar with correct color coding.
- Run: send a `context_update` event via curl while dashboard is open.
- Expect: card updates in real-time without page reload.

**Done When**

- Context % is visible on session cards when data is available.
- Color coding reflects urgency (red when low).
- Real-time updates work via SSE.

## Risks And Mitigations

- **Risk**: Claude Code status line `used_percentage` is cumulative and breaks after compaction.
  **Mitigation**: Recompute percentage from `current_usage.*` tokens and `context_window_size` ourselves. Don't trust the pre-calculated field.

- **Risk**: Codex JSONL watcher adds a long-running process dependency.
  **Mitigation**: Make it optional (`pnpm codex:context-watch`). The historical importer still captures context data retroactively. The watcher is a nice-to-have for live display.

- **Risk**: Model context window sizes change with new model versions.
  **Mitigation**: The lookup table is a simple JSON-like structure. When sources provide `model_context_window` directly (Codex JSONL, Claude Code debug log), prefer that over the lookup. The table is a fallback only.

- **Risk**: Status line script adds latency to Claude Code turns.
  **Mitigation**: Background the curl POST (`&`). Status line scripts have a 300ms debounce and are non-blocking by design.

- **Risk**: Schema migration breaks existing databases.
  **Mitigation**: `ALTER TABLE ADD COLUMN` with nullable defaults is the safest SQLite migration. All existing rows get NULL for the new columns, which the dashboard handles gracefully.

- **Risk**: Debug log format for `autocompact:` could change without notice.
  **Mitigation**: We're NOT parsing debug logs in the recommended approach. If we add it later as "precision mode," treat it as best-effort with a try/catch.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Schema migration works | `pnpm build && pnpm dev` then `sqlite3 data/agentmonitor.db "PRAGMA table_info(sessions)"` | New columns present |
| Context update API works | `curl -X POST .../api/events -d '{"session_id":"test","agent_type":"claude_code","event_type":"context_update","metadata":{"context_window_size":200000,"context_tokens_used":80000,"context_pct_remaining":60}}'` | 201 response, session updated |
| Status line script computes % | `echo '<json>' \| bash hooks/claude-code/statusline.sh` | Correct percentage displayed |
| Codex import captures context | `pnpm run import --source codex --force` then query sessions | Non-null context columns |
| Claude Code import captures context | `pnpm run import --source claude --force` then query sessions | Non-null context columns |
| Dashboard shows context bar | Open dashboard with seeded session | Visual context indicator on card |
| SSE live update works | POST context_update while dashboard open | Card updates without reload |
| `pnpm build` passes | `pnpm build` | Exit code 0 |
| CSS builds | `pnpm css:build` | Exit code 0 |

## Recommended Execution Order

**Phase 1 — Foundation (Tasks 1-4)**: Schema, queries, API contract, model lookup. No external dependencies. Enables everything else.

**Phase 2 — Live Ingestion (Tasks 5-6)**: Status line script for Claude Code, JSONL watcher for Codex. These are independent and can be worked in parallel.

**Phase 3 — Historical Import (Tasks 7-8)**: Extend both importers. These backfill context data for existing sessions. Independent of each other.

**Phase 4 — Dashboard (Task 9)**: UI display. Depends on Phase 1 (data available) but can start as soon as Task 3 is done with manually-seeded data.

## Handoff

1. Execute in this session, task by task.
2. Open a separate execution session.
3. Refine this plan before implementation.
