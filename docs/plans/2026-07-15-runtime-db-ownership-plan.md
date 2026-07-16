---
date: 2026-07-15
topic: runtime-db-ownership
stage: plan
status: complete
source: conversation
---

# Runtime DB Ownership Plan

## Goal

Deliver the runtime ownership and teardown contract in
`docs/specs/2026-07-15-runtime-db-ownership-spec.md`: one long-running runtime
per canonical SQLite database, prompt conflict failure, stale-owner recovery,
and complete cleanup on failed startup or shutdown.

## Scope

### In Scope

- A DB-scoped local ownership primitive with stale-state recovery.
- Runtime startup ordering that acquires ownership and confirms the HTTP bind
  before background work starts.
- Awaited teardown for watchers, SSE clients, timers, HTTP, SQLite, and ownership.
- Human CLI diagnostics and non-zero exit behavior for ownership conflicts.
- Real-process red/green coverage and current runtime documentation.

### Out of Scope

- Locking one-shot CLI commands out of SQLite.
- Cross-machine or network-filesystem coordination.
- New CLI flags, JSON output, HTTP routes, or Portless routing behavior.
- A general daemon supervisor or service manager.

## Assumptions And Constraints

- `amon serve`, `pnpm start`, and the Portless child all converge on
  `startAgentMonitorRuntime`; the ownership seam must remain in that shared
  runtime rather than only in the CLI wrapper.
- The resolved DB path is canonicalized through the existing filesystem so path
  aliases that resolve to the same existing file share ownership.
- Atomic local-file creation is sufficient for same-machine startup exclusion;
  a live or permission-inaccessible recorded PID is treated conservatively as an
  owner.
- Tests use real child processes, temporary databases, temporary ports, and real
  HTTP/SSE connections. No test may touch the installation database.
- The existing exit-code-1 runtime-failure class and stderr diagnostic convention
  remain the CLI contract; no JSON failure schema is introduced.

## Map Before You Cut

The direct and Portless-backed CLI paths both reach
`src/cli/commands/runtime.ts:73-82`, which dynamically imports and starts the same
runtime used by `src/server.ts:1-4`. `src/runtime.ts:22-39` currently initializes
SQLite and starts services around an HTTP listener without an ownership guard;
`src/runtime.ts:76-85` stops timers and the server but omits SQLite closure and
does not await the watcher. The watcher owns a Chokidar handle and resync timer in
`src/watcher/service.ts:20-21,223-236`. The two SSE registries own per-client
heartbeat timers and open responses in `src/sse/emitter.ts:15-119` and
`src/api/v2/live-stream.ts:19-169` but expose no runtime-wide close operation.

The thinnest seam is therefore one ownership module called only by the shared
runtime, plus explicit close operations on the resource owners the runtime
already orchestrates. A CLI-only lock would miss `pnpm start`; a port-only guard
would still permit two ports to write one DB; and a new supervisor/dependency
would be broader than the local single-host invariant requires.

## Task Breakdown

### Task 1: Define and test DB-scoped ownership

**Objective**

Create an ownership primitive that atomically grants one live process ownership
of a canonical database path, rejects a live competitor, safely recovers stale or
invalid ownership state, and only releases the caller's own ownership record.

**Files**

- Create: `src/runtime-ownership.ts`
- Create: `tests/runtime-ownership.test.ts`

**Dependencies**

None.

**Research Context**

- `src/db-path.ts:28-32` is the side-effect-free DB resolver shared by CLI and
  server; ownership receives the already-resolved runtime DB path rather than
  inventing a second config rule.
- `src/db/connection.ts:29-49` opens a singleton `better-sqlite3` handle and
  already exposes the closure operation runtime teardown needs.

**Implementation Steps**

1. Write failing tests against temporary real filesystem paths for exclusive
   acquisition, independent DB acquisition, stale/dead PID recovery, malformed
   state recovery, token-safe idempotent release, and canonical path aliases.
2. Run the literal test file and capture the expected red result before adding
   the implementation.
