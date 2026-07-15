# Operations

This document owns local development, runtime commands, environment variables, and testing workflow.

Related docs:

- Root overview and fastest setup: [../../README.md](../../README.md)
- Product/capability reference: [FEATURES.md](FEATURES.md)
- Architecture and code map: [ARCHITECTURE.md](ARCHITECTURE.md)
- API navigation: [../api/README.md](../api/README.md)
- Claude Code integration details: [../../hooks/claude-code/README.md](../../hooks/claude-code/README.md)
- Codex integration details: [../../hooks/codex/README.md](../../hooks/codex/README.md)

## Operator Startup

```bash
pnpm build
pnpm link --global
amon serve
```

`amon serve` is the single launcher for the built product. It runs Express on
the fixed `127.0.0.1:3141` backend and uses the pinned, package-local Portless
CLI to expose `https://agentmonitor.localhost`. The named root redirects to
`/app/`; direct `http://127.0.0.1:3141/` retains the legacy compatibility
dashboard. Hooks, OTEL exporters, and direct API clients stay on `:3141`.

Portless starts its HTTPS proxy automatically and may request local-CA trust on
first use. `amon serve --no-portless` bypasses the named HTTPS origin and starts
only the direct backend. Ctrl-C shuts down the runtime and removes its Portless
route.

## Source Development

```bash
pnpm install
pnpm dev          # terminal 1: server in watch mode
pnpm frontend:dev # terminal 2: Svelte app at :5173 with API proxy
pnpm css:watch    # optional terminal 3: shared Tailwind output for legacy / and built /app/
```

Open `http://127.0.0.1:3141/app/` or `http://127.0.0.1:5173/app/` in this
source/HMR workflow.

## Useful Commands

```bash
pnpm build              # TypeScript build + CSS build
pnpm start              # Run compiled server from dist/
pnpm cli -- --help      # AgentMonitor CLI help during local development
pnpm cli -- health      # Check the local TypeScript server
pnpm cli -- sessions list --json # Query session history from SQLite
pnpm test               # Run self-contained TypeScript tests (excludes parity)
pnpm test:watch         # Watch-mode self-contained test runner
pnpm test:parity:ts     # Run isolated TypeScript parity tests (temp server + temp DB)
pnpm test:v2:contract:ts # Run isolated black-box tests for the canonical TS /api/v2 contract
pnpm test:parity:ts:live # Run parity tests against a running TS server on :3141
pnpm lint               # ESLint
pnpm seed               # Send demo events (server must be running)
pnpm run import         # Import historical sessions
pnpm reclaim:trace-quality # Drop the old trace-quality warehouse tables + VACUUM (opt-in)
pnpm reparse:sessions   # Force reparse Claude session-browser history
pnpm reparse:codex-sessions # Force reparse Codex session-browser history
pnpm bench:ingest       # Ingest throughput benchmark
pnpm recalculate-costs  # Recalculate costs from pricing data
```

## AgentMonitor CLI

The package exposes two equivalent executables after build or installation:
`amon` and `agentmonitor`. Use `amon` as the short preferred form in examples;
`agentmonitor` exists for explicitness and package-name discoverability.

During local development, use `pnpm cli -- ...` to run the TypeScript entrypoint
without installing the package:

```bash
pnpm cli -- --help
pnpm cli -- serve
pnpm cli -- serve --no-portless
pnpm cli -- health --url http://127.0.0.1:3141
pnpm cli -- status --json
pnpm cli -- open

pnpm cli -- import --source claude-code --dry-run
pnpm cli -- sync sessions --source codex --force
pnpm cli -- costs recalc --dry-run
pnpm cli -- quality traces --json
pnpm cli -- warehouse publish --dry-run --json

pnpm cli -- sessions list --json
pnpm cli -- sessions show <session-id>
pnpm cli -- sessions search "deploy model"
pnpm cli -- live watch
pnpm cli -- live watch --kinds user_message,tool_call

pnpm cli -- usage summary --days 7
pnpm cli -- analytics tools --limit 20
pnpm cli -- quality findings --severity high

pnpm cli -- hooks install claude --dry-run
pnpm cli -- hooks print-codex-config
```

Built package examples:

```bash
pnpm build
node --import tsx --test tests/cli-e2e.test.ts
./dist/cli.js --help
amon --help          # after installing or linking the package
agentmonitor --help  # equivalent alias after installing or linking the package
amon serve           # https://agentmonitor.localhost, backed by 127.0.0.1:3141
```

