# Backlog

Living list of **future** design gaps, tech debt, and better ways to do a thing
noticed during normal execution. Fix simple, quick, or blocking issues inline;
capture only durable follow-ups worth revisiting cold. Not a commitment for the
active task unless explicitly pulled into scope; ROADMAP.md is the higher-bar
shipped/directional view. Add an item only when it cannot be fixed inline and
represents recurring friction, meaningful risk or cost, an unresolved decision,
or a concrete trigger.

This repository is the canonical owner for its follow-ups; cross-repository work
belongs with the repository that owns the capability, with links from affected
repositories only when useful.

Convention: each item has **What** (the friction), **Why or evidence**, and
optionally **Next** (the smallest action that makes it actionable) or **Revisit
when** (an intentional external or measurable gate). Default state is omitted;
use **Revisit when** for gates and `State: blocked — <reason>` only when work is
genuinely blocked externally.

**Cite a number, or say it is a guess.** Any causal or performance claim here —
"X is slow", "Y causes the flake" — carries a measurement, or is labelled
*hypothesis, unmeasured*. Entries get read back later as established fact and
turned into work: an unmarked guess about the Analytics fan-out was written here,
believed on re-read, and nearly bought a whole endpoint before a 30-second `curl`
showed the endpoints return in 1–4ms. The label is the forcing function that makes
someone run the cheap probe first.

Review this file after a significant shipped slice or at least quarterly: confirm
each item is still open, refresh dated evidence, promote selected work to a plan,
convert it to a trigger, or move completed decisions and work to the Roadmap or
decision history.

When an item ships it **leaves this doc**. Record it in `ROADMAP.md` when it is a
recent milestone that changes current direction; otherwise let its PR and commits
hold the detailed history. Do not keep a resolved section here.

---

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

#### Auto-import re-reads and re-hashes every transcript on every run
- **What**: `processFile` (`src/import/index.ts`) reads and SHA-256 hashes the
  whole of every discovered Claude, Codex and Antigravity file on each
  auto-import (every 10 minutes by default), before it checks `import_state`.
  Unchanged files cost a full read. `import_state.file_size` is stored but never
  used to skip one. The run is synchronous, so the server blocks while it hashes.
- **Why it matters / evidence**: measured 2026-09-24 on this MacBook with the
  files cached in memory:
  - Hashing 359 Codex rollouts (about 1 GB; Codex never deletes them) takes
    0.40–0.44 s per run.
  - Claude transcripts were capped at about 30 days by `cleanupPeriodDays` until
    that was raised to 3650. At the current rate (about 234 MB of transcripts
    and file history per 30 days) they add about 1 s per run for each year kept.
  - Runs with the files no longer in memory are slower (not measured).
- **Next**: skip re-reading a file whose size and mtime match the stored state.
  Keep the full hash for changed files and for `--force`. Store the mtime
  alongside the size. Land this after the Codex import usage repair, which
  changes the same path to hash and parse one read of the file
  (`docs/plans/2026-09-24-codex-import-usage-repair-plan.md`).

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
  refactored onto `linearScale`) **shipped** 2026-09-04 (see ROADMAP). What
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

#### Windowed Codex skill-event scan chooses the agent index
- **What**: on the 2026-07-29 copied 1.4 GB database,
  `EXPLAIN QUERY PLAN` for the fixed-window Codex skill-event leg chose
  low-cardinality `idx_events_agent_type` and a temporary ordering b-tree
  instead of `idx_events_usage_ts`. After removing the duplicate ledger read,
  the complete enriched 2026-07-01..27 health query measured a 102.5 ms median
  over seven warm runs versus 88.3 ms for phase 1 alone.
- **Why it matters**: current latency is acceptable, but this leg still scales
  with all retained Codex events and may become the next health-query bottleneck
  as history grows.
- **Next**: benchmark a purpose-built partial/composite skill-event index
  against the real predicate and ordering; retain it only if the planner uses it
  and write cost/storage remain justified.

