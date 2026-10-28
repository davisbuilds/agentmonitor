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

- **What**: Sessions lists and child lookups reconcile known Codex rollout/UUID
  aliases, and Claude subagents link to the parent session their transcript
  records (2026-10-13). Quality, Analytics and the warehouse export count a
  Codex session once (2026-10-16). Search and projection storage still have
  distinct identity semantics, and only the Sessions list hides internal jobs
  (Codex compaction, memory and app background threads). Consumers that stored
  earlier reads keep their duplicates: a downstream store of the session list
  from before 2026-10-13 can hold a Codex session under both ids.
- **Why or evidence**: the Codex watcher keys a session by its rollout basename,
  whereas the summary adapter uses event session IDs, so a Codex session can hold
  a trace summary under each. On 2026-10-13 every Codex session in a 15-row
  Quality sample was listed twice, once per id, now under the same title. Event
  history can outlive the source transcripts and browser projections; forcing a
  file resync cannot recover absent files. See `tests/v2-session-identity.test.ts`
  and `tests/session-title-queries.test.ts` for the bounded list guarantees, not
  a claim that all read surfaces are reconciled.
- **Write-side root (2026-10-26)**: in a 30-day sample, every rollout-backed
  Codex session also held a native-UUID browser row. The alias CTEs in
  `src/db/v2-queries.ts` exist because the watcher names rollout rows by file
  basename. Keying those rows by `session_meta.id` when writing would retire
  most of them, but it is an identity migration of stored rows, links and
  summaries in its own right.
- **Next**: define persisted provider-native identity plus child-agent identity
  and coverage provenance; preserve existing links and pins during any migration.
  Expose usage-only versus browsable coverage explicitly without fabricating
  transcripts, and audit each aggregate before calling its count conversations.

### Codex thread names and app-job detection

- **What**: Codex sessions are titled by their first real prompt, or a subagent
  by its task name. The Codex app's own generated thread names are not read, and
  its background threads (thread naming, catch-up summaries, memory
  consolidation) are recognized only by their prompt's opening words.
- **Why or evidence**: the names live in Codex's internal state database, not in
  rollouts or telemetry, and on one host on 2026-10-13 fewer than a tenth of
  threads had one; reading it would couple amon to that schema. The background
  threads leave no rollout and their telemetry carries no originator, so a
  reworded prompt would list them as ordinary sessions again
  (`CODEX_APP_JOB_PREFIXES` in `src/parser/session-title.ts`).
- **Revisit when**: Codex writes thread names or a job marker into rollouts or
  telemetry, or Codex app jobs reappear in the Sessions list.

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

#### Codex tool outcomes are not recorded per call
- **What**: rollout-parsed Codex tool calls carry call linkage and a result
  receipt (2026-10-26): arrival time, output size, and a bounded preview under
  tool-argument capture. They state no exit code or success.
- **Why or evidence**: 2026-10-26, local rollouts from Codex 0.154 to 0.163.
  - Tool outputs are free text (for example "Script completed", or a wall time).
  - The `item_completed` records that do carry `exit_code` and `status` use
    their own ids. Only a small share of them match a call's `call_id`.
  - Inferring an outcome from the output text would guess.
- **Next**: when Codex links a structured outcome to `call_id`, add it to the
  receipt. Until then, a downstream reader that needs an outcome should read
  the preview, knowing it is absent when capture is off.

#### Claude custom session titles are not read
- **What**: Claude Code transcripts can carry `custom-title` (`customTitle`)
  and `agent-name` (`agentName`) lines, the name a user or the harness gave the
  session. The session browser titles a session from `ai-title` or its first
  prompt and ignores these, so a renamed session shows another name.
- **Why or evidence**: the ingestion probe's first live run (2026-10-26)
  reported both as `unknown`. They occur in a few older transcripts.
- **Next**: decide the precedence (a user's custom title over `ai-title` seems
  right), read them in the Claude parser's title path, and list them as read
  in `src/parser/record-types.ts`.

#### Codex inter-agent messages are not projected
- **What**: Codex rollouts record messages between agents as
  `response_item/agent_message`, each with an author and recipient, beside
  `inter_agent_communication_metadata`. The session browser shows neither, so a
  parent's transcript omits what it sent to and heard from its subagents.
