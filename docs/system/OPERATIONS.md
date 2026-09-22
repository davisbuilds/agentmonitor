# Operations

This document owns local setup, runtime operation, integrations, recovery, and
verification procedures. Use `amon --help` for the exact command surface and
[`src/config.ts`](../../src/config.ts) for exact environment parsing and defaults.

Related references:

- Product behavior: [FEATURES.md](FEATURES.md)
- Architecture and data ownership: [ARCHITECTURE.md](ARCHITECTURE.md)
- API ownership: [../api/README.md](../api/README.md)
- Claude integration: [../../hooks/claude-code/README.md](../../hooks/claude-code/README.md)
- Codex integration: [../../hooks/codex/README.md](../../hooks/codex/README.md)

## Built Product

```bash
pnpm build
pnpm link --global
amon serve
```

`amon serve` runs Express on the fixed `127.0.0.1:3141` backend and normally uses
the pinned package-local Portless CLI to expose
`https://agentmonitor.localhost`. Both roots redirect to `/app/`. Hooks, OTLP
exporters, and direct API clients remain on `:3141`.

`amon serve --no-portless` starts the direct backend without the named HTTPS
origin. Ctrl-C shuts down the runtime and removes its Portless route.

### Runtime Ownership

Long-running startup is exclusive per resolved SQLite database. A competing
runtime targeting the same database exits before HTTP and background work and
reports the owning PID and path. Dead-process state recovers automatically. Do not
delete an adjacent `.runtime.lock` while its reported PID is live.

Different explicit database paths may run concurrently. One-shot reads, backup,
import, sync, recalculation, and warehouse publication do not acquire runtime
ownership. Shutdown stops HTTP reconnects, timers, SSE clients, quota work,
watchers, and SQLite before releasing the lock, allowing an immediate restart.

## Source Development

After upgrading the Codex lineage parser, preserve a closed database backup and
rehearse `amon sync sessions --source codex --force` on a separate database path
before reparsing the live projection. Unchanged files otherwise retain their old
null lineage; deploying the binary alone cannot classify that historical data.
Unknown source shapes remain unclassified. Reparse reads native files but never
modifies them. Daily activity is documented in the README; inspect its aggregate
response separately from the older created-identity inventory.

```bash
pnpm install
pnpm dev          # TypeScript server with watch mode
pnpm frontend:dev # Svelte HMR server with API proxy
```

Open `http://127.0.0.1:3141/app/` for the backend-served app or
`http://127.0.0.1:5173/app/` for the frontend HMR path.

During development, `pnpm cli -- ...` runs the TypeScript CLI entrypoint. After a
build/link, use `amon ...`. `agentmonitor` is an equivalent executable alias.
Finite read commands support `--json` for stable machine consumption and reserve
stderr for diagnostics. Unsupported flags fail instead of being ignored.

Use help at the level being automated:

```bash
pnpm cli -- --help
pnpm cli -- usage --help
pnpm cli -- analytics --help
amon --help
```

Package scripts remain compatibility wrappers for older workflows. Prefer the CLI
for new operator documentation and automation.

## Common Configuration

All configuration is optional. [`src/config.ts`](../../src/config.ts) is the
complete authority; [`.env.example`](../../.env.example) provides a practical
local-runtime starting point. Common controls include:

| Concern | Variables |
| --- | --- |
| Listener and database | `AGENTMONITOR_HOST`, `AGENTMONITOR_PORT`, `AGENTMONITOR_DB_PATH` |
| Event/SSE limits | `AGENTMONITOR_MAX_PAYLOAD_KB`, `AGENTMONITOR_SESSION_TIMEOUT`, `AGENTMONITOR_MAX_FEED`, `AGENTMONITOR_STATS_INTERVAL`, `AGENTMONITOR_MAX_SSE_CLIENTS`, `AGENTMONITOR_SSE_HEARTBEAT_MS` |
| Discovery and sync | `AGENTMONITOR_PROJECTS_DIR`, `AGENTMONITOR_CLAUDE_DIR`, `AGENTMONITOR_AUTO_IMPORT_MINUTES`, `AGENTMONITOR_SYNC_EXCLUDE_PATTERNS` |
| Live fidelity/privacy | `AGENTMONITOR_ENABLE_LIVE_TAB`, `AGENTMONITOR_CODEX_LIVE_MODE`, `AGENTMONITOR_CODEX_CONTEXT_WINDOW`, `AGENTMONITOR_LIVE_CAPTURE_PROMPTS`, `AGENTMONITOR_LIVE_CAPTURE_REASONING`, `AGENTMONITOR_LIVE_CAPTURE_TOOL_ARGUMENTS`, `AGENTMONITOR_LIVE_DIFF_PAYLOAD_MAX_BYTES` |
| Codex quotas | `AGENTMONITOR_CODEX_QUOTA_POLL_INTERVAL_MS` |
| Skill catalogs | `AGENTMONITOR_SKILL_CATALOG_DIRS` |
| Usage budgets | `AGENTMONITOR_USAGE_BUDGETS_PATH` |
| Aggregate warehouse | `AGENTMONITOR_WAREHOUSE_DSN`, `AGENTMONITOR_WAREHOUSE_ACCOUNT`, `AGENTMONITOR_WAREHOUSE_SCHEMA`, `AGENTMONITOR_WAREHOUSE_BI_ROLE` |

