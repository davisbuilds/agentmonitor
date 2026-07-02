# AgentMonitor: Antigravity CLI Integration

**There is no hook to install for Antigravity.** Unlike Claude Code (hooks) and
Codex (OTEL export), Antigravity CLI has telemetry disabled and exports no OTLP,
so AgentMonitor integrates with it **historically** by reading the conversation
databases it already writes to disk.

## How it works

Antigravity CLI stores each conversation as a per-conversation SQLite file:

```
~/.gemini/antigravity-cli/conversations/<uuid>.db
```

The `steps` and `gen_metadata` tables hold **plaintext protobuf** blobs (no
encryption, no compression). AgentMonitor decodes them with descriptor-pinned +
empirically-pinned field maps to recover activity, model, token usage, and cost.
See `docs/specs/baselines/antigravity-proto-fieldmap.md` for the field map and
its provenance.

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

The **session browser** rows (`browsing_sessions` / `messages` / `session_items`)
are projected automatically by the running AgentMonitor watcher on startup and on
each periodic resync — no separate command. New conversations appear on the next
resync (live file-tailing is not implemented yet).

## Fidelity

Antigravity sessions project at `fidelity=summary`
(`integration_mode=antigravity-sqlite`). The transcript text and per-tool
arguments/outputs live in private `CortexStep*` payload messages that are not yet
descriptor-pinned, so the browser and full-text search currently index the step
**kind** (e.g. `run command`, `view file`) rather than raw content. Token
accounting and cost are exact; content depth upgrades when the payload internals
are decoded, without changing the ingestion seam.
