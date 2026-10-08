# Backlog

Future-only gaps and opportunities worth revisiting. Capture recurring friction,
meaningful risk or cost, unresolved decisions, or concrete revisit triggers.
Fix simple, quick, or blocking issues inline when within the active task's scope.

## Conventions

- **Entry:** state **What** and **Why or evidence**. Add **Next** (a useful first
  action) or **Revisit when** (a concrete gate) where helpful; no fixed template
  is required.
- **Evidence:** date and source volatile claims. Support causal or performance
  claims with measurements, or label them **hypothesis, unmeasured**.
- **Delegation:** agents can execute entries directly. Recording a candidate does
  not expand the active task or select a roadmap priority. Use an issue when
  persistent discussion or coordination helps; no mandatory graduation step.
- **Ownership:** keep cross-repository work with the capability-owning repository.
  If an issue owns the details, retain only a useful linked summary here; avoid
  parallel checklists. Keep private evidence out of public entries and issues.
- **Closure:** reconcile affected entries as work lands. Remove resolved concerns,
  retain unresolved remainders, and preserve durable rationale in its owning
  reference. Roadmap records selected direction; Git and PRs hold routine shipped
  history. Revisit the broader list during prioritization or when stale entries
  impede work.

A past unmeasured Analytics fan-out claim nearly prompted a new endpoint before
a cheap latency probe disproved it. Keep hypotheses visibly separate from facts
so later readers know what still needs checking.

## Open

### Consistent session identity and parent/child coverage across read surfaces

- **What**: Sessions lists now reconcile known Codex rollout/UUID aliases, but
  Analytics, Live, Search and projection storage still have distinct identity
  semantics. Claude child-agent transcript IDs also need explicit, reliable
  parent linkage rather than a pooled conversation count.
- **Why or evidence**: the Codex watcher uses a rollout basename, whereas the
  summary adapter uses event session IDs. Claude child-agent files can carry an
  embedded parent session ID that differs from their filename. Event history can
  outlive the source transcripts and browser projections; forcing a file resync
  cannot recover absent files. See `tests/v2-session-identity.test.ts` for the
  bounded list guarantee, not a claim that all read surfaces are reconciled.
- **Next**: define persisted provider-native identity plus child-agent identity
  and coverage provenance; preserve existing links and pins during any migration.
  Expose usage-only versus browsable coverage explicitly without fabricating
  transcripts, and audit each aggregate before calling its count conversations.

### Explicit provenance for unresolved historical timestamps

- **What**: the conservative timestamp repair leaves fields without matching
  event/turn lineage unchanged. Current integration-mode labels alone cannot
  establish whether those timestamps denote producer time or observation time.
- **Why or evidence**: the repair's `unresolvedFields` counter and refusal cases
  in `tests/repair-summary-timestamps.test.ts` make this limitation explicit.
- **Revisit when**: a consumer needs those excluded historical dates. Establish
  stronger source evidence or expose unknown provenance explicitly; do not loosen
  the repair predicates merely to drive the unresolved count to zero.

### Ingestion

#### Codex subagent boundary rests on the current rollout layout
- **What**: the importer finds a `thread_spawn` subagent's own activity from
  UUIDv7 `turn_id` times (see ARCHITECTURE). That relies on how Codex lays out
  subagent rollouts and mints turn ids today.
- **Why or evidence**: verified on 2026-09-24 for every `thread_spawn` rollout
  from Codex 0.94.0 to 0.156.1. All of them had datable turns and a boundary.
  A layout change would make the parse fall back to billing the whole rollout,
  as before the fix.
- **Revisit when**: `amon costs repair-codex-usage` reports
  `subagent_boundaries_unresolved` above 0, or a new subagent's import/OTEL
  ratio leaves 0.95–1.02. Re-measure on each Codex minor version that changes
  subagent behaviour.

#### Long-context tier is chosen per row, not per request
- **What**: pricing picks the long-context tier from the size of one row's
  token change. A Codex import row that spans several requests can therefore
  cross the tier threshold when no single request did.
