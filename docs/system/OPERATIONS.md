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
| Reporting zone | `AGENTMONITOR_TIMEZONE` |
| Aggregate warehouse | `AGENTMONITOR_WAREHOUSE_DSN`, `AGENTMONITOR_WAREHOUSE_ACCOUNT`, `AGENTMONITOR_WAREHOUSE_SCHEMA`, `AGENTMONITOR_WAREHOUSE_BI_ROLE` |

`AGENTMONITOR_TIMEZONE` names the IANA zone (for example `America/New_York`) that
every user-facing day is reported in. It defaults to the host's zone; an invalid
name falls back to the host's rather than failing startup. The aggregate warehouse
export ignores it and keeps UTC days, so rows already exported stay comparable.

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

Recovering child-agent usage that the old id scheme dropped is a separate step,
and it must precede the repair:

```sh
amon import --source claude-code --force   # recover, then repair
```

`import_state` records those transcripts as seen, so only `--force` revisits
them. Expect totals to **rise** here: this imports events that were never
stored.

Both were exercised on a local store on 2026-09-22, after a validated backup and
a full rehearsal on a copy of it. Expected shape, which is what to check against
your own run rather than a specific total:

- the forced import bridges the overwhelming majority of events as duplicates
  and imports only the child-agent rows that the old scheme dropped;
- the repair corrects roughly one matched row in six, reclaiming the usage those
  repeat lines double-counted, and re-derives a summary per affected session;
- a second run of either is a no-op, and `PRAGMA integrity_check` stays `ok`.

Both ran safely with the server live, so stopping it is not required; a backup
still is.

The repair cannot reach two classes of row, so a repaired database still carries
inflated historical cost that no local evidence can settle. The report counts
them separately: `rows_ambiguous` (an id claimed by more than one transcript)
and `rows_without_transcript` (the source file is gone). On the store used
above the second class was the large majority of pre-fix imported rows —
unrepairable evidence typically outnumbers repairable by several times over,
because event history outlives the transcripts it came from.

### Imported Codex usage repair

Until 2026-09-24 the Codex importer had two defects that inflated stored usage.
Stored rows keep both, because import skips an unchanged file, and before this
fix it only inserted ids it had not seen.

- **Copied subagent history.** A `thread_spawn` subagent's rollout can open with
  a copy of its parent's history, with the parent's cumulative token counters
  and file edits re-stamped at spawn time. Each copied counter was billed again,
  so affected subagents imported hundreds of times what Codex's own OTEL saw.
- **Rewritten rollouts.** Import ids are positions in the rollout. When Codex
  rewrites a rollout, the ids move. Insert-only import left the old rows
  alongside the new ones, and a model refresh wrote the file's cost onto stale
  tokens.

New imports are correct. A changed rollout's import rows are now reconciled to
its parse: updated in place, deleted when the parse no longer produces them, or
inserted. A subagent is billed from its first own turn (see ARCHITECTURE). An
unchanged file is still skipped, so rows already stored need the repair:

```sh
amon costs repair-codex-usage --json            # preview, no writes
amon costs repair-codex-usage --apply
```

It reconciles every discoverable rollout through the importer's own path, so a
repaired session is exactly what a fresh import would store. The preview runs
the same work and rolls it back.

**Procedure:**

1. Take a validated backup (see above).
2. Rehearse on a copy. Also copy `~/.codex/sessions` and `config.toml` to a
   scratch Codex directory, so the preview and the apply read identical bytes.
   Then run:

   ```sh
   amon database backup --output <private-dir>/rehearsal.db
   AGENTMONITOR_DB_PATH=<private-dir>/rehearsal.db \
     amon serve --port 3999 --no-import --no-watch --no-portless
   ```

   Record `/api/v2/monitor/stats` overall and with `?agent=codex` after this
   first startup, which prices any missing costs on the copy. Stop the server.
   Then run the preview and the apply with `--codex-dir <scratch>`, restart the
   server, and read the same endpoints again.
