---
date: 2026-03-06
topic: agentsview-integration
stage: plan
---

# AgentsView Integration into AgentMonitor

## What We Are Building

Evolving agentmonitor from a real-time event dashboard into a comprehensive agent activity platform with two modes:
1. **Monitor** - live real-time dashboard (existing functionality)
2. **Sessions/Search/Analytics** - historical session browsing, full-text search, and rich analytics (inspired by wesm/agentsview)

The result is a unified localhost tool for both watching agents work in real-time AND reviewing/analyzing past sessions.

## Why This Direction

- agentsview validated session browsing + message viewing + FTS search as highly valuable for agent workflows
- agentmonitor already has strong real-time monitoring, cost tracking, and multi-agent support
- Combining both creates a platform neither project achieves alone
- Staying on Node.js/TypeScript keeps the stack unified and avoids Go dependency

## Key Decisions

- **Dual-table data model**: Keep existing `events` table for real-time monitoring. Add new `messages` and `tool_calls` tables for session browsing. Different shapes serve different access patterns cleanly.
- **Hybrid ingestion**: File-watcher (chokidar) auto-discovers and parses session files into messages/tool_calls. Existing hooks continue feeding events for live dashboard. Both share session IDs for cross-linking.
- **Full frontend rewrite to Svelte 5**: Current vanilla JS replaced with Svelte 5 + Vite. Svelte compiles away framework overhead (important for rendering thousands of messages), and agentsview validated it for exactly this use case.
- **Tab-based navigation**: Top-level tabs: Monitor | Sessions | Analytics | Search. Clear separation of real-time vs. historical views.
- **FTS5 for search**: SQLite FTS5 virtual table on messages content, matching agentsview's proven approach.
- **API versioning**: New endpoints under `/api/v2/` to coexist with existing `/api/` endpoints during transition.

## Constraints

- Localhost TypeScript only -- no Rust/Tauri concerns
- No regressions to existing real-time monitoring functionality
- SQLite (better-sqlite3) remains the database
- Express.js backend continues serving API + embedded SPA

## Development Methodology

Red/green TDD throughout all phases:
1. **Red**: Write a failing test that describes the desired behavior
2. **Green**: Write the minimum code to make the test pass
3. **Refactor**: Clean up while keeping tests green

Each phase lists its test-first targets. Tests live alongside source in `src/**/*.test.ts` (unit/integration) and `tests/` (end-to-end). Use Vitest as the test runner (consistent with existing project tooling if present, otherwise add it).

## Scope

### Tier 1 - Core (must-have)
- Session Browser: filterable session list with project grouping
- Message Viewer: conversation replay with content blocks (text, code, thinking, tool use)
- Full-Text Search: FTS5 across all message content with highlighting
- Analytics Dashboard: activity charts, project breakdowns, tool usage stats

### Tier 2 - Valuable (included in initial build)
- Session Relationships: parent/child, subagent linking, navigable
- File-watcher ingestion: chokidar-based auto-discovery of session files

### Tier 3 - Future Work (documented, not built now)
- AI Insights: generated summaries via CLI
- Export/Sharing: HTML export, GitHub Gist publishing
- Minimap: message density visualization
- Keyboard Navigation: vim-style shortcuts (j/k, session switching)

## Success Criteria

1. Monitor tab works as it does today -- zero regressions to real-time dashboard
2. Sessions tab browses all discovered Claude Code sessions, filters by project/agent/date, views full conversation with rendered content blocks
3. Search tab returns results across all message content with highlighting and navigation to source session/message
4. Analytics tab shows activity over time, project breakdowns, and tool usage stats
5. File-watcher automatically discovers and parses new/changed session files
6. Session relationships (subagent, parent/child) are navigable
7. README, AGENTS.md, and system docs updated to reflect new capabilities

---

## Phased Implementation Plan

### Dependency Map

```
Phase 1 (data layer) --> Phase 2 (ingestion) --> Phase 3 (API)
                                                      |
                                                      v
                                             Phase 4a (scaffold + monitor parity)
                                                      |
                                                      v
                                             Phase 4b-4d (new tabs) --> Phase 4e (cutover)
                                                                             |
                                                                             v
                                                                       Phase 5 (docs)
```

Phase 4a can start in parallel with Phase 3 using mock data, then wire to real API once Phase 3 delivers.

---

### Phase 1: Data Layer Foundation

**Goal:** New tables exist, FTS5 verified, API contracts defined. No user-facing changes.

