# Features

This document describes AgentMonitor's observable product behavior and the limits
that users and agents must preserve. Exact endpoints and response types live in
the v2 route/query source and [API index](../api/README.md).

## Canonical Product Surface

- The Svelte SPA at `/app/` is the sole human-facing surface; `/` redirects there.
- Monitor, Live, Sessions, Search, and Analytics are the primary workflows.
- Analytics contains Overview, Usage, Skills, Insights, and Quality sub-views under
  one shared date/project/agent filter context.
- Deep links preserve the active view and selected session, message, or trace where
  applicable.

## Agent-First CLI

`amon` exposes the same local data needed by automated consumers: runtime health,
sessions, live activity, search, analytics, usage, insights, benchmarks, trace
quality, operational metrics, budgets, tier feedback, database maintenance, and
imports. `agentmonitor` is an executable alias.

Read commands default to concise human output and provide stable `--json` output
for agents. Filter semantics and data-selection rules are shared with v2 wherever
the command represents a UI read. Use `amon --help` and subcommand help as the
current command contract.

## Monitor And Live

Monitor provides current sessions, recent events, aggregate stats, tool activity,
provider-native quota snapshots, and context-window occupancy. It consumes the v2
Monitor reads and the shared SSE stream.

The Monitor's token headline counts every bucket (uncached input, output, cache
reads and cache writes), which is how Claude's `/stats` and Codex's `/usage`
count tokens. Its breakdown splits the buckets and each agent. It covers the
usage recorded on this machine: a harness's account-wide total can include
other machines and cloud tasks that no local source records.

Live exposes normalized sessions, turns, items, and a dedicated live stream. Its
fidelity is explicit:

- Claude session files can provide transcript-capable live detail.
- Codex OTEL provides summary-oriented live activity, including response-completion
  token and cost data. Historical Codex JSONL import enriches later analysis but is
  not the sole usage source.
- Antigravity supports historical summary import and has no live projection.

Context occupancy is absent when the source cannot support it. Its numerator is
the latest request's prompt size, so compaction can lower the displayed value; the
product never substitutes a misleading `0%` for missing evidence.

## Sessions, Search, And Pins

- Session browsing provides incremental transcript loading, child-session context,
  tool calls, metadata, and an activity minimap for long sessions.
- Search supports recency and relevance ordering and includes enough session
  context to navigate directly to the matching ordinal.
- Pinned transcript moments use session-plus-ordinal identity so they survive
  re-imports that replace internal row IDs.
- The global `Cmd/Ctrl+K` palette searches recent sessions and transcript matches
  from any tab.
- Sessions lists count recognized Codex rollout/UUID aliases once and prefer
  JSONL history. Existing detail links remain valid. A browser session is a
  projected conversation or child-agent history, not a turn, API call, billing
  block, or duration. Resuming the same native conversation does not itself make
  a new conversation. Browser coverage and event-derived usage-session coverage
  are different populations; totals should not be compared as equivalent.

## Analytics And Skill Evidence

Analytics covers activity over time, projects, agents, tools, hour-of-week patterns,
velocity, and high-volume sessions. Capability metadata distinguishes all-session
aggregates from tool or transcript analysis that excludes unsupported sources.

Skill analytics combine explicit Claude `Skill` calls with concrete Codex reads of
`SKILL.md`. Shell variables and glob paths do not count as named skills. A Codex
read reported by both OTEL and its JSONL rollout counts once: OTEL is
authoritative per session and skill, and the rollout adds only the reads OTEL
did not report. Skill
health distinguishes first reads, post-compaction rehydration, repeats without
compaction, and unclassifiable observations by harness. Claude and Codex evidence
is not pooled as directly comparable because the observation mechanisms differ.

Invocation, presentation, project breadth, and version attribution are screening
evidence. They do not by themselves prove skill value, correct placement, or a
reason to remove a skill. Missing denominators remain unavailable with a reason
rather than becoming zero.

External profile authorities may attach bounded, immutable expected-realization
evidence to a compatible session. The session view then compares desired context
with observed consultation and instruction evidence without rewriting history.

## Usage And Cost

