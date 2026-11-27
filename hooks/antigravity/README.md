# AgentMonitor: Antigravity CLI Integration

**There is no hook to install for Antigravity.** Unlike Claude Code (hooks) and
Codex (OTEL export), Antigravity CLI has telemetry disabled and exports no OTLP,
so AgentMonitor integrates with it **historically** by reading the conversation
databases it already writes to disk.

## How it works

Antigravity CLI stores each conversation as a per-conversation SQLite file and,
for newer sessions, JSONL transcript logs:

```
~/.gemini/antigravity-cli/conversations/<uuid>.db
~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl
~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl
```

The `steps` and `gen_metadata` tables hold **plaintext protobuf** blobs (no
encryption, no compression). AgentMonitor decodes them with descriptor-pinned +
empirically-pinned field maps to recover activity, model, token usage, and cost
estimates. See `docs/specs/baselines/antigravity-proto-fieldmap.md` for the field map and
its provenance. AgentMonitor prefers `transcript_full.jsonl` when present and non-empty
and falls back to the bounded `transcript.jsonl` mirror (marking truncated fields
visibly) so the session browser and full-text search index prompts, reasoning,
assistant replies, tool calls, and tool outputs directly.

## Setup

Nothing to configure. Just import:

```bash
# Event/usage/cost backfill
pnpm cli -- import --source antigravity

# Preview first
pnpm cli -- import --source antigravity --dry-run

# Point at a non-default root
pnpm cli -- import --source antigravity --antigravity-dir /path/to/antigravity-cli
```

## Live Watcher & Statusline Bridge

The **session browser** rows (`browsing_sessions` / `messages` / `session_items`)
and **Monitor** event/session rows (`events` / `sessions`) are projected together
from one shared read-only SQLite snapshot reader (`src/import/antigravity/snapshot.ts`
with bounded retries for WAL churn / `SQLITE_BUSY`) and one shared WAL-aware
change token (folding `.db`, `.db-wal`, `.db-shm`, `conversation_summaries.db`
(+ its `-wal`), and companion `transcript_full.jsonl` / `transcript.jsonl` bytes).
The watcher runs on startup, on real-time changes under
`~/.gemini/antigravity-cli/conversations/` (`.db`, `.db-wal`, `.db-shm`) and
`~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/`
(`transcript_full.jsonl` and `transcript.jsonl`), and on each 15-minute periodic
resync.

During sync, live changes ingest new/updated Antigravity `events` (deduped by
stable `event_id` with legacy `gen:i` bridging), reconcile `sessions` bounds and
lifecycle (marking active root and subagent conversations `status='active'` with
`<ContextPill>` prompt occupancy while their latest activity stays within the
configured session timeout, keeping historical conversations `ended`, and letting
`idle_check` sweeps transition `active -> idle -> ended`), and broadcast SSE
`event` and `session_update` updates so active conversations appear live in
**Monitor -> Active Agents**. AgentMonitor reads `gen_metadata` prompt token
counts for context occupancy and reads
`~/.gemini/antigravity-cli/conversation_summaries.db` (read-only, fail-open on
optional reads) for project identity, session titles, and parent/subagent lineage.

For live Antigravity subscriber quota windows (`gemini-5h`, `gemini-weekly`, or
`3p-*` fallback) and turn-level context-window updates, send `agy` statusline
JSON payloads to:

```text
POST /api/provider-quotas/antigravity/statusline
```

`email` and `subagents` fields are stripped before persisting `raw_payload`.

## Fidelity

When `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl`
(or an untruncated `transcript.jsonl` with no `truncated_fields`) is present and
parseable, Antigravity sessions project at `fidelity=full`
(`integration_mode=antigravity-transcript`): the session browser, live stream,
tool analytics, and full-text search expose user prompts, thinking text,
assistant responses, tool calls with decoded arguments, and tool results.
When only a bounded mirror containing `truncated_fields` (such as `transcript.jsonl`)
is available, AgentMonitor projects `integration_mode=antigravity-transcript` at
`fidelity=summary` (summary capabilities with explicit `[truncated: ...]` markers
and `has_full_transcript=false`). When no parseable transcript exists, AgentMonitor
falls back cleanly to `fidelity=summary` (`integration_mode=antigravity-sqlite`),
indexing SQLite `steps` kinds (e.g. `run command`, `view file`). If SQLite `steps`
advance ahead of a lagging transcript, trailing unflushed steps preserve `ended_at`
as summary placeholders until the transcript flushes.

Billing token and cost estimates are imported from SQLite `gen_metadata`
(`ModelUsageStats`: input, output, cache write, cache read, and informational thinking
tokens, without adding the field-1 model enum) via `amon import --source antigravity`
and real-time watcher syncs, keyed by stable generation IDs (`messageId`, then
`providerAssignedMessageId`, then `gen_metadata.idx`) with legacy ordinal `gen:i`
bridging. Per-generation timestamps are recovered from `chat_start_metadata.created_at`
or unique `planner_response` message-ID joins (`timestamp_source` provenance in
`metadata`; unattributed generations keep `client_timestamp` unset). Transcript token
fields feed display-only `context_used_tokens` fallback and never create usage or
cost rows. Use `amon costs repair-antigravity-usage --dry-run --json` / `--apply` to
atomically reconcile pre-Slice 1/Slice 2 imported usage rows, migrate legacy ordinal
IDs, and refresh `sessions` aggregates and `session_trace_summary`.
