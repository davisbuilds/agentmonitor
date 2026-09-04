# Roadmap

Directional roadmap for AgentMonitor. This is a planning snapshot, not a release contract or detailed implementation log.

## Completed Highlights

Concise record of shipped work that has left `BACKLOG.md`. Newest first.

- Operational OTEL metrics ingestion (2026-09-04) — *What:* the `/api/otel/v1/metrics`
  endpoint stopped silently dropping everything it didn't recognize. Root cause
  was deeper than the backlog's framing (the `!hasTokens && !hasCost` route guard):
  `parseOtelMetrics` only ever emitted deltas for 6 hardcoded token/cost names —
  none of which exist in Codex 0.153.2 — so Codex's entire metric stream (posted
  to us per `~/.codex/config.toml`) was discarded in the parser. Now `parseOtelMetrics`
  classifies each datapoint into **usage** (Claude Code token/cost → synthetic
  `llm_response`, unchanged), **operational** (Bucket A: outcome/state-tagged
  counters like `codex.memory.startup{state=...}` → new dedicated `otel_metrics`
  table, read via `GET /api/v2/metrics` grouped by name×attrs), **skipped**
  (Codex token/cost metrics — deliberately not stored because logs are
  authoritative; storing would double-count), and **dropped** (timings/sizes/
  unrecognized — tallied by name and logged as a throttled aggregate for intake
  visibility). Inclusion is a principle, not a name allowlist: a metric is
  operational when its datapoint carries an outcome attribute and isn't a
  timing/size/token metric — auto-admitting new outcome counters while keeping the
  high-volume `*.duration_ms` family (the original DB-bloat culprit) out.
  Dedicated table, not `events`, chosen after measuring ~50 COUNT(*)/event_type
  aggregates a metric row would otherwise leak into. *Why:* agentmonitor is the
  local observability console for Codex yet couldn't answer "is memory
  consolidation running, and why is it skipping?" — a real 2026-08-30 stall had
  to be diagnosed by reading the Codex binary. Verified against the actual metric
  catalog enumerated from the Codex 0.153.2 binary (`strings`), since rollout
  files don't carry metrics. Also confirmed via the real DB that Codex token/cost
  stays accurate (OTEL logs + JSONL import, within a few % daily). Tests:
  `tests/otel-metrics-classify.test.ts`, `tests/otel-metrics-store.test.ts`, plus
  an end-to-end POST→`/api/v2/metrics` case. UI surface is a tracked follow-up.
- Date-aware pricing (rate schedules) (2026-09-04) — *What:* the pricing engine
  can now price an event by the rate in force when it happened, not just by
  prompt-size tier. A model may carry an optional `schedule` of `{ from, ...rates }`
  periods (each with its own optional `tiers`) on top of its inline base rates;
  `calculate()` / `effectiveRates()` take an optional `at` timestamp (Date / epoch
  ms / ISO string) and select the period effective at that instant (`from`
  inclusive) before tier selection. Every reprice path threads the event's own
  timestamp (`client_timestamp ?? created_at`) — live ingestion, `amon costs
  recalc`, the cache-inclusive backfill migration, Codex/Antigravity import, and
  v2 cache-savings estimation — so re-running recalc after a boundary does not
  retroactively reprice pre-boundary rows; an omitted/unparseable `at` prices at
  the current wall clock. First use: the Gemini 3.6/3.7/3.8 Flash launch promo
  ($0.75/$3.75) now carries a schedule entry that flips to list ($1.50/$7.50,
  cacheRead $0.15) on 2027-01-01 automatically, replacing the manual-bump-on-the-day
  toil the deadline-guard test only bought time against. Models with no `schedule`
  keep exactly one period, so date selection is a no-op for them. Mechanism +
  data only; the two still-unpriced vendor models (`claude-fable-5-1`,
  `gpt-5.6-cyber`) remain a separate follow-up pending verified rate cards. *Why:*
  a lapsed rate is a silent money bug of the same shape as the dist-pricing
  incident (wrong cost, no error, plausible dashboard); this retires the
  manual-bump class rather than patching one more instance. Tests:
  `tests/pricing-date-schedule.test.ts` (boundary-inclusive edge mutation-verified).
