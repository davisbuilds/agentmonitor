# Improvement Backlog

Living list of **future** friction points, design gaps, and follow-up actions
noticed while implementing specs. Lightweight — items get added when they bite,
removed when they're done or proven not worth doing. Not a commitment for the
active task unless explicitly pulled into scope; ROADMAP.md is the higher-bar
shipped/directional view.

Convention: each item has **What** (the friction), **Why it matters**, and
optionally **Sketch** (a one-line implementation thought). Status one of:
`📥 noted` / `🟡 in-progress` / `🗑 dropped`.

When an item ships it **leaves this doc** — record it as a concise what/why
bullet in `ROADMAP.md` (Completed Highlights) instead of keeping a "resolved"
note here. This file stays future-only.

---

## Open

### Skill trigger health (2026-07-09)

Source: `docs/plans/2026-07-09-skill-trigger-health-plan.md` (phase 1 shipped).
These are the deferred follow-ups surfaced during and after the build.

#### Version attribution only reaches skills in the installed catalog
📥 noted
- **What**: version resolution matched ~1/3 of invoked skills on the live DB (23
  of 73). The rest resolve to `null` — renamed skills (`writing-plans` →
  `write-plan`), non-dojo skills (`yeet`), and project-local / plugin skills that
  aren't in `~/.claude/skills` or `~/.codex/skills`.
- **Why it matters**: version-over-version comparison is the core of the feedback
  loop, so this coverage is the ceiling on phase-1 usefulness. Also:
  `versionApproximate` is ~always true today because snapshots are stamped with
  `now`; it only gains signal once the catalog is observed across a real bump.
- **Sketch**: phase-2 catalog discovery for project-local `.claude/skills` and
  plugin catalogs; treat name+version identity carefully across sources.

#### Validate (and likely widen) the misfire heuristic before consumers depend on it
📥 noted
- **What**: the interrupt-based misfire signal was 0 across all 639 real
  invocations. Plausible (a genuine interrupt right after a skill fires is rare)
  and the heuristic deliberately under-counts, but combined the signal may be too
  sparse to drive anything.
- **Why it matters**: phase 2 wants to rank skills by misfire rate; a metric
  that's structurally near-zero can't. `misfireEligible` now exposes the
  denominator so a min-sample guard is possible, but the signal itself needs
  validation.
- **Sketch**: widen to interrupt anywhere in the invoking assistant span, or add
  lexical negation in the next prompt (both already scoped out of phase 1);
  measure against real sessions before building ranking on top.

#### Never-fired scan runs un-throttled per health request
📥 noted
- **What**: each `/api/v2/analytics/skills/health` request scans the filesystem
  for never-fired detection, separate from the TTL-throttled snapshot refresh
  scan.
- **Why it matters**: minor today; a free cleanup if the skill-extraction
  unification below happens (thread the single scanned catalog through both).

### Skill extraction unification

#### Unify Claude/Codex skill-invocation extraction between the daily and health queries
📥 noted
- **What**: Claude `Skill` calls and Codex `.../SKILL.md` reads are identified in
  two places in `src/db/v2-queries.ts` — `getAnalyticsSkillsDaily` and
  `getAnalyticsSkillsHealth` — with the Codex event/JSONL blocks (including the
  session-dedup logic) copy-pasted between them.
- **Why it matters**: edge-case path handling drifts across the copies; a single
  parser is one place to fix Codex parsing and keeps the two queries honest.
- **Sketch**: a shared invocation iterator yielding
  `{ skillName, timestamp, project, agent, sessionId?, ordinal?, source }`; daily
  folds into date buckets, health folds into name+version. Guard the refactor with
  the existing daily tests.

### Analytics rollups (schema-storage-rebalance Phase 2)

#### Daily dimensional rollup can't back Usage at exact parity
📥 noted
- **What**: a daily `events_rollup_daily(day, agent_type, model, project)` cannot
  serve Usage: every Usage breakdown emits `COUNT(DISTINCT session_id)`, sessions
  span buckets, so distinct counts are unrecoverable from a sum-rollup. Usage also
  buckets by `date(COALESCE(client_timestamp, created_at))`, counts only
  metric-bearing events, and normalizes `project`/`model` to `'unknown'`; the live
  Monitor uses sub-day rolling windows a daily rollup can't serve either.
- **Why it matters**: the rollup as specced has no exact-parity reader, and Phase
  1's covering indexes already made these reads fast (monitor list 269ms → 34ms),
  so its remaining value is long-term scalability, not current speed.
- **Sketch**: if revisited, use a session-grained rollup
  `(day, agent, model, project, session_id)` so distinct counts stay exact.
  Revisit trigger: events table > ~3M rows or a hot Usage read > ~150ms.

