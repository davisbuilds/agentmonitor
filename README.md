# AgentMonitor

Local dashboard and session browser for observing AI coding agents across live telemetry, tool activity, costs, and session history.

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

4. Report back: confirm install + build + tests passed, note that AI insights are
   the only thing needing a key, and give me the launch commands: `pnpm dev`
   (terminal 1) and `pnpm frontend:dev` (terminal 2), then open
   http://127.0.0.1:5173/app/.

Don't commit anything.
```

Prefer to do it yourself? The manual steps are below.

## What It Does

- Serves the canonical Svelte app at `/app/` for Monitor, Live, Sessions, Pinned, Analytics, Usage, Insights, and Search.
- Accepts live ingest from Claude Code hooks, Codex OTEL export, or generic HTTP event producers.
- Watches local Claude session files and imports historical Claude Code and Codex sessions into SQLite.
- Streams live updates over SSE for dashboards and operator views.
- Exposes session-browser APIs under `/api/v2/sessions/*`, including bucketed transcript activity for minimap-style navigation in the Sessions viewer.
- Exposes pinned-message review APIs under `/api/v2/pins` and `/api/v2/sessions/:id/messages/:messageId/pin` for durable saved-review workflows.
- Exposes transcript search under `/api/v2/search` with recency/relevance sorting and session-context metadata for navigation-first search UIs.
- Exposes capability-aware analytics under `/api/v2/analytics/*`, including summary, activity, project, tool, skill, hour-of-week, top-session, velocity, and per-agent views.
- Exposes event-derived historical usage under `/api/v2/usage/*`, including summary totals, daily series, project/model/tier/agent attribution, cache economics, prior-period comparison, read-only budget reports, advisory tier feedback, and top sessions with coverage metadata.
- Exposes event-derived Monitor migration endpoints under `/api/v2/monitor/*`, including summary stats, filter options, event feed data, active session aggregates, session detail/transcript data, and tool error-rate/duration analytics.
- Exposes persisted AI-generated insights under `/api/v2/insights/*`, scoped to the current historical filters and grounded in analytics and usage coverage metadata.
- Exposes provider-native quota snapshots under `/api/provider-quotas`, including Codex app-server polling and Claude statusline bridge ingestion.

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
- Claude Code quota bridge: [hooks/claude-code/README.md#claude-statusline-quota-bridge](hooks/claude-code/README.md#claude-statusline-quota-bridge)
- Generic ingest contract: [docs/api/event-contract.md](docs/api/event-contract.md)
- Historical import and runtime behavior: [docs/system/OPERATIONS.md](docs/system/OPERATIONS.md)

## Documentation

Start with [docs/README.md](docs/README.md) for the full docs map.

- Product and capability overview: [docs/system/FEATURES.md](docs/system/FEATURES.md)
- Local development and runtime operations: [docs/system/OPERATIONS.md](docs/system/OPERATIONS.md)
- Architecture and code organization: [docs/system/ARCHITECTURE.md](docs/system/ARCHITECTURE.md)
- API docs and contracts: [docs/api/README.md](docs/api/README.md)
- Roadmap and project direction: [docs/project/ROADMAP.md](docs/project/ROADMAP.md)
- Current product/runtime state: [docs/project/CURRENT_STATE.md](docs/project/CURRENT_STATE.md)
- Contributor workflow: [CONTRIBUTING.md](CONTRIBUTING.md)
- Agent implementation guidance: [AGENTS.md](AGENTS.md)
