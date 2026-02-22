# Operations

## Local Development

```bash
pnpm install
pnpm dev          # terminal 1: server in watch mode
pnpm css:watch    # terminal 2: Tailwind CSS watch
```

Open `http://127.0.0.1:3141`.

## Useful Commands

```bash
pnpm build              # TypeScript build + CSS build
pnpm start              # Run compiled server from dist/
pnpm test               # Run test suite (node test runner)
pnpm test:watch         # Watch-mode test runner
pnpm lint               # ESLint
pnpm seed               # Send demo events (server must be running)
pnpm import             # Import historical sessions
pnpm bench:ingest       # Ingest throughput benchmark
pnpm recalculate-costs  # Recalculate costs from pricing data
```

## Environment Variables

All optional with sensible defaults:

| Variable | Default | Used For |
|----------|---------|----------|
| `AGENTSTATS_PORT` | `3141` | HTTP listen port |
| `AGENTSTATS_HOST` | `127.0.0.1` | HTTP bind address |
| `AGENTSTATS_DB_PATH` | `./data/agentstats.db` | SQLite database path |
| `AGENTSTATS_MAX_PAYLOAD_KB` | `10` | Max metadata payload size |
| `AGENTSTATS_SESSION_TIMEOUT` | `5` | Minutes before session goes idle |
| `AGENTSTATS_MAX_FEED` | `200` | Max events in feed |
| `AGENTSTATS_STATS_INTERVAL` | `5000` | Stats broadcast interval (ms) |
| `AGENTSTATS_MAX_SSE_CLIENTS` | `50` | Max concurrent SSE connections |
| `AGENTSTATS_SSE_HEARTBEAT_MS` | `30000` | SSE heartbeat interval (ms) |

Benchmark overrides: `AGENTSTATS_BENCH_URL`, `AGENTSTATS_BENCH_MODE`, `AGENTSTATS_BENCH_EVENTS`, `AGENTSTATS_BENCH_CONCURRENCY`, `AGENTSTATS_BENCH_BATCH_SIZE`.

## Hook Installation

### Claude Code

```bash
./hooks/claude-code/install.sh
```

Restart Claude Code after installing. See `hooks/claude-code/README.md` for details.

### Codex

Add to `~/.codex/config.toml`:

```toml
[otel]
log_user_prompt = true

[otel.exporter.otlp-http]
endpoint = "http://localhost:3141/api/otel/v1/logs"
protocol = "json"
```

The dev server must be running before starting a Codex session.

## Historical Import

```bash
pnpm import --source claude-code    # Claude Code JSONL logs
pnpm import --source codex          # Codex session files
pnpm import --dry-run               # Preview without writing
```

## CI

No CI pipeline. Quality gates are manual:

- `pnpm build` (TypeScript compilation).
- `pnpm test` (7 test files covering contracts, API, hooks, import, OTEL, pricing).
- `pnpm css:build` (if frontend styles touched).
- `GET /api/health` sanity check.

## Runtime Artifacts

Do not commit: `data/`, `*.db`, generated CSS output in `public/css/output.css`.
