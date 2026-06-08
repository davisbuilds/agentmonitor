# Improvement Backlog

Working list of opportunities noticed while implementing specs. These are not commitments for the active task unless explicitly pulled into scope.

## Trace Quality Layer

- Consolidate score target resolution into one reusable query helper or SQLite view. The score read APIs, summaries, coverage accounting, findings, and rollups all need to answer "which trace/session does this score belong to?" and drift here can make session/message/event/session-item scores visible in one endpoint but missing in another.
- Decide the canonical semantics for non-trace score targets in trace detail. Task 5 adds session, message, event, and session-item scores, but trace detail currently centers on direct trace and observation scores; product should decide whether session-scoped scores should appear on every trace in that session or only in aggregate rollups.
- Add an explicit maintainer workflow for deterministic code evaluators. The service can regenerate local evaluator scores safely, but there is not yet a CLI command or v2 action endpoint to run it intentionally.
- Add fixture coverage for score targets beyond trace and observation. Session, message, event, and session-item target handling deserves integration tests across list, summary, rollup, and trace-filtered views.
- Normalize trace-quality prompt source vocabulary after existing databases can be migrated safely. Task 6 accepts both canonical names such as `skill_file` and legacy names such as `skill`; a future migration should convert old rows and eventually remove legacy source values from writes and docs.
- Share skill extraction logic between analytics and trace-quality prompt attribution. Both paths now identify Claude `Skill` calls and Codex `skills/.../SKILL.md` reads, and a single parser would reduce drift in edge-case path handling.
- Define a formal tokenmaxxing task-template attribution contract. Prompt attribution currently records task-template refs only from explicit metadata because broad file-path inference would be speculative without a stable template path or metadata convention.
- Decide how prompt rollups should treat session-scoped scores. Task 6 counts direct observation/source-target scores plus trace-level scores for traces containing a prompt; session-level scores remain excluded because assigning them to every prompt in a session may overstate attribution.
