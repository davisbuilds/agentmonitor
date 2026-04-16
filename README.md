# AgentMonitor

Local dashboard and session browser for observing AI coding agents across live telemetry, tool activity, costs, and session history.

## What It Does

- Serves the canonical Svelte app at `/app/` for Monitor, Live, Sessions, Analytics, Usage, and Search.
- Accepts live ingest from Claude Code hooks, Codex OTEL export, or generic HTTP event producers.
- Watches local Claude session files and imports historical Claude Code and Codex sessions into SQLite.
- Streams live updates over SSE for dashboards and operator views.
- Exposes capability-aware analytics under `/api/v2/analytics/*`, including summary, activity, project, tool, hour-of-week, top-session, velocity, and per-agent views.
- Exposes event-derived historical usage under `/api/v2/usage/*`, including summary totals, daily series, project/model/agent attribution, and top sessions with coverage metadata.

## Current Product Shape

- Canonical UI and app contract: `/app/` + `/api/v2/*`
- Transitional compatibility surface: legacy dashboard at `/`
- Alternate runtime under evaluation: `rust-backend/`

## Quick Start

Requirements:

- Node.js `24.13.0`
- `pnpm` `10.29.3+`

Install and run the canonical dev flow:

```bash
nvm use
pnpm install

# terminal 1
pnpm dev

# terminal 2
pnpm frontend:dev

# terminal 3 if you are touching shared Tailwind output or the legacy dashboard
pnpm css:watch
```

Open:

- `http://127.0.0.1:5173/app/` for Vite-powered frontend development
- `http://127.0.0.1:3141/app/` for the Express-served canonical app
- `http://127.0.0.1:3141/` only for legacy compatibility work

If you want the Express-served `/app/` to refresh as you edit frontend code, run `pnpm frontend:watch`.

## Common Commands

```bash
pnpm build
pnpm test
pnpm run import --source claude-code
pnpm run import --source codex
```

Full command, config, and runtime notes live in [docs/system/OPERATIONS.md](docs/system/OPERATIONS.md).

## Integrations

- Claude Code hooks: [hooks/claude-code/README.md](hooks/claude-code/README.md)
- Codex OTEL setup: [hooks/codex/README.md](hooks/codex/README.md)
- Generic ingest contract: [docs/api/event-contract.md](docs/api/event-contract.md)
- Historical import and runtime behavior: [docs/system/OPERATIONS.md](docs/system/OPERATIONS.md)

## Documentation

Start with [docs/README.md](docs/README.md) for the full docs map.

- Product and capability overview: [docs/system/FEATURES.md](docs/system/FEATURES.md)
- Local development and runtime operations: [docs/system/OPERATIONS.md](docs/system/OPERATIONS.md)
- Architecture and code organization: [docs/system/ARCHITECTURE.md](docs/system/ARCHITECTURE.md)
- API docs and contracts: [docs/api/README.md](docs/api/README.md)
- Roadmap and project direction: [docs/project/ROADMAP.md](docs/project/ROADMAP.md)
- Contributor workflow: [CONTRIBUTING.md](CONTRIBUTING.md)
- Agent implementation guidance: [AGENTS.md](AGENTS.md)

## Notes

- The Svelte app is the product surface to extend. The legacy `/` dashboard is still served, but should not define new behavior.
- Some Monitor features still read v1 endpoints today, while Sessions, Search, Analytics, Usage, and Live center on `/api/v2/*`.
- Analytics responses now include coverage metadata so the UI can distinguish “all matching sessions” from capability-limited slices like tool analytics.
- Usage responses include coverage metadata so the UI can distinguish usage-bearing events from matching events that carry no cost or token data.
- The Rust backend is real and tested, but it is still converging on the same canonical `/app/` + `/api/v2/*` surface.