- Small correctness/tooling sweep (2026-09-03) — *What:* three self-contained
  fixes. (1) The last benchmark-segregation leak: v1 `getStats` lifetime
  `total_sessions` `COUNT(*)`d the `sessions` table with no source predicate, so
  ended benchmark cells inflated it — now a correlated `NOT EXISTS` over
  benchmark events, plus a v6 data migration that sweeps the event-less
  `sessions` rows the v5 legacy-benchmark cleanup orphans (they have no event
  left to correlate against). v2 analytics already counts `browsing_sessions`,
  which benchmark cells never project into, so it was already clean. (2) `amon serve
  --no-browser` was accepted but never opened a browser on either the direct or
  Portless path — removed the misleading flag so it now fails loudly as an
  unknown option rather than lying about a no-op. (3) Closed the
  `src/contracts/event-contract.ts` coverage gaps (non-object body, string
  trimming, whitespace-only required fields, unparseable/non-string
  `client_timestamp`, error aggregation) on top of the existing suite. *Why:*
  small debt with real failure modes — a bake-off silently inflating a lifetime
  count, a flag that misrepresents the CLI contract, and the untrusted-payload
  boundary whose coercion branches weren't pinned.
- Benchmark frontier chart + shared chart primitives (2026-09-04) — *What:* P3 of
  the Benchmarks tab. A cost×score Pareto scatter (`BenchmarkFrontier.svelte`):
  log10 `$/trial` x-axis, linear `[0,1]` score y-axis, a dashed polyline through
  the backend-computed Pareto arms (`arm.pareto`), faint domination connectors
  (dominated arm → its dominator, matched on `canonical_model` via
  `dominated_by`), hollow ◯ native / filled ● routed markers, hover tooltip, and
  click-to-drill that highlights and scrolls to the arm's ladder row. Unpriced
  arms (no positive `cost_per_trial`) are held off the cost axis and named in a
  legend note — never silently dropped. Built on new *shared* inline-SVG
  primitives — `ui/chart/scales.ts` (pure `linearScale`/`log10Scale` + nice-tick
  + `formatUsd`, unit-tested and mutation-verified), `ui/chart/layout.ts`, and a
  tokenized `ui/chart/PlotFrame.svelte` (frame only, no marks) — validated as a
  real abstraction by refactoring the Monitor CostDashboard "Spend Over Time"
  timeline onto `linearScale` (behavior preserved, algebraically identical). The
  frontier geometry is a pure `frontier-geometry.ts` module so it is testable
  without a DOM. Only P4 (artifact export) remains deferred. Spec:
  `docs/specs/2026-09-02-benchmark-comparison-view-spec.md`.