The legacy package scripts remain compatibility wrappers. Prefer the CLI for new
operator docs and automation because it has consistent global flags such as
`--db-path`, `--url`, `--json`, `--plain`, `--quiet`, and `--no-input`.

## Environment Variables

All optional with sensible defaults:

| Variable | Default | Used For |
|----------|---------|----------|
| `AGENTMONITOR_PORT` | `3141` | HTTP listen port |
| `AGENTMONITOR_HOST` | `127.0.0.1` | HTTP bind address |
| `AGENTMONITOR_DB_PATH` | `<install-root>/data/agentmonitor.db` | SQLite database path. The default follows the install, not the shell, so `amon serve` reads the same DB from any directory. A value set here is used as given — a relative one is resolved against the working directory. |
| `AGENTMONITOR_MAX_PAYLOAD_KB` | `10` | Max metadata payload size |
| `AGENTMONITOR_SESSION_TIMEOUT` | `5` | Minutes before session goes idle |
| `AGENTMONITOR_MAX_FEED` | `200` | Max events in feed |
| `AGENTMONITOR_STATS_INTERVAL` | `5000` | Stats broadcast interval (ms) |
| `AGENTMONITOR_MAX_SSE_CLIENTS` | `50` | Max concurrent SSE connections |
| `AGENTMONITOR_SSE_HEARTBEAT_MS` | `30000` | SSE heartbeat interval (ms) |
| `AGENTMONITOR_PROJECTS_DIR` | auto-detected from cwd ancestry | Workspace root used for git branch resolution |
| `AGENTMONITOR_USAGE_BUDGETS_PATH` | `./config/budgets.json` | Optional local JSON config for read-only usage budget reports |
| `AGENTMONITOR_WAREHOUSE_DSN` | unset | Postgres DSN for explicit `warehouse publish`; unset disables live publish |
| `AGENTMONITOR_WAREHOUSE_ACCOUNT` | `local` | Account label published as the warehouse identity grain |
| `AGENTMONITOR_WAREHOUSE_SCHEMA` | `agentmonitor` | Postgres schema for `runs` and `publish_run` |
| `AGENTMONITOR_WAREHOUSE_BI_ROLE` | `medallion_bi` | Optional BI read role granted on the `agentmonitor` schema when present |
| `AGENTMONITOR_ENABLE_LIVE_TAB` | `true` | Shows the Svelte `Live` tab |
| `AGENTMONITOR_CODEX_LIVE_MODE` | `otel-only` | Codex live fidelity mode (`otel-only`, reserved `exporter`) |
| `AGENTMONITOR_LIVE_CAPTURE_PROMPTS` | `true` | Capture or redact live prompt payloads |
| `AGENTMONITOR_LIVE_CAPTURE_REASONING` | `true` | Capture or redact live reasoning payloads |
| `AGENTMONITOR_LIVE_CAPTURE_TOOL_ARGUMENTS` | `true` | Capture or redact tool-call input arguments |
| `AGENTMONITOR_LIVE_DIFF_PAYLOAD_MAX_BYTES` | `32768` | Payload cap for diff-style live records |
| `AGENTMONITOR_SYNC_EXCLUDE_PATTERNS` | unset | Comma-separated path patterns to ignore during historical discovery, import, and watcher resync |
| `AGENTMONITOR_SKILL_CATALOG_DIRS` | `~/.claude/skills`, `$CODEX_HOME/skills` | Path-delimited (`:`) installed skill catalogs scanned for version attribution and never-fired detection by `/api/v2/analytics/skills/health` |

Benchmark overrides: `AGENTMONITOR_BENCH_URL`, `AGENTMONITOR_BENCH_MODE`, `AGENTMONITOR_BENCH_EVENTS`, `AGENTMONITOR_BENCH_CONCURRENCY`, `AGENTMONITOR_BENCH_BATCH_SIZE`.

## Hook Installation

### Claude Code

```bash
pnpm cli -- hooks install claude --dry-run
pnpm cli -- hooks install claude --force
```

The underlying installer remains available as
`./hooks/claude-code/install.sh`. Restart Claude Code after installing. See
[../../hooks/claude-code/README.md](../../hooks/claude-code/README.md) for
details.

### Codex

Print the recommended `~/.codex/config.toml` snippet:

```bash
pnpm cli -- hooks print-codex-config
```

The output is equivalent to:

```toml
[otel]
log_user_prompt = true

[otel.exporter.otlp-http]
endpoint = "http://localhost:3141/api/otel/v1/logs"
protocol = "json"

[otel.metrics_exporter.otlp-http]
endpoint = "http://localhost:3141/api/otel/v1/metrics"
protocol = "json"
```

