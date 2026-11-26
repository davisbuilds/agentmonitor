# AgentMonitor: Antigravity CLI Integration

**There is no hook to install for Antigravity.** Unlike Claude Code (hooks) and
Codex (OTEL export), Antigravity CLI has telemetry disabled and exports no OTLP,
so AgentMonitor integrates with it **historically** by reading the conversation
databases it already writes to disk.

## How it works

Antigravity CLI stores each conversation as a per-conversation SQLite file and,
for newer sessions, a compact JSONL transcript log:

```
~/.gemini/antigravity-cli/conversations/<uuid>.db
~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl
```

The `steps` and `gen_metadata` tables hold **plaintext protobuf** blobs (no
encryption, no compression). AgentMonitor decodes them with descriptor-pinned +
empirically-pinned field maps to recover activity, model, token usage, and cost.
See `docs/specs/baselines/antigravity-proto-fieldmap.md` for the field map and
its provenance. When the compact `transcript.jsonl` exists alongside the
conversation DB, the session browser and full-text search index its prompts,
reasoning, assistant replies, tool calls, and bounded tool outputs directly.

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
are projected automatically by the running AgentMonitor watcher on startup, on
real-time changes under `~/.gemini/antigravity-cli/conversations/` (`.db` and
`.db-wal`), and on each 15-minute periodic resync. During sync, AgentMonitor
also reads `gen_metadata` prompt token counts for context occupancy and reads
`~/.gemini/antigravity-cli/conversation_summaries.db` (read-only, fail-open)
for project identity, session titles, and parent/subagent lineage.

For live Antigravity subscriber quota windows (`gemini-5h`, `gemini-weekly`, or
`3p-*` fallback) and turn-level context-window updates, send `agy` statusline
JSON payloads to:

```text
POST /api/provider-quotas/antigravity/statusline
```

`email` and `subagents` fields are stripped before persisting `raw_payload`.

## Fidelity

When `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl`
is present and parseable, Antigravity sessions project at `fidelity=full`
(`integration_mode=antigravity-transcript`): the session browser, live stream,
tool analytics, and full-text search expose user prompts, thinking text,
assistant responses, tool calls with decoded arguments, and bounded tool results.
When `transcript.jsonl` is absent, empty, or unparseable, AgentMonitor falls
back cleanly to `fidelity=summary` (`integration_mode=antigravity-sqlite`),
indexing SQLite `steps` kinds (e.g. `run command`, `view file`). Token
accounting and cost remain exact in both modes.
