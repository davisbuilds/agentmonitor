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

#### Some openbench comparator models are unpriced (`laguna-s-2.1`, `nemotron-3-ultra`)
- **What**: `import benchmark` prices the paid bake-off targets (glm-5.3-flash,
  deepseek-v4-flash-0731, minimax-m3) and the codex/claude daily drivers, but
  surfaces `laguna-s-2.1` and `nemotron-3-ultra` as unpriced (billed null, loud
  non-zero exit) in current runs.
- **Why it matters / evidence**: `laguna-s-2.1` is routed `:free` in
  `_forks/openbench/obench/bridge/config.yaml` yet the fork's root `prices.json`
  lists 0.1/0.2 — free-vs-paid is genuinely ambiguous, so a rate was **not**
  guessed. `nemotron-3-ultra` has no authoritative source in the fork at all.
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

#### OTLP ingestion bypasses the event contract (negative usage is storable)
- **What**: `src/api/otel.ts:63` inserts parser output straight through
  `insertEvent` without `normalizeIngestEvent`, so the contract's non-negative
  invariant does not apply to the OTLP path. A log record carrying a negative
  `gen_ai.usage.input_tokens`/`output_tokens`/`gen_ai.usage.cost` stores those
  values verbatim.
- **Why or evidence**: reproduced 2026-09-22 — a crafted record with
  `{input_tokens: -999999, output_tokens: -50, cost: -500.75}` stored and
  aggregated to exactly those negatives, which drags `SUM()` totals down and can
  mask real spend. ARCHITECTURE.md names the contract as *the* external
  ingest boundary, so this is an invariant gap, not a missing nicety.
- **Next**: route OTLP-derived events through `normalizeIngestEvent`, or clamp
  token/cost fields before insert; cover with a red test that asserts a negative
  attribute is rejected or clamped.

#### Non-finite cost values poison every downstream SUM
- **What**: `src/contracts/event-contract.ts:144` (`getOptionalNonNegativeNumber`)
  tests `typeof raw !== 'number' || raw < 0` but never `Number.isFinite`, so
  `cost_usd: 1e400` (JSON-parses to `Infinity`) passes validation on the public
  `POST /api/events` path.
- **Why or evidence**: reproduced 2026-09-22 — one accepted row made
  `SELECT SUM(cost_usd)` return `Infinity` permanently for every scope containing
  it (session, project, model, total). `NaN` is separately coerced to `NULL` by
  better-sqlite3, silently dropping the value instead of refusing it.
- **Next**: reject non-finite numbers in the contract helper
  (`!Number.isFinite(raw) || raw < 0`) and add a contract test for `Infinity`,
  `-Infinity`, and `NaN`.

#### OTLP events carry no dedup key, so exporter retries double-count
- **What**: `parseLogRecord`/`parseOtelMetrics` never set `event_id`, and the
  dedup branch in `src/db/queries.ts:446` only runs `if (event.event_id)`. OTLP
  exporters retry on timeout or connection reset by design, and each retry
  inserts fresh rows.
- **Why or evidence**: reproduced 2026-09-22 — replaying one identical parsed log
  record twice produced 2 rows and doubled `tokens_in`/`cost_usd` for a single
  logical delivery. The v1 HTTP contract documents `event_id` dedup; the OTLP
  path silently has none.
- **Next**: derive a stable `event_id` for OTLP records (hash of trace/span id
  plus timestamp and metric name) so retries collapse the way documented
  ingestion does.

#### Browser-reachable unauthenticated writes to the local ingest surface
- **What**: `src/app.ts:10` accepts `text/plain` for `/api/events` and
  `/api/otel`, which is a CORS-safelisted content type, and no Origin/Host check
  exists anywhere in the server. Any page the operator visits can blind-POST
  fabricated events to `127.0.0.1:3141`. Chained with
  `isHistoricalImportedEvent` (`src/db/queries.ts:307`), a forged
  `{session_id, source:'import'}` body with no `client_timestamp` also forces an
  arbitrary session to `status='ended'`.
- **Why or evidence**: reproduced 2026-09-22 — a cross-origin request with
  `Content-Type: text/plain` and `Origin: https://evil.example.com` returned
  `201` and wrote; a forged import event flipped a live session to `ended` with
  no ownership check. The write lands regardless of whether the attacker page can
  read the response, so same-origin read blocking is not mitigation.
- **Next**: validate `Origin`/`Host` against loopback on the ingest routes, or
  drop `text/plain` from accepted ingest content types; decide deliberately
  whether the public contract should ever be able to end a session it did not
  create. Also reduces DNS-rebinding exposure.