- **Why or evidence**: after the subagent boundary fix, such rows are rare.
  Measured on 2026-09-24, they are about half of 1% of that fix's cost
  correction.
- **Next**: price a multi-request span with the tier of its largest request,
  once `last_token_usage` per request is read. Otherwise leave as is.

#### Codex requests that only OTEL records
- **What**: Codex's per-request OTEL often sees slightly more usage than the
  rollout counters. Rollout import is authoritative where the two overlap, so
  the difference is dropped.
- **Why or evidence**: measured 2026-09-24 on subagent sessions the repair does
  not change: they sit at 0.92–1.02× OTEL, mostly below 1. Plain sessions were
  not measured this way. The cause is a hypothesis, unmeasured: requests that
  fail or are retried without a counter update.
- **Next**: compare per-request OTEL ids with rollout counters for one session
  below 0.95×, before changing any reconciliation.

#### Some openbench comparator models are unpriced (`laguna-s-2.1`, `nemotron-3-ultra`)
- **What**: `import benchmark` prices the paid bake-off targets (glm-5.3-flash,
  deepseek-v4-flash-0731, minimax-m3) and the codex/claude daily drivers, but
  surfaces `laguna-s-2.1` and `nemotron-3-ultra` as unpriced (billed null, loud
  non-zero exit) in current runs.
- **Why it matters / evidence**: `laguna-s-2.1` is routed `:free` in
  the comparator harness's own bridge config yet its root `prices.json` lists
  0.1/0.2 — free-vs-paid is genuinely ambiguous, so a rate was **not** guessed. `nemotron-3-ultra` has no authoritative source in the fork at all.
- **Next / Revisit when**: these models re-enter a run whose costs matter. Confirm
  the tier (free → 0, or the paid OpenRouter rate) from a live
  `openrouter.ai/api/v1/models` pull, then add entries to
  `src/pricing/data/openrouter.json`. Noted 2026-09-02.

