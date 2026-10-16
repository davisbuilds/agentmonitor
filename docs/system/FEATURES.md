# Features

This document describes AgentMonitor's observable product behavior and the limits
that users and agents must preserve. Exact endpoints and response types live in
the v2 route/query source and [API index](../api/README.md).

## Canonical Product Surface

- The Svelte SPA at `/app/` is the sole human-facing surface; `/` redirects there.
- Monitor, Analytics, and Sessions are the primary workflows. Sessions holds
  full-text search and pinned messages; the live stream is Monitor's drill-in
  rather than a tab of its own.
- Analytics contains Overview, Usage, Skills, Insights, and Quality sub-views under
  one shared date/project/agent filter context. Insights appears only once an LLM
  provider API key is configured.
- Monitor, Analytics, and Sessions each lay their filters out in one bar under the
  command bar, in the same order: the page's scope (Analytics' sub-views or the
  Sessions search box), then Project and Agent, then the page's own filters, with
  Clear and the page's actions at the end. Each tab keeps its own selection;
  switching tabs does not carry a filter over.
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

## Monitor And The Live Stream

Monitor provides current sessions as agent cards, recent events, aggregate stats,
provider-native quota snapshots, and context-window occupancy. It consumes the v2
Monitor reads and the shared SSE stream. A card folds repeated recent events into
one row with a count. The header's quota pill names each provider and shows what
is left of its most-used window.

Model IDs read one way everywhere: as the vendor names the model, without a
routing prefix, a long-context suffix, a Bedrock wrapper, or a release date
stamp. The unpriced-models notice keeps the exact ID, since that is what a rate
card must match.

Clicking an agent card opens that session's live stream and inspector in place, at
`#monitor?session=<id>`; old `#live` links land on Monitor. A session with no live
record, and every session when the live view is turned off
(`AGENTMONITOR_ENABLE_LIVE_TAB=false`, a name kept for compatibility), opens the
recent-events drawer instead.

Monitor filters by agent only, the one filter every Monitor read honors: the stats,
the cards, their recent events, live updates, and the cost windows. Project and the
event-level filters live in Sessions and Analytics, whose reads support them.

Monitor's cost figures name their window: today and the last 30 days. Both come
from the Usage summary with the window of Usage's 30D range, so Monitor and Usage
show the same 30-day cost. Monitor carries no cost or tool breakdown of its own;
those live in Analytics.

The Monitor's token headline counts every bucket (uncached input, output, cache
reads and cache writes), which is how Claude's `/stats` and Codex's `/usage`
count tokens. Its breakdown splits the buckets and each agent. It covers the
usage recorded on this machine: a harness's account-wide total can include
other machines and cloud tasks that no local source records.

The live stream exposes a session's normalized turns and items, updated over a
dedicated live SSE stream. It opens at the session's newest items and follows
new ones while you are at the bottom; scrolling to the top loads the page before.
Instructions a harness injects for the model (Codex's developer-role messages:
permissions, skills, memory) read as Instructions rather than as the assistant,
and the prompt capture setting governs them as it does prompts. Its fidelity is
explicit:

- Claude session files can provide transcript-capable live detail. Reasoning
  appears only where the transcript recorded its text; Claude Code often records
  a thinking block with the text left out, and such a block projects no item.
  The stream and the trace tree fold each tool result into its call's row and
  state a status only when it is not a routine success.
- Codex OTEL provides summary-oriented live activity, including response-completion
  token and cost data. Historical Codex JSONL import enriches later analysis but is
  not the sole usage source.
- Antigravity conversation files feed a summary-fidelity live projection when
  the watcher syncs them; this does not establish transcript-level parity.

Context occupancy is absent when the source cannot support it. Its numerator is
the latest request's prompt size, so compaction can lower the displayed value; the
product never substitutes a misleading `0%` for missing evidence.

## Sessions, Search, And Pins

- Session browsing provides incremental transcript loading, child-session context,
  tool calls, metadata, and an activity minimap for long sessions. Codex's
  injected developer-role messages are labelled Instructions, with their own
  entry in the author filter.
