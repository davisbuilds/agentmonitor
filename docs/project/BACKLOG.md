# Improvement Backlog

Working list of opportunities noticed while implementing specs. These are not commitments for the active task unless explicitly pulled into scope.

## Context occupancy gauge

- **Occupancy only populates on live sync, not initial/bulk sync.** Occupancy is
  written by the live adapters (`syncClaudeLiveSession`/`syncCodexLiveSession`);
  the initial watcher sync and historical parse write `browsing_sessions` via
  `insertParsedSession`, which does not carry occupancy. So on a fresh server
  start, a session shows occupancy only after its next live turn (seconds for a
  genuinely active session; never for idle/historical ones). This matches the
  spec's "historical occupancy out of scope," but if we want cards populated
  immediately after restart, `insertParsedSession` could write the two columns
  from `parsed.metadata.context_used_tokens` + the resolver (small, additive).
  Verified live: only the actively-written session showed occupancy on a scratch
  boot (24–25%, 1M window); bulk-imported sessions were blank.
- **Monitor-card join not visually verified under live v1 hooks.** The Live
  inspector (pure v2) renders occupancy correctly end-to-end. The Monitor cards
  read the v1 store and join v2 occupancy by session id; this was svelte-checked
  and logically verified, but not screenshotted with a live hook/OTEL-fed active
  session (the scratch server had 0 active v1 sessions). The Codex id mismatch
  (v1 OTEL UUID vs v2 rollout filename) is now handled in `refreshOccupancy`,
  which aliases each occupancy entry under the embedded UUID as well (PR #61
  review fix); still confirm the join renders on a real running card, especially
  for Codex.
- **Authoritative Claude context window via the statusline bridge (accuracy
  refinement).** The occupancy gauge resolves the Claude denominator to a 1M
  default (guarded), because the transcript does not state the active window.
  The existing Claude statusline bridge (`hooks/claude-code/statusline_bridge.sh`
  → `POST /api/provider-quotas/claude/statusline`) already forwards Claude Code's
  full statusline payload, which carries `exceeds_200k_tokens` (and the model).
  Feed that in as an authoritative override of the resolved default so the
  denominator matches the real window instead of a guess. Additive, opt-in, and
  matches the "first-party snapshot preferred, derived fallback" pattern already
  used for quota. Note: the statusline does not provide a better *numerator* — the
  context-fill number is computed by the statusline script from the same
  transcript token usage we already parse, so this refines only the window.
- **Trajectory sparkline (Task 8, deferred).** Session-lifetime occupancy fill
  over time with compaction drop-offs, in the detail/inspector surface. Needs a
  bounded sample buffer in the projection and a retention decision (see
  `docs/plans/2026-07-07-context-occupancy-gauge-plan.md`). Gauge + pill shipped
  first; this is the fast-follow.

## Invocation Mode (headless/interactive pill)

- Live marking works: the file watcher stamps `sessions.metadata.mode` from the
  JSONL as it parses (verified end-to-end — a real `claude -p` and a synthetic
  drop both mark within ~1s), with `session_parsed` refreshing the open Monitor
  and auto-import as the backstop. Fixing the chokidar-5 glob regression (watch
  dirs, not globs) was required to make this — and all live file-tailing — fire
  at all. Residual edge: if a session's file were fully written before its
  Monitor row exists (hook POST vs. watcher parse) *and* never touched again, it
  would wait for the next resync/auto-import; not observed in practice because
  real runs write incrementally and re-fire the watcher after the row appears.
- No `mode` filter facet in the Monitor `FilterBar` yet (intentionally scoped
  out). Adding one is cheap if wanted: `mode` currently lives in
  `sessions.metadata` (json_extract), so a filterable/indexed path would want a
  dedicated column.
- Fixed inline: the Codex import previously mislabeled `session_meta.originator`
  into `metadata.cli_version` (`src/import/codex.ts`) and dropped the real
  `cli_version`; now stored under `metadata.originator`. No consumer read the old
  field.