#### `insertEvent` is not transactional, leaving orphan sessions
- **What**: `src/db/queries.ts:415` calls `upsertAgent`/`upsertSession` (each
  committing immediately), then a session UPDATE, cost calculation, and finally
  the `events` INSERT. Any throw in that span — a constraint violation, or
  `SQLITE_BUSY` under concurrent hook/OTEL/watcher/auto-import writers — leaves a
  committed `sessions` row with no event.
- **Why or evidence**: reproduced 2026-09-22 against a scratch DB (forced
  constraint failure): session row present, zero events. The `v6`
  `deleteOrphanedSessions` migration (`src/db/schema.ts:1022`) sweeps this class
  once but is `user_version`-gated, so it never prevents recurrence; orphans
  inflate `total_sessions`/`active_sessions` indefinitely.
- **Next**: wrap the body from `upsertAgent` through the final INSERT in a single
  `db.transaction(...)`; also guard the post-insert `syncCodexSummaryLiveEvent`
  so a projection failure cannot 500 a write that already committed or skip
  `markStatsDirty()`.

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

#### Codex OTEL suppression drops unrelated JSONL skill invocations
- **What**: `src/skills/invocation-ledger.ts:322` keys
  `codexSessionsWithEvents` by canonical session id alone, so the presence of
  *any* qualifying OTEL skill event suppresses *all* JSONL-detected invocations
  for that session — including entirely different skills.
- **Why or evidence**: reproduced 2026-09-22 — a session invoking `skill-alpha`
  (via OTEL) and `skill-beta` (JSONL-only) counted alpha and silently dropped
  beta. Distinct from the backlogged windowed-scan index item, which is
  performance; this is undercounting, potentially to zero, in consultation
  analytics.
- **Next**: key suppression by `(canonical session, skill name, command
  fingerprint)` so only genuinely duplicated occurrences collapse.

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
  sub-15ms overview queries without touching the authoritative archive (report:
  `~/Dev/tokenmaxxing/research/reports/clone-pattern-mining-agentsview-2026-09-13.md`,
  pattern 2; agentsview `internal/db/usage_cache_schema.go`). Worth a look when
  building the derived store — the disposable-sibling framing (rebuildable, never
  authoritative) directly addresses the rebuild/recovery and parity concerns above.

#### Legacy v1 session-list N+1
- **What**: the v1 `queries.ts` session list (retiring `/` dashboard) keeps the
  per-session correlated-subquery N+1 that v2 `listMonitorSessions` shed.
- **Why it matters**: left untouched to avoid investing in the deprecated surface.
- **Next**: apply the same CTE rewrite if v1 is kept.

### Read-surface correctness (v2 API, 2026-09-22 review)

#### Benchmark rows leak into the Monitor feed and session list
- **What**: `listMonitorEvents` (`src/db/v2-queries.ts:1470`) and
  `listMonitorSessions` (`:1370`) never apply `excludeBenchmarkUsageCondition`,
  unlike `getMonitorStats`/`getMonitorToolStats`.