- Benchmark comparison view — Benchmarks tab (2026-09-03) — *What:* the consumer
  half of the benchmark pipeline (PR #106). A dedicated `/app/` Benchmarks tab
  renders the segregated bake-off: a studies list drilling into a per-arm ladder
  with Pareto verdicts (value-pick / on-frontier / trivial-only / dominated /
  unreliable), native-vs-routed markers, and an auto-generated honesty panel
  (unpriced/derived cost basis, no-op trials, excluded-trial small-sample
  warnings). Backed by `getBenchmarkStudies`/`getBenchmarkStudy` and the
  `GET /api/v2/benchmarks[/:studyId]` routes — the one benchmark-inclusive read
  surface, grouping cells by `study_id` and never routing through
  `buildUsageFilterState`. Study + model identity come from openbench's own row
  fields (`study`/`study_sha256`/`suite`/`canonical_model`/`reasoning_effort`/
  `is_open_model`), with parent-dir/effort-suffix derivation only as a legacy
  fallback. Persisted `event_id` is namespaced `${study_id}::${run_id}` so
  cross-study reruns (which share a `run_id`) are not dropped as duplicates; a v5
  data migration drops pre-namespacing rows. *Why:* the ingest (below) delivered
  no operator value without a view; this is the comparison the pipeline exists to
  enable. The frontier scatter chart + shared inline-SVG chart primitives (P3)
  shipped 2026-09-04 (above); only the artifact export (P4) remains in
  `BACKLOG.md`. Spec: `docs/specs/2026-09-02-benchmark-comparison-view-spec.md`.
- Benchmark ingest for openbench runs (2026-09-02) — *What:* a `benchmark`
  EventSource and `amon import benchmark <results.jsonl>` map each openbench cell
  to one aggregate `llm_response` event keyed on `run_id` (idempotent), tagged
  `source='benchmark'` and segregated from the default cost/usage/analytics
  aggregates (opt in via `UsageParams.include_benchmark`) at the shared
  `buildUsageFilterState` seam so all 14 usage queries inherit it. Cost prefers a
  row's captured `cost_usd`, else derives from the pricing tables (reasoning-effort
  suffixes stripped for codex daily-driver comparators); unpriced models are
  surfaced loudly instead of billed as null. Added `openrouter.json` pricing for
  glm-5.3-flash, deepseek-v4-flash-0731, minimax-m3. *Why:* the benchmark stream is
  a first-party data source whose trusted token accounting the console could not
  see; `CODEX_HOME` isolation left no JSONL/OTEL for the live or import paths.
- Application-consistent database export (2026-08-13) — *What:* the one-shot
  `amon database backup --output <absolute-path>` command now uses SQLite's
  online backup API alongside the active WAL runtime, stages the copy under a
  private parent, converts it to a self-contained `DELETE`-journal database,
  runs full integrity and foreign-key checks, and atomically publishes mode
  `0600`. Replacement is explicit; source/sidecar overlap, symlinks, broad
  parents, stale destination sidecars, and non-regular targets fail closed.
  *Why:* copying the live main DB without its WAL is inconsistent, while an ops
  backup job needs one validated artifact without stopping observability.
- Cache-inclusive unknown-pricing visibility (2026-08-04) — *What:* Top Models now
  offers an All tokens view that includes input, output, cache-read, and cache-write
  traffic; model tables use the same total. The Usage page persistently identifies
  pricing-incomplete models, their cache-inclusive observed tokens, and their event count
  without fabricating a cost. The warning stays visible when a formerly unknown model
  receives pricing but its historical $0 rows still need `amon costs recalc`. *Why:* a
  cache-heavy new model can otherwise vanish from the default Cost view before or after
  its pricing record arrives.
- Configurable Claude history root (2026-07-29) — *What:*
  `AGENTMONITOR_CLAUDE_DIR` now supplies one Claude data root to startup sync,
  live and periodic watcher discovery, automatic and historical event import,
  and `amon sync sessions`; explicit `--claude-dir` flags still win. An isolated
  real-filesystem regression proves configured history is included while
  ambient `~/.claude/projects` history is excluded, and the built consultation
  verifier now exercises startup parsing without suppressing watcher discovery.
  *Why:* the shipping verifier previously admitted 94 ambient sessions or had
  to disable all watcher discovery, so alternate installations and runtime
  probes could not isolate Claude and Codex history symmetrically.
- Usage overview hot-path optimization (2026-07-16) — *What:* the representative
  30-day built-product read fell from a 229.24 ms warm median to 134.67 ms while
  preserving exact parity with every per-panel Usage endpoint. The overview now
  selects coverage once, reuses each row's model classification across all folds,
  derives usage-side coverage from those rows, uses a compact prior-period cost
  aggregate, and bulk-enriches the limited top sessions. `pnpm bench:usage`
  provides a read-only threshold gate. *Why:* the
  live database crossed the backlog's 150 ms trigger at only ~270K events, but
  profiling showed redundant work rather than a need for a persisted rollup. If
  the direct path crosses 150 ms again near multi-million-row scale, revisit a
  session-grained `(day, agent, model, project, session_id)` derived store so
  distinct-session counts remain exact.