- Resolved (PR #60 review): historical sessions imported before this feature now
  backfill via `setSessionMode` on `amon import --force`, and the open Monitor
  refetches on the `auto_import` SSE broadcast instead of needing a manual reload.

## Analytics Rollups (deferred — schema-storage-rebalance Phase 2 finding)

- A daily dimensional rollup `events_rollup_daily(day, agent_type, model, project)`
  CANNOT back the Usage surface at exact parity. Every Usage breakdown
  (`getUsageDaily/Models/Agents/Projects/Tiers`) emits `session_count` =
  COUNT(DISTINCT session_id), and a session spans multiple buckets, so distinct
  session counts are unrecoverable from a coarser sum-rollup. Usage also buckets
  by `date(COALESCE(client_timestamp, created_at))` (not `created_at`), counts
  only metric-bearing events, and normalizes `project`/`model` to `'unknown'`.
  The live Monitor surface (`getMonitorStats`) uses sub-day rolling `since`
  windows a daily rollup cannot serve either. Net: the dimensional rollup as
  specced has no exact-parity reader. Options if revisited: (a) a session-grained
  rollup `(day, agent, model, project, session_id)` so `COUNT(DISTINCT session_id)`
  stays exact (larger, but collapses many events/session/day into one row); or
  (b) keep it deferred — Phase 1's covering indexes already made these reads fast
  (e.g. monitor session list 269ms->34ms), so the rollup's remaining value is
  long-term scalability, not current speed. Suggested revisit trigger: events
  table > ~3M rows or a measured hot Usage read > ~150ms.
- The legacy v1 `queries.ts` session list (the retiring `/` dashboard) still has
  the same per-session correlated-subquery N+1 that v2 `listMonitorSessions` shed.
  Left untouched to avoid investing in the deprecated surface; apply the same CTE
  rewrite if v1 is kept.

## Trace Quality Layer

- Consolidate score target resolution into one reusable query helper or SQLite view. The score read APIs, summaries, coverage accounting, findings, and rollups all need to answer "which trace/session does this score belong to?" and drift here can make session/message/event/session-item scores visible in one endpoint but missing in another.
- Decide the canonical semantics for non-trace score targets in trace detail. Task 5 adds session, message, event, and session-item scores, but trace detail currently centers on direct trace and observation scores; product should decide whether session-scoped scores should appear on every trace in that session or only in aggregate rollups.
- Add an explicit maintainer workflow for deterministic code evaluators. The service can regenerate local evaluator scores safely, but there is not yet a CLI command or v2 action endpoint to run it intentionally.
- Add fixture coverage for score targets beyond trace and observation. Session, message, event, and session-item target handling deserves integration tests across list, summary, rollup, and trace-filtered views.
- Normalize trace-quality prompt source vocabulary after existing databases can be migrated safely. Task 6 accepts both canonical names such as `skill_file` and legacy names such as `skill`; a future migration should convert old rows and eventually remove legacy source values from writes and docs.
- Share skill extraction logic between analytics and trace-quality prompt attribution. Both paths now identify Claude `Skill` calls and Codex `skills/.../SKILL.md` reads, and a single parser would reduce drift in edge-case path handling.
- Define a formal tokenmaxxing task-template attribution contract. Prompt attribution currently records task-template refs only from explicit metadata because broad file-path inference would be speculative without a stable template path or metadata convention.
- Decide how prompt rollups should treat session-scoped scores. Task 6 counts direct observation/source-target scores plus trace-level scores for traces containing a prompt; session-level scores remain excluded because assigning them to every prompt in a session may overstate attribution.
- Let an ambiguous explicit prompt hint fall through to skill/template inference instead of vetoing it. Prompt attribution resolves explicit metadata, then task template, then inferred skills, and returns on the first tier that yields a ref *or* a warning. Today a partial explicit hint (e.g. `prompt_version` with no `prompt_name`) emits a warning and short-circuits, so a deterministic `Skill`/`SKILL.md` attribution on the same observation is dropped. A valid explicit ref should still win, but an explicit *warning* (no ref) should keep the warning and continue to lower tiers. Deferred because the overlap is rare, the prompts surface has no consumer yet, and it would change attribution behavior; revisit once the prompts UI ships.

## Pricing (verified against Google's Gemini API pricing page, 2026-07-01)

- ~~**Add `gemini-3.5-flash` to `src/pricing/data/gemini.json`.**~~ DONE (2026-07-02):
  added `gemini-3.5-flash` ($1.50/$9.00/$0.15) with the Antigravity id/display
  aliases (`gemini-3-flash-a`, `Gemini 3.5 Flash (High/Medium/Low)`); also added
  `claude-fable-5` ($10/$50/$1, 5m cache-write $12.50) + a `fable` classifier tier.
- **Model prompt-size price tiers (engine-wide, not Antigravity-specific).** Google
  doubles Gemini rates above 200k prompt tokens (e.g. 3.1 Pro input $2→$4, output
  $12→$18, cache $0.20→$0.40). `PricingRegistry`/`gemini.json` store a single flat
  per-model rate, so any model with a >200k context window under-bills large
  sessions ~2×. Would need a tiered pricing shape (`{ threshold, rates }[]`) and a
  `calculate()` that picks the tier by prompt size. Affects Gemini today; other
  providers use similar long-context tiers. Revisit if long-context cost accuracy
  matters.