**Tasks:**
1. Add `messages` table to `src/db/schema.ts`:
   - `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   - `session_id` (TEXT) -- links to session UUID from JSONL
   - `ordinal` (INTEGER) -- message sequence within session
   - `role` (TEXT) -- "user" or "assistant"
   - `content` (TEXT) -- JSON-serialized content blocks (text, code, thinking, tool_use)
   - `timestamp` (TEXT) -- RFC3339
   - `has_thinking` (INTEGER) -- boolean flag for filtering
   - `has_tool_use` (INTEGER) -- boolean flag for filtering
   - `content_length` (INTEGER) -- for analytics
   - Indexes: `(session_id, ordinal)`, `(session_id, role)`

2. Add `tool_calls` table:
   - `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   - `message_id` (INTEGER) -- FK to messages
   - `session_id` (TEXT) -- denormalized for direct queries
   - `tool_name` (TEXT) -- raw tool name
   - `category` (TEXT) -- normalized: Read, Write, Edit, Bash, Search, Agent, etc.
   - `tool_use_id` (TEXT) -- unique invocation ID
   - `input_json` (TEXT) -- tool input arguments
   - `result_content` (TEXT) -- tool output
   - `result_content_length` (INTEGER)
   - `subagent_session_id` (TEXT) -- links to spawned subagent sessions
   - Indexes: `session_id`, `category`, `tool_name`

3. Add `browsing_sessions` table (session metadata for the browser, separate from existing `sessions` table which tracks live event-based sessions):
   - `id` (TEXT PRIMARY KEY) -- session UUID
   - `project` (TEXT)
   - `agent` (TEXT) -- agent type (claude, codex, etc.)
   - `first_message` (TEXT) -- preview of first user message
   - `started_at` (TEXT)
   - `ended_at` (TEXT)
   - `message_count` (INTEGER)
   - `user_message_count` (INTEGER)
   - `parent_session_id` (TEXT)
   - `relationship_type` (TEXT) -- fork, continuation, subagent
   - `file_path` (TEXT) -- source JSONL file
   - `file_size` (INTEGER)
   - `file_hash` (TEXT) -- SHA256 for dedup
   - Indexes: `ended_at DESC`, `project`, `agent`, `started_at`

4. Add `messages_fts` FTS5 virtual table:
   - Content source: `messages.content`
   - Triggers on INSERT/UPDATE/DELETE to keep in sync
   - Porter stemming + unicode61 tokenization

5. Add `watched_files` table (skip cache for file-watcher):
   - `file_path` (TEXT PRIMARY KEY)
   - `file_hash` (TEXT)
   - `file_mtime` (TEXT)
   - `status` (TEXT) -- "parsed", "skipped", "error"
   - `last_parsed_at` (TEXT)

6. Define TypeScript API response interfaces in a new `src/api/v2/types.ts`:
   - `BrowsingSession`, `Message`, `ToolCall`, `SearchResult`, `AnalyticsSummary`, etc.

**TDD targets (write tests first):**
- Schema migration creates all new tables without affecting existing tables
- FTS5 insert + search returns matching results
- FTS5 highlight/snippet extraction works
- FTS5 triggers keep index in sync on INSERT/UPDATE/DELETE
- `watched_files` dedup logic (insert, check hash, skip unchanged)
- Backward-compatible migration: existing `events`/`sessions`/`agents` tables unmodified

**Verification:**
- All tests green
- `pnpm build` succeeds
- Existing dashboard still works (`GET /api/health`, manual spot check)

**Deliverable:** New tables exist in DB, FTS5 confirmed working, API types defined.

---

### Phase 2: Ingestion (File-Watcher + Parser)

**Goal:** Session files automatically discovered, parsed, and stored in new tables.

**Tasks:**
1. Build Claude Code JSONL parser (`src/parser/claude-code.ts`):
   - Parse JSONL line-by-line
   - Extract messages with content blocks:
     - Text blocks (plain text, markdown)
     - Code blocks (with language)
     - Thinking blocks (extended thinking)
     - Tool use blocks (tool_name, input, tool_use_id)
     - Tool result blocks (paired with prior tool_use)
   - Extract tool calls into normalized `tool_calls` records
   - Category normalization: Read, Write, Edit, Bash, Search, Agent, Glob, Grep, etc.
   - Parse timestamps from message data
   - Extract project name from directory structure
   - Compute session metadata (message counts, first message preview, start/end times)