- Exclusive runtime DB ownership + complete teardown (2026-07-15) — *What:*
  every long-running runtime now acquires ownership of its canonical SQLite path
  before schema, HTTP, watcher, import, quota, or broadcast work. A second
  same-DB process exits with the live owner PID; different DBs can coexist and
  dead-process state recovers automatically. Startup waits for the HTTP bind,
  while bind failure and SIGINT/SIGTERM/programmatic shutdown close timers, both
  SSE registries, in-flight quota polling, Chokidar, HTTP, and SQLite before
  releasing ownership. One-shot CLI commands remain available. *Why:* recovery
  found an orphan runtime retaining DB handles and background work after losing
  its listener; port exclusivity alone did not protect one SQLite history from
  two runtime lifecycles.
- Stable Portless operator origin (2026-07-14) — *What:* `amon serve` remains the
  single built-product launcher and now wraps the fixed `127.0.0.1:3141` runtime
  with pinned, package-local Portless at `https://agentmonitor.localhost`; the
  named root redirects to canonical `/app/`, Ctrl-C removes the route, and
  `--no-portless` preserves direct startup. Hook and OTEL ingestion remain on
  loopback rather than inheriting browser HTTPS concerns. *Why:* give the local
  console one stable human-facing origin without destabilizing its machine-facing
  ingestion contract.
- Session-analytics recovery + Codex `exec` compatibility (2026-07-14) —
  *What:* after an isolated-test import-order bug cleared the real DB's event and
  session-browser tables, a frozen SQLite snapshot and `.recover` rehearsal
  restored 139,118 missing event rows (bringing the live checkpoint back above
  $9.6k and 58.9M output tokens). A forced rebuild from 369 surviving JSONLs
  restored 640 browsing sessions, 96,763 messages, and 49,883 tool calls. Skill
  inference now accepts both `exec_command` and newer `exec` tool names across
  event and JSONL paths while rejecting shell placeholders such as `$skill` and
  `*`; date-only timeline labels retain the API's UTC bucket in local time.
  Startup now warns—without mutating—when a currently discoverable Claude/Codex
  file is cached as parsed but its browser projection is absent. Red/green
  regressions guard the analytics and warning paths; the test-runner install-DB
  interlock plus a destructive-fixture handle assertion prevent recurrence.
   *Why:* ordinary import rebuilt enough usage history for the dashboard to look
   plausible, while the independent `watched_files` cache silently skipped the
   deleted transcript-derived rows.
