# Current State

This document captures high-change product and runtime notes that are useful for
maintainers but too detailed for the root README.

## Product Surface

- The Svelte app is the product surface to extend. The legacy `/` dashboard is still served, but should not define new behavior.
- The Svelte Monitor read path uses `/api/v2/monitor/*`; v1 remains for ingest, SSE, provider quotas, and legacy dashboard compatibility.
- The Monitor header uses provider-native quota data only. AgentMonitor polls Codex quotas directly from the local Codex app-server and ingests Claude subscriber quota data through the official Claude Code statusline payload bridge.

## Sessions And Search

- The Sessions viewer uses `/api/v2/sessions/:id/activity` to render a bucketed transcript activity map and jump through long transcripts without loading the entire session up front.
- Pinned-message review uses session-plus-ordinal deep links so saved transcript moments survive session re-imports that replace raw message row IDs.
- Search results include session context, and the Svelte app exposes a global command palette on `Cmd/Ctrl+K` for jumping into recent sessions or transcript hits without leaving the current tab first.

## Analytics, Usage, And Insights

- Analytics responses include coverage metadata so the UI can distinguish "all matching sessions" from capability-limited slices like tool analytics.
- Usage responses include coverage metadata so the UI can distinguish usage-bearing events from matching events that carry no cost or token data.
- Usage endpoints accept `date_from`, `date_to`, `project`, `agent`, `model`, `provider`, and `tier` filters.
- Stored `cost_usd` remains the source of truth for event cost. Cache hit rate, estimated cache savings, prior-period deltas, read-only budget states, and human-reviewed tier feedback are derived at query time.
- Insight generation is optional and supports OpenAI, Anthropic, and Gemini providers. Configure it with `AGENTMONITOR_INSIGHTS_PROVIDER=openai|anthropic|gemini` plus the matching provider key:
  - `AGENTMONITOR_OPENAI_API_KEY` or `OPENAI_API_KEY`
  - `AGENTMONITOR_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY`
  - `AGENTMONITOR_GEMINI_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY`
- Generated insights persist the exact date/project/agent scope plus the analytics/usage coverage they were created from.

## Runtime Direction

- The local operator CLI is the preferred command surface for maintenance and reporting. `amon` is the short executable name; `agentmonitor` is an equivalent alias.
- Existing package scripts for import, session reparse, cost recalculation, and trace-quality backfill now remain as compatibility wrappers around the CLI.
- The Rust backend is real and tested, and covers the historical `/api/v2/*` surface used by the Svelte app.
- Rust remains an alternate runtime under evaluation rather than the default server.