Usage is event-derived and includes totals, daily series, project/model/tier/agent
attribution, model mix, and top sessions. Shared filters cover date, project, agent,
model, provider, and provider-neutral tier.

- Stored `cost_usd` remains the authoritative event cost. Cache savings are an
  estimate from current pricing metadata and disclose incomplete pricing coverage.
- Input, output, cache-read, and cache-write tokens remain separate. Model views can
  show all four buckets.
- Unknown and deprecated models stay visible. A persistent warning identifies
  unpriced use or known pricing that has not yet been applied to zero-cost history.
- Imported Codex JSONL usage wins over overlapping live OTEL usage in aggregates;
  raw events remain available in session and monitor history.
- Benchmark events are excluded from normal usage, analytics, and the Monitor's
  totals, event feed, and session list.
  Benchmark-aware reads can opt into them explicitly. Usage and analytics reads
  reject an unparseable `date_from`/`date_to` with a 400 rather than reporting
  an empty window.
- Every user-facing day is a local day in the reporting zone (the host's, or
  `AGENTMONITOR_TIMEZONE`): a bare `date_from`/`date_to` selects local calendar
  days, and daily charts, active-day counts, the Hour-of-Week heatmap, skill
  and trace-quality windows, and budget periods all bucket the same way. The
  aggregate warehouse export is the exception and keeps UTC days.
- Usage responses disclose when matching events lack token or cost data.

Read-only budgets use an optional local JSON configuration and report alert state
without blocking agents or hooks. See [usage-budgets.md](usage-budgets.md).

Tier feedback derives deterministic findings from usage totals, model attribution,
top sessions, and content-free browsing metadata. It never reads message content,
changes models, edits prompts, enforces budgets, or modifies agent policy. Its
findings always require human review before any routing or policy change.

## Insights

Insights are generated on demand and persisted with their exact date, project, and
agent scope plus the analytics/usage coverage used to produce them. OpenAI,
Anthropic, and Gemini providers are optional; local monitoring works without any
provider API key. Generated text remains visibly attached to its scope and evidence
limits.

## Trace Quality

Quality presents one lean trace per session from the content-free session summary.
Observation trees are projected on demand from local source rows and are not stored
as a second trace warehouse. List and detail views disclose usage and telemetry
coverage over the full filtered set. Drill-ins from Usage, Analytics, Live,
Sessions, and Search can open the relevant trace.

Deep scoring, prompt management, and persisted observation/eval storage remain
outside the local product boundary. See [trace-quality.md](trace-quality.md).

## Benchmarks And Operational Metrics

Imported benchmark studies remain segregated from personal activity and usage
totals. Benchmark reads expose study arms, cost/quality evidence, eligibility, and
Pareto comparisons without promoting estimated or incomplete evidence to a stronger
grade.

Operational OTEL metrics are stored separately from events and exposed to the CLI
and v2 API as name-and-attribute aggregates. They carry no tokens or cost and never
enter activity or usage totals.

## Privacy And Capture Controls

- Live prompt, reasoning, and tool-argument capture can each be disabled.
- Tool names and structural evidence can remain visible while sensitive arguments
  are redacted.
- Instruction-load telemetry records file identity and provider metadata; the hook
  does not read or emit instruction contents.
- Trace-quality list rows and aggregate warehouse exports are content-free.
- Insight generation is the sole product path that sends an analysis request to a
  configured external model provider.

## Historical Import And Recovery

Claude Code, Codex, Antigravity, and benchmark sources can be imported through the
CLI. Hash tracking makes normal reruns idempotent; date filters, dry runs, and
forced recovery are available where appropriate.

Event import and session-browser reconstruction are separate. Losing browser tables
requires a forced session sync from source files; event import alone cannot restore
messages, tool calls, or inferred-skill history. Detailed procedures live in
[OPERATIONS.md](OPERATIONS.md).

## Compatibility Boundary

V1 remains active for ingestion, provider quotas, shared SSE, and reads still used
by parity/ingestion-readback tests. New product and CLI read work belongs on v2.
Retiring the remaining v1 reads requires moving their test consumers first.
