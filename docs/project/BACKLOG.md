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

When an item ships it **leaves this doc** — record it as a concise what/why
bullet in `ROADMAP.md` (Completed Highlights) instead of keeping a "resolved"
note here. This file stays future-only.

---

## Open

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
  wanted; spec `docs/specs/2026-09-02-benchmark-comparison-view-spec.md` (P4
  section). Watch openbench #5 (per-attempt cost) — landing it would drop the
  "cost is a floor" honesty caveat. Noted 2026-09-02, updated 2026-09-04.

### Skill trigger health (2026-07-09)

Source: `docs/plans/2026-07-09-skill-trigger-health-plan.md` (phase 1 shipped).
These are the deferred follow-ups surfaced during and after the build.

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

### Analytics rollups (schema-storage-rebalance Phase 2)

#### Legacy v1 session-list N+1
- **What**: the v1 `queries.ts` session list (retiring `/` dashboard) keeps the
  per-session correlated-subquery N+1 that v2 `listMonitorSessions` shed.
- **Why it matters**: left untouched to avoid investing in the deprecated surface.
- **Next**: apply the same CTE rewrite if v1 is kept.

### Context occupancy

#### Monitor-card occupancy join not visually verified under live v1 hooks
- **What**: the Live inspector (pure v2) renders occupancy end-to-end; the Monitor
  cards read the v1 store and join v2 occupancy by session id. Svelte-checked and
  logically verified, but not screenshotted with a live hook/OTEL-fed active
  session (the scratch server had 0 active v1 sessions). The Codex id mismatch (v1
  OTEL UUID vs v2 rollout filename) is aliased in `refreshOccupancy`.
- **Why it matters**: confirm the join renders on a real running card, especially
  for Codex.

#### Trajectory sparkline (occupancy gauge Task 8)
- **What**: session-lifetime occupancy fill over time with compaction drop-offs,
  in the detail/inspector surface.
- **Why it matters**: gauge + pill shipped first; this is the fast-follow.
- **Next**: needs a bounded sample buffer in the projection and a retention
  decision (see `docs/plans/2026-07-07-context-occupancy-gauge-plan.md`).

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
  does it is invisible (no error, plausible dashboard). Two date-dependent rates
  now sit in the index and will silently drift without date-awareness (below):
  the added **Gemini 3.6/3.7/3.8 Flash carry a promo $0.75 in / $3.75 out that
  reverts to $1.50 / $7.50 on 2027-01-01**, and `gpt-5.6-sol` shows a promo $4/$20
  ("through 2026-11-21") on the OpenAI page while aggregators list $5/$30 — we
  kept list ($5/$30); captured `cost_usd` covers benchmark actuals, so the table
  only affects the unpriced-fallback estimate.
- **Next / Revisit when**: add fable-5-1 / gpt-5.6-cyber the moment usage shows
  them unpriced (watch the "unknown-priced tokens" surface). The Gemini Flash and
  sol promos are the date-aware case (below) — before 2027-01-01, bump Gemini
  Flash to $1.50/$7.50 (or land date-aware rates). Noted 2026-09-03.

#### Processing-service tier is not captured with usage events
- **What**: cost estimation uses standard synchronous API rates. Event rows do not
  record OpenAI Standard, Priority, Batch, or other processing-service tiers, so
  the registry cannot select service-tier-specific pricing.
- **Why it matters**: GPT-5.6 Priority prices differ from standard rates. Standard
  pricing remains the honest default until ingestion exposes the billed service
  tier; do not infer it from the model ID.

#### Pricing engine has no date-awareness (rate schedules)
- **What**: `calculate()` selects rates by prompt-size tier but not by date, so a
  model carries one set of numbers forever. A rate that changes on a date (an
  intro period ending, a provider price cut) requires a manual `*.json` bump on
  the day, tracked only by a hardcoded deadline test.
- **Why it matters**: a lapsed rate is a silent money bug — the same shape as the
  dist-pricing incident (wrong cost, no error, plausible dashboard). The
  Sonnet-5 intro→standard transition (handled manually in `ed1bf70`, 2026-09-01)
  was the most recent instance; `tests/pricing-expiry.test.ts` is the deadline
  guard pattern. The guard buys time; it is not the fix.
- **Next / Revisit when**: the next dated rate change is known in advance, or the
  manual-bump toil recurs. Let a model carry a rate schedule (`{ from, rates }[]`)
  and select the entry effective at the event's timestamp; migrate the
  deadline-guarded rates onto it. Noted 2026-07 (Sonnet 5 expiry); reframed
  2026-09-03 after the manual bump shipped.

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

#### OTEL metrics without token/cost deltas are silently dropped
- **What**: `POST /api/otel/v1/metrics` (`src/api/otel.ts`) only persists a
  metric when it carries a token or cost delta (`if (!hasTokens && !hasCost)
  continue;`). Operational counters that carry a status/label but no
  tokens/cost — e.g. Codex's `codex.memory.startup` counter, whose `status` tag
  is `skipped_rate_limit` / success / etc. — are discarded on ingest, so nothing
  about them ever reaches the DB.
- **Why it matters**: agentmonitor is the local observability console for Codex,
  yet it cannot answer operational questions like "is Codex's memory
  consolidation running, and if not, why is it skipping?" The counter is exported
  to `127.0.0.1:3141` and thrown away. Diagnosing a real Codex consolidation
  stall (2026-08-30) had to fall back to reading the Codex binary + source
  because the console was blind to the signal it was already receiving. This is
  the "absence is a claim about the instrument" trap: an empty query looked like
  "never happened" when the ingest path had dropped it.
- **Evidence**: `src/api/otel.ts` metrics handler; Codex emits
  `codex.memory.startup` via `session_telemetry.counter` (metric, not
  token/cost). Confirmed `metadata LIKE '%codex.memory%'` returns 0 rows in
  `data/agentmonitor.db` despite Codex exporting it.
- **Next / options**: persist label-only / gauge / counter metrics as a
  first-class metric event (not a synthetic `llm_response`), keyed by metric name
  + attributes, so status-tagged operational counters are queryable. At minimum,
  stop silently dropping non-token metrics — record them with their attributes.
- **Revisit when**: adding any Codex operational observability (consolidation
  health, rate-limit skips) to the console.