- **Why or evidence**: 2026-10-26 inventory of local rollouts; the types are
  listed as known-unused in `src/parser/record-types.ts`, so the ingestion probe
  reports them under `known_unused`.
- **Next**: decide whether these are transcript content (an author/recipient
  message kind) or lineage metadata. Then project them like other messages, and
  check how the subagent boundary treats them.

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
  once `last_token_usage` per request is read. Otherwise leave as is. Since
  2026-10-27 this applies only to the counter path: rollouts from before Codex
  0.154, or whose records start mid-thread. A rollout recorded per request from
  its first request is billed one request at a time. The counter path also
  still leaves aborted-turn requests unbilled.

#### Some openbench comparator models are unpriced (`laguna-s-2.1`, `nemotron-3-ultra`)
- **What**: `import benchmark` prices the paid bake-off targets (glm-5.3-flash,
  deepseek-v4-flash-0731, minimax-m3) and the codex/claude daily drivers, but
  surfaces `laguna-s-2.1` and `nemotron-3-ultra` as unpriced (billed null, loud
  non-zero exit) in current runs.
- **Why it matters / evidence**: `laguna-s-2.1` is routed `:free` in
  the comparator harness's own bridge config yet its root `prices.json` lists
  0.1/0.2, so free-vs-paid is genuinely ambiguous and a rate was **not** guessed.
  A live `openrouter.ai/api/v1/models` pull on 2026-10-09 lists both a paid and a
  `:free` ($0) route for each: `poolside/laguna-s-2.1` at $0.09/$0.18 (cache read
  $0.009) and `nvidia/nemotron-3-ultra-550b-a55b` at $0.50/$2.20 (cache read
  $0.10). The imported `canonical_model` drops the route, so the pull cannot say
  which one a run used, and `nemotron-3-ultra` mapping to the 550B model is
  itself an assumption. Still not priced.
- **Next / Revisit when**: these models re-enter a run whose costs matter. Read
  the run's actual route (`:free` or paid) from the harness config, then add
  entries to `src/pricing/data/openrouter.json` from a fresh pull. Noted
  2026-09-02, rechecked 2026-10-09.

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

#### Claude Code OTEL stays off: it adds little the import lacks (2026-10-27)
- **What**: amon ingests Claude Code's OTEL metrics correctly, but the installed
  Claude Code does not export them, and enabling it is not planned.
- **Why or evidence**: measured on 2026-10-27 with Claude Code 2.1.311 against a
  scratch database:
  - Before the parser fix in the same PR, every metric row was stored under
    session `unknown` and every log record was dropped. Claude Code puts
    `session.id` on each point and record, not on the resource, so enabling
    export would have double-counted Claude cost permanently.
  - With the fix, each session's metric cost equals its imported cost exactly,
    and the import covers every metric row once the transcript lands.
  - Logs and metrics do not double-count: amon stores Claude's `api_request`
    log with no tokens or cost, because Claude sends `cost_usd` and
    `input_tokens` under plain names. A test pins "counted once" so a parser
    that learns those names must deduplicate.
  - What enabling would add: a live lead of seconds over the file watcher, and
    usage for sessions whose transcript never reaches this machine. Claude's
    own cost is already checked through `cost-state` (`amon costs
    check-sessions`). Active time, lines changed, commits and edit decisions
    are exported but not stored.
  - Space: about five rows per session, model and active export interval, each
    about 1 KB with indexes. At the measured activity that is roughly 7-15% more
    events rows a day, well under 1% of the database a month. Logs add about
    as many rows again with no usage in them. Prompts and responses arrive
    redacted by default; every point carries account identifiers, which amon
    does not store.
- **Revisit when**: Claude runs where its transcripts do not reach this machine,
  or active-time or edit-decision metrics are wanted (that also needs metric
  ingestion beyond tokens and cost). Enable metrics only.

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

#### Trajectory sparkline (occupancy gauge Task 8)
- **What**: session-lifetime occupancy fill over time with compaction drop-offs,
  in the detail/inspector surface.