The dev server must be running before starting a Codex session.

Current runtime note:

- `AGENTMONITOR_CODEX_LIVE_MODE=otel-only` is the only implemented Codex mode today.
- OTEL-only Codex data is suitable for summary observability, not `claude-esp`-style plan/diff/reasoning playback.
- The `exporter` mode name is reserved for a future richer Codex-side exporter.
- The session-browser watcher separately follows local Claude JSONL history under `~/.claude/projects` and local Codex history under `~/.codex/sessions`.
- The watcher and full historical import both maintain file-hash skip caches, so unchanged files that previously parsed to zero messages/events are not retried on every restart or periodic sync.
- `AGENTMONITOR_SYNC_EXCLUDE_PATTERNS` uses root-relative glob-style patterns. Bare names such as `vercel-plugin` match any path segment; path patterns such as `nested/sessions` match that subtree relative to the watched root.

For full setup and behavior notes, use [../../hooks/claude-code/README.md](../../hooks/claude-code/README.md) and [../../hooks/codex/README.md](../../hooks/codex/README.md).

## Historical Import

```bash
pnpm cli -- import --source claude-code    # Claude Code JSONL logs
pnpm cli -- import --source codex          # Codex session files
pnpm cli -- import --source antigravity    # Antigravity CLI conversation DBs (~/.gemini/antigravity-cli)
pnpm cli -- import --dry-run               # Preview without writing
pnpm cli -- sync sessions --source claude  # Rebuild browsing_sessions/messages/tool_calls from Claude JSONL
pnpm cli -- sync sessions --source codex   # Rebuild browsing_sessions/messages/tool_calls from Codex JSONL
pnpm cli -- costs recalc --dry-run         # Preview cost backfill
```

`--source antigravity` also accepts `--antigravity-dir <path>` to point at a
non-default `antigravity-cli` root (default `~/.gemini/antigravity-cli`).

Operational notes:

- `pnpm run import`, `pnpm reparse:sessions`, `pnpm reparse:codex-sessions`, and `pnpm recalculate-costs` remain compatibility wrappers around the CLI commands.
- Full imports update `import_state` even when a file produced zero events, so unchanged unsupported/non-interactive files are skipped on later full imports.
- Date-scoped imports intentionally do not update the skip cache because they only process part of each file.
- `pnpm cli -- import --source codex --force` refreshes event history and cost backfill, but it does not rebuild Codex session-browser `tool_calls`; use `pnpm cli -- sync sessions --source codex --force` when transcript-derived analytics such as inferred skill usage need to be backfilled.
- Antigravity has no `sync sessions` CLI subcommand: `import --source antigravity` writes events/usage/cost, and the running watcher projects the session-browser rows (`browsing_sessions` + `messages` + `session_items`, `integration_mode=antigravity-sqlite`, `fidelity=summary`) on startup and every periodic resync. There is no live file-tailing yet — new conversations appear on the next resync. Antigravity DBs are discovered recursively under `~/.gemini/antigravity-cli/conversations/**/*.db`.
- If historical rows still have `cost_usd = NULL` even though they already have `model` and token counts, rerun `pnpm cli -- costs recalc`; that backfills stale imports after pricing-data updates or importer fixes.
- Re-importing does **not** repair token counts on rows already in the DB: `insertEvent` dedups by `event_id` and skips existing rows (insert-only, no general upsert), and `--force` only bypasses the file-hash skip. One-shot corrections to already-stored rows must go through a `runDataMigrations` step in `src/db/schema.ts`. The narrow exception is Codex model attribution: deterministic duplicate import rows backed by an explicit JSONL `turn_context` may refresh only `model` and derived `cost_usd`, followed by a `session_trace_summary` rebuild; config-only legacy rows remain untouched.
- The cache-inclusive `tokens_in` repair (OpenAI/Codex rows that overstated cost by billing cached tokens at the full input rate) runs automatically once on next startup via the `user_version`-guarded migration; no manual command is needed. It re-normalizes `tokens_in` and recomputes `cost_usd` for OpenAI/Google rows and leaves Anthropic untouched.
- The GPT-5.6 upgrade runs another one-shot migration: Codex event-import hashes are invalidated, then the normal auto-import reparses those files and refreshes explicit per-turn model/cost attribution. Import output reports `events_refreshed`; no manual re-import is required when auto-import is enabled. With `--no-import` or a disabled auto-import interval, run `pnpm cli -- import --source codex --force` once after upgrading.
- Excluded paths are ignored before hashing or parsing, and they do not create `import_state` or `watched_files` rows.

