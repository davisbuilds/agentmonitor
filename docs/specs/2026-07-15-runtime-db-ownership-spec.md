---
date: 2026-07-15
topic: runtime-db-ownership
stage: spec
status: complete
source: conversation
---

# Runtime DB Ownership Spec

## Problem

AgentMonitor operators can accidentally leave a failed or superseded runtime
holding the same SQLite database as the runtime that serves the dashboard. The
extra process can keep background imports, watchers, timers, and database handles
alive without a usable listener, making one local history writable by multiple
runtime lifecycles and making shutdown behavior unreliable.

## Contract

When this ships, at most one AgentMonitor runtime owns a resolved SQLite database
at a time; a competing startup fails clearly before background work begins, stale
ownership left by a dead process does not block recovery, and every startup or
shutdown failure releases all acquired runtime resources. The contract is
verified by `pnpm exec tsx --test tests/runtime-ownership.test.ts tests/cli-runtime.test.ts`.

## Success Criteria

- A second runtime targeting the same resolved database exits non-zero promptly,
  writes a concise human-readable diagnostic to stderr, and does not start a
  watcher, import loop, quota poller, stats broadcaster, or HTTP listener.
- Concurrent runtimes targeting different resolved databases remain supported.
- Ownership left by a process that no longer exists is recovered automatically.
- A failed HTTP bind leaves no database ownership or background runtime work
  behind, and a later startup can use that database successfully.
- SIGINT, SIGTERM, and programmatic shutdown close the HTTP server, background
  work, SQLite connection, and database ownership before completing.
- Existing `amon serve`, Portless, direct-runtime, hook, OTEL, and database-path
  selection behavior remains otherwise unchanged.

## Evaluation

Deterministic process-level tests start real AgentMonitor runtimes against
temporary SQLite databases and ports, observe exit codes and diagnostics, and
prove that ownership can be reacquired after stale state, bind failure, and clean
shutdown. The repository pre-push gates prove the change remains compatible with
the wider runtime and CLI surface.

## Scope

### In Scope

- Exclusive ownership for each resolved SQLite database used by a long-running
  AgentMonitor runtime.
- Automatic recovery from ownership state whose process is no longer alive.
- Complete cleanup for startup failure and all supported shutdown paths.
- Stable human-facing CLI failure behavior for ownership conflicts.
- Runtime documentation and project-lifecycle records for the shipped behavior.

### Out of Scope

- Restricting one-shot reporting, maintenance, import, sync, or warehouse commands
  from opening the database while the runtime is active.
- Coordinating database ownership across different machines or network filesystems.
- Replacing SQLite WAL behavior or adding a general-purpose process supervisor.
- Changing Portless routing, browser-opening behavior, HTTP routes, or API shapes.

## Assumptions And Constraints

- The safety boundary is one long-running runtime per canonical database path,
  not one runtime per package installation; isolated temporary or alternate
  databases must remain usable concurrently.
- Ownership state is local machine state and may expose only the canonical
  database path, owner PID, and startup time in operator diagnostics.
- If process liveness cannot be distinguished from a permission error, startup
  must conservatively treat the recorded owner as live.
- Crash recovery must not require a manual cleanup command.
- Tests must use temporary databases and real child processes; they must never
  open the installation database.

## Open Questions

None.

## Handoff

1. Hand off to `write-plan` to select the thinnest runtime ownership and cleanup
   seams, sequence red/green tests, and define full verification.
2. Review the contract inline against its falsifiable process-level checks.
3. Refine the contract before sequencing if implementation reconnaissance reveals
   a contract-changing constraint.