- **Why it matters**: gauge + pill shipped first; this is the fast-follow.
- **Next**: needs a bounded sample buffer in the projection and a retention
  decision.

### Pricing

#### Some stored rates disagree with the vendors' live pricing pages
- **What**: no model with recent usage is unpriced any more: Claude Haiku 5.5
  (prompt-length tiered at 100K) and `gpt-5.6-cyber` were priced 2026-10-09 from
  the vendors' live pages. The same day Sonnet 5.5 cache reads were corrected
  from $0.20 to $0.10/MTok (the page's "0.05x the base input price"). Open items:
  - **Stored Sonnet 5.5 costs**: `estimated` costs stored before the correction
    used the $0.20 cache-read rate. Startup only fills NULL costs, so they need a
    full recalc, not `--missing-only`. `reported` costs are never rewritten.
  - **GPT-5.6 cache writes**: the OpenAI page (checked 2026-09-23, again
    2026-10-09) lists a 1.25x cache-write column for every GPT-5.6 and GPT-6
    model, while `codex.json` bills GPT-5.6 Sol, Terra and Luna cache writes at
    the input rate (commit `84db40b`'s reading). `gpt-5.6-cyber` uses the page's
    $15.625, so the GPT-5.6 rows now disagree among themselves. No effect today,
    since Codex emits no cache-write tokens.
  - **GPT-5.6 Sol promo**: the OpenAI page shows $4/$20 ("through 2026-11-21")
    while aggregators list $5/$30. We kept list ($5/$30); a `schedule` entry
    could encode the promo.
- **Why it matters**: a wrong rate is as silent as a missing one: the dashboard
  stays plausible.
- **Next**: once the Sonnet 5.5 correction is running, run
  `amon costs recalc --dry-run --json` and confirm that only Sonnet 5.5 rows
  move, then apply it. Reconcile the GPT-5.6 cache-write column before Codex
  starts emitting cache-write tokens.

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
- **Compaction rows (2026-10-26)** are keyed by the request's `response_id`,
  not the positional index, and advance no counter. Adding them re-keyed no
  stored row; the test `counter rows keep the ids they had before compactions
  were billed` pins that.
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

#### Imported Claude cost runs below Claude Code's own running cost, inside the main models
- **What**: imported Claude cost reads a few percent below Claude Code's own
  figure. On the main models the rates agree, so the shortfall is usage the
  transcripts never record. About two fifths of it is compactions; the rest is
  unidentified.
- **Why or evidence**:
  - **History.** After the 2026-09-27 repair, sessions read about 10-15% below
    the harness. Billing 1-hour cache writes at their own rate (2026-10-04)
    closed about half of that. On 2026-10-26 imported cost was 0.962 of the
    harness's, weighted by cost.
  - **Rates agree on the main models (2026-10-27).** Pricing each checkpoint's
    own tokens at amon's rates reproduces the harness's cost to within 0.1% on
    Opus 5.5, Opus 4.8, Opus 5, Sonnet 5 and Fable 5.1. `costs check-sessions`
    now reports this as `coverage` beside the ratio.
  - **Where the rates disagree, the harness is the outlier.** Claude Code
    (2.1.311) bills Sonnet 5.5 cache reads at 0.1x base input. Anthropic's
    pricing page says 0.05x, which amon uses, so Sonnet 5.5 sessions read low
    at full coverage. Side-model rates cannot be compared this way: amon holds
    no rows to give their cache-write TTL, and a tiered model's session totals
    cannot be repriced (see OPERATIONS).
  - **Side models are never in a transcript.** Haiku requests, for example
    WebFetch summarizing a page, have near-zero coverage. They are a fraction
    of a percent of cost in long sessions, but up to about a third in a short
    one.
  - **Main-model coverage is about 0.96, weighted by cost.** Pricing each
    compaction in the window as a request that reads `preTokens` from cache
    and writes `postTokens` of output explains about 42% of the main-model gap.
    That covers about 91% of the missing output, but only about 19% of the
    missing cache reads. Sessions with no compaction still read 1-3.6% low.
  - **Auto mode's permission classifier is a candidate, unconfirmed.** Sessions
    mostly in auto mode keep a 3-4% residual after compactions. Sessions that
    bypass permissions range from 0 to 3.4%. A headless `claude -p` run in auto
    mode logged only `sdk` requests, all of them in its transcript, so it
    neither confirms nor rules this out for interactive sessions.
  - **Retracted.** The earlier "0.05 resumed session" reading and a 3-19x
    reading on 2026-10-26 were both window errors. `cost-state` totals restart
    when a process does not restore the session's cost state, and its
    `startTime` says when.
- **Next**: identify the unrecorded main-model requests. Export one
  interactive session's OTEL logs to a scratch collector, not the live amon,
  and compare its `api_request` records per `query_source` with the
  transcript; the `repl_main_thread` records should match it one for one. If
  compactions or a named source account for the rest, decide whether to
  estimate them with explicit provenance or to disclose the gap.
- **Revisit when**: weighted coverage drifts outside about 0.9-1.0, or a
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

#### Cumulative OTLP baselines live only in memory
- **What**: `computeDelta` in `src/otel/parser.ts` converts cumulative counters
  to deltas against an in-memory baseline, and counts a series' full value the
  first time it sees it. After an amon restart, the next export of every
  cumulative series is counted in full again, for usage (tokens and cost) and
  operational metrics alike. A zero-change export also stores no retry key, so
  a resend that arrives after a restart is not caught either.
- **Why or evidence**: latent today. Checked 2026-10-09: Codex hardcodes
  delta temporality for its OTLP metric exporter (`codex-rs/otel/src/metrics/
  client.rs`), and Claude Code is not configured to export metrics to amon, so
  no cumulative series arrives. Raised by review of the operational retry dedup.
- **Revisit when**: a producer that exports cumulative temporality is
  connected (a Claude Code metrics export, or a Codex change). Then persist
  the baseline per series (keyed as `computeDelta` keys it today) so a restart
  diffs against the last stored value, and treat a series first seen after a
  restart as a baseline rather than a delta.

#### A failed operational insert fails the request after usage is stored
- **What**: the OTLP metrics route stores usage events before operational
  points; if the operational insert throws, the request returns 500 after the
  usage events were written. The exporter then retries the whole batch.
- **Why or evidence**: noted 2026-10-09 while adding operational retry dedup.
  Usage events and operational points both dedup resends now, so a retry
  should not double-count; whether the partial write leaves anything else
  inconsistent is unchecked.
- **Revisit when**: an operational insert failure shows up in the logs, or the
  metrics route gains another write. Then wrap both writes in one transaction.

#### The OTLP traces route acknowledges spans and discards them
- **What**: `POST /api/otel/v1/traces` in `src/api/otel.ts` checks that the body
  is JSON and returns `200 {}` without parsing, storing, or counting the spans.
  The logs and metrics routes admit records and report drops; this route reports
  success for a batch it threw away, so an exporter sees no error.
- **Why or evidence**: latent today. Checked 2026-10-22 on the Mac mini: Codex
  exports only logs and metrics to amon (`~/.codex/config.toml`), and Claude Code
  has no OTEL exporter configured, so no spans arrive. Claude Code 2.1.300 added
  GenAI semantic-convention span attributes (`gen_ai.conversation.id`,
  `gen_ai.tool.name`, `error.type`), which makes enabling its traces tempting;
  doing so would lose every span without a signal.
- **Next**: until ingestion exists, make the route honest (count the spans as
  rejected the way the logs and metrics routes record drops, or return 501).
  Before building ingestion, capture a sanitized Claude Code 2.1.301+ trace
  export and compare its spans with the events hooks, session files, and OTEL
  logs already produce. Ingest only what spans add, and deduplicate against
  those sources.

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

### Frontend testing

#### Cover component behavior (mount + reactivity)
- **What**: every pure `frontend/src/lib` module now has mutation-checked unit
  tests (2026-10-09). Not covered: component mounting and `$derived`/`$effect`
  reactivity, which needs `@testing-library/svelte` plus
  `flushSync`/`$effect.root`.
- **Why it matters**: component tests are the larger lift and only pay off
  where a component holds real logic rather than markup over tested helpers.
- **Next / Revisit when**: stand up `@testing-library/svelte` the first time a
  component's behavior (not just its markup) needs a regression guard. No
  coverage threshold is enforced yet; add one only once the surface is broad
  enough that a number is meaningful. Noted 2026-09-11, narrowed 2026-10-09.

#### `test:verify` runs outside CI, so its browser scenarios can rot
- **What**: the verification pilot's scenarios (`pnpm test:verify`) are neither a
  CI job nor a pre-push gate.
- **Why or evidence**: after Live folded into Monitor, the live-session scenario
  kept opening `#live`, by then a redirect, and failed until 2026-10-15. Nothing
  noticed, though it is the one check that runs the compiled watcher through to
  the browser.
- **Next**: time `pnpm test:verify` in the E2E job (which already builds and
  installs Chromium) and add it there if the cost is acceptable.

#### Frontend pure-module tests are split across two runners
- **What**: most `frontend/src/lib` helper tests (`frontier-geometry`, chart
  `scales`, `monitor-analytics`, `route-state`, the `*-state.ts` helpers,
  `session-roles`, `session-capabilities`, `skill-consultation-view`, usage
  `model-colors` and `unpriced-usage`) are root `node:test` files under
  `tests/` and run in `pnpm test`. The Vitest harness (`pnpm frontend:test`)
  holds the store tests plus `session-text`, `format`, `quota-pill`, and chart
  `layout`. `monitor-session-merge` and `monitor-token-totals` have a suite in
  each (`format`'s two were merged into Vitest on 2026-10-15).
- **Why or evidence**: the split hid existing coverage. The 2026-09-11
  coverage entry listed the root-tested modules as untested.
- **Next**: when the UI restructure moves or renames one of these modules, move
  its tests into a colocated Vitest file in the same change. Merge the
  duplicated suites at the same time.

### Cross-repo pattern-mining candidates (agentsview, 2026-09-13)

Flagged by a clone-mining report comparing `agentsview` (a Go/Svelte local
AI-agent session aggregator — same archetype as agentmonitor) against this repo.
The report is held outside this repository and is agent-generated. All three
items were checked against current code and a local store on 2026-10-01; the
entries below record what was measured, not the report's claims.

#### Codex OTEL events project item-less turns
- **What**: `syncCodexSummaryLiveEvent` ensures one projected turn for every
  Codex OTEL event, whether or not the event yields an item. Request-side and
  decision rows (`llm_request`, tool decisions) therefore each add a turn with
  nothing in it.
- **Why or evidence**: measured 2026-10-26 on the live store. Before the
  stream-fragment prune, about two thirds of all projected turns were item-less
  Codex turns. Most of them came from the fragments, which the prune removes
  together with their turns. The remainder is smaller, but the shape persists
  for every non-item event.
- **Next**: decide whether a turn needs an item to exist. If so, skip the turn
  for item-less events, and prune the stored ones with the same
  preview/digest/ownership gate as `amon database prune-codex-fragments`.
  Check first that the live view and trace projection never read an item-less
  turn.

#### Watcher re-sync still reads, hashes and summarizes the whole session
- **What**: since 2026-10-07 a re-sync parses only the appended lines (see
  ARCHITECTURE, Session Browser And Live), but every sync still reads and hashes
  the whole file, and the trace summary of a session without events (mostly
  Codex) still projects its full transcript.
- **Why or evidence**: measured 2026-10-07 with `verify probe resync` on the
  largest local transcripts, a 10-line append: the parse went from about 0.19 s
  (Claude) and 0.33 s (Codex) to under 0.1 ms. What remains on the Codex
  transcript, about 0.14 s end to end, is mostly read and hash (about 0.06 s)
  and the trace summary (about 0.065 s). A Claude session with events
  summarizes in about 12 ms on the live store.
- **Next**: if appends to large Codex rollouts still block the server, derive the
  trace summary for event-less sessions incrementally, then hash only the bytes
  after a checkpoint, as `agentsview` does (`internal/sync/checkpoint.go`) with a
  trailing-anchor check; the periodic resync's full hash would remain the
  backstop for a changed prefix.