3. Implement the small ownership module with an atomic create, a bounded stale
   recovery retry, conservative process-liveness handling, owner metadata for
   diagnostics, and token-checked idempotent release.
4. Re-run the literal test file to green and refactor without widening the public
   surface beyond acquisition, conflict error, and release handle.

**Verification**

- Run: `pnpm exec tsx --test tests/runtime-ownership.test.ts`
- Expect: all ownership behaviors pass against temporary real files.

**Test Discovery Verified**

- Runner/discovery evidence: `package.json` runs `tests/*.test.ts`, which includes
  `tests/runtime-ownership.test.ts`.
- Literal proof: `pnpm exec tsx --test tests/runtime-ownership.test.ts` runs the
  new test file directly.

**Done When**

- One live owner wins per canonical DB, different DBs remain independent, dead
  or malformed owners recover, and release cannot remove another token's state.

### Task 2: Make runtime startup and teardown ownership-safe

**Objective**

Make the shared runtime acquire DB ownership before SQLite/background work,
confirm the HTTP listener before starting background work, and unwind every
resource on partial startup or shutdown.

**Files**

- Modify: `src/runtime.ts`
- Modify: `src/server.ts`
- Modify: `src/watcher/service.ts`
- Modify: `src/provider-quotas/service.ts`
- Modify: `src/sse/emitter.ts`
- Modify: `src/api/v2/live-stream.ts`
- Modify: `tests/sse-emitter.test.ts`
- Modify: `tests/v2-live-stream.test.ts`
- Modify: `tests/watcher-service-live.test.ts`
- Modify: `tests/watcher-projection-warning.test.ts`

**Dependencies**

Task 1.

**Assumptions Verified**

- `src/runtime.ts:22-39` is the shared startup choke point and currently starts
  background services immediately after initiating `listen()`.
- `src/runtime.ts:76-85` is the shared programmatic shutdown path and currently
  omits `closeDb()` and ownership because ownership does not yet exist.
- `src/server.ts:1-4` is a thin wrapper and can await an asynchronous shared
  startup without duplicating lifecycle behavior.
- `src/db/connection.ts:46-50` already provides idempotent SQLite closure.
- `src/watcher/service.ts:223-236` clears watcher state but does not await
  Chokidar's asynchronous `close()`.
- `src/provider-quotas/service.ts:5-30` clears the polling interval but does not
  await a quota refresh already in flight, which can otherwise write after SQLite
  closes.
- `src/sse/emitter.ts:97-119` and `src/api/v2/live-stream.ts:150-169` already own
  the per-client teardown logic needed by a close-all operation.

**Implementation Steps**

1. Add behavioral tests proving both SSE registries close every client and its
   heartbeat, and update watcher tests to await shutdown.
2. Make watcher shutdown await Chokidar closure, make quota shutdown await an
   in-flight refresh, and expose close-all operations that reuse each
   broadcaster's existing per-client cleanup.
3. Convert shared runtime startup to resolve only after ownership, schema work,
   and successful HTTP listen; start background work only after listen succeeds.
4. Centralize idempotent cleanup so partial startup and normal shutdown close
   started services, SSE clients, HTTP, SQLite, and finally ownership.
5. Await shared startup from both the direct server entrypoint and CLI runtime
   caller without changing routes, URLs, or Portless topology.

**Verification**

- Run: `pnpm exec tsx --test tests/sse-emitter.test.ts tests/v2-live-stream.test.ts tests/watcher-service-live.test.ts tests/watcher-projection-warning.test.ts`
- Expect: broadcaster and watcher cleanup tests pass with no open-handle hang.

**Test Discovery Verified**

- Runner/discovery evidence: all modified files already match the
  `tests/*.test.ts` package test glob.
- Literal proof: the targeted command above runs every modified test file.

**Done When**

- No background service begins before a successful bind, and all partial or
  normal runtime exits release HTTP, SSE, watcher, timer, SQLite, and ownership
  resources in a bounded sequence.

### Task 3: Prove the CLI/process contract red-to-green

**Objective**