The default database follows the package installation rather than the invoking
shell directory. An explicit relative `AGENTMONITOR_DB_PATH` resolves against the
working directory.

Insight generation additionally uses `AGENTMONITOR_INSIGHTS_PROVIDER` and the
selected provider's API-key, model, and optional base-URL variables. The accepted
aliases and defaults are intentionally source-owned because provider configuration
changes more frequently than the monitoring runtime.

## Integration Setup

### Claude Code

```bash
pnpm cli -- hooks install claude --dry-run
pnpm cli -- hooks install claude --force
```

Restart Claude Code after installation. The hook emits asynchronous, content-free
instruction-load metadata in addition to lifecycle and tool events. It never reads
or emits instruction file contents. See the dedicated hook README for current hook
names and payload details.

### Codex

```bash
pnpm cli -- hooks print-codex-config
```

The generated `~/.codex/config.toml` snippet points JSON OTLP logs and metrics to
the direct backend. Start AgentMonitor before the Codex session. If Codex terminal
activity is visible but `source=otel` stops updating, confirm the configured
endpoint is `127.0.0.1:3141` rather than a stale port.

Codex `otel-only` mode is summary-oriented. It provides live activity and usage,
while the separate local-session watcher supplies historical transcript-derived
data where available. It does not claim Claude-equivalent live transcript,
reasoning, or diff fidelity.

## Import And Session Recovery

Use `amon import --help`, `amon import benchmark --help`, and
`amon sync sessions --help` for the current flags. The important distinction is:

- `amon import` reconstructs event history and cost-bearing rows.
- `amon sync sessions` reconstructs browsing sessions, messages, turns, items, tool
  calls, and transcript-derived analytics.

`import_state` and `watched_files` protect those paths independently. If browser
tables are restored, cleared, or fall behind while watcher hashes survive, normal
startup treats unchanged files as current. Startup warns when a discoverable
Claude/Codex transcript is cached as parsed but lacks its browser projection.

Preserve the database, then rebuild browser history explicitly:

```bash
amon sync sessions --source all --force
```

`amon import --force` cannot restore tool-call or inferred-skill history. Date
scoped imports intentionally do not update whole-file skip state. Benchmark import
creates segregated `source='benchmark'` rows; it does not fabricate transcripts for
ephemeral benchmark runs.

## Database Backup And Repair Safety

Create an application-consistent backup while the WAL writer remains active:

```bash
amon database backup --output /absolute/private/path/agentmonitor.db
```

The command requires an absolute regular-file destination, refuses source/sidecar
paths and unsafe replacements, creates a mode-`0600` staged database through
SQLite's online backup API, validates it, and publishes it atomically. Use
`--replace` to replace an existing valid target. AgentMonitor does not choose a
backup schedule or retention policy.

Before a repair that rewrites the install database, stop duplicate runtimes, create
the backup, and inspect ownership:

```bash
lsof -nP data/agentmonitor.db data/agentmonitor.db-wal data/agentmonitor.db-shm
```

A raw forensic snapshot must keep the database, WAL, and SHM together. Copying a
live main database alone is incomplete. Tests refuse to open the install database,
but maintenance commands may mutate an explicitly selected database.

### Historical summary timestamp repair

`scripts/repair-summary-timestamps.ts` repairs only offset-free UTC database-time
fallbacks with matching event/turn lineage. It excludes file-backed/transcript
projections, client-supplied timestamps and ambiguous matches. It changes no
event rows, message counts, payloads or identities. Session start additionally
must match the first source event; this conservative rule can leave old fields
unresolved. It is not a blanket timezone conversion or a replay of ingestion.

Stop all writers and preserve a validated SQLite backup first. Restore that backup
to a disposable file and rehearse there before applying to the install database.
Use absolute paths; preview opens the database read-only and prints only counts
and a candidate digest, not session identifiers or contents:

```sh
pnpm exec tsx scripts/repair-summary-timestamps.ts --db /absolute/database.db
pnpm exec tsx scripts/repair-summary-timestamps.ts --db /absolute/database.db \
  --apply --expect-digest <digest-from-reviewed-preview>
```

Apply re-inventories under an immediate transaction and refuses a mismatched
digest. Any write failure rolls back the whole repair. The digest is a drift
guard, not proof of a backup or writer shutdown; those remain operator duties.
Verify integrity, compare all non-target columns with the backup, and check that
changed values differ only by the UTC marker/ISO separator. A repeated preview
must report zero eligible changes; `unresolvedFields` may remain nonzero. Restart
the newly built runtime afterward so new fallbacks keep their timezone marker.

### Imported Claude usage repair

