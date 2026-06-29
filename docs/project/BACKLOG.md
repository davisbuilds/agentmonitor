# Improvement Backlog

Working list of opportunities noticed while implementing specs. These are not commitments for the active task unless explicitly pulled into scope.

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