#### Codex OTEL events carry no producer time
- **What**: Codex's OTLP log appender never sets `timeUnixNano`. The event time
  is only in the `event.timestamp` attribute (`codex-rs/otel/src/events/shared.rs`),
  which `parseLogRecord` does not read, so `client_timestamp` is NULL and every
  read falls back to `created_at` (server receive time).
- **Why or evidence**: measured 2026-09-23 on the live DB: all but one OTEL row
  lacks `client_timestamp`. The error is the exporter's batch delay (seconds),
  so the effect on daily views is small, but ordering within a batch and any
  per-event latency math use arrival time.
- **Next**: fall back to `event.timestamp`, then `observedTimeUnixNano`, in
  `parseLogRecord`. First check the Codex OTEL/JSONL overlap suppression, which
  compares timestamps, still pairs rows once OTEL rows carry producer time.
  Related: OTLP operational metrics (`otel_metrics`) have no retry dedup yet,
  unlike usage metrics.

### Analytics rollups (schema-storage-rebalance Phase 2)

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

#### Interleaved sidechain turns can clobber occupancy (latent)
- **What**: `src/parser/claude-code.ts:450` updates `contextUsedTokens` and
  `latestModel` for every assistant turn with usage, with no `isSidechain`
  guard, so an inline subagent turn would overwrite the main thread's occupancy
  with its own small context.
- **Why or evidence**: reproduced 2026-09-22 against a synthetic transcript
  (main thread at 500k/1M reported as 1200 tokens after a subagent turn). **Not
  currently reachable**: Claude Code now writes subagents to separate
  `agent-*.jsonl` files, which the parser already treats as distinct sessions,
  and 0 of the 200 most recent local transcripts contain inline
  `"isSidechain":true` lines. Latent regression risk only, if the transcript
  layout changes back or an older archive is imported.
- **Revisit when**: importing legacy transcripts with inline sidechains, or if
  the upstream layout changes; the fix is a one-line guard on the occupancy
  assignment.

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
  and Fable 5.1 were priced 2026-09-23 from the live pricing page, after Fable
  5.1 usage had already landed at $0; both break the 0.1x cache-read convention
  (0.05x and 0.025x), so a rate card cannot be derived from the input price.
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
  manual backfill is needed. What is still missing is the signal: a check that
  fails, or a Monitor warning, when recent usage carries an unpriced model would
  catch the next launch before the $0 rows pile up.

#### Processing-service tier is not captured with usage events
- **What**: cost estimation uses standard synchronous API rates. Event rows do not
  record OpenAI Standard, Priority, Batch, or other processing-service tiers, so
  the registry cannot select service-tier-specific pricing.
- **Why it matters**: GPT-5.6 Priority prices differ from standard rates. Standard
  pricing remains the honest default until ingestion exposes the billed service
  tier; do not infer it from the model ID.

#### Child-agent transcripts collide with their parent's event ids, so their usage never imports
- **What**: `parseClaudeCodeFile` derives `event_id` from
  `claude-code:<sessionId>:<line index>`, and a child-agent transcript
  (`projects/<project>/<session>/subagents/agent-*.jsonl`) embeds its **parent's**
  `sessionId`. Parent and child therefore mint identical ids for the same line
  number, and `insertEvent` returns early on an existing `event_id` — so
  whichever file imports second has those events silently dropped.
- **Why or evidence**: measured 2026-09-22 — **every** child-agent event in a
  sampled session collided with a parent id, so none of that session's delegated
  usage was ever stored. A local store shows a small population of rows the
  usage repair flags as `rows_ambiguous` for the same reason. This is an under-count in the opposite
  direction from the per-content-block over-count fixed in this branch, and the
  two do not cancel: they hit different sessions by different amounts. Surfaced
  by Codex review on PR #137.