Until 2026-09-22 the Claude Code importer billed one event per assistant JSONL
line. Claude writes one line per content block and repeats the turn's `usage` on
each, so affected turns were counted two to five times, and cost followed the
tokens. New imports are correct; rows already stored are not, because `event_id`
is per line and dedup skips them on re-import.

`amon costs repair-claude-usage` re-parses the discoverable transcripts and
aligns each stored row to what its line should have contributed. It reports by
default and writes only with `--apply`:

```sh
amon costs repair-claude-usage --json          # preview, no writes
amon costs repair-claude-usage --apply
```

Take a validated backup first (see above). Rows are never deleted: a repeat line
keeps its event and loses only the usage it double-counted, so transcripts,
event history and tool-call projections are unchanged. Re-running finds nothing
further to correct.

Applying also re-derives `session_trace_summary` for every repaired session:
that rollup stores its own token and cost totals, the trace-quality API and
warehouse export read it directly, and startup backfill skips rows already at
the current projection version.

Two classes of row are reported rather than repaired, because neither has an
unambiguous source:

- `rows_without_transcript` — the file is gone. Event history outlives its
  transcripts, and a missing source is not evidence of anything.
- `rows_ambiguous` — more than one transcript mints the same `event_id`. A
  child-agent transcript embeds its parent's `sessionId` and ids derive from
  (session, line index), so parent and child collide on the same line number.

Repair matches a stored row under either identity scheme: the current id,
derived from the transcript line's own `uuid`, and the positional id every row
imported before that change still carries. A row keyed the old way is therefore
still repairable.

On the development store at the time of the fix, 14,857 of 83,147 matched rows
were correctable, 284 were ambiguous, and 75,195 rows had no surviving
transcript — so a repaired database can still carry inflated historical cost
that no local evidence can settle.

## Trace-Quality Reclaim

The lean trace-quality model no longer uses the old persisted trace, observation,
score, prompt, and projection tables. Existing databases retain them until the
operator runs the explicit reclaim:

```bash
pnpm reclaim:trace-quality --dry-run
pnpm reclaim:trace-quality
```

The live command drops the obsolete derived tables and runs `VACUUM`; it may need
temporary free space comparable to the database and a brief exclusive lock. It is
never run during normal startup. Source events and session-browser rows remain
untouched, while `session_trace_summary` and `trace_quality_export_state` remain.

## Aggregate Warehouse Export

`amon warehouse publish` optionally publishes content-free
`session_trace_summary` rows to AgentMonitor's own Postgres schema. Normal startup,
ingestion, imports, and the local UI do not require Postgres.

```bash
amon warehouse publish --dry-run --json
AGENTMONITOR_WAREHOUSE_DSN=postgresql://... amon warehouse publish
```

The live path upserts one row per `(account, session_id)` and records a publication
lineage row. Re-publication does not retract a warehouse row when local data is
later deleted. `--dry-run` needs no DSN and opens no Postgres connection.
`--min-batch` prevents accidental tiny publishes but is not a privacy threshold.
Changing the account label can duplicate BI identity and emits a warning.

The mapped row is restricted to the content-free allowlist described in
[trace-quality.md](trace-quality.md). Langfuse trace/eval depth remains a separate
deferred path.

## Performance Measurement

`pnpm bench:usage` measures the complete running-server Usage overview path,
including JSON serialization and validation. It separates warmup from measured
samples and can enforce a locally chosen `--max-median-ms` when the machine,
database snapshot, and date range are named. The repository has no universal
latency constant.

Use the workspace measurement guide before making a decision from a benchmark.
Record the entrypoint, dataset/window, host, warmup policy, sample count, and
whether the server was source or built.

## Verification

The pre-push checks are:

```bash
pnpm lint
pnpm build
pnpm test
```

If frontend TypeScript or Svelte changes, also run:

```bash
pnpm frontend:check
pnpm frontend:test
```

Main branch protection currently requires `Lint, Build, Test` and
`E2E (Playwright)`. The CI workflow also runs a Gitleaks job. Current workflow
definitions and live branch protection are authoritative; see
[GIT_HISTORY_POLICY.md](../project/GIT_HISTORY_POLICY.md) for the verification
commands.

Parity and v2 contract commands remain available for focused API work. The
skill-context built-product oracle runs compiled parsers, schema, API, and browser
behavior against isolated Claude and Codex fixtures:

```bash
pnpm build
pnpm verify:skill-context-built
```

Set `AGENTMONITOR_VERIFY_DOJO_RUNTIME=1` to add the optional local cross-repository
Dojo extractor smoke when that sibling checkout is present. It is not a CI
dependency because `~/Dev` is not a monorepo.

## Manual Built-Product Check

1. Run `pnpm build`, then `amon serve`.
2. Open `https://agentmonitor.localhost` and confirm the root redirects to `/app/`.
3. Confirm capture settings match the Live banner.
4. Start a Claude or Codex session and verify new activity appears without a full
   page reload.
5. When capture is disabled, confirm payloads render redacted.
6. Treat Codex `otel-only` sessions as summary-oriented.

Runtime databases and related artifacts (`data/`, `*.db`, WAL/SHM files) must not
be committed.