2. Build session relationship detection:
   - Parse `uuid` / `parentUuid` fields for parent-child links
   - Detect subagent sessions (agent-* prefixed task IDs in tool_use)
   - Store `parent_session_id` + `relationship_type` on browsing_sessions

3. Build file-watcher service (`src/watcher/index.ts`):
   - Use chokidar to watch `~/.claude/projects/` recursively
   - File filter: `*.jsonl` files
   - Debounce: 500ms per file change
   - On new/changed file:
     - Compute SHA256 hash
     - Check `watched_files` table -- skip if hash unchanged
     - Parse with Claude Code parser
     - Insert into `browsing_sessions`, `messages`, `tool_calls` in a transaction
     - Update `watched_files` record
   - On startup: scan all existing files, parse any new/changed ones

4. Wire file-watcher into server startup (`src/server.ts`):
   - Start watcher after DB initialization
   - Graceful shutdown on server stop
   - Log discovery/parse stats on startup

5. Add periodic re-scan (every 15 min) for files that may have been missed by watcher.

**TDD targets (write tests first):**
- JSONL parser: extracts messages with correct roles, ordinals, timestamps from sample JSONL
- JSONL parser: identifies and categorizes content blocks (text, code, thinking, tool_use, tool_result)
- JSONL parser: normalizes tool categories (Read, Write, Edit, Bash, etc.)
- JSONL parser: extracts session metadata (project, start/end times, message counts)
- JSONL parser: detects parent/child session relationships (uuid/parentUuid)
- JSONL parser: handles edge cases (empty files, malformed lines, missing fields)
- File-watcher: skips files with unchanged hash
- File-watcher: re-parses files with changed hash
- File-watcher: inserts parsed data transactionally (all-or-nothing per file)
- Integration: parsed messages are FTS-searchable

**Verification:**
- All tests green
- Start server, verify it discovers real `~/.claude/projects/` session files
- Query tables directly to confirm data populated
- Unchanged files are skipped on restart (hash check)

**Deliverable:** Server auto-discovers and parses Claude Code sessions. Data is queryable via SQL.

---

### Phase 3: API Layer (New Endpoints)

**Goal:** All session browser data accessible via REST API under `/api/v2/`.

**Tasks:**
1. Session endpoints (`src/api/v2/sessions.ts`):
   - `GET /api/v2/sessions` -- list with filters:
     - `limit` (1-500, default 200)
     - `cursor` (opaque pagination token)
     - `project`, `agent` (string filters)
     - `date_from`, `date_to` (date range)
     - `min_messages`, `max_messages` (count filters)
     - Response: `{ sessions: BrowsingSession[], cursor?: string }`
   - `GET /api/v2/sessions/:id` -- single session with metadata
   - `GET /api/v2/sessions/:id/messages` -- paginated messages:
     - `offset`, `limit` (default 100)
     - Response: `{ messages: Message[], total: number }`
   - `GET /api/v2/sessions/:id/children` -- child/subagent sessions

2. Search endpoint (`src/api/v2/search.ts`):
   - `GET /api/v2/search?q=<query>` -- FTS5 search:
     - `project`, `agent` (optional filters)
     - `limit`, `cursor` (pagination)
     - Response: `{ results: SearchResult[], cursor?: string }`
     - Each result includes: session metadata, matching message snippet with highlights, message ordinal

3. Analytics endpoints (`src/api/v2/analytics.ts`):
   - `GET /api/v2/analytics/summary` -- total sessions, messages, daily averages
   - `GET /api/v2/analytics/activity` -- sessions/messages over time (daily buckets):
     - `date_from`, `date_to`, `project`, `agent` filters
   - `GET /api/v2/analytics/projects` -- per-project message/session counts
   - `GET /api/v2/analytics/tools` -- tool usage by category and name, with counts

4. Metadata endpoints:
   - `GET /api/v2/projects` -- distinct project names
   - `GET /api/v2/agents` -- distinct agent types

5. SSE enhancement -- add `session_parsed` event type to existing `/api/stream` so the frontend knows when new sessions are available.

6. Add all query logic to a new `src/db/v2-queries.ts` (keeping SQL centralized per existing convention).

