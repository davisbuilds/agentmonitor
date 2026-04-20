# Operations

This document owns local development, runtime commands, environment variables, and testing workflow.

Related docs:

- Root overview and fastest setup: [../../README.md](../../README.md)
- Product/capability reference: [FEATURES.md](FEATURES.md)
- Architecture and code map: [ARCHITECTURE.md](ARCHITECTURE.md)
- API navigation: [../api/README.md](../api/README.md)
- Claude Code integration details: [../../hooks/claude-code/README.md](../../hooks/claude-code/README.md)
- Codex integration details: [../../hooks/codex/README.md](../../hooks/codex/README.md)

## Local Development

```bash
pnpm install
pnpm dev          # terminal 1: server in watch mode
pnpm frontend:dev # terminal 2: Svelte app at :5173 with API proxy
pnpm css:watch    # optional terminal 3: shared Tailwind output for legacy / and built /app/
```

Open `http://127.0.0.1:3141` or `http://127.0.0.1:5173/app/`.

## Useful Commands

```bash
pnpm build              # TypeScript build + CSS build
pnpm start              # Run compiled server from dist/
pnpm test               # Run self-contained TypeScript tests (excludes parity)
pnpm test:watch         # Watch-mode self-contained test runner
pnpm test:parity:ts     # Run isolated TypeScript parity tests (temp server + temp DB)
pnpm test:v2:contract:ts # Run isolated black-box tests for the canonical TS /api/v2 contract
pnpm test:parity:ts:live # Run parity tests against a running TS server on :3141
pnpm test:parity:rust   # Run parity tests against a running Rust server on :3142
pnpm rust:dev           # Run the Rust backend directly on :3142
pnpm rust:test          # Run the Rust backend test suite
pnpm rust:test:runtime-invariants # Run Rust runtime-host invariants
pnpm lint               # ESLint
pnpm seed               # Send demo events (server must be running)
pnpm run import         # Import historical sessions
pnpm bench:ingest       # Ingest throughput benchmark
pnpm recalculate-costs  # Recalculate costs from pricing data
```

## Environment Variables

All optional with sensible defaults:

| Variable | Default | Used For |
|----------|---------|----------|
| `AGENTMONITOR_PORT` | `3141` | HTTP listen port |
| `AGENTMONITOR_HOST` | `127.0.0.1` | HTTP bind address |
| `AGENTMONITOR_DB_PATH` | `./data/agentmonitor.db` | SQLite database path |
| `AGENTMONITOR_MAX_PAYLOAD_KB` | `10` | Max metadata payload size |
| `AGENTMONITOR_SESSION_TIMEOUT` | `5` | Minutes before session goes idle |
| `AGENTMONITOR_MAX_FEED` | `200` | Max events in feed |
| `AGENTMONITOR_STATS_INTERVAL` | `5000` | Stats broadcast interval (ms) |
| `AGENTMONITOR_MAX_SSE_CLIENTS` | `50` | Max concurrent SSE connections |
| `AGENTMONITOR_SSE_HEARTBEAT_MS` | `30000` | SSE heartbeat interval (ms) |
| `AGENTMONITOR_PROJECTS_DIR` | auto-detected from cwd ancestry | Workspace root used for git branch resolution |
| `AGENTMONITOR_ENABLE_LIVE_TAB` | `true` | Shows the Svelte `Live` tab |
| `AGENTMONITOR_CODEX_LIVE_MODE` | `otel-only` | Codex live fidelity mode (`otel-only`, reserved `exporter`) |
| `AGENTMONITOR_LIVE_CAPTURE_PROMPTS` | `true` | Capture or redact live prompt payloads |
| `AGENTMONITOR_LIVE_CAPTURE_REASONING` | `true` | Capture or redact live reasoning payloads |
| `AGENTMONITOR_LIVE_CAPTURE_TOOL_ARGUMENTS` | `true` | Capture or redact tool-call input arguments |
| `AGENTMONITOR_LIVE_DIFF_PAYLOAD_MAX_BYTES` | `32768` | Payload cap for diff-style live records |
| `AGENTMONITOR_SYNC_EXCLUDE_PATTERNS` | unset | Comma-separated path patterns to ignore during historical discovery, import, and watcher resync |

Benchmark overrides: `AGENTMONITOR_BENCH_URL`, `AGENTMONITOR_BENCH_MODE`, `AGENTMONITOR_BENCH_EVENTS`, `AGENTMONITOR_BENCH_CONCURRENCY`, `AGENTMONITOR_BENCH_BATCH_SIZE`.

## Hook Installation

### Claude Code

```bash
./hooks/claude-code/install.sh
```

Restart Claude Code after installing. See [../../hooks/claude-code/README.md](../../hooks/claude-code/README.md) for details.

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
pnpm run import --source claude-code    # Claude Code JSONL logs
pnpm run import --source codex          # Codex session files
pnpm run import --dry-run               # Preview without writing
```

Operational notes:

- Full imports update `import_state` even when a file produced zero events, so unchanged unsupported/non-interactive files are skipped on later full imports.
- Date-scoped imports intentionally do not update the skip cache because they only process part of each file.
- Excluded paths are ignored before hashing or parsing, and they do not create `import_state` or `watched_files` rows.

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

1. Start the server with `pnpm dev` and the Svelte app with `pnpm frontend:dev`.
2. Open `/app/` and confirm the `Live` tab appears when `AGENTMONITOR_ENABLE_LIVE_TAB=true`.
3. Confirm the live settings banner matches your env for prompt, reasoning, and tool-argument capture.
4. Start a Claude session and verify new items appear without a full page reload.
5. If prompts or reasoning are disabled, confirm the inspector shows redacted payloads rather than raw content.
6. For Codex, treat `otel-only` sessions as summary-only until a richer exporter-backed path exists.