- **Why or evidence**: reproduced 2026-09-22 — with one real event and one
  `source='benchmark'` event seeded, the default (no-param) calls returned both.
  This contradicts ARCHITECTURE.md ("benchmark events remain excluded from normal
  activity and usage aggregates unless a benchmark-aware read explicitly includes
  them") and the comment at `src/db/usage-reconciliation.ts:34`. The live DB
  currently holds 179 benchmark rows, so the leak is visible today.
- **Next**: apply the existing exclusion condition to both queries with an
  opt-in param, mirroring `buildUsageFilterState`.

#### Invalid usage/analytics dates return 200 with all-zero totals
- **What**: `readAnalyticsParams` (`src/api/v2/router.ts:596`) and
  `buildUsageFilterState` (`src/db/v2-queries.ts:2632`) never validate
  `date_from`/`date_to`, unlike the `/activity/*` routes which reject non
  `YYYY-MM-DD` input with 400. SQLite's `datetime('not-a-date')` is NULL, so the
  comparison is never true and every row filters out.
- **Why or evidence**: reproduced 2026-09-22 —
  `getUsageSummary({date_from:'not-a-date'})` returned `total_cost_usd: 0`,
  `total_usage_events: 0`, empty breakdown instead of an error. Affects
  usage/summary, /daily, /projects, /models, /models/daily, /tiers, /agents,
  /top-sessions, /facets, /overview and analytics/summary, /activity, /projects,
  /tools. A typo renders as "no spend", the silent-$0 failure class this repo
  already guards elsewhere.
- **Next**: reuse the `/activity/*` date validation in `readAnalyticsParams` and
  return 400.

#### `limit=0` removes the row cap instead of clamping
- **What**: `listMonitorSessions` (`src/db/v2-queries.ts:1402`) treats
  `limit <= 0` as "no LIMIT clause" rather than clamping like every sibling list
  read.
- **Why or evidence**: reproduced 2026-09-22 — with 120 sessions seeded, the
  default returned 50 while `limit=0` and `limit=-1` each returned all 120. An
  unbounded read is reachable from `GET /api/v2/monitor/sessions?limit=0`.
- **Next**: clamp with the file's existing
  `Math.min(Math.max(limit, 1), N)` pattern.

#### `date_to` day boundary is off by an hour on DST transitions
- **What**: `listBrowsingSessions` (`src/db/v2-queries.ts:362`) builds the
  exclusive upper bound with local-timezone `getDate`/`setDate` mutation, not the
  UTC-safe pattern used in `src/trace-quality/on-demand.ts:29` and elsewhere in
  this same file.
- **Why or evidence**: reproduced 2026-09-22 — a session at
  `2026-03-08T23:30:00Z` with `date_to=2026-03-08` returned 0 rows under
  `TZ=America/Los_Angeles` and 1 row under `TZ=UTC`, because the local calendar
  day is 23 hours on that date. This is a local-first desktop app, so the host's
  real zone is what runs.
- **Next**: use UTC date math (`Date.parse(...) + 86400000` or `setUTCDate`).

#### Hour-of-Week heatmap buckets UTC but is labeled local time
- **What**: `getAnalyticsHourOfWeek` (`src/db/v2-queries.ts:2232`) applies
  `strftime('%w'/'%H', started_at)` with no `localtime` modifier, while
  `frontend/src/lib/components/analytics/HourOfWeekHeatmap.svelte:24` labels the
  view "Message density by local weekday and hour" / "24h local time".
- **Why or evidence**: confirmed 2026-09-22 by direct query comparison — for
  `2026-09-11 02:00:00`, `%w` yields `5` (Fri) UTC versus `4` (Thu) with
  `localtime` on this host. Every non-UTC operator sees their activity pattern
  shifted by their offset, mislabeled as local.
- **Next**: decide which one is the contract — bucket with `localtime` (or in JS
  from the parsed UTC date) or relabel the axis — and make code and label agree.

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
- **What**: the 2026-09-03 live-page audit (which confirmed ~40 existing rates,
  corrected Sonnet 5 + gpt-5.6 luna/terra, and **added** the newer Gemini Flash
  line — 3.6/3.7/3.8 Flash, 3.5 Flash-Lite, 2.5 Flash-Lite) still leaves a couple
  unpriced: `claude-fable-5-1` (Fable 5.1, cacheRead 0.025× = $0.25/MTok) and
  `gpt-5.6-cyber` ($12.50/$75). An unpriced model bills as **$0**, the silent
  under-report failure mode.
- **Why it matters**: only bites if one of these appears in the data, but when it
  does it is invisible (no error, plausible dashboard). The Gemini 3.6/3.7/3.8
  Flash promo→list revert (2027-01-01) is now handled by date-aware rate
  schedules (shipped 2026-09-04, see ROADMAP), so it no longer needs a manual
  bump. `gpt-5.6-sol` shows a promo $4/$20 ("through 2026-11-21") on the OpenAI
  page while aggregators list $5/$30 — we kept list ($5/$30); captured `cost_usd`
  covers benchmark actuals, so the table only affects the unpriced-fallback
  estimate (a `schedule` entry could encode the sol promo too if we choose to).
- **Next / Revisit when**: add fable-5-1 / gpt-5.6-cyber the moment usage shows
  them unpriced (watch the "unknown-priced tokens" surface) — blocked only on a
  verified rate card (fable-5-1's output rate is unrecorded; do not guess it).
  Noted 2026-09-03; date-schedule mechanism landed 2026-09-04.

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
- **Why or evidence**: measured 2026-09-22 on a local session — **267 of 267**
  child-agent events collided with parent ids, dropping 7.2M tokens for that one
  session. The live store shows 284 rows the usage repair flags as
  `rows_ambiguous` for the same reason. This is an under-count in the opposite
  direction from the per-content-block over-count fixed in this branch, and the
  two do not cancel: they hit different sessions by different amounts. Surfaced
  by Codex review on PR #137.
- **Next**: make `event_id` include file identity (e.g. the transcript's
  basename or a path hash) so parent and child cannot collide. Note the
  migration cost before doing it: every existing imported row's id changes, so
  re-import would insert duplicates rather than dedupe against history. Needs a
  deliberate plan — id-derivation version marker, or a one-time remap — not a
  drive-by edit. Related: [Consistent session identity](#consistent-session-identity-and-parentchild-coverage-across-read-surfaces).

#### Imported Claude rows with no surviving transcript stay inflated
- **What**: `amon costs repair-claude-usage` (shipped 2026-09-22 with the
  per-content-block billing fix) can only correct rows whose transcript still
  exists. Rows whose source file is gone keep the inflated usage the old
  importer wrote.
- **Why or evidence**: a dry run on the development store (2026-09-22, after
  ids moved onto the producer's `uuid`) reported 83,147 matched rows, 14,857
  correctable ($2,451 and 3.6B tokens reclaimed), 284 ambiguous, and **75,195
  rows with no surviving transcript**. A separate estimate that groups
  identical usage tuples within a session put total inflation near $8.2k, so
  roughly $5.7k sits in rows with no local evidence left to check them against.
  Historical cost views stay wrong by an unknown-but-bounded amount.
- **Next / Revisit when**: decide deliberately between three options — leave and
  disclose (cheapest, but every historical cost view silently overstates), a
  heuristic collapse of identical `(session, timestamp, usage)` tuples (recovers
  most of the remainder but *will* over-collapse genuinely identical turns, so
  it trades a known overstatement for an unmeasured understatement), or a
  provenance marker that labels pre-fix imported rows as unreliable in the UI.
  Do not run a heuristic collapse without first measuring how often distinct
  turns legitimately share a usage tuple.

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

#### Budget windows use local calendar dates against UTC SQL
- **What**: `localDateString`/`periodRange` (`src/usage/budgets.ts:152`) build
  day/week/month bounds from host-local `getFullYear/getMonth/getDate`, but
  `buildUsageFilterState` (`src/db/v2-queries.ts:2645`) compares via SQLite
  `datetime()`, which reads a bare `YYYY-MM-DD` as UTC midnight.
- **Why or evidence**: reproduced 2026-09-22 — under
  `TZ=America/Los_Angeles`, a $5 event at `2026-09-22T19:30:00-07:00` (still
  "today" locally) reported `spent_usd: 0` for that day's budget. West of UTC the
  window is shifted by the offset, so a spend cap can under-report evening spend
  and fail to trip while spilling the prior day in. No budgets are configured
  locally today, so this is latent until one is.
- **Next**: compute budget bounds in UTC (or make the comparison zone-aware) so
  the window matches how timestamps are stored.

#### `costs recalc` overwrites benchmark rows' authoritative captured cost
- **What**: the recalc query (`src/cli/commands/maintenance.ts:292`) rewrites
  `cost_usd` for every event with usage and has no `source != 'benchmark'`
  exemption, unlike the read paths and unlike `resolveBenchmarkCost`
  (`src/import/benchmark.ts:109`), whose own docstring calls the captured
  provider cost authoritative.
- **Why or evidence**: reproduced 2026-09-22 — a benchmark event with captured
  `cost_usd=1.5` became `3` (the local-table estimate) after one recalc run. Real
  provider cost (promo, discount, rounding) is destroyed and unrecoverable
  without re-import.
- **Next**: skip `source='benchmark'` in the recalc statement, or gate it behind
  an explicit `--include-benchmark`. Complements the existing recalc-clobber
  caution in the memory notes, which covers captured costs generally.

#### Antigravity generations all inherit the session's first timestamp
- **What**: `src/import/antigravity.ts:113` computes `firstTs` once and reuses
  `iso(firstTs)` as both `client_timestamp` and the pricing `at` for every
  generation in the session loop.
- **Why or evidence**: reproduced 2026-09-22 with a fixture straddling the
  `2027-01-01` Gemini Flash promo revert in `src/pricing/data/gemini.json`: both
  generations priced at `1.125` instead of the later one's correct `2.25`. Two
  consequences — cost-over-time views bunch all Antigravity spend at session
  start, and date-aware rate schedules select the wrong period.
- **Next**: carry each generation's own step timestamp into both fields.

#### `gpt-6-astra` charges for cache writes against file convention (unverified)
- **What**: `src/pricing/data/codex.json:5` gives `gpt-6-astra`
  `cacheWriteCostPerMTok: 12.5`, the only non-zero cache-write rate among the
  OpenAI-family entries, and its base rates (`10/50/1/12.5`) exactly match
  `claude-fable-5` in `claude.json`.
- **Why or evidence**: internal-consistency signal only, 2026-09-22 — every
  sibling GPT-5.x/o-series entry sets cache write to 0, matching OpenAI's
  convention of not charging for cache writes. **Not verified against a vendor
  rate card**, so the copy-paste explanation is a *hypothesis, unmeasured*; the
  live DB shows `gpt-6-astra` usage, so the exposure is real if the rate is
  wrong.
- **Next / Revisit when**: confirm against a published rate card before editing;
  do not guess the rate. If confirmed a paste error, zero the base and tier
  cache-write rates.

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

#### Hooks abort on repositories with no commits yet
- **What**: `get_branch` in `hooks/claude-code/send_event.sh:64` ends with
  `git rev-parse --abbrev-ref HEAD`, which exits 128 on an unborn HEAD. Because
  `BRANCH="$(get_branch)"` is a bare assignment under `set -euo pipefail`, the
  hook script dies before `send_event` runs.
- **Why or evidence**: reproduced 2026-09-22 — piping a payload to
  `post_tool_use.sh` in a freshly `git init`-ed repo printed nothing, exited 128,
  and fired no curl (`bash -x` shows the script ending right after
  `+ BRANCH=HEAD`). Affects `session_start.sh`, `session_end.sh`,
  `post_tool_use.sh`: every event is dropped for a repo's whole pre-first-commit
  life, exactly the new-project case the tool should capture best.
- **Next**: `BRANCH="$(get_branch || true)"` or end the function with a
  `|| true` / `echo "${branch:-}"` so git failure never escapes.

#### Statusline bridge and the Python hook block the agent's hot path
- **What**: `hooks/claude-code/statusline_bridge.sh:11` runs curl in the
  foreground with `-m 1` on every statusline render, and
  `hooks/claude-code/python/send_event.py:76` calls `thread.join(timeout=2)`
  despite documenting fire-and-forget.
- **Why or evidence**: measured 2026-09-22 against a listener that accepts but
  never responds — statusline bridge 1.05–1.12s per render; Python
  `post_tool_use.py` 2.13s per tool call, versus 0.06s for the shell equivalent
  (which backgrounds curl) and 0.08s when the connection is refused outright. A
  slow-but-reachable server is the bad case; a down server is fast.
- **Next**: background the statusline curl or drop its timeout to ~150–250ms, and
  bring the Python sender to true fire-and-forget parity with the shell hooks.

#### Malformed OTLP timestamps return a 500 with a full stack trace
- **What**: `nanoToIso` (`src/otel/parser.ts:191`) calls `BigInt(nanos)`
  unguarded from `src/api/otel.ts:61,84`; a non-numeric `timeUnixNano` throws a
  `SyntaxError` past the app's only error middleware (which special-cases
  body-parser JSON errors) to Express's default handler.
- **Why or evidence**: reproduced 2026-09-22 — `POST /api/otel/v1/logs` with
  `timeUnixNano: "not-a-number"` returned 500 including absolute server paths;
  `NODE_ENV` is set nowhere in the repo, so Express stays in verbose dev error
  mode. The process itself survived (`/api/health` still 200).
- **Next**: return `undefined` from `nanoToIso` on parse failure, and set
  `NODE_ENV=production` for `amon serve`.

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

#### Sessions page lacks the stale-response guard every other store has
- **What**: `loadSessions` in
  `frontend/src/lib/components/sessions/SessionsPage.svelte:122` assigns
  `sessions`/`total`/`cursor`/`hasMore` with no request token or
  `AbortController`, unlike `search`, `usage`, `insights`, `trace-quality` and
  `live`, which all guard.
- **Why or evidence**: traced 2026-09-22 (not executed — component races are
  outside the current pure-function Vitest harness). Changing the Project filter
  then the Agent filter quickly, or a `hashchange` from Back/Forward racing an
  in-flight load, lets the older response overwrite newer state: the list stops
  matching the visible filters and `cursor`/`hasMore` can page from the wrong
  position.
- **Next**: copy the `++requestToken` pattern from `usage.svelte.ts`'s
  `fetchAll` and bail when stale.

#### `formatNumber` rounds past its unit boundary
- **What**: `frontend/src/lib/format.ts:25` picks the unit before rounding, so
  values just under a boundary render in the lower unit at four digits.
- **Why or evidence**: reproduced 2026-09-22 — `formatNumber(999950)` →
  `"1000.0K"` (expected `"1.0M"`), `formatNumber(999950000)` → `"1000.0M"`.
  `frontend/src/lib/format.test.ts` asserts only round values, so the boundary
  band is unguarded.
- **Next**: round first, then select the tier; add boundary cases to the existing
  test.

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
AI-agent session aggregator — same archetype as agentmonitor) against this repo:
`~/Dev/tokenmaxxing/research/reports/clone-pattern-mining-agentsview-2026-09-13.md`.
The report is agent-generated and was **not** independently verified against
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
