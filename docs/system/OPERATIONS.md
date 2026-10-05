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

### Login Service (macOS)

```bash
pnpm build
amon service install     # or: node dist/cli.js service install
amon service status
amon service restart     # after every rebuild
amon service uninstall
```

`amon service install` writes the launchd agent
`~/Library/LaunchAgents/dev.agentmonitor.serve.plist` and starts it. The agent
runs the build the installing CLI belongs to (`node <install>/dist/cli.js serve
--no-portless`) from the install root, starts at login, and restarts the server
when it exits with an error. A server that was stopped (`amon service uninstall`,
`launchctl bootout`) exits cleanly and stays stopped. Output goes to
`~/Library/Logs/agentmonitor/serve.log`, which nothing rotates.

launchd starts the server without the shell's environment. The install records
`PATH` (the Codex quota reader runs `codex app-server`), `CODEX_HOME`, and the
`AGENTMONITOR_*` settings in effect when it runs, and lists them. A setting whose
name marks a secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `DSN`)
is left out and named as skipped, and generic provider keys such as
`OPENAI_API_KEY` are never read, so insights that need a provider key are
unavailable under the service. After changing a setting, rerun the install: it
stops the service's own server, waits for it to release the database, and
starts the new one. It refuses while a server it does not run owns the database;
stop that one first.

The service serves the direct port only. `https://agentmonitor.localhost` comes
from Portless, which runs one HTTPS proxy per machine, shared by every project
that uses it. To keep the named URL with the service, run that proxy at boot from
a global install (`npm install -g portless`, then `portless service install`) and
give AgentMonitor a static route: `portless alias agentmonitor 3141`. The alias
outlives server restarts, so the URL works however the server is started; while
the server is down, the proxy answers with an error rather than refusing the
connection. `portless doctor` checks the proxy, its routes and the certificate.

### Runtime Ownership

Long-running startup is exclusive per resolved SQLite database. A competing
runtime targeting the same database exits before HTTP and background work and
reports the owning PID and path. Dead-process state recovers automatically. Do not
delete an adjacent `.runtime.lock` while its reported PID is live.

Different explicit database paths may run concurrently. One-shot reads, backup,
import, sync, recalculation, and warehouse publication do not acquire runtime
ownership. Shutdown stops HTTP reconnects, timers, SSE clients, quota work,
watchers, and SQLite before releasing the lock, allowing an immediate restart.

**Restart after every rebuild.** A server keeps the code it started with, and a
one-shot command runs the build now on disk. After a rebuild the two can write the
same rows in different ways: an unrestarted server once kept billing Claude usage
the pre-fix way for hours while the fixed importer ran beside it. So the server
fingerprints its compiled modules and pricing tables at startup and records that
fingerprint in its `.runtime.lock`. When the build on disk changes:

- the app header shows **Restart needed**;
- `/api/health` reports `build.stale: true`, with the `started` and `current`
  fingerprints;
- the server logs a `[build]` warning once;
- any CLI command other than `serve` warns on stderr when the server on the same
  database runs a different build.

The fingerprint hashes content, so rebuilding the same source does not trigger it.
A server run from source (`pnpm dev`) reports `build.tracked: false`.

## Source Development