#### Legacy v1 session-list N+1
📥 noted
- **What**: the v1 `queries.ts` session list (retiring `/` dashboard) keeps the
  per-session correlated-subquery N+1 that v2 `listMonitorSessions` shed.
- **Why it matters**: left untouched to avoid investing in the deprecated surface.
- **Sketch**: apply the same CTE rewrite if v1 is kept.

### Context occupancy

#### Monitor-card occupancy join not visually verified under live v1 hooks
📥 noted
- **What**: the Live inspector (pure v2) renders occupancy end-to-end; the Monitor
  cards read the v1 store and join v2 occupancy by session id. Svelte-checked and
  logically verified, but not screenshotted with a live hook/OTEL-fed active
  session (the scratch server had 0 active v1 sessions). The Codex id mismatch (v1
  OTEL UUID vs v2 rollout filename) is aliased in `refreshOccupancy`.
- **Why it matters**: confirm the join renders on a real running card, especially
  for Codex.

#### Trajectory sparkline (occupancy gauge Task 8)
📥 noted
- **What**: session-lifetime occupancy fill over time with compaction drop-offs,
  in the detail/inspector surface.
- **Why it matters**: gauge + pill shipped first; this is the fast-follow.
- **Sketch**: needs a bounded sample buffer in the projection and a retention
  decision (see `docs/plans/2026-07-07-context-occupancy-gauge-plan.md`).

#### Statusline can't authoritatively set the Claude window
🗑 dropped
- **What**: idea was to override the guarded 1M default with a real window from
  the statusline bridge. The bridge forwards the full payload, but it carries no
  numeric window/token count — only the boolean `exceeds_200k_tokens`, a usage
  threshold, not a window size.
- **Why it matters (dropped)**: `true` merely confirms ≥1M (no-op for the default)
  and `false` is ambiguous (200K plan vs 1M plan under 200K), so it can't safely
  set 200K. Real per-plan fidelity needs 200K-vs-1M *plan* detection, which no
  ingested source exposes. Not worth building as framed.

### Invocation mode

#### No `mode` filter facet in the Monitor FilterBar
📥 noted
- **What**: intentionally scoped out. `mode` lives in `sessions.metadata`
  (json_extract).
- **Why it matters**: cheap to add if wanted, but a filterable/indexed path would
  want a dedicated column rather than json_extract.

### Pricing

#### Processing-service tier is not captured with usage events
📥 noted
- **What**: cost estimation uses standard synchronous API rates. Event rows do not
  record OpenAI Standard, Priority, Batch, or other processing-service tiers, so
  the registry cannot select service-tier-specific pricing.
- **Why it matters**: GPT-5.6 Priority prices differ from standard rates. Standard
  pricing remains the honest default until ingestion exposes the billed service
  tier; do not infer it from the model ID.

#### Claude Sonnet 5 intro pricing expires 2026-08-31
📥 noted
- **What**: `claude.json` encodes intro rates ($2/$10, cacheRead $0.20, 5m write
  $2.50). Standard pricing ($3/$15, cacheRead $0.30, 5m write $3.75) takes effect
  2026-09-01.
- **Why it matters**: the engine has no date-awareness, so this is a manual data
  bump on that date. (Sonnet 5's newer tokenizer emits ~30% more tokens; cost
  reflects reported tokens, so no engine change needed.)

#### Pricing tables were never shipped to `dist/` — models added since Feb billed as $0
✅ fixed 2026-07-13
- **What**: the build ran `cp -r src/pricing/data dist/pricing/data`. That creates
  the directory on the first run, but on every run after — the destination now
  existing — `cp` descends and writes `dist/pricing/data/data/`, leaving the JSON
  the runtime reads frozen at the first build (2026-02-19). Opus 4.8, Fable 5,
  Sonnet 5 and the GPT-5.6 tiers all landed in `src/` and none reached `dist/`.
- **Why it went unnoticed for five months**: every gate reads `src/`. `tsc`
  passed, `pnpm test` passed (tsx, `src/`), `pnpm dev` was correct (tsx, `src/`).
  Only the built server — what `amon serve` runs — was wrong, and an unpriced
  model bills as **$0 rather than raising**, so the dashboard stayed plausible
  while under-reporting the most-used models entirely.
- **Fix**: `rm -rf` the destination before copying, plus
  `scripts/check-pricing-dist.mjs` in `pnpm build`, which fails if the shipped
  tables drift from source. Verified by reintroducing the `cp -r` condition.
- **Follow-up**: events written while the build was stale carry `cost_usd = 0`.
  `amon costs recalc` repairs them (it skips models it cannot price rather than
  zeroing them).
- **Generalize**: any non-TS asset the build copies into `dist/` has this shape,
  and no gate would catch it. Worth auditing other `cp` steps.
