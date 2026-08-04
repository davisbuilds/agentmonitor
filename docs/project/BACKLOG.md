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

#### `src/contracts/event-contract.ts` has no test of its own
- **What**: 246 lines of ingestion validation (`normalizeEventType`, `normalizeStatus`,
  `normalizeClientTimestamp`, `getRequiredString`, `getOptionalNonNegativeInt`) with no
  dedicated test file. It's reached indirectly through import/API tests, but its own
  coercion branches aren't pinned.
- **Why it matters**: this is the boundary where untrusted hook payloads become typed
  events. The failure mode matches the one this repo already knows well — a bad
  normalization silently reshapes data into something plausible rather than throwing, so
  it surfaces as wrong numbers on the dashboard, not as an error.
- **Next**: table-driven tests over the `normalize*`/`get*` helpers with malformed,
  missing, and out-of-range fields; assert coercion vs. rejection explicitly. Noted
  2026-07-16 during the portfolio TDD-guidance pass.

### Runtime CLI

#### `amon serve --no-browser` is accepted but has no effect
- **What**: the serve parser accepts `--no-browser`, but neither direct nor
  Portless-backed startup opens a browser, so the flag currently changes no
  observable behavior.
- **Why it matters**: the flag implies an auto-open default that does not exist,
  which makes the runtime CLI contract misleading.
- **Next**: either implement browser opening after health readiness and honor
  the opt-out, or remove the flag in a deliberate compatibility pass.

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

#### Processing-service tier is not captured with usage events
- **What**: cost estimation uses standard synchronous API rates. Event rows do not
  record OpenAI Standard, Priority, Batch, or other processing-service tiers, so
  the registry cannot select service-tier-specific pricing.
- **Why it matters**: GPT-5.6 Priority prices differ from standard rates. Standard
  pricing remains the honest default until ingestion exposes the billed service
  tier; do not infer it from the model ID.

#### Claude Sonnet 5 intro pricing expires 2026-08-31
- **What**: `claude.json` encodes intro rates ($2/$10, cacheRead $0.20, 5m write
  $2.50). Standard pricing ($3/$15, cacheRead $0.30, 5m write $3.75) takes effect
  2026-09-01.
- **Why it matters**: the engine has no date-awareness, so this is a manual data
  bump on that date. (Sonnet 5's newer tokenizer emits ~30% more tokens; cost
  reflects reported tokens, so no engine change needed.)
- **Guard**: `tests/pricing-expiry.test.ts` fails the build from 2026-09-01 if the
  registry still returns intro rates, with the replacement values in the message.
  A silent 33% under-count is exactly the dist-pricing failure mode — wrong money,
  no error — so it gets a deadline instead of a memory.
- **Real fix (still open)**: date-aware rates, so a model can carry a rate schedule
  rather than one set of numbers forever. The guard buys time; it is not the fix.

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