After upgrading the Codex lineage parser, preserve a closed database backup and
rehearse `amon sync sessions --source codex --force` on a separate database path
before reparsing the live projection. Unchanged files otherwise retain their old
null lineage; deploying the binary alone cannot classify that historical data.
Unknown source shapes remain unclassified. Reparse reads native files but never
modifies them. [Daily activity](../api/activity-contract.md#daily-conversation-activity)
is an aggregate read; inspect its response separately from the older
created-identity inventory.

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

Benchmark delivery is explicit; the session watcher does not watch OpenBench
result directories. After a scored campaign finishes, verify its sealed run with
OpenBench on the execution host, transfer the unchanged results JSONL privately
to the dashboard host, check its SHA-256 against the verified source, and run
`amon import benchmark /absolute/path/to/results.jsonl` there. Reimporting the
same study and cell is idempotent. Check `amon benchmarks list` or the Benchmarks
page for the expected study and cell count before calling delivery complete.
Keep qualification controls separate from scored studies.

Canonical Harbor rows use their embedded suite manifest hash as the study key
and suite ID as the label when top-level study fields are absent. Malformed
Harbor identities are skipped instead of grouped under the shared `suite-runs`
directory. Explicit row identity and `--study` retain their precedence; ordinary
legacy rows retain the directory-name fallback. The importer reads identity but
does not verify OpenBench's seals or promote results to publishable evidence.
Re-importing a canonical Harbor file from the directory it was first imported
from replaces each cell an older importer stored under that directory's name
(`legacy_rows_replaced` in the summary), so the collapsed `suite-runs` study
disappears. A file moved to a differently named directory cannot match those
rows; re-import it from a directory with the original name.

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

## Storage Maintenance

Three things keep the database from growing without bound:

- **WAL cap.** Every connection sets `journal_size_limit` to 64 MB, so a checkpoint
  truncates the WAL back to that size after a burst of writes. Without the limit,
  SQLite keeps the WAL at its largest size indefinitely.
- **Search-index merge.** Deleted or replaced messages leave dead entries in the
  FTS index until a merge reaches them. The server merges the index in bounded
  steps 10 minutes after startup and every 6 hours, pausing between steps so
  requests and file events are served meanwhile. On a clean index a run is one
  step that finds nothing. Before this existed, one store's index had grown to
  13 times its rebuilt size, with 93% of it dead entries.
- **Explicit compaction.** Free pages stay inside the file until a `VACUUM`. That
  only runs when you ask for it.

Check the current state at any time; this is read-only and safe while the server
runs (from a checkout, `pnpm --silent verify probe reclaim --json` also projects
what a compaction would free, without stopping anything; see
[Probing the installed service](#probing-the-installed-service)):

```bash
amon database storage
```

It reports the database, WAL, free-page and search-index sizes. Reading a bloated
search index takes a while, since every page of it is visited.

To return free pages to the filesystem, stop the server, then compact:

```bash
amon database compact --backup /absolute/private/path/before-compact.db
```

The command takes runtime ownership, so it refuses while a server owns the
database and a server cannot start partway through. It first writes a validated
backup (the same checks as `amon database backup`, and it never replaces an
existing file), then merges the search index fully, runs `VACUUM`, truncates the
WAL, and runs `quick_check`. The volume holding the database needs about twice the
database's size free for the rewrite, plus its size again when the backup is on
the same volume, and the backup's volume needs room for the backup; the command
checks both before writing anything. On one multi-gigabyte
store it took under three minutes and roughly halved the file. Keep the backup
until the restarted server looks right.

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

The repair also bills each transcript line once when several rows hold it:

- a line stored under both its uuid id and its positional id keeps the uuid row;
- a resumed session's transcript repeats its predecessor's lines with the same
  uuids, and the copy in the transcript it was resumed from keeps the line.
  Resuming copies the whole history, so the source is the transcript whose
  lines all appear in the other; when neither contains the other (the original
  was used again after the resume) both copies are reported as ambiguous;
- a positional id that a transcript and one of its child agents both minted
  belongs to the transcript once every child line that bills something has a
  row of its own. The repair corrects only token and cost columns, so a row the
  child wrote (its timestamp and model) is zeroed when the transcript's line
  bills nothing, and is otherwise left ambiguous rather than given the
  transcript's tokens under the child's provenance.

A row that now bills different, non-zero tokens keeps a reported cost; an
estimated cost is recomputed from the new tokens. On a store older than cost
provenance, the repair first labels each unlabelled cost as estimated or
reported, the same way startup does, so that comparison runs against the tokens
the cost was written for.

Each turn is billed with the usage on its **last** line. Every line of a turn
repeats its input and cache counts; a main transcript repeats the final output
count as well, but a child agent's transcript records output block by block, so
only its last line is final. The importer refreshes a turn it stored while the
turn was still being written, and the repair brings older rows up to the final
count.

To check imported cost against Claude Code's own accounting, run
`amon costs check-claude-sessions`. It compares each session the statusline
bridge has reported with the imported cost for the same process window; a
ratio a little under 1 is expected, and one near 2 would mean lines are being
counted per content block again. No ratio is given while any imported row in
the window has usage but no cost (an unpriced model), since the sum would skip
it and read low.

The repair also fills in the 1-hour part of each row's cache writes. Claude
transcripts split each request's cache writes into a 5-minute and a 1-hour part
(`message.usage.cache_creation`), and the 1-hour part bills at 2x input rather
than 1.25x. Rows imported before schema v15 carry no split, so they bill every
cache write at the 5-minute rate. The repair takes the split from the transcript
and re-estimates an `estimated` cost; a reported cost is kept. Token totals do not
change. `rows_split_1h` counts these rows, and `cost_reclaimed_usd` is net, so it
goes negative when the raised costs outweigh the reclaimed ones. A row whose
transcript records no split, or whose transcript is gone, is left as it is.

Applying also re-derives `session_trace_summary` for every repaired session:
that rollup stores its own token and cost totals, the trace-quality API and
warehouse export read it directly, and startup backfill skips rows already at
the current projection version.

Two classes of row are reported rather than repaired, because neither has an
unambiguous source:

- `rows_without_transcript` — the file is gone. Event history outlives its
  transcripts, and a missing source is not evidence of anything.
- `rows_ambiguous` — transcripts disagree on what an `event_id` holds. A
  child-agent transcript embeds its parent's `sessionId` and positional ids
  derive from (session, line index), so parent and child collide on the same
  line number. The id is the parent's once the child's line has a row of its
  own; until then the row may be the child's only record. A row the child
  wrote also stays ambiguous when the parent's line bills something.

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
them. The same holds for transcripts restored from a backup to their original
paths: `import_state` still has each one at the hash it was imported with, so
restore first, then force the import. Expect totals to **rise** here: this
imports events that were never stored, and it gives dropped child lines the
rows of their own that let the repair settle their collisions.

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
them separately: `rows_ambiguous` (transcripts that disagree on an id)
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
left as stored. A rollout that cannot prove which session it owns, or that has
a line that does not parse, is counted in `sessions_unreconciled` and gets
insert-only import as before. A failed session rolls back on its own. It is listed in
`sessions_failed` and the CLI exits with partial success. Rerunning finishes it.

**Measured shape.** This was rehearsed on 2026-09-24 against a copy of a local
store and a snapshot of its rollouts:
- the changed subagents moved from 140–810× OTEL to 0.976–0.994×;
- every changed plain session landed on its rollout's own counter, apart from
  the few whose counter restarts mid-session, which that check skips;
- the Codex Monitor total fell by about 45%;
- a second apply changed nothing.

### Pricing a newly released model

An unpriced model bills as **$0**, not as an error, and its rows keep a NULL
cost. To catch one early, the app header shows an **unpriced models** notice,
`/api/health` lists them under `pricing.unpriced_models`, and the server log
warns once per new set; each covers usage from the last 7 days. Add the rate
from the vendor's live pricing page, never from a multiplier: recent models
break the usual cache ratios. Rates load once from the build, so a pricing update reaches the server
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

### Disposable compiled-app verification

The development-only `pnpm verify` CLI provides known fixtures, browser checks,
and inspectable evidence. Build first; the driver uses `tsx`, but the application,
watcher, schema, queries, and frontend come from the compiled outputs. See the
[pilot framing](../design/2026-10-01-verification-cli-pilot-design.md) for goals and
extraction criteria. `pnpm verify --help` owns exact syntax and exit codes;
`pnpm --silent verify list --json` is the executable workflow map.

```bash
pnpm build
pnpm exec playwright install chromium # once, if not already available
pnpm --silent verify run live-session --json
pnpm --silent verify run usage --json
```

Each one-shot run starts its own loopback app and stops it after verification,
failure, or handled interruption. Live verification appends a synthetic Claude
JSONL message and observes the real watcher, projection, API, and browser update
without a reload. Usage verification seeds 1,000 events plus session metadata,
checks independently known totals, and changes the browser's project filter.
It tests aggregation/rendering, not usage ingestion or real provider pricing.

For exploration, `pnpm --silent verify start --json` returns a URL and session
directory. Open that URL with ordinary browser tools; `advance <directory>` adds
a synthetic transcript message. `run <scenario> --session <directory>` checks
that instance and leaves it running. `inspect <directory>` reads evidence or
queries session state; `stop <directory>` confirms shutdown and is repeatable.
Control uses a session-specific local token, not a stored PID. Concurrent runs
against the same session are refused. If a runner is forcibly killed, stop that
session and start another rather than bypassing its stale lock.

The host uses a disposable SQLite database and explicit fixture directories,
without inheriting application overrides or provider credentials. It expires
after one hour. This exercises `createApp` and the watcher, **not** full
`amon serve` startup, Portless, external hooks, provider authentication, or the
installed service. It is not an OS sandbox for arbitrary code. Keep exploration
to synthetic inputs; evidence may contain anything submitted to this instance.

Every run writes schema-versioned `result.json`, API observations, browser logs,
screenshots, and a Playwright trace when available. It identifies the Git revision
and dirty state, hashes of compiled trees/verifier/benchmark/lockfile, browser,
host, individual checks, errors, and cleanup status. Builds changed since session
start are refused; source freshness is not inferred from a build hash. Rebuild
before testing a source change, then start a new session. Missing prerequisites
are `blocked`; later checks remain `not_run`. A green result covers only the
named workflow and build. Inspect the recorded paths or use
`pnpm exec playwright show-trace <trace.zip>`.

Usage records endpoint warmups and five measured samples using the existing
benchmark, separately from single browser navigation/filter-to-asserted-card
observations. Browser timings include automation overhead and are not statistical
latency estimates. There is no default performance gate. Optional usage thresholds
apply to the API median and browser filter sample; choose them for a named host
and fixture, not as a production guarantee.

Sessions and evidence live under the OS temporary directory with owner-only
access. Stopping releases processes, ports, watchers, and database handles;
it deliberately retains files so failures remain inspectable. Copy evidence you
need to keep, then remove the exact stopped session/evidence directories when
finished. There is no promised OS retention interval or automatic disk quota.
Runs have a two-minute deadline; a hard-killed runner may leave its host until
the one-hour expiry. Startup failure logs remain at the path in the error.

### Probing the installed service

`pnpm --silent verify probe <name> --json` investigates the real install rather
than a fixture. By default it reads the database of the globally linked `amon`
(its checkout's `data/agentmonitor.db`); `--db <path>` names another file. See the
[pilot framing](../design/2026-10-01-verification-cli-pilot-design.md) for why
probes may read it and the rules they follow.

```bash
pnpm build
pnpm --silent verify probe health --json                     # build/staleness, listener, DB and WAL sizes
pnpm --silent verify probe ingestion --json                  # import/watcher state of discoverable transcripts
pnpm --silent verify probe monitor-stats --agent codex --json # per-statement timing and query plan
pnpm --silent verify probe snapshot --json                   # disposable copy for probes that write
pnpm --silent verify probe resync <transcript.jsonl> [--db <snapshot>] --json
pnpm --silent verify probe plans --db <snapshot> --index-sql 'CREATE INDEX ...' --json  # index impact
pnpm --silent verify probe hotspots --db <snapshot> --json   # slowest reads behind the routes
pnpm --silent verify probe reclaim --json                    # what database compact would free
pnpm --silent verify probe index-audit --json                # which events indexes statements still need
```

Read probes open the database `readonly` with `query_only` in a child process
that is killed, with anything it started, at its deadline (`--timeout-ms`
overrides the per-probe default), so a slow statement cannot hold a WAL snapshot
open indefinitely. `resync` writes
only to a fresh scratch database, removed afterwards, or to a snapshot directory
created by `probe snapshot`; any other `--db` is refused. A snapshot needs free
temporary space of twice the database size and stays until you remove its
directory; one that fails or is interrupted mid-copy is removed. Re-sync needs a
transcript of at least two lines, one kept and one appended.

`plans` measures an index's effect before it ships. On a snapshot it runs the
compiled app's startup migrations, creates the `--index-sql` candidate (or uses an
existing `--index NAME`), drives a built-in list of read routes, and records
each statement that touches the index's table. It compares plans with the index
present and with it dropped inside a rolled-back transaction, then times and
reports the statements whose plans change. Use it to find
regressions elsewhere, not only the read the index targets. It reports truncated
SQL and plans, not results; the route list is a sample, so a statement reached
only by other routes or by writes is not compared. Both this probe and `hotspots`
save the statements they recorded, with their parameters (identifiers such as
session ids), to `sql-corpus/routes.jsonl` in the evidence directory for
`index-audit`. Like
`resync`, it refuses any `--db` that is not a snapshot from `probe snapshot`.
`--index-sql` accepts exactly one `CREATE INDEX` or `CREATE UNIQUE INDEX`
statement, parsed by SQLite before execution; SQL scripts and other operations
are rejected. It must create a new index in the snapshot's main database. Use
`--index` to compare an existing index, including one already shipped by startup
migrations.

`hotspots` finds where reads spend their time. It drives the same routes on a
snapshot, records every distinct read statement they run, on any table, and then
times (three warm runs) and explains each one on a read-only connection. It lists
the 25 slowest, each with its route, truncated SQL, plan, and hints from the plan:
`aggregate_row_lookups` (a count or sum whose index does not cover the columns it
filters, so every match costs a table lookup), `row_lookups`, `temp_btree`, and
`full_scan`. The hints rank what to look at; they are not verdicts. Run it after an
index or query change, and when a route is slow but its own statements look fast in
isolation. The same snapshot and route-list limits as `plans` apply.

Both probes report `attempted_routes`, HTTP failures in `failed_routes` (`-1`
means the request failed without a response), and an explicit `coverage` summary.
`complete` means this built-in sample finished, not that every product route or
query was covered. A failed route or statement makes coverage `partial`;
statement failures include the route, truncated SQL, and error. An `observed`
result can have partial coverage: inspect it before interpreting no changes or
no hotspots as evidence. For example, a query using `INDEXED BY` cannot be
compared after its required index is dropped.

`reclaim` answers whether `amon database compact` is worth a stop. It copies the
database through the online backup API (a read, like `snapshot`), runs compact's
own steps on the copy (a full search-index `optimize`, `VACUUM`, and a WAL
checkpoint), and reports current against projected sizes and the reclaimable
bytes. The parent deletes the copy when the probe ends, even if the worker failed
or was killed, so nothing with database content is left behind. It needs free
temporary space of about twice the database size. Timings are for the copy, not
for compact on the installed database, which also writes and validates a backup.

`index-audit` asks which indexes on a table (`--table`, default `events`) the
app's statements still need. It runs the unit test suite with a preload that
records each distinct statement, writers included, along with those its plan
tests explain (a plan test pins a query shape on purpose). It then copies the
installed database's schema, without rows, into the evidence directory. The
app never runs `ANALYZE`, so SQLite plans from the schema alone; the probe checks
that by requiring every statement to plan identically on the copy and on the
real database, and leaves out and reports any that do not. On the copy it drops
each index in turn, inside a rolled-back transaction, and compares every
statement's plan, not only the plans that name the index: a partial index can
steer the planner without appearing in a plan. A plan is worse when it gains a
full scan, a temporary sort, row lookups, an automatic index, fewer indexed
search terms, a search that no longer constrains a column it did (as many
terms, far more rows), or trades a partial index for a full one, or when the
statement no longer prepares (`INDEXED BY`). Each index is reported as `constraint`
(unique, never proposed), `unused`, `replaceable`, or `needed`, with its size.
`plan_tests_only` marks one held only by a shape a plan test explains, which may
be a stale copy of a rewritten query. The proposed `drop_set` adds unused and
then replaceable indexes, largest first, re-checking every statement against
the whole set, so two indexes that only stand in for each other are not both
dropped. The recorded suite gets its own temp directory in the evidence
directory, removed when the probe ends even if the deadline killed it. Add the
route reads of a `hotspots` or `plans` run with
`--corpus <evidence>/sql-corpus` (repeatable, replacing the test run). The audit
compares plans, not timings; time a candidate's affected reads with `plans
--index` on a snapshot before dropping it.

Monitor-stats and hotspots name their timing sum `sum_statement_medians_ms`.
It adds separately measured statement medians; it is not endpoint latency or a
representative workload duration. Hotspots deduplicates reads by SQL and
parameters and reports the first route that encountered each one, rather than
weighting statements by production frequency.

Health reports `database_size_matches` as a size comparison only;
`target_matches_running_server` stays `unknown`. Equal sizes do not identify the
server's database.

Ingestion resolves `--claude-dir` and `--codex-home` first, then the caller's
`AGENTMONITOR_CLAUDE_DIR` / `CODEX_HOME`, then home-directory defaults. Repeat
`--exclude PATTERN` to override `AGENTMONITOR_SYNC_EXCLUDE_PATTERNS`; `--exclude
""` clears exclusions. Relative roots resolve against the invocation directory.
The result records the resolved roots and exclusions in `observations.discovery`.
These are the probe's settings, not verified settings of the running server;
provide the service's scope when investigating its ingestion state.

Re-sync removes its copied transcripts and scratch database after success,
failure, deadline expiry, or handled interruption. Parent-side cleanup runs after
the worker exits, including when it is killed. `--retain-transcripts` explicitly
keeps the transcript copies for debugging; `content_artifacts` lists those paths
and any retained snapshot. Explicit snapshots are never deleted by re-sync.
If the parent itself is forcibly killed, cleanup cannot run: inspect and remove
its evidence directory manually. The `cleanup` field reports cleanup failure
rather than claiming the content was removed.

Results use the run evidence layout (`result.json` under an
`agentmonitor-evidence-*` directory) and add the target kind, path, and file sizes
before and after. `monitor-stats` times the statements the endpoint itself runs on
a separate connection with the server's page cache size; it omits the idle-session
update the endpoint performs and does not go through HTTP. Structured observations
contain counts, timings, plans, and scope metadata rather than transcript bodies.
Explicitly retained transcripts and snapshots contain real content; worker logs
are diagnostic output, not a sanitized export. Keep evidence from a real store
out of public issues and commits.

`pnpm test:verify` type-checks the driver and exercises lifecycle isolation,
interruption, real browser workflows, missing prerequisites, explicit timing
failure, and a wrong-but-plausible compiled aggregation mutation. It temporarily
modifies a local `dist` file and restores it; run it serially without concurrent
builds or other verification against that checkout. Its probe tests run against
fixture databases from the disposable host, never the installed one. The normal
tests do not require Chromium or a built app; they cover the probes' read-only
opener and target guards.

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