Exercise observable runtime ownership behavior through real `amon serve`
processes, including the Portless-compatible direct child path.

**Files**

- Modify: `src/cli/commands/runtime.ts`
- Modify: `tests/cli-runtime.test.ts`

**Dependencies**

Tasks 1 and 2.

**Assumptions Verified**

- `src/cli/commands/runtime.ts:73-82` is the direct runtime handler used by the
  Portless child and currently assumes synchronous runtime startup.
- `src/cli.ts:19-53` maps expected `CliError` failures to stderr and exit code 1,
  while preserving stdout for successful machine output.
- `tests/cli-runtime.test.ts:107-220` already starts real direct and fake-Portless
  subprocesses against temporary DBs and ports, so it is the behavior-level seam
  for ownership and shutdown rather than a mock-based unit test.

**Implementation Steps**

1. Add a process test that starts one runtime, attempts a second port against the
   same DB, and expects prompt exit 1 plus a diagnostic naming the DB and live PID;
   run it against the pre-fix runtime to observe red.
2. Add process tests showing different DBs can run concurrently, stale ownership
   recovers, bind failure releases ownership, and shutdown with an active SSE
   client exits cleanly and permits immediate restart.
3. Map the runtime ownership conflict to the existing expected runtime-failure
   CLI class, await runtime startup, and preserve the long-running handler only
   after startup succeeds.
4. Re-run the literal CLI runtime test to green and confirm no process cleanup
   helper silently converts a forced SIGKILL into a pass.

**Verification**

- Run: `pnpm exec tsx --test tests/cli-runtime.test.ts`
- Expect: competing same-DB startup exits 1 promptly; stale, failed-bind, SSE
  shutdown, different-DB, and restart scenarios all pass without forced cleanup.

**Test Discovery Verified**

- Runner/discovery evidence: `tests/cli-runtime.test.ts` already matches and runs
  under the package's `tests/*.test.ts` glob.
- Literal proof: `pnpm exec tsx --test tests/cli-runtime.test.ts` runs the exact
  process contract suite.

**Done When**

- The user-visible CLI behavior and every contract recovery path are proven by
  real child processes, real SQLite files, and real sockets.

### Task 4: Update runtime references and lifecycle records

**Objective**

Make canonical docs describe DB-scoped ownership and complete shutdown, remove
the shipped item from the future-only backlog, and record why it shipped.

**Files**

- Modify: `README.md`
- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `docs/system/OPERATIONS.md`
- Modify: `docs/project/CURRENT_STATE.md`
- Modify: `docs/project/ROADMAP.md`
- Modify: `docs/project/BACKLOG.md`
- Modify: `docs/specs/2026-07-15-runtime-db-ownership-spec.md`
- Modify: `docs/plans/2026-07-15-runtime-db-ownership-plan.md`

**Dependencies**

Tasks 1 through 3.

**Assumptions Verified**

- `README.md:61-74` owns quick-start runtime behavior and direct-versus-Portless
  expectations.
- `docs/system/ARCHITECTURE.md:47-65` owns shared runtime and CLI lifecycle shape.
- `docs/system/OPERATIONS.md:14-31` owns operator startup and shutdown behavior.
- `docs/project/CURRENT_STATE.md:31-46` owns high-change runtime notes.
- `docs/project/ROADMAP.md:7-41` is the newest-first shipped record.
- `docs/project/BACKLOG.md:21-23,41-50` requires shipped items to leave the
  future-only backlog and move to the roadmap.

**Implementation Steps**

1. Document same-DB conflict behavior, stale recovery, resource-complete shutdown,
   and the fact that one-shot commands are not locked out.
2. Remove the runtime-holder item from the backlog and add a concise newest-first
   roadmap highlight with the operational why.
3. Mark the spec and plan complete only after the final verification matrix is
   green.

**Verification**

- Run: `rg -n "ownership|same database|same SQLite|runtime" README.md docs/system/ARCHITECTURE.md docs/system/OPERATIONS.md docs/project/CURRENT_STATE.md docs/project/ROADMAP.md docs/project/BACKLOG.md`
- Expect: canonical references agree, and the open backlog no longer lists the
  shipped ownership gap.