- **Next**: make `event_id` include file identity (e.g. the transcript's
  basename or a path hash) so parent and child cannot collide. Note the
  migration cost before doing it: every existing imported row's id changes, so
  re-import would insert duplicates rather than dedupe against history. Needs a
  deliberate plan — id-derivation version marker, or a one-time remap — not a
  drive-by edit. Related: [Consistent session identity](#consistent-session-identity-and-parentchild-coverage-across-read-surfaces).

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
- **Revisit when**: Codex starts rewriting or compacting rollout files, or a
  derivation change becomes genuinely necessary. Either way it needs a legacy-id
  bridge first, mirroring `src/import/index.ts`'s ownership rule; do not simply
  update the pinned expectation.

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

#### Bedrock-style and `[1m]` model IDs never resolve (silent $0)
- **What**: `PricingRegistry.normalize` (`src/pricing/index.ts:227`) strips only
  `anthropic/`, `openai/`, `google/` prefixes. `anthropic.claude-…-v1:0`,
  `us.anthropic.claude-…-v1:0` and a trailing `[1m]` long-context marker fall
  through to no match, and no alias covers them.
- **Why or evidence**: reproduced 2026-09-22 — `claude-sonnet-4-5-20250929`
  resolves while the Bedrock and `[1m]` spellings return `pricing_status=unknown`
  and `cost_usd` stays null. Claude Code against Bedrock is a real, supported
  configuration, and an unpriced model bills as $0 rather than raising — the same
  shape as the five-month dist-pricing bug.
- **Next**: strip `^(us\.)?anthropic\.`, a trailing `-v\d+:\d+`, and a
  trailing `[1m]` before lookup (or add explicit aliases), with a normalization
  test per spelling. Distinct from the unpriced-model item above, which is a
  missing rate card rather than a normalization gap.

#### Cache-write TTL tiers are not represented anywhere (unanswered)
- **What**: nothing in the pricing schema, the OTEL `token.type` handling
  (`src/otel/parser.ts:1093`), or the Claude Code JSONL usage shape distinguishes
  Anthropic's 5-minute from 1-hour cache-write TTL; one flat
  `cacheWriteCostPerMTok` exists per model.
- **Why or evidence**: current values (e.g. sonnet-5 at `2.5` = 1.25× base input)
  follow the 5m convention, so a 1h-TTL write would underprice by roughly
  1.6–2×. Whether local telemetry ever surfaces the distinction was **not
  established** — recorded unanswered rather than closed.
- **Revisit when**: extended-cache-TTL usage is plausible locally. The cheap
  probe is to grep a live transcript and an OTEL capture for any TTL-bearing
  usage field before designing schema for it.

### Reliability And Observability

#### CI flake: analytics capability banner times out on a cold runner
- **What**: `search-analytics-capabilities.spec.ts:119` intermittently exceeds
  Playwright's 5s `expect` timeout waiting for the coverage banner. It passes on
  retry, so CI stays green and it reads as flaky rather than broken.
- **Why it matters**: it burns retries and trains us to ignore a red E2E. Ruled
  out so far: it is not query time (the seeded DB has two sessions), and it is not
  a text race between `coverage.summary` and `coverage.tools` (both seeded sessions
  are `tool_analytics: full`, so `excluded_sessions` is always 0 and the banner
  cannot flip branches). Most likely first-navigation cost — it is the first test
  in the file — but that is unconfirmed.
- **Next**: instrument the wait before changing the timeout. Raising it would
  hide the cause, and the point is to learn whether first paint is genuinely slow.

#### Operational metrics UI surface (follow-up to the shipped ingestion)
- **What**: operational OTEL metrics now ingest into `otel_metrics` and read via
  `GET /api/v2/metrics` (shipped 2026-09-04, see ROADMAP), but there is no `/app/`
  surface yet — no Codex consolidation-health panel or rate-limit-skip view.
- **Why it matters**: the data is queryable but an operator still has to hit the
  API by hand. A small Monitor/Analytics panel ("is memory consolidation running,
  and which states is it hitting?") is the payoff that motivated the ingestion.
- **Next / Revisit when**: building Codex operational observability into the
  console. The read shape (name×attrs → occurrences/last-seen) is already there;
  this is a frontend consumer. Noted 2026-09-04.

#### Hook safety heuristics under-match and should be documented as best-effort
- **What**: the destructive-command filter
  (`hooks/claude-code/pre_tool_use.sh:33` and the identical regex in
  `python/pre_tool_use.py:31`) requires a literal unquoted path token followed by
  whitespace/EOL, and the sensitive-file regex (`:55`) is an anchored,
  case-sensitive suffix match.
- **Why or evidence**: tested 2026-09-22 — `rm -rf /` is blocked, while
  `rm -rf "/"`, `rm -rf ${HOME}`, `rm -rf $HOME/`, `rm -rf /*` and
  `rm --recursive --force /` all pass. `.env.local`, `.env.production`,
  `credentials.json` and `.PEM` produce no `security_warning`. These are everyday
  spellings, not adversarial ones.
- **Next**: normalize quotes/braces and match common suffixes; match secret files
  on basename patterns case-insensitively. Either way state plainly in
  `hooks/claude-code/README.md` that this is best-effort telemetry, not a
  security control, so no one builds on it as one.

#### Hook installer rough edges
- **What**: `hooks/claude-code/install.sh:57` names backups with 1-second
  resolution, so two installs in the same second overwrite the first backup with
  already-modified settings. Separately, `notification.sh` is listed in
  `hooks/claude-code/README.md:125` but is wired nowhere — `install.sh` registers
  only SessionStart, Stop, PostToolUse, PreToolUse, UserPromptSubmit and
  InstructionsLoaded, and there is no `python/notification.py`.
- **Why or evidence**: both confirmed 2026-09-22 — two back-to-back installs into
  a scratch config dir produced one shared `settings.json.bak.<ts>` (hook entries
  themselves dedupe correctly, so idempotency is fine); `grep -in notification`
  across `install.sh`, `README.md` and `python/` hits only the README row.
- **Next**: add a PID/nanosecond suffix or skip when a backup exists; then either
  wire `Notification` into the installer and manual-install docs or delete the
  script and its README row.

#### Small hardening items from the 2026-09-22 review
- **What**: a cluster of individually minor gaps, all traced, none urgent:
  `Number(params.cursor)` yielding `NaN` silently matches zero rows
  (`src/db/v2-queries.ts:551`); `getOperationalMetricSummary` has a floor-only
  limit guard with no upper clamp (`:4241`); `AGENTMONITOR_PORT` is validated
  `>= 1` with no upper bound, so `99999` reaches `listen()` as a raw
  `ERR_SOCKET_BAD_PORT` instead of the CLI's usage error
  (`src/config.ts:220`, `src/cli/commands/runtime.ts:36`); `parseIntegerOption`
  accepts `--limit 100xyz` as `100` because `parseInt` stops at the first
  non-digit (`src/cli/args.ts:174`); `outputRaw.slice(0, 500)`
  (`src/otel/parser.ts:738,769`) truncates by UTF-16 unit and can split an astral
  character into a lone surrogate that SQLite stores as U+FFFD — a different path
  from the byte-safe `truncateMetadata`; `buildObservationTree`
  (`src/trace-quality/on-demand.ts:272`) has no cycle guard, currently safe only
  because its sole producer enforces forward-only links.
- **Why or evidence**: each reproduced or traced 2026-09-22 during the review;
  none has a known user-visible failure today.
- **Next**: fix opportunistically when touching the owning file.

#### Antigravity live projection is documented as absent but is wired
- **What**: `docs/system/FEATURES.md:37` and `docs/system/ARCHITECTURE.md:163`
  state Antigravity has no live projection, but
  `syncAntigravityLiveSession` (`src/live/antigravity-adapter.ts:49`) is wired
  into the watcher at `src/watcher/index.ts:312` and performs summary-fidelity
  live projection, including WAL-aware resync.
- **Why or evidence**: confirmed 2026-09-22 by tracing the live-wired path. Doc
  staleness, not a runtime bug — but a consumer reading the fidelity claim would
  be misled about what Antigravity reports.
- **Next**: correct both docs to describe summary-fidelity live projection, or
  state precisely what "no live projection" was meant to exclude (e.g. SSE push).

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

#### `editedFilesBySession` grows for the life of the browser tab
- **What**: the module-level `Map<string, Set<string>>` at
  `frontend/src/lib/stores/monitor.svelte.ts:61` is populated on every live
  file-edit event and never evicted; a full-repo grep finds no `.delete()` or
  clear for it.
- **Why or evidence**: traced 2026-09-22. The SSE connection opens once at app
  mount and lives for the whole tab, so on a long-running dashboard — the
  product's stated use case — every session that ever edits a file retains an
  entry after it ends. Slow unbounded growth; no measured impact yet, so the
  severity is *hypothesis, unmeasured*.
- **Next**: evict when a session resolves to `ended` in
  `applyLiveEventAggregate`, or prune against the bounded `sessions` array on
  `setSessions`.

### Cross-repo pattern-mining candidates (agentsview, 2026-09-13)

Flagged by a clone-mining report comparing `agentsview` (a Go/Svelte local
AI-agent session aggregator — same archetype as agentmonitor) against this repo.
The report is held outside this repository and is agent-generated; it was **not**
independently verified against
agentmonitor's current code, so each item below is a **hypothesis to confirm**
before acting — the cited agentmonitor files/pains are the report's claims.

#### Watcher re-reads whole appending JSONL transcripts (safe-resume checkpoints)
- **What**: the report claims the ingestion watcher re-reads/re-hashes full JSONL
  transcript files on each turn instead of resuming from the appended delta.
  `agentsview` uses persistent safe-resume checkpoints — inode/mtime/change-time
  gating plus a bounded 128 KiB trailing-anchor digest — to read only new bytes on
  multi-hundred-MB logs (report pattern 1; agentsview `internal/sync/checkpoint.go`).
- **Why it matters / evidence**: report-sourced; cites `src/watcher/index.ts`,
  `src/db/schema.ts`. Unconfirmed — verify the watcher actually re-reads whole files
  today before treating this as a defect.
- **Next / Revisit when**: confirm the re-read behavior in `src/watcher/index.ts`;
  if real and large logs are a live cost, port the checkpoint + tail-anchor scheme.

#### Session project identity fragments across ephemeral git worktrees
- **What**: the report claims sessions run in ephemeral agent worktrees resolve to
  the worktree branch leaf rather than the canonical parent repo, fragmenting a
  project's sessions. `agentsview` resolves `.git` gitfiles → `commondir` and
  recovers deleted ephemeral worktrees from surviving ancestors/`.git/worktrees/`
  (report pattern 3; agentsview `internal/parser/project.go`).
- **Why it matters / evidence**: report-sourced; cites `src/util/project-identity.ts`,
  `src/parser/{claude-code,codex-sessions}.ts`. Unconfirmed.
- **Next / Revisit when**: confirm project-identity handling of worktree gitfiles;
  if sessions genuinely fragment, add canonical-parent resolution + sibling recovery.

#### Inline base64 tool-result images bloat the store
- **What**: the report claims multi-MB base64 image data URIs from browser/screenshot
  tools are stored inline, bloating SQLite and UI serialization. `agentsview` strips
  them to a compact descriptor (`agentsview_image`) with SHA-256 + byte count (report
  pattern 5; agentsview `internal/db/tool_result_images.go`).
- **Why it matters / evidence**: report-sourced; cites `src/contracts/event-contract.ts`,
  `src/parser/claude-code.ts`. Unconfirmed — verify whether inline base64 images
  actually reach the store today.
- **Next / Revisit when**: confirm via a real session containing tool images; if they
  land inline, strip to an `image_ref` descriptor in `normalizeEvent`.