#### Benchmark artifact export (P4)
- **What**: P1 data/queries + P2 arm-ladder UI **shipped** 2026-09-03 (PR #106);
  **P3** frontier chart + shared inline-SVG primitives (`ui/chart/scales.ts`,
  `layout.ts`, `PlotFrame.svelte`, `BenchmarkFrontier.svelte`, CostDashboard
  refactored onto `linearScale`) **shipped** 2026-09-04 (`527945b`, `739b177`). What
  remains is **P4** (optional) — a self-contained "Publish study" artifact export
  mirroring the claude.ai Pareto artifact, with the app as source of truth.
- **Why it matters**: the ladder + honesty panel + frontier now deliver the full
  in-app comparison; the export is only a shareable-snapshot convenience. Not
  blocking — pure enhancement.
- **Next / Revisit when**: build P4 if a shareable standalone study page is
  wanted. Watch openbench #5 (per-attempt cost) — landing it would drop the
  "cost is a floor" honesty caveat. Noted 2026-09-02, updated 2026-09-04.

### Skill trigger health (2026-07-09)

Phase 1 shipped. These are the deferred follow-ups surfaced during and after
the build.

#### Version attribution only reaches skills in the installed catalog
- **What**: version resolution matched ~1/3 of invoked skills on the live DB (23
  of 73). The rest resolve to `null` — renamed skills (`writing-plans` →
  `write-plan`), non-dojo skills (`yeet`), and project-local / plugin skills that
  aren't in `~/.claude/skills` or `~/.codex/skills`.
- **Why it matters**: version-over-version comparison is the core of the feedback
  loop, so this coverage is the ceiling on phase-1 usefulness. Also:
  `versionApproximate` is ~always true today because snapshots are stamped with
  `now`; it only gains signal once the catalog is observed across a real bump.
- **Next**: phase-2 catalog discovery for project-local `.claude/skills` and
  plugin catalogs; treat name+version identity carefully across sources.

#### Validate (and likely widen) the misfire heuristic before consumers depend on it
- **What**: the interrupt-based misfire signal was 0 across all 639 real
  invocations. Plausible (a genuine interrupt right after a skill fires is rare)
  and the heuristic deliberately under-counts, but combined the signal may be too
  sparse to drive anything.
- **Why it matters**: phase 2 wants to rank skills by misfire rate; a metric
  that's structurally near-zero can't. `misfireEligible` now exposes the
  denominator so a min-sample guard is possible, but the signal itself needs
  validation.
- **Next**: widen to interrupt anywhere in the invoking assistant span, or add
  lexical negation in the next prompt (both already scoped out of phase 1);
  measure against real sessions before building ranking on top.

#### Windowed Codex skill-event scan still reads its candidate rows
- **What**: the skill health/daily Codex leg (`codexSkillEventStatement`) now
  seeks an agent-ordered composite (agent with its tool or event type), so it
  reads only Codex tool calls rather than every Codex event. It still looks up
  each of those rows to test `metadata LIKE '%SKILL.md%'` and the window, then
  sorts.
- **Why or evidence**: on a 2026-10-01 snapshot of a local store the old
  agent_type-only seek took about 3 s warm; the new plan takes about 0.15-0.25 s
  warm (1.3-1.8 s cold). Cost now grows with retained Codex tool calls, not all
  Codex events. `tests/monitor-agent-filter-plans.test.ts` pins the seek.
- **Revisit when**: skill health latency becomes noticeable again. A LIKE on
  metadata cannot be indexed, so the next step would be recording SKILL.md
  reads as a column or a narrow table at ingest rather than another index.

#### Usage overview derived store remains a measured fallback
- **What**: the event-derived `/api/v2/usage/overview` still folds matching usage
  rows in JavaScript for its exact rollups, but the 2026-09-13 source-count
  optimization removed the dominant full-window grouping cost. The earlier
  150 ms warm figure was a local revisit trigger, not a product SLO.
- **Why it matters / evidence**: on the named 697K-event, 60-day snapshot, the
  final source-level overview improved from a 309.32 ms warm median to 220.99 ms;
  the built HTTP path measured 227.14 ms over seven warm runs. The earlier repair
  had already reduced a 6.6 second cold read and stopped Monitor from issuing
  redundant per-panel reads. Current latency is usable, while the query remains a
  plausible scaling target if observed CLI/UI latency rises with retained history.
  Re-measured 2026-10-02 on a snapshot over HTTP, 30-day window: an agent filter
  had pushed the overview to 8-10 s for Codex (agent-led index plus a row lookup
  per event) and the top sessions' event count cost about 3.7 s unfiltered; with
  the window leading those reads and a session-window index, the overview takes
  0.1-0.3 s warm, filtered or not. The matching-population count (about 0.6 s,
  index-only) is now its largest statement.
- **Next / Revisit when**: revisit a session-grained `(day, agent, model, project,
  session_id)` derived store when representative user-facing latency becomes a
  recurring problem or retained history materially changes the curve. Require
  exact overview parity, bounded write/storage cost, and explicit rebuild/recovery;
  keep source events authoritative. Updated 2026-09-14. **Reference implementation**:
  a cross-repo clone-mining report flagged that `agentsview` ships this exact
  pattern — a *disposable sibling* SQLite DB (`usage-cache-vX.db`) holding unpriced
  message facts + timezone-aware daily rollups + narrow dedup exceptions, giving
  sub-15ms overview queries without touching the authoritative archive (report
  pattern 2, held outside this repository; agentsview
  `internal/db/usage_cache_schema.go`). Worth a look when
  building the derived store — the disposable-sibling framing (rebuildable, never
  authoritative) directly addresses the rebuild/recovery and parity concerns above.

#### Monitor session list parses every event of the listed sessions
- **What**: `listMonitorSessions` pages the sessions cheaply, then aggregates
  every event of those sessions, including `json_extract` over `metadata` for
  files edited and lines added or removed. Its cost grows with the events in the
  listed sessions, not with the page size.
- **Why or evidence**: re-measured 2026-10-02 on the live server after compaction.
  The Monitor page's own request (live sessions only) took 65 ms at the median and
  70 ms at p90 over 40 samples, with one 0.49 s outlier; the earlier 1.8 s sample
  was such an outlier, not the norm. The default 50-session list takes about
  0.15 s warm, and a 200-session list about 0.3 s: roughly linear in the events
  of the listed sessions. Keeping the aggregates on the `sessions` row would mean
  every event write path (insert, cost recalc, repairs, dedup, deletes) has to
  keep them right, to save 50-150 ms.
- **Revisit when**: the Monitor page's request passes about 0.3 s at the median,
  or a consumer needs the full list often. Then keep the per-session aggregates
  on the `sessions` row as events are written, with a one-time backfill.

#### Legacy v1 session-list N+1
- **What**: the v1 `queries.ts` session list (retiring `/` dashboard) keeps the
  per-session correlated-subquery N+1 that v2 `listMonitorSessions` shed.
- **Why it matters**: left untouched to avoid investing in the deprecated surface.
- **Next**: apply the same CTE rewrite if v1 is kept.

### Context occupancy

#### Monitor-card occupancy join not visually verified with a live session
- **What**: the Live inspector and Monitor reads use v2. Monitor separately joins
  occupancy from the Live session projection by session id. This is Svelte-checked
  and logically verified but was not screenshotted with a live hook/OTEL-fed active
  session. Codex's Monitor UUID and Live rollout identity are aliased during the
  occupancy refresh.
- **Why it matters**: confirm the join renders on a real running card, especially
  for Codex.

#### Trajectory sparkline (occupancy gauge Task 8)
- **What**: session-lifetime occupancy fill over time with compaction drop-offs,
  in the detail/inspector surface.
- **Why it matters**: gauge + pill shipped first; this is the fast-follow.
- **Next**: needs a bounded sample buffer in the projection and a retention
  decision.

### Invocation mode

#### No `mode` filter facet in the Monitor FilterBar
- **What**: intentionally scoped out. `mode` lives in `sessions.metadata`
  (json_extract).
- **Why it matters**: cheap to add if wanted, but a filterable/indexed path would
  want a dedicated column rather than json_extract.

### Pricing

#### A few current vendor models are still unpriced ($0-bill risk)
- **What**: `gpt-5.6-cyber` ($12.50/$75) is still unpriced, and an unpriced
  model bills as **$0** — the silent under-report failure mode. Claude Opus 5.5
  and Fable 5.1 were priced 2026-09-23, Sonnet 5.5 and GPT-6.1 Sol 2026-10-04,
  each after its usage had already landed at $0. Opus 5.5, Fable 5.1 and GPT-6.1
  Sol all break the 0.1x cache-read convention (0.05x, 0.025x, 0.05x), so a rate
  card cannot be derived from the input price.
- **Why it matters**: only bites if the model appears in the data, but when it
  does it is invisible (no error, plausible dashboard). `gpt-5.6-sol` shows a
  promo $4/$20 ("through 2026-11-21") on the OpenAI page while aggregators list
  $5/$30 — we kept list ($5/$30); a `schedule` entry could encode the promo.
  The same page (checked 2026-09-23, when GPT-6 Sol/Luna were added) lists a
  1.25x cache-write column for every GPT-5.6 and GPT-6 model, while `codex.json`
  bills GPT-5.6 cache writes at the input rate (commit `84db40b`'s reading). No
  effect today, since Codex emits no cache-write tokens; reconcile before it
  does. That page also confirms `gpt-6-astra`'s $12.50 cache write.
- **Next / Revisit when**: add a model the moment the "unknown-priced tokens"
  surface shows it, from the vendor's live page (never from a multiplier).
  Startup prices its stored usage on the restart that ships the rate, so no
  manual backfill is needed. Since 2026-10-04 the app header, `/api/health` and
  the server log name any model with unpriced usage in the last week.

#### Processing-service tier is not captured with usage events
- **What**: cost estimation uses standard synchronous API rates. Event rows do not
  record OpenAI Standard, Priority, Batch, or other processing-service tiers, so
  the registry cannot select service-tier-specific pricing.
- **Why it matters**: GPT-5.6 Priority prices differ from standard rates. Standard
  pricing remains the honest default until ingestion exposes the billed service
  tier; do not infer it from the model ID.

#### Codex event ids are positional, and a change to the emitted set re-keys history
- **What**: `src/import/codex.ts` derives ids from a counter over *emitted*
  events. Changing which events are emitted re-keys every stored row, so the
  next import stops matching them and duplicates the history. Unlike the Claude
  importer there is no legacy-id bridge to absorb such a change.
- **Why or evidence**: measured 2026-09-22 while evaluating a switch to the
  producer's `ordinal`, which was **rejected** — the counter advances only on
  emitted events, so noise lines do not shift ids (verified byte-identical
  against a noisy fixture), the producer ordinal and computed index agree across
  120 real rollouts, and no rollout shares a `session_meta` id, so Codex has no
  collision to fix. Switching would have re-keyed every stored Codex import row
  for no measured gain. Two mutation-tested guards now make an accidental change loud:
  `skipped, malformed and zero-delta lines do not shift later event ids` and
  `pins the Codex event-id derivation against accidental re-keying`.
- **Revisit when**: a change to the set or order of emitted events makes a
  derivation change necessary. Rewritten rollout content is already reconciled
  under the current ids; a derivation change needs a legacy-id bridge first,
  mirroring `src/import/index.ts`'s ownership rule. Do not simply update the
  pinned expectation.

#### Imported Claude rows with no surviving transcript stay inflated
- **What**: `amon costs repair-claude-usage` (shipped 2026-09-22 with the
  per-content-block billing fix) can only correct rows whose transcript still
  exists. Rows whose source file is gone keep the inflated usage the old
  importer wrote.
- **Why or evidence**: the repair was **applied** on a local store 2026-09-22
  and corrected roughly one matched row in six, re-deriving a summary per
  affected session. What it could not reach remains: a small set of ambiguous
  rows, and **a large majority of pre-fix imported rows whose transcript is
  gone** — several times the repairable population. A separate estimate that groups
  identical usage tuples within a session suggested the reachable repair
  recovers only about a third of the total inflation, leaving the rest in rows
  with no local evidence left to check them against. Historical cost views stay
  wrong by an unknown-but-bounded amount.
  On 2026-09-26 transcripts restored from offsite backups made mid-July onward
  checkable again. In those months repeat-line billing was about half of July's
  checkable imported cost and about a third of August's; the second repair pass
  corrected them. Backups reach no further back, so the earlier rows are the
  whole remaining population. That they carry similar inflation is a
  hypothesis, not a measurement.
- **Next / Revisit when**: now the only remaining inflation, so this is the whole
  question rather than part of it. Decide deliberately between three options —
  leave and disclose (cheapest, but every historical cost view silently
  overstates), a
  heuristic collapse of identical `(session, timestamp, usage)` tuples (recovers
  most of the remainder but *will* over-collapse genuinely identical turns, so
  it trades a known overstatement for an unmeasured understatement), or a
  provenance marker that labels pre-fix imported rows as unreliable in the UI.
  Do not run a heuristic collapse without first measuring how often distinct
  turns legitimately share a usage tuple.

#### Imported Claude cost runs below Claude Code's own running cost, cause unsplit
- **What**: `amon costs check-claude-sessions` compares imported cost with the
  statusline's `cost.total_cost_usd` for the same session and process window.
  After the 2026-09-27 repair, the sessions checked read about 10-15% below the
  harness. Billing 1-hour cache writes at their own rate (repair applied
  2026-10-04) closed about half of that: re-measured 2026-10-05 on six sessions,
  imported cost is about 0.95 of the harness's, weighted by cost (0.92 with the
  outlier below), and five sessions read between 0.93 and 1.07. The harness also
  pays for requests that never become transcript turns; which requests, and how
  much each contributes, is unmeasured.
- **Open question**: one resumed session reads about 0.05 of the harness's cost
  after both repairs. Whether its statusline cost covers earlier processes of the
  same session, or its transcript is missing turns, is unchecked; comparing its
  process window against the transcript's turn timestamps would answer it.
- **Why or evidence**: 2026-09-27, one long session: compaction records carry
  `preTokens`/`postTokens` but no usage or cost, and pricing its compactions
  from those sizes accounts for roughly 12% (context read from cache) to 55%
  (read uncached) of that session's gap. The rest is unattributed; side requests
  (titles, command checks, fetch summaries) are a hypothesis. Until split, a
  shortfall this size cannot be told apart from a real import gap of the same
  size.
- **Next**: keep a history of statusline samples per session (write only when
  the cost changes) instead of the latest. The harness's cost jump across each
  compaction's window (`timestamp`, `durationMs`), less the transcript turns in
  it, is that compaction's measured cost; what remains between compactions is
  the other requests. Exact alternative: Claude Code's OpenTelemetry log export
  records every API request with model, tokens and cost; pointing it at amon
  needs a Claude Code configuration change and a check of how amon ingests
  those events and whether they identify the request's purpose.
- **Revisit when**: the weighted ratio drifts outside about 0.9-1.0, or a
  decision rests on the absolute size of Claude cost.

#### The warehouse export still buckets UTC days
- **What**: every user-facing day is now a local day in the reporting zone
  (2026-09-23), but `src/warehouse/*` still derives its `day` column from the
  UTC date, so an exported day and the same day in the app can hold different
  rows near midnight.
- **Why or evidence**: kept deliberately. The export writes into a persisted
  Postgres table, so switching its basis would leave earlier rows on UTC days
  and new rows on local days in one table, a mismatch no reader could detect.
- **Next / Revisit when**: a warehouse consumer compares daily totals against
  the app. Then decide between re-exporting history on local days and recording
  the zone per row; either needs a migration of the existing table, not just a
  code change.

#### The cache savings estimate prices every cache write at the 5-minute rate
- **What**: stored costs bill Claude's 1-hour cache writes at their own rate
  (2x input), but `estimateCacheSavings` in `src/db/v2-queries.ts` charges every
  cache write the 5-minute premium (1.25x), so it overstates savings by 0.75x
  input per 1-hour write token.
- **Why or evidence**: since mid-2026 roughly 90% of Claude cache-write tokens
  are 1-hour writes (measured 2026-10-04). The usage read that feeds the
  estimate is served by `idx_events_usage_covering`; adding
  `cache_write_1h_tokens` to it would break the covering read or grow the index.
  Cache reads dominate the savings, so the error is smaller than the share
  suggests; it is unmeasured.
- **Revisit when**: a decision rests on the savings figure. Measure the
  overstatement first, then add the column to the covering index if it matters.

### Reliability And Observability

#### Operational metrics UI surface (follow-up to the shipped ingestion)
- **What**: operational OTEL metrics now ingest into `otel_metrics` and read via
  `GET /api/v2/metrics` (shipped 2026-09-04; see `src/api/v2/router.ts` and
  `src/db/otel-metrics.ts`), but there is no `/app/`
  surface yet — no Codex consolidation-health panel or rate-limit-skip view.
- **Why it matters**: the data is queryable but an operator still has to hit the
  API by hand. A small Monitor/Analytics panel ("is memory consolidation running,
  and which states is it hitting?") is the payoff that motivated the ingestion.
- **Next / Revisit when**: building Codex operational observability into the
  console. The read shape (name×attrs → occurrences/last-seen) is already there;
  this is a frontend consumer. Noted 2026-09-04.

#### OTLP operational metrics have no retry dedup
- **What**: an exporter retry of an operational metrics batch (`otel_metrics`)
  stores its points again. Usage metrics and log records already dedup retries.
- **Why or evidence**: noted 2026-09-23 while fixing Codex OTEL producer time.
  Occurrence counts in `GET /api/v2/metrics` can overstate by the retry rate;
  that rate is unmeasured.
- **Next**: apply the usage-metric retry key to operational points if a
  consumer starts reading occurrence counts as exact.

#### Hook safety heuristics under-match
- **What**: the destructive-command filter
  (`hooks/claude-code/pre_tool_use.sh` and the identical regex in
  `python/pre_tool_use.py`) requires a literal unquoted path token, and the
  sensitive-file check is an anchored, case-sensitive suffix match on a file
  tool's `file_path`.
- **Why or evidence**: re-tested 2026-10-01: `rm -rf /` is blocked, while
  `rm -rf "/"`, `rm -rf ${HOME}`, `rm -rf /*` and `rm --recursive --force /`
  pass. `.env.local`, `credentials.json` and `.PEM` are not logged. The hooks
  README now states the checks are best-effort telemetry, not a security
  control.
- **Next**: normalize quotes/braces and match common suffixes; match secret files
  on basename patterns case-insensitively. Keep the README's caveat either way.

### Frontend testing

#### Extend Vitest coverage beyond the store/pure layer
- **What**: the Vitest harness (added 2026-09-11) covers the Monitor store, the
  reconnect/SSE signalling, and the pure `lib/*.ts` helpers (`format`,
  `monitor-session-merge`). It does **not** yet cover: component mounting +
  `$derived`/`$effect` reactivity (needs `@testing-library/svelte` +
  `flushSync`/`$effect.root`), or the remaining pure modules
  (`monitor-analytics`, `frontier-geometry`, `session-roles`,
  `session-capabilities`, `skill-consultation-view`, the `*-state.ts` helpers).
- **Why it matters**: chart geometry (`frontier-geometry`) and the cost-window
  logic (`monitor-analytics`) are exactly the silent-render-plausible-but-wrong
  class this project guards; they are pure and cheap to cover. Component tests
  are the larger lift and only worth it where a component holds real logic.
- **Next / Revisit when**: fold in the remaining pure modules opportunistically
  when touching them; stand up `@testing-library/svelte` the first time a
  component's behavior (not just its markup) needs a regression guard. No
  coverage threshold is enforced yet — add one only once the surface is broad
  enough that a number is meaningful. Noted 2026-09-11.

### Cross-repo pattern-mining candidates (agentsview, 2026-09-13)

Flagged by a clone-mining report comparing `agentsview` (a Go/Svelte local
AI-agent session aggregator — same archetype as agentmonitor) against this repo.
The report is held outside this repository and is agent-generated. All three
items were checked against current code and a local store on 2026-10-01; the
entries below record what was measured, not the report's claims.

#### Watcher re-sync still re-parses the whole transcript
- **What**: since 2026-10-01 a re-sync writes only the rows that changed, but it
  still reads, hashes and parses the whole file on every append.
- **Why or evidence**: measured 2026-10-01 on a 34 MB, 7k-message Claude
  transcript against a scratch database: the parse took 0.08–0.12 s, against
  about 0.011 s for the incremental write (the full rewrite it replaced took
  about 0.83 s). The parse grows with the session and blocks the server. The
  trace-summary re-derive, then the larger cost, now reads only the event columns
  its rollup uses for sessions with events: measured warm on a store snapshot
  2026-10-05, about 6x faster on the largest sessions (roughly 75 ms to 12 ms),
  with identical summaries for every stored session. Sessions without events
  (mostly Codex) still load and project their full transcript.
- **Next**: resume the parse from a stored byte offset with a trailing-anchor
  check, as `agentsview` does (`internal/sync/checkpoint.go`), falling back to a
  full parse on mismatch.