**TDD targets (write tests first):**
- Sessions list: returns paginated results, respects cursor
- Sessions list: filters by project, agent, date range, message count
- Sessions detail: returns session with metadata
- Messages endpoint: returns paginated messages for a session in ordinal order
- Children endpoint: returns child/subagent sessions
- Search: FTS query returns matching results with snippets
- Search: filters combine with FTS (project + query)
- Search: pagination via cursor
- Analytics summary: correct totals
- Analytics activity: correct daily bucketing
- Analytics projects: correct per-project counts
- Analytics tools: correct tool frequency ranking
- Existing `/api/` endpoints still work (regression tests)

**Verification:**
- All tests green
- `pnpm build` succeeds
- Endpoints return correct data from real parsed sessions

**Deliverable:** Complete REST API for session browsing, search, and analytics.

---

### Phase 4: Frontend Rewrite (Svelte 5 SPA)

#### Phase 4a: Scaffold + Monitor Tab Parity

**Goal:** Svelte 5 app serves at `/app/` with Monitor tab matching existing dashboard.

**Tasks:**
1. Initialize Svelte 5 + Vite + TypeScript project in `/frontend/`:
   - `frontend/src/` -- Svelte components, stores, routes
   - `frontend/src/lib/stores/` -- reactive state (Svelte 5 runes)
   - `frontend/src/lib/components/` -- UI components
   - `frontend/src/lib/api/` -- typed API client
   - Vite config: proxy `/api/` to Express backend in dev mode
   - Build output: `frontend/dist/` (Express serves this in production)

2. Configure Express to serve Svelte app:
   - Dev: Svelte dev server on separate port, proxied
   - Production: serve `frontend/dist/` as static files at `/app/`
   - Keep existing vanilla JS at `/` during development

3. Build shared layout:
   - App shell with top nav tabs: Monitor | Sessions | Analytics | Search
   - Client-side router (hash-based or simple state)
   - Status bar with connection indicator

4. Build Monitor tab (port existing vanilla JS):
   - Stats bar (events, sessions, agents, cost, tokens)
   - Agent cards with live session info, status, metrics, mini event feed
   - Event feed with pagination
   - Cost dashboard (total, by model, by project)
   - Tool analytics (call counts, error rates, duration)
   - Usage monitor (per-agent limits)
   - Filter bar (agent_type, event_type, tool_name, model, project, branch, source)
   - SSE client with auto-reconnect

5. Build API client (`frontend/src/lib/api/client.ts`):
   - Typed fetch wrappers for all `/api/` and `/api/v2/` endpoints
   - Error handling
   - SSE connection management

**Verification:**
- Monitor tab at `/app/` has feature parity with existing dashboard at `/`
- SSE streaming works (events update in real-time)
- All filters work
- Cost and tool analytics display correctly
- No regressions on existing `/` dashboard

**TDD targets (write tests first):**
- API client: typed fetch wrappers return correct types
- SSE client: reconnects on disconnect
- Component tests (where practical): stats bar renders counts, filter bar emits correct params

**Gate:** Do not proceed to 4b until Monitor tab parity is confirmed.

#### Phase 4b: Sessions Tab

**Goal:** Browse and view agent sessions with full conversation replay.

**Tasks:**
1. Session list component:
   - Filterable list (project, agent, date range)
   - Project grouping (collapsible groups)
   - Cursor-based pagination (load more on scroll)
   - Session preview: first message, timestamp, message count, agent badge
   - Active session highlighting

2. Message viewer:
   - Virtual scrolling for large sessions (@tanstack/svelte-virtual)
   - Message rendering by role (user/assistant)
   - Content block rendering:
     - Text: markdown via `marked` + sanitization via `dompurify`
     - Code: syntax highlighting with language detection
     - Thinking: collapsible thinking blocks (Claude extended thinking)
     - Tool use: collapsible tool blocks showing tool name, input, output
   - Loading states and pagination

3. Session detail header:
   - Project, agent, duration, message/token counts
   - Link to parent session (if child/subagent)
   - List of child sessions with navigation

4. Session relationship navigation:
   - Breadcrumb trail for parent > child chains
   - Subagent inline references with click-through

5. Svelte stores:
   - `sessions.svelte.ts`: session list, filters, pagination, selected session
   - `messages.svelte.ts`: message loading, caching per session

**Verification:**
- Can browse all discovered sessions
- Filters narrow results correctly
- Message viewer renders all content block types
- Virtual scrolling handles sessions with 1000+ messages
- Session relationships are navigable

**TDD targets:** Content block renderer tests (text/code/thinking/tool_use produce correct markup), session store filter logic, message pagination state management.

#### Phase 4c: Search Tab