- A session is titled by the name its harness gave it (Claude Code's own title,
  or a subagent's task), else by its first prompt, skipping the context harnesses
  inject ahead of it (Codex AGENTS.md and environment blocks, Claude Code command
  wrappers), else "Untitled <agent> session". Every page uses the same title.
- Session lists nest a subagent under its parent whenever the parent is stored,
  and hide internal jobs, including the Codex app's own background threads.
- Full-text search lives in the Sessions list: while a query is entered, matching
  messages replace the list, with recency or relevance ordering and the list's
  project and agent filters; clearing the query returns to the list. A result
  opens its session at the matching ordinal, and closing the viewer returns to
  the results. The query rides the `#sessions?q=…` link, and starting a search
  adds one history entry, so Back returns to the list. Old `#search?…` links
  redirect there without adding a history entry.
- Search matches what a message says (its text, thinking, tool names, tool
  inputs and tool results), not the JSON it is stored as, so snippets read as
  text and a block key such as "type" matches only messages that use the word.
- Inline images (pasted images, screenshots in tool results) are stored as a
  descriptor with their SHA-256 and size, not their base64 data, so they are
  neither shown nor searchable. AgentMonitor keeps no copy: once a source
  transcript is gone, so are its images.
- Pinned transcript moments use session-plus-ordinal identity so they survive
  re-imports that replace internal row IDs. A message's Pin button appears on
  hover or keyboard focus; a pinned message always shows Pinned. Pinned is a filter on the Sessions
  list (`#sessions?pinned=1`): it lists pinned messages under the same project
  and agent filters, and a query then narrows them by the words they show
  rather than searching every transcript. Old `#pinned` and
  `#sessions?view=pinned` links redirect to it.
- The global `Cmd/Ctrl+K` palette searches recent sessions and transcript matches
  from any tab.
- A session reads as live while it was active in the last five minutes and as
  active within fifteen, whatever status was last stored; before 2026-10-16 a
  session whose producer went quiet, such as one known only from telemetry,
  stayed live indefinitely and counted in every recent Skills window.
- Sessions lists and Analytics count recognized Codex rollout/UUID aliases once
  and prefer JSONL history; before 2026-10-16 Analytics counted such a session,
  and its messages, twice. Existing detail links remain valid. A browser session is a
  projected conversation or child-agent history, not a turn, API call, billing
  block, or duration. Resuming the same native conversation does not itself make
  a new conversation. Browser coverage and event-derived usage-session coverage
  are different populations; totals should not be compared as equivalent.

## Analytics And Skill Evidence

Analytics Overview covers activity over time, projects, agents, tools,
hour-of-week patterns, and velocity. Top sessions appear once, in
Usage, ranked by cost; all skill evidence lives in Skills, which shows daily
skill invocation volume above the consultation explorer and exports both as CSV.
The shared date, project, and agent filters scope both Skills panels; the
explorer's harness, name, signal, and sort controls narrow only the explorer.
A project is the git repository a session's
working directory belongs to, named after the repository root: subdirectories
and worktrees in a worktree area (`.worktrees/`, `*-worktrees/`,
`.claude/worktrees/`, `.codex/worktrees/`) count as their repository, also once
removed. A directory outside any repository is named after itself; sessions that
record no working directory (Codex OTEL-only, Antigravity) have no project. Capability metadata distinguishes all-session
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

Usage is event-derived and includes totals, one daily chart split by the top
models (each day carries its cost, tokens, events, and sessions, and clicking it
narrows the page to that day), project/model/tier/agent attribution, and top
sessions. The shared filters cover date, project,
and agent; Usage adds model, provider, and provider-neutral tier behind the bar's
Filters button. The total cost names its date range, so it reads apart from
Monitor's today and 30-day figures.

- Stored `cost_usd` remains the authoritative event cost. Cache savings are an
  estimate from current pricing metadata and disclose incomplete pricing coverage.
- Input, output, cache-read, and cache-write tokens remain separate. Model views can
  show all four buckets.
- Claude cache writes are priced by cache lifetime: the 1-hour part a transcript
  records bills at its own rate, the rest at the 5-minute rate. Transcripts began
  recording the split in mid-2026. An estimated cost on an earlier row, on a row
  whose transcript is gone, or on a token-only OTEL export prices every cache
  write at the 5-minute rate; Claude Code's own reported cost already includes
  the 1-hour price. The cache savings estimate still uses the 5-minute rate for
  every write.
- Unknown and deprecated models stay visible. A persistent warning identifies
  unpriced use or known pricing that has not yet been applied to zero-cost history.
  Every page's header also names models whose last week of usage has no rate
  card, so a newly released model does not pile up at $0 unnoticed. Codex's
  `codex-auto-review` routing alias has no public rate; it stays unpriced and
  outside that notice.
- Bedrock model IDs (`us.anthropic.claude-…-v1:0`) and Claude Code's `[1m]`
  long-context suffix price as their Anthropic model at list rates. Bedrock's
  regional-endpoint premium is not modeled.
- Claude Code token and cost figures are **per API response**: each assistant
  turn is billed once, with the usage its last transcript line records. That is
  what Anthropic bills and what Claude Code's live counters (statusline,
  `/cost`) add up. Claude Code's `/stats` sums every transcript line instead,
  and a turn is written as one line per content block, so `/stats` reads about
  twice as high. `amon costs check-claude-sessions` compares imported cost with
  Claude Code's own running cost for each session the statusline bridge has
  reported; expect a ratio a little under 1, because the harness also pays for
  requests that never reach a transcript, such as compaction. How that
  shortfall splits between them is unmeasured (see BACKLOG).
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

The Insights sub-view is offered only once at least one provider has an API key.
A link to `#analytics?view=insights` on a server with no key opens Overview
instead. Saved insights stay in the database and reappear once a key is
configured.

## Trace Quality

Quality presents one lean trace per session from the content-free session summary,
named by the session's title.
Observation trees are projected on demand from local source rows and are not stored
as a second trace warehouse. List and detail views disclose usage and telemetry
coverage over the full filtered set. Drill-ins from Usage's top sessions, the
live stream's inspector, and Sessions (the viewer and its search results) can
open the relevant trace.
A Codex session summarized under its native UUID and one or more rollout files
lists once, as the event-backed UUID summary when there is one, and a drill-in
by any of its ids opens it.

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