- Skill consultation decomposition and Analytics evidence (2026-07-29) —
  *What:* Claude and Codex session parsing now preserves ordered consultations,
  compactions, and Codex runtime catalog presentations in an atomic,
  reparse-safe projection. Daily and health analytics share one invocation
  ledger, fixing the case where an out-of-window OTEL event suppressed an
  in-window JSONL fallback. The additive health response decomposes selected
  occurrences into first read, post-compaction rehydration, repeat, and
  unclassifiable classes per harness, with eligible denominators, project
  breadth, version quality, exposure partitions, and explicit comparability.
  Data migration v4 schedules existing Claude/Codex session files for one
  backfill parse. Claude hook installs now also retain content-free
  `InstructionsLoaded` occurrences and a SessionStart instrumentation marker,
  while missing asynchronous delivery remains explicitly unobservable.
  Immutable, content-hashed expected realizations can now be stored and
  explicitly associated to same-harness sessions without being erased by
  transcript reparse; conflicting artifact IDs and session rebinds fail without
  writes. A bounded per-session oracle now preserves distinct catalog and
  instruction occurrences, compares each catalog only against realization
  authority valid at that occurrence, and reports numeric catalog occupancy
  only for a fresh policy with fully compatible runtime scope, units, and
  measurement method. Codex world-state instruction identities are retained
  without instruction contents, and initial catalogs are scoped with the
  session's first reported runtime identity. *Why:* raw reads conflate distinct
  consultation behavior and invite unsafe cross-harness conclusions, while
  current filesystem state is not historical desired-state authority. The
  additive v2 resources now expose the bounded per-session oracle plus
  immutable realization create/replay and one-time association with stable
  status semantics; mixed legacy health rows are machine-labeled
  compatibility-only. The `/app/` Analytics Overview now preserves raw phase-1
  invocation volume and a bounded six-row consultation index; the dedicated
  Skills sub-view owns harness/name/signal/sort controls, progressive result
  disclosure, separate Claude/Codex lanes, first-read denominators,
  compaction-aware classes, project breadth, catalog exposure gaps, and
  expandable version/coverage evidence. Its CSV carries the same per-harness
  boundary. A built-product oracle seeds both parsers into
  isolated SQLite, exercises the compiled API and realization association
  contract, and verifies the panel plus agent-filter behavior in Chromium at
  desktop and narrow widths. Final shipping validation on a consistent copy of
  the 1.4 GB local database migrated 434 associated files, parsed 407 with zero
  errors, and produced 1,667 ordered observations plus 17,392 catalog entries;
  a stable second pass was a no-op and forced recovery reproduced the same row
  counts. Independent source parsing reconciled 394 consultations across 131
  sessions with zero class differences. Reusing one ledger selection reduced
  the fixed-window enriched health median from 165.1 ms to 102.5 ms (phase-1
  median 88.3 ms), and the actual Dojo extractor accepted the built response.
  Spec/plan:
  `docs/specs/2026-07-27-skill-invocation-decomposition-spec.md` and
  `docs/plans/2026-07-28-skill-invocation-decomposition-plan.md`.