**Goal:** Full-text search across all message content.

**Tasks:**
1. Search input with debounced query
2. Results list:
   - Session context (project, agent, date)
   - Message snippet with highlighted match terms
   - Click navigates to session + scrolls to message
3. Filter by project/agent
4. Cursor-based pagination
5. Search store: `search.svelte.ts`

**Verification:**
- Search returns relevant results
- Highlighting shows matched terms
- Click-through opens correct session at correct message
- Filters work in combination with search query

**TDD targets:** Search store debounce/query logic, result highlighting extraction.

#### Phase 4d: Analytics Tab

**Goal:** Rich analytics dashboard for session/message data.

**Tasks:**
1. Summary cards: total sessions, messages, daily averages
2. Activity chart: sessions/messages over time (daily buckets)
   - Date range selector
   - Project/agent filter
   - Lightweight SVG line/bar chart (no heavy lib dependency)
3. Project breakdown: bar chart of messages per project
4. Tool usage: ranked list of tools by category and frequency
5. Analytics store: `analytics.svelte.ts`

**Verification:**
- Summary numbers match raw data
- Charts render and respond to filter changes
- Data updates when new sessions are parsed

**TDD targets:** Analytics store data transformation logic, date bucketing helpers.

#### Phase 4e: Cutover

**Goal:** Svelte app becomes the primary frontend.

**Tasks:**
1. Move Svelte build output to serve from `/` instead of `/app/`
2. Remove vanilla JS files from `/public/js/`
3. Update Express static file serving
4. Update `public/index.html` to load Svelte app
5. Verify all tabs work from `/`
6. Remove any dev-only proxy configuration

**Verification:**
- All four tabs work from `/`
- SSE streaming works
- No references to old vanilla JS remain
- `pnpm build` produces working production build
- `pnpm dev` starts dev server correctly

---

### Phase 5: Documentation + Polish

**Goal:** Project docs reflect new architecture. Tier 3 future work documented.

**Tasks:**
1. Update `README.md`:
   - New architecture overview (dual-mode: Monitor + Sessions/Search/Analytics)
   - Updated setup instructions (Svelte frontend build steps)
   - New dev workflow (frontend dev server)
   - Updated API documentation (v2 endpoints)
   - Screenshots of new UI

2. Update `CLAUDE.md` / `AGENTS.md`:
   - New code map entries (frontend/, parser/, watcher/, api/v2/)
   - New working commands (frontend dev, build)
   - Updated validation checklist
   - New implementation guardrails for Svelte code

3. Document Tier 3 future work in `docs/plans/future-work.md`:
   - AI Insights: design notes for CLI-generated summaries
   - Export/Sharing: HTML export and GitHub Gist publishing spec
   - Minimap: message density visualization approach
   - Keyboard Navigation: vim-style shortcut mapping
   - Additional agent support: Codex, Copilot, Gemini file-watcher parsers

4. Clean up any development artifacts:
   - Remove `/app/` route if still present
   - Remove unused vanilla JS references
   - Verify `.gitignore` covers `frontend/dist/`, `frontend/node_modules/`

**Verification:**
- README accurately describes current project
- CLAUDE.md has correct commands and code map
- `pnpm build` and `pnpm dev` work as documented
- New developer could onboard from README alone

---

## Resolved Design Questions

- **Virtual scrolling**: `@tanstack/svelte-virtual` -- same ecosystem as agentsview, well-maintained
- **Charts**: Lightweight SVG components (no heavy library). agentsview hand-rolled charts in Svelte; same approach keeps bundle small for localhost tool
- **Initial agent support**: Claude Code only in file-watcher. Expanding to Codex/others is additive future work
- **Parser strategy**: Port agentsview's parsing logic to TypeScript, adapting to our data model. Leverage patterns from existing `src/import/claude-code.ts` importer

## Risk Mitigations

- **Frontend rewrite risk**: Old dashboard stays at `/` until Phase 4e cutover. New app develops at `/app/`. Zero-downtime transition.
- **FTS5 availability**: Verified in Phase 1 before building anything that depends on it. better-sqlite3 ships with FTS5 enabled in recent versions.
- **Parser complexity**: Start with linear sessions (common case). Add fork/subagent detection iteratively in Phase 2. Real session files used for validation throughout.
- **Performance with large datasets**: Virtual scrolling, cursor-based pagination, and FTS5 indexing handle scale. SQLite WAL mode for concurrent reads.