**Done When**

- Operators and maintainers can find the new invariant, and project lifecycle
  docs correctly distinguish shipped behavior from future work.

### Task 5: Run high-risk completion gates and commit coherently

**Objective**

Prove the built and source paths satisfy the contract, then preserve the work in
reviewable commits.

**Files**

- Modify: all files changed by Tasks 1 through 4.

**Dependencies**

Tasks 1 through 4.

**Assumptions Verified**

- `package.json:10-27` defines the required source lint, built runtime, frontend
  build, and full Node test gates.
- `AGENTS.md` requires `pnpm lint`, `pnpm build`, and `pnpm test` before push and
  warns that only the built `dist/` runtime proves installed behavior.

**Implementation Steps**

1. Run targeted ownership/runtime tests, then lint, build, and the full Node test
   suite against the final diff.
2. Run the process contract suite against `dist/cli.js` to prove the emitted
   runtime rejects a competitor and restarts after shutdown.
3. Inspect `git diff --check`, the final diff, and worktree scope.
4. Mark the spec and plan complete, rerun validation, then commit implementation
   and lifecycle documentation in coherent chunks without pushing.

**Verification**

- Run: `pnpm lint && pnpm build && pnpm test`
- Run: `AGENTMONITOR_TEST_CLI_ENTRYPOINT=dist/cli.js pnpm exec tsx --test tests/cli-runtime.test.ts`
- Run: `git diff --check`
- Expect: every command exits 0; the full test summary has zero failures; the
  built subprocess smoke rejects same-DB concurrency and restarts cleanly.

**Done When**

- Fresh high-risk verification supports every success claim, the diff contains
  only this feature, and coherent local commits preserve the completed work.

## Risks And Mitigations

- Risk: PID reuse can conservatively identify an unrelated live process as the
  owner of a crash-left record.
  Signal: the diagnostic names a live PID while no AgentMonitor runtime owns the
  database.
  Mitigation: fail closed rather than permit concurrent writers; ownership
  metadata includes startup time for diagnosis, and a future process-fingerprint
  enhancement can be added without weakening this contract.
- Risk: an SSE or HTTP connection could keep `server.close()` pending.
  Signal: the real-process SIGTERM test exceeds its bounded graceful-exit window.
  Mitigation: close both SSE registries before awaiting HTTP closure, with forced
  child termination treated as a test failure rather than successful cleanup.
- Risk: filesystem semantics on network-mounted paths may not provide the local
  atomicity assumed here.
  Signal: lock creation or replacement returns an unexpected filesystem error.
  Mitigation: surface the startup error and do not open SQLite; cross-machine and
  network-filesystem coordination remains explicitly out of scope.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Exclusive same-DB ownership and stale recovery | `pnpm exec tsx --test tests/runtime-ownership.test.ts` | All ownership tests pass |
| Awaited watcher and SSE cleanup | `pnpm exec tsx --test tests/sse-emitter.test.ts tests/v2-live-stream.test.ts tests/watcher-service-live.test.ts tests/watcher-projection-warning.test.ts` | All cleanup tests pass without hanging |
| Observable CLI conflict, bind-failure cleanup, and restart | `pnpm exec tsx --test tests/cli-runtime.test.ts` | All real-process tests pass without forced SIGKILL |
| Source and built runtime compatibility | `pnpm lint && pnpm build && pnpm test` | Exit 0 and zero test failures |
| Emitted runtime ownership behavior | `AGENTMONITOR_TEST_CLI_ENTRYPOINT=dist/cli.js pnpm exec tsx --test tests/cli-runtime.test.ts` | All built-process runtime tests pass |
| Clean scoped diff | `git diff --check && git status --short` | No whitespace errors; only feature files are changed |

## Handoff

1. Execute this plan in the current session, task by task.
2. Review the plan inline against the contract and thinnest-seam criteria because
   multi-agent delegation was not requested for this repository task.
3. Refine only if implementation evidence reveals a contract-changing constraint.