- Pricing tables reach `dist/`, and the cwd stops deciding which DB you read (2026-07-13) — *What:* the build ran `cp -r src/pricing/data dist/pricing/data`, which creates the directory on the first run but on every run after descends into it and writes `dist/pricing/data/data/`, freezing the JSON the runtime reads at the first build (2026-02-19). Opus 4.8, Fable 5, Sonnet 5 and the GPT-5.6 tiers all landed in `src/` and none reached `dist/`. Fixed by clearing the destination first, plus `scripts/check-pricing-dist.mjs` in `pnpm build`. Separately, the default DB path was cwd-relative, so `amon serve` from outside the repo silently created a second database and auto-imported into it; it now follows the install, resolved through one shared resolver so `amon status` cannot disagree with the server. *Why it hid for five months:* every gate reads `src/` — `tsc`, `pnpm test` and `pnpm dev` all run from source, and only `amon serve` loads `dist/`. An unpriced model bills as $0 rather than raising, so the dashboard stayed plausible while under-reporting the most-used models entirely. Events written while the build was stale carry `cost_usd = 0`; `amon costs recalc` repairs them. Any non-TS asset the build copies into `dist/` has this shape and no gate would catch it.
- GPT-5.6 pricing + Codex attribution backport (2026-07-12) — *What:* added standard API pricing for `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, including the unsuffixed Sol alias, cache-write charges, and full-request long-context tiers above 272K; usage classification exposes the durable Sol/Terra/Luna tiers. Codex historical import now follows each JSONL `turn_context` model rather than stamping current `config.toml`, with a one-shot hash invalidation and narrowly scoped duplicate refresh that corrects model/cost plus trace summaries while leaving legacy config-only logs untouched. *Why:* the pricing table alone would have mislabeled real Terra and Luna sessions as whichever model happened to be configured during import.
- Skill trigger health, phase 1 (2026-07-09) — *What:* `/api/v2/analytics/skills/health` reports per-skill invocations, last-invoked, never-fired flags, an interrupt-based misfire rate (with `misfireEligible` denominator), and the skill version installed at each invocation. Computed at query time over existing `tool_calls`/`messages`/`events` rows (historical backfill, no reingest) with a TTL-throttled catalog-snapshot refresh; installed catalogs configurable via `AGENTMONITOR_SKILL_CATALOG_DIRS`. *Why:* the measurement plane for a skill feedback loop — version-over-version comparison of skill edits. Verified on the live 1.1GB DB (79 rows over 639 invocations). Dojo-side consumer + signal widening are phase 2 (see BACKLOG). Spec/plan: `docs/specs/2026-07-07-skill-trigger-health-spec.md`, `docs/plans/2026-07-09-skill-trigger-health-plan.md`.
- Context occupancy gauge + backfill (2026-07-07) — *What:* per-session context-window occupancy on Monitor cards and the Live inspector, resolved through a shared per-agent window resolver. `insertParsedSession` writes occupancy on the initial-sync/import path so cards populate on boot; a one-shot `runDataMigrations` step (`user_version` 1→2, `backfillOccupancyOnUpgrade`) invalidates the `watched_files` hash for null-occupancy Claude/Codex sessions once so an already-synced DB backfills on the next startup sync. *Why:* idle/historical sessions previously showed occupancy only after their next live turn. Gated to Claude/Codex; one-time bounded reparse on upgrade. Plan: `docs/plans/2026-07-07-context-occupancy-gauge-plan.md`.
- Invocation-mode pill (headless/interactive) — *What:* the file watcher stamps `sessions.metadata.mode` from the JSONL as it parses (verified end-to-end within ~1s), with `session_parsed` refreshing the open Monitor and auto-import as backstop; historical sessions backfill via `setSessionMode` on `amon import --force`. Required fixing a chokidar-5 regression to watch directories, not globs — which unblocked all live file-tailing. Also corrected Codex `cli_version`/`originator` metadata mislabeling in `src/import/codex.ts`. *Why:* distinguish `claude -p` headless runs from interactive sessions in the operator surface.
- Pricing data currency (2026-07-08) — *What:* prompt-size price tiers in `calculate()` (optional `tiers` array selecting rates by uncached input + cacheRead + cacheWrite), applied to `gemini-3.1-pro-preview` and `gemini-2.5-pro` >200K tiers; added `gemini-3.5-flash` and `claude-fable-5` with Antigravity id/display aliases and a `fable` classifier tier. *Why:* keep local cost estimates faithful to published provider pricing. Note: new tiers affect newly-calculated costs only; large historical Gemini sessions need an `amon reparse`/maintenance recalc to pick up the correction.

## Now

- Reduce remaining legacy `/` dashboard reliance now that the Svelte app and `/api/v2/*` contract are the clear product center.
- Keep only the durable v1 localhost behavior that still serves ingest, SSE, provider quota, or legacy compatibility needs.
- Improve the Live surface, especially around fidelity boundaries, session noise, and operator clarity when data is summary-only.
- Use the shipped `amon` / `agentmonitor` CLI as the primary operator command surface for runtime checks, maintenance, and local reporting.

## Focus Areas

### Legacy Surface Reduction

- Define cutover gates for replacing or redirecting the legacy `/` dashboard with the Svelte app.
- Preserve v1 endpoints intentionally where they support ingest clients, SSE compatibility, provider quota bridge behavior, or low-risk legacy access.
- Remove legacy-only UI paths once the Svelte app covers the corresponding operator workflows and manual regression checks are stable.

### Live Fidelity and Operator Clarity

- Improve Codex live projection beyond the current summary-first OTEL path where richer local or telemetry sources are available.
- Make fidelity boundaries obvious in the UI so operators can distinguish transcript-capable sessions from summary-only sessions without guessing.
- Reduce session noise through better grouping, filtering, and session lifecycle presentation in Live and Monitor views.

### Product Polish and Release Confidence

- Continue tightening Monitor, Live, Sessions (Browse / Pinned sub-views), Search, and the consolidated Analytics tab (Overview / Usage / Skills / Insights / Quality sub-views) around real review and monitoring workflows.
- The "Instrument Console" Svelte redesign is **shipped (Phases 1–6)**: every `/app/` tab is on the design tokens — foundation (tokens + type + shell), shared primitives, Monitor, Sessions/Search, the consolidated Analytics group, and the Live operator view. IA consolidations: Usage + Insights → Analytics sub-views; Pinned → a Sessions sub-view. Mobile was intentionally deprioritized (laptop-first; agents run on-device).
- The first-class CLI is **shipped** with `amon` as the preferred executable and `agentmonitor` as an alias. Keep new maintenance and reporting workflows discoverable there before adding more package scripts.
- Maintain a manual regression checklist for the canonical Svelte app, especially around deep links, long transcripts, live updates, and drawer/navigation behavior.
- Prefer small UI refinements that reduce ambiguity over larger redesigns unless operator workflows show a clear gap.

### Trace Quality

- **Reframed (2026-06) to a lean, collector-not-backend view** — shipped: one trace per session served from the content-free `session_trace_summary`, detail projected on-demand, and three `/api/v2/trace-quality/{traces,traces/:id,traces/:id/observations}` reads. The persisted trace/observation/score/prompt warehouse (~half the DB) was removed and is reclaimed via the opt-in `pnpm reclaim:trace-quality`. The eval depth (scores/findings/prompts) is **deferred to the export**, not reinvented locally. See [../system/trace-quality.md](../system/trace-quality.md) and [POSITIONING.md](POSITIONING.md).
- Keep coverage honesty as a first principle: summary-only telemetry (e.g. Codex OTEL) must never render as full fidelity in the UI or API.
- The content-free aggregate export is **shipped** as `amon warehouse publish`: it publishes `session_trace_summary` into AgentMonitor's own `agentmonitor.runs` schema/table with lineage and an optional `medallion_bi` grant. The Langfuse depth path remains deferred via `trace_quality_export_state`.

## Next

- Define and verify parity gates for retiring or sharply reducing reliance on the legacy `/` dashboard.
- Tighten v2 contract coverage and runtime testing for the TypeScript backend.
- Keep improving session browsing, search, analytics, and live inspection where real operator workflows expose gaps.
- Make integration behavior and capture/redaction settings easier to understand from the product surface, CLI, and docs.

## Later

- Support richer Codex-native live fidelity beyond the current OTEL summary path.
- Revisit packaging or alternate runtime distribution work once the canonical web contract is stable.
- Expand multi-agent support where new integrations can map cleanly onto the existing monitor, history, and live models.
- Build the **deferred Langfuse trace-quality depth export**: forward the on-demand projection to Langfuse for trace/eval depth via the dormant `trace_quality_export_state` seam. Keep it manual-first, redaction-aware, dry-run-previewable, and never required for local functionality.
- Optional medallion-owned follow-up: add an adoption-KPI-excluded assistant/coding-agent usage view over `agentmonitor.runs`; do not fold AgentMonitor's personal account telemetry into `gold.adoption_kpis_daily`.

## Working Principles

- Prefer extending `/app/` and `/api/v2/*` over adding new behavior to the legacy `/` surface.
- Keep fidelity honest in both product UI and API responses, especially when Claude and Codex capabilities differ.
- Favor docs and plans that age well: roadmap for direction, plan docs for implementation detail, architecture docs for system shape.

## Active References

- Repo convergence plan: [../plans/2026-04-08-repo-convergence-implementation.md](../plans/2026-04-08-repo-convergence-implementation.md)
- Architecture overview: [../system/ARCHITECTURE.md](../system/ARCHITECTURE.md)
- Product surface reference: [../system/FEATURES.md](../system/FEATURES.md)
