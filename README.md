# AgentMonitor

Local dashboard and session browser for observing AI coding agents across live
telemetry, tool activity, costs, quota state, and historical session data.

## Agent Setup

New here? Paste the prompt below into your coding agent (Claude Code, Codex, etc.) and it will install, build, and verify the repo, then tell you how to launch the live dashboard.

```text
Set up the `agentmonitor` repo for me. It's a local dashboard for monitoring AI
coding agents — Node.js + TypeScript + Express + SQLite backend with a Svelte 5
frontend, all served on localhost.

Do this, in order:

1. Install deps. Use Node 24.13.0 (`nvm use` if nvm is present) and pnpm 10.29.3+;
   run `pnpm install` from the repo root. Clone
   https://github.com/davisbuilds/agentmonitor.git and cd in first if needed.

2. Configure env (optional — it runs without any secrets). Copy `.env.example` to
   `.env`; every `AGENTMONITOR_*` var already has a sensible default. The only
   optional secrets are for AI-generated insights: AGENTMONITOR_INSIGHTS_PROVIDER
   plus the matching provider key (OPENAI_API_KEY / ANTHROPIC_API_KEY /
   GEMINI_API_KEY). Leave them as placeholders unless I ask for insights.

3. Verify the build works WITHOUT any secrets: run `pnpm build` then `pnpm test`.
   Both should pass offline. If either fails, show me the error and stop.

4. Link the built CLI with `pnpm link --global`, then report back: confirm install
   + build + tests passed, note that AI insights are the only thing needing a
   key, and give me the launch command `amon serve`. Open
   https://agentmonitor.localhost; the first run may ask to trust Portless's
   local HTTPS certificate.

Don't commit anything.
```

Prefer to do it yourself? The manual steps are below.

## What It Does

- Serves the canonical Svelte app at `/app/` for Monitor, Live, Sessions, Pinned, Analytics, Usage, Insights, and Search.
- Accepts live ingest from Claude Code hooks, Codex OTEL export, or generic HTTP event producers.
- Watches local Claude and Codex session history and imports historical sessions into SQLite.
- Streams live updates over SSE for dashboards and operator views.
- Exposes canonical app APIs under `/api/v2/*`.
- Exposes a lean local trace-quality view (one trace per session) — a content-free per-session summary plus on-demand observation detail.
- Provides provider-native quota snapshots through `/api/provider-quotas`.
- Ships a local operator CLI. The preferred command is `amon`; `agentmonitor` is an equivalent executable alias.
- Supports optional persisted AI-generated insights grounded in analytics and usage coverage.
- Reports per-skill trigger health (invocations, never-fired, version-attributed misfire rate) via `/api/v2/analytics/skills/health`.

## Quick Start

Requirements:

- Node.js `24.13.0`
- pnpm `10.29.3+`

```bash
nvm use
pnpm install
pnpm build
pnpm link --global
amon serve
```

Open `https://agentmonitor.localhost`. Portless terminates local HTTPS and sends
traffic to the fixed AgentMonitor server on `127.0.0.1:3141`; the bare named URL
redirects to the canonical `/app/` surface. Hooks, OTEL exporters, and direct API
clients continue to use `http://127.0.0.1:3141`. Portless is pinned as an
AgentMonitor dependency, so no global Portless install is required. Use
`amon serve --no-portless` for direct-only startup.

For active frontend development with Vite HMR, keep the two-process workflow:

```bash
# terminal 1: Express server on :3141
pnpm dev

# terminal 2: Vite frontend with API proxy on :5173
pnpm frontend:dev
```

Open:

- `http://127.0.0.1:5173/app/` for Vite-powered frontend development.
- `http://127.0.0.1:3141/app/` for the Express-served canonical app.
- `http://127.0.0.1:3141/` only for direct legacy dashboard compatibility work.

If you want the Express-served `/app/` to refresh as you edit frontend code, run
`pnpm frontend:watch`. Run `pnpm css:watch` only when touching shared Tailwind
output for the legacy dashboard or built `/app/`.

## Common Commands