3. Stop the live server and verify its port is free. A rollout that grows
   during the apply is reconciled again by the next import, but the Monitor's
   stats cache only resets on restart.
4. Back up the live database again, then preview it and compare the preview
   with the rehearsal. Then run `--apply`, restart the server, and check that a
   second preview reports no changes.

**Reading the report.** Each changed row is classified by the evidence it
carries:

| Class | Meaning |
|---|---|
| `copied_history` | a parent's row, dropped from a subagent |
| `orphaned` | an id the rewritten rollout no longer produces |
| `refresh_drift` | stale tokens under a cost that already matches the file |
| `repriced` | same tokens, cost from older rates |
| `subagent_model` | a subagent's session model, moved from its parent's first turn to its own |
| `annotated` | only non-usage fields differ |
| `appended` | new usage since the last import |
| `unclassified` | none of the above |

**Do not apply while `unclassified` is above 0.** Also check the two outside
instruments in the report:

- `counter_mismatches` must be empty. Each changed plain session's repaired
  usage is compared with the final cumulative counter Codex wrote in its own
  rollout. Rollouts whose counter restarts mid-session are counted in
  `counter_sessions_reset` and skipped, because their final counter understates
  what was billed.
- `subagent_otel` compares each changed subagent with Codex's per-request OTEL,
  before and after. `otel_ratios_moved_away` must be 0.

A rollout that does not name its model is attributed to the `config.toml`
model. The repair keeps the model already stored for such rows, because
today's config says nothing about an older session.

**What to expect in the Monitor:**

- The Codex Monitor total changes by the import change plus the change in
  counted OTEL rows. Deleting rows can move a session's latest import timestamp
  earlier, and the OTEL rows after it then count again.
- Other agents are unchanged.
- Usage rows can move to other days as they take back their rollout
  timestamps.

A session whose rollout is gone is counted in `sessions_without_rollout` and
left as stored. A failed session rolls back on its own. It is listed in
`sessions_failed` and the CLI exits with partial success. Rerunning finishes it.

**Measured shape.** This was rehearsed on 2026-09-24 against a copy of a local
store and a snapshot of its rollouts:
- the changed subagents moved from 140–810× OTEL to 0.976–0.994×;
- every changed plain session landed on its rollout's own counter;
- the Codex Monitor total fell by about 45%;
- a second apply changed nothing.

### Pricing a newly released model

An unpriced model bills as **$0**, not as an error, and its rows keep a NULL
cost. Rates load once from the build, so a pricing update reaches the server
only with a rebuild and restart, and every `amon serve` startup prices those
NULL-cost usage rows before it starts accepting requests. Adding a model therefore
needs no manual backfill. A one-shot command does the same thing without a restart:

```bash
amon costs recalc --missing-only --dry-run --json   # report what would be priced
amon costs recalc --missing-only                    # apply
```

### Cost provenance and correcting a rate

Each stored cost records its `cost_source`. `reported` is the producer's own
figure: a captured benchmark bill, Claude Code's cost attribute or cost metric,
or any cost an API client sends. `estimated` came from our pricing tables. A
recalc only ever rewrites `estimated` rows and fills NULL ones. It never touches
`reported`. When a published rate turns out to be wrong, fix the table and run
a full recalc:

```bash
amon costs recalc --dry-run --json   # labels, then reports, then rolls back
amon costs recalc
```

The recalc re-derives the cached trace summary of every non-benchmark session it
changes in the same transaction, so a failed run rolls back whole.

Cost rows written before provenance was recorded are labelled on first startup
(or by a recalc). Producers that never send a cost (the Codex and Antigravity
importers) are estimates. Benchmark costs are reported. Elsewhere
a stored cost equal to the tables at the event's time is taken as an estimate
and any other as reported. Ambiguity resolves toward `reported`: a mislabelled
estimate just stays stale, while a mislabelled reported cost could be
overwritten.

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