## Trace Quality Reclaim

The trace-quality reframe (2026-06) removed the persisted trace/observation/score
/prompt warehouse; detail is now projected on-demand and only the lean
`session_trace_summary` is stored. An existing database keeps the old tables until
you reclaim them with an explicit, opt-in one-shot:

```bash
pnpm reclaim:trace-quality --dry-run  # report which warehouse tables would be dropped + row counts
pnpm reclaim:trace-quality            # DROP them + VACUUM to return the freed pages (~900 MB)
```

Operational notes:

- It drops `trace_quality_{traces,observations,scores,prompt_refs,observation_prompts,projection_state}` and VACUUMs. The dormant `trace_quality_export_state` seam and `session_trace_summary` are kept.
- It is **never run at startup** — a normal upgrade never rewrites a live DB. Run it when convenient; VACUUM needs a brief exclusive lock and temporary free disk (~the DB size).
- The dropped data is a pure derived projection: source `events`, `browsing_sessions`, `messages`, `session_items`, `session_turns`, and `tool_calls` are untouched, so the lean view is fully reconstructable.
- The summary self-heals on startup (`ensureSessionTraceSummaryBackfill` re-backfills any row at a stale version or with a NULL `trace_id`).
- The aggregate warehouse export is now the explicit `warehouse publish` command below. Langfuse trace/eval depth is still deferred; no `AGENTMONITOR_LANGFUSE_*` env vars ship yet. See [trace-quality.md](trace-quality.md#warehouse-aggregate-export).

## Warehouse Export

`amon warehouse publish` publishes the content-free `session_trace_summary`
aggregate to a shared Postgres warehouse. It is opt-in and CLI-only: normal
server startup, ingest, imports, and local dashboard use never require Postgres.

```bash
pnpm cli -- warehouse publish --dry-run --json
AGENTMONITOR_WAREHOUSE_DSN=postgresql://... pnpm cli -- warehouse publish
pnpm cli -- warehouse publish --date-from 2026-06-01 --date-to 2026-06-30
```

Contract:

- Live publish writes to `<schema>.runs` (default `agentmonitor.runs`) with one
  row per `(account, session_id)` and upserts on that key. It never removes a
  warehouse row if a local session is later redacted or deleted; tombstones are a
  separate future follow-up.
- Each invocation appends `<schema>.publish_run` lineage with the effective
  `account`, date window, published/suppressed counts, AgentMonitor version, and
  BI grant status.
- `AGENTMONITOR_WAREHOUSE_BI_ROLE` defaults to `medallion_bi`. The command checks
  `pg_roles` before granting and reports `grant_skipped` when the role is absent,
  so a fresh local Postgres can still publish successfully.
- `--dry-run` does not require `AGENTMONITOR_WAREHOUSE_DSN`; it prints planned
  SQL/counts and does not import or connect to `pg`.
- `--account` overrides the configured account label and emits a warning because
  re-publishing the same sessions under a different account can double-count in
  BI aggregates.
- `--min-batch` is only an operator guard against accidental tiny publishes. It
  is not a privacy control; this export is a per-session fact, not a k-anonymous
  aggregate.

Before mapping rows, the command runs the same summary self-heal as
`quality traces`; if any `session_trace_summary` row is stale or missing
`trace_id`, it can re-backfill all sessions from local source tables.

## CI

GitHub Actions workflow: `.github/workflows/ci.yml`

Current required check on `main` branch protection:

- `Lint, Build, Test`

The CI job runs:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm build`
- `pnpm test`

Parity tests are available for manual/shared-runtime verification but are not part of the required CI workflow.

## Runtime Artifacts

Do not commit: `data/`, `*.db`, generated CSS output in `public/css/output.css`.

## Manual Live Verification

1. Run `pnpm build`, then start the built runtime with `amon serve`.
2. Open `https://agentmonitor.localhost` and confirm it redirects to `/app/` and
   the `Live` tab appears when `AGENTMONITOR_ENABLE_LIVE_TAB=true`.
3. Confirm the live settings banner matches your env for prompt, reasoning, and tool-argument capture.
4. Start a Claude session and verify new items appear without a full page reload.
5. If prompts or reasoning are disabled, confirm the inspector shows redacted payloads rather than raw content.
6. For Codex, treat `otel-only` sessions as summary-only until a richer exporter-backed path exists.