```bash
pnpm dev                         # TS server in watch mode
pnpm frontend:dev                # Svelte/Vite dev server
pnpm css:watch                   # Shared Tailwind output watcher
pnpm build                       # TS build + CSS + frontend build
pnpm start                       # Run compiled server
amon serve                       # Compiled runtime at https://agentmonitor.localhost
amon serve --no-portless         # Direct runtime on http://127.0.0.1:3141
pnpm cli -- --help               # CLI help during local development
pnpm cli -- health               # Check the local server
pnpm cli -- sessions list --json # Query session history from SQLite
pnpm cli -- import --dry-run     # Preview historical import
pnpm lint                        # ESLint
pnpm test                        # Node test runner suite
pnpm frontend:check              # Svelte check
pnpm run import --source claude-code # Compatibility wrapper for `amon import`
pnpm run import --source codex       # Compatibility wrapper for `amon import`
pnpm reparse:sessions                # Compatibility wrapper for `amon sync sessions`
pnpm reparse:codex-sessions          # Compatibility wrapper for `amon sync sessions`
```

Full command, config, parity, import, benchmark, and runtime notes live in
[docs/system/OPERATIONS.md](docs/system/OPERATIONS.md).

## Configuration

AgentMonitor runs locally without secrets. `.env` is optional because every
`AGENTMONITOR_*` variable has a default.

Common knobs:

- `AGENTMONITOR_PORT` / `AGENTMONITOR_HOST` for the TypeScript runtime bind.
- `AGENTMONITOR_DB_PATH` for the SQLite database location.
- `AGENTMONITOR_PROJECTS_DIR` for git branch/project resolution.
- `AGENTMONITOR_ENABLE_LIVE_TAB` and live capture/redaction flags.
- `AGENTMONITOR_SYNC_EXCLUDE_PATTERNS` for historical discovery/import ignores.

AI insight generation is optional and needs `AGENTMONITOR_INSIGHTS_PROVIDER` plus
the matching provider key. See [docs/system/OPERATIONS.md](docs/system/OPERATIONS.md)
for the full environment table.

## Integrations

- Claude Code hooks: [hooks/claude-code/README.md](hooks/claude-code/README.md)
- Codex OTEL setup: [hooks/codex/README.md](hooks/codex/README.md)
- Claude Code quota bridge: [hooks/claude-code/README.md#claude-statusline-quota-bridge](hooks/claude-code/README.md#claude-statusline-quota-bridge)
- Generic ingest contract: [docs/api/event-contract.md](docs/api/event-contract.md)
- Historical import and runtime behavior: [docs/system/OPERATIONS.md](docs/system/OPERATIONS.md)

## Code Layout

```text
src/api/              Express route handlers
src/cli/              Local operator CLI command modules
src/cli.ts            CLI executable entrypoint for amon and agentmonitor
src/contracts/        TypeScript event contract types and validation
src/db/               SQLite schema, migrations, queries, connection management
src/import/           Historical Claude/Codex importers
src/live/             Live session normalization and projection
src/otel/             OTLP JSON parser
src/pricing/          Model pricing and cost calculation
src/provider-quotas/  Provider-native quota polling/ingest
src/runtime.ts        Shared TypeScript runtime startup used by server and CLI
src/sse/              SSE client management and fan-out
src/watcher/          Session-history watcher and sync
frontend/             Svelte 5 `/app/` frontend
public/               Legacy dashboard assets
hooks/                Claude Code and Codex integration setup
tests/                Node test runner suite
docs/                 System, project, API, and plan docs
```

## Documentation

Start with [docs/README.md](docs/README.md) for the full docs map.

- Agent implementation guidance: [AGENTS.md](AGENTS.md)
- Product and capability overview: [docs/system/FEATURES.md](docs/system/FEATURES.md)
- Local development and runtime operations: [docs/system/OPERATIONS.md](docs/system/OPERATIONS.md)
- Architecture and code organization: [docs/system/ARCHITECTURE.md](docs/system/ARCHITECTURE.md)
- Local trace-quality layer: [docs/system/trace-quality.md](docs/system/trace-quality.md)
- API docs and contracts: [docs/api/README.md](docs/api/README.md)
- Current product/runtime state: [docs/project/CURRENT_STATE.md](docs/project/CURRENT_STATE.md)
- Roadmap and project direction: [docs/project/ROADMAP.md](docs/project/ROADMAP.md)
- Contributor workflow: [CONTRIBUTING.md](CONTRIBUTING.md)

## Current Boundaries

- Canonical product surface is Svelte `/app/` plus `/api/v2/*`.
- Legacy `/` remains on direct loopback access for compatibility; the Portless
  root redirects to `/app/`.
- TypeScript on `127.0.0.1:3141` is the runtime.
- Codex `otel-only` live data is summary-oriented; transcript-grade parity needs richer local-state integration.
- AI insight generation is optional and the only path that needs provider API keys.
