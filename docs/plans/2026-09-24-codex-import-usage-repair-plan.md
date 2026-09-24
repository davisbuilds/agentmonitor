---
date: 2026-09-24
author: claude
topic: codex-import-usage-repair
stage: plan
status: draft
source: conversation
spec: docs/specs/2026-09-24-codex-import-usage-repair-spec.md
risk_profile: high
readiness: ready
---

# Codex Import Usage Repair Plan

## Goal

Deliver the contract in
[the Codex import usage repair spec](../specs/2026-09-24-codex-import-usage-repair-spec.md):

- Each Codex session's import rows equal what the current parser derives from
  its rollout.
- A `thread_spawn` subagent's copied parent history produces no events.
- Existing databases are corrected through a repair that shows a preview first.

The accepted outcome is the Monitor's Codex figure matching what Codex actually
used, checked against Codex's own per-request OTEL. It is not the mechanism
below.

## Scope

### In Scope

- The boundary rule in the Codex importer (SC-01, SC-02).
- A per-session reconciliation that replaces insert-or-ignore plus
  model refresh for Codex files (SC-03, SC-05).
- `amon costs repair-codex-usage [--apply]`, whose report includes an OTEL
  cross-check (SC-04, SC-06).
- A rehearsal on a backup copy, then a live apply once the user gives the
  go-ahead (SC-06, SC-07).
- Updates to OPERATIONS, ARCHITECTURE, ROADMAP and BACKLOG.

### Out of Scope

The following are out of scope, as in the spec:
- tier selection across multi-request spans;
- requests that appear only in OTEL;
- copied history in the transcript browser and skill analytics;
- unpriced models;
- every non-`import-cdx-` row.

Each gets a BACKLOG entry with its measurement, except unpriced models, which
the bounty list already tracks.

## Assumptions And Constraints

- The repo is public. Tracked text carries ratios and row classes only; absolute
  spend stays in chat.
- Tests never open the install database. Every new test sets
  `AGENTMONITOR_DB_PATH` before importing and asserts the resolved handle.
- Development is red/green TDD. Every guard gets a mutation probe.
- Merges use merge commits. The PR gets a Codex review, monitored through
  `pulls/<n>/reviews` and comments.
- The live `--apply` needs the user's explicit go-ahead after they have seen the
  rehearsal numbers. It runs with the server stopped, after a verified backup.

## Map Before You Cut

All of the evidence in this section was verified on 2026-09-24:
- host `macbook`;
- the install database behind the running `dist/` server;
- Codex CLI rollouts, up to `cli_version` 0.146.x in the corpus.

**Data path.** Rollouts flow through three steps:
1. `runImport` runs every 10 minutes from `src/runtime.ts:38`, or through
   `amon import`.
2. `processFile` (`src/import/index.ts:130`) hashes the whole file
   (`src/import/codex.ts:357`) and skips the file when the hash matches
   `import_state`.
3. Otherwise `parseCodexFile` (`src/import/codex.ts:78`) runs, then
   `importEvents` (`src/import/index.ts:80`).

`importEvents` calls `insertEvent` (`src/db/queries.ts:432`). A duplicate id
falls back to `refreshImportedCodexEventModel` (`src/db/queries.ts:95`), which
updates model and cost but never tokens. That is the drift.

`insertEvent` fans out to:
- the Codex summary projection (`src/live/codex-adapter.ts:337`), one turn plus
  one item per event (`:381`);
- the trace summary, through `safelyMaintainTraceSummaryForEvent`;
- the stats cache inside the server process (`src/db/queries.ts:899`).

**Ids.** Usage ids are `codex:<session>:token:<eventIndex>`, and the counter
advances only on emitted events (`src/import/codex.ts:140`). File-change ids
reuse the same counter (`patch:<eventIndex>`). `tests/import.test.ts:595` pins
the derivation for plain sessions and warns that re-keying duplicates history
under insert-or-ignore.

**Consumers of the rows.** The Monitor's Codex cost is the import rows plus
OTEL rows that no import row overlaps. The overlap rule is at
`src/db/usage-reconciliation.ts:15`, and the Monitor query at
`src/db/v2-queries.ts:1685`. Observed on 2026-09-24: the Codex Monitor total
equals import cost plus a small OTEL residual that the reconciliation leaves in.
No foreign key references `events`.

The Codex summary projection has two properties that matter here:
- `ensureProjectedTurn` and `ensureProjectedItem` (`src/live/projector.ts:273`,
  `:313`) never update a row that already exists.
- The projected message counts equal the item counts.

**Sibling paths checked:**
- **Codex OTEL** reports usage per request, so it has no cumulative counters.
  Its log fields are read at `src/otel/parser.ts:603`.
- **The transcript parser** (`src/parser/codex-sessions.ts:268`) reads only
  `last_token_usage`, for context occupancy, so it is unaffected.
- **Live projection rows** come from event rows, not from counters.
- **Non-subagent rollouts** have no turns older than their own id. Across the
  corpus, the 5 that share counters with other files are the parents that were
  copied from.
- **Every subagent rollout** has turn ids and a boundary.
- **Duplicate ids within one parse** are `session_start` only, in 11 files, with
  identical payloads.

**The seam.** The plan changes two places:
- one reconciliation function for Codex import rows, used by both the importer
  and the repair;
- the boundary rule inside `parseCodexFile`.

For skipped counters with a positive delta, the counter still advances. That
keeps the ids of the child's own events byte-identical to today's, so SC-03 only
has to delete the copied rows' ids.

**Measurements** (in chat, 2026-09-23 and 24; the ratios are portable):
- **Copied-prefix subagents:** imported tokens run 140–810× OTEL today, and
  0.976–0.994× with the boundary.
- **Compacted children:** 0.93–0.95× today. A "total minus last" reseed would
  make them 0.13–0.18×, which is why the plan rejects it.
- **Non-subagent mismatches** trace to OTEL outage hours and to the period
  before OTEL. Their counter deltas equal `last_token_usage`.

## Task Breakdown

### Task 0: Re-baseline and stop gate

**Objective**

Confirm that the measurements this plan rests on still hold before any code
changes. The corpus changes daily.

**Files**

- Create: scratch scripts only, never tracked, under the session scratchpad:
  `boundary.mts`, `otelcheck.mts`, `orphans.mts`, `dupids.mts`.

**Dependencies**

None

**Implementation Steps**

1. Record `hostname -s`, the Codex `cli_version` range in the corpus, and the
   rollout count. Take the Monitor Codex and all-agent totals from
   `/api/v2/monitor/stats`.
2. Re-run each scratch script. Each one must first reproduce one known positive:
   - the boundary script: `019f9b0e`'s prefix;
   - the orphan script: `019f9497`'s orphans;
   - the OTEL script: a copied-prefix session over 100×.

**Verification**

- Run: the four scratch scripts, using `AGENTMONITOR_DB_PATH=<scratch>` for
  anything that imports `src/`, and opening the install database read-only.
- Expect all of the following:
  - every known positive is reproduced;
  - every changed file is `thread_spawn`;
  - OTEL ratios for the boundary-parsed subagents are within 0.95–1.02;
  - no subagent rollout lacks a boundary.

**Done When**

- All gates pass. Any failure stops the plan for a re-plan, not a workaround.

### Task 1: Reconcile a Codex file's import rows to its parse

**Objective**

SC-03 and SC-05: importing a Codex file makes that session's `import-cdx-` rows
equal to the parse. This lands before Task 2, so re-keyed ids can never be
inserted next to stale rows. A guard is not switched on until the path that
cleans up after it exists.

**Files**

- Create: `src/import/codex-reconcile.ts`
- Modify: `src/import/index.ts`
- Modify: `src/import/codex.ts` (parse from the provided bytes)
- Modify: `src/db/queries.ts` (retire the Codex branch of
  `refreshImportedCodexEventModel`)
- Modify: `src/live/codex-adapter.ts` (refresh or remove a projected turn and
  item for a replaced or deleted row)
- Test: `tests/codex-import-usage.test.ts`

**Dependencies**

Task 0

**Assumptions Verified**

- `src/import/index.ts:98-121`: insert-or-ignore, then
  `refreshImportedCodexEventModel`.
- `src/db/queries.ts:124-135`: the refresh sets model, cost and `cost_source`,
  but not tokens.
- `src/import/codex.ts:357`: a full-content sha256, read separately from the
  parse. The race only runs in the safe direction (the stored hash is older
  than the parse), but a single read removes it.
- `src/live/projector.ts:313`: an existing item is never updated.
- The Codex summary projection keys each turn and item on `event_id`
  (`src/live/codex-adapter.ts:381-395`).

**Implementation Steps**

1. Read the file once, hash those bytes, and parse the same bytes.
2. Deduplicate the parse by id, keeping the first occurrence.
3. In one transaction per session:
   - load the session's stored `import-cdx-` rows, meaning `source='import'` and
     `agent_type='codex'`;
   - update rows whose id matches and whose tokens, model, cost or timestamp
     differ, keeping `id` and `created_at`;
   - delete rows whose id the parse no longer produces, together with their
     projected turn and item;
   - insert new ids through `insertEvent`, which keeps the existing fan-out;
   - refresh the projected payload of every updated row;
   - recompute the projected message counts;
   - maintain the trace summary;
   - write `import_state` with the hash of the applied bytes.
4. Return per-session counts of inserted, updated, deleted and unchanged rows.
   The same function returns a preview without writing, for Task 3.
   - The preview runs the same code in a transaction that is rolled back by a
     thrown sentinel, as the recalc preview does.
   - A test-only `onAfterDelete` hook provides the EV-REC-01 fault injection.
5. `insertEvent` logs a Codex projection failure rather than raising it. The
   reconciliation therefore re-reads the session's projected turns and items
   after writing. If they do not equal the rows, it throws and rolls the
   session back, so a projection failure cannot pass silently.
6. Leave date-scoped imports (`--from` / `--to`) as they are today:
   insert-only, with no hash recorded. A partial parse must never delete rows.

**Verification**

- Run: `node --import tsx --test tests/codex-import-usage.test.ts`
- Expect the following cases to pass:
  - a shortened rewrite removes orphans;
  - a rewrite that changes tokens updates the tokens with the cost;
  - `created_at` and `id` survive an update;
  - an unchanged re-import writes nothing;
  - OTEL, Claude and benchmark rows for the same session id are untouched
    (EV-NEG-01);
  - projection turns and items equal the rows;
  - an exception thrown between delete and insert leaves the session unchanged,
    and a retry converges (EV-REC-01);
  - two sequential imports converge (EV-CON-01);
  - an appended file after a stale hash reconciles on the next import
    (EV-CON-02);
  - a date-scoped import deletes nothing.
- Mutation probes, each of which must turn a test red:
  - skip the delete;
  - update cost without tokens;
  - overwrite `created_at`;
  - hash before a second read;
  - drop the `source='import'` predicate.

**Test Discovery Verified**

- `package.json:19` runs `tests/*.test.ts`, so the new file is discovered.
- The literal command above runs it alone. It is planned, and will run once the
  file exists.

**Done When**

- Every case above passes.
- Every mutation probe goes red.
- The existing suites `tests/import.test.ts` (including the id pin at `:595`)
  and `tests/codex-adapter.test.ts` stay green.

### Task 2: Copied history produces no events

**Objective**

SC-01 and SC-02: apply the turn-id boundary inside `parseCodexFile`.

**Files**

- Modify: `src/import/codex.ts`
- Test: `tests/codex-import-usage.test.ts`
- Modify: `tests/import.test.ts` (add a subagent id pin next to the existing
  pin, which stays unchanged)

**Dependencies**

Task 1

**Assumptions Verified**

- `src/import/codex.ts:103`: only the first `session_meta` sets the session.
- `src/import/codex.ts:190-240`: deltas start from zero, and the counter
  advances only on emitted events.
- `src/import/codex.ts:258-300`: file changes key on the same counter.
- `src/parser/codex-sessions.ts:155-160` already reads
  `source.subagent.thread_spawn` with the same shape, which is research context
  for detecting subagents.

**Implementation Steps**

1. In the first pass, detect `thread_spawn` and compute the boundary line: the
   first `turn_context` whose `turn_id` UUIDv7 time is at or after the session
   id's UUIDv7 time. If no boundary is found, mark the file
   `boundary_unresolved` and apply no skipping (EV-LEG-02).
2. In the second pass, before the boundary:
   - let token counters update the previous totals, and advance the event
     counter for each positive delta, but emit nothing;
   - emit no file-change events, but advance the counter exactly as today's
     code would.
3. Expose `boundary_unresolved` and the number of skipped counters so the
   repair report can show them.

**Verification**

- Run: `node --import tsx --test tests/codex-import-usage.test.ts tests/import.test.ts`
- Expect these fixtures to pass:
  - full copied prefix: no usage from the prefix, and the own rows keep
    today's ids;
  - copied prefix containing `apply_patch`: no file-change row from the prefix;
  - compacted child, first counter with `last` = 0: billed in full (SC-02);
  - child whose first counter follows its own tool call: unchanged;
  - duplicate counter just after the boundary: zero delta, no row;
  - plain session: output identical, and the pin stays green;
  - no turn ids: billed as today and flagged.
- Mutation probes, each of which must turn a test red:
  - bill from zero before the boundary;
  - reseed from total minus last;
  - use timestamps instead of turn ids;
  - stop advancing the counter for skipped counters.

**Test Discovery Verified**

- The files are the same as Task 1's. The id pin at `tests/import.test.ts:595`
  exists and passes today (observed on 2026-09-24 in the last full `pnpm test`
  for PR #146).

**Done When**

- Every fixture and mutation probe behaves as listed.
- The read-only corpus differential passes: non-subagent files are unchanged,
  and every changed file is `thread_spawn` with parent-matched removed counters.

### Task 3: `amon costs repair-codex-usage`

**Objective**

SC-04 and SC-06: preview by default, apply with `--apply`, and report classes
plus an OTEL cross-check.

**Files**

- Create: `src/import/codex-usage-repair.ts`
- Modify: `src/cli/commands/maintenance.ts`
- Test: `tests/codex-usage-repair.test.ts`

**Dependencies**

Task 1, Task 2

**Assumptions Verified**

- `src/cli/commands/maintenance.ts:280-310`: `costs repair-claude-usage
  [--apply]` is opt-in, prints a summary, and supports `--json`. This command
  follows the same shape.
- `src/import/claude-usage-repair.ts:40-60`: that repair reports rather than
  touches rows that have no transcript. This one adopts the same rule.

**Implementation Steps**

1. Discover rollouts the same way import does, reusing `discoverCodexLogs` with
   `--codex-dir`, and run the Task 1 reconciliation for each file.
2. Report:
   - files scanned;
   - sessions changed, split into copied-prefix, orphan and drift, with an
     `unclassified` count;
   - rows inserted, updated and deleted;
   - the change in tokens and cost;
   - sessions without a rollout (untouched);
   - files that failed to parse (untouched);
   - `boundary_unresolved`;
   - for every changed session with OTEL rows, the imported-to-OTEL token ratio
     before and after, and the hours with OTEL gaps;
   - sessions left with no import usage.
3. Apply each session in its own transaction. Print a reminder to restart the
   server, because its stats cache lives in its own process.

**Verification**

- Run: `node --import tsx --test tests/codex-usage-repair.test.ts`
- Expect these cases to pass:
  - the preview writes nothing, and its counts equal what apply then does;
  - a second apply reports zero;
  - a session with no rollout keeps its rows and is counted (EV-NEG-02);
  - a malformed file is skipped and counted;
  - legacy rows with no cost provenance end up labelled `estimated`
    (EV-LEG-01);
  - the OTEL ratio moves toward 1 on a copied-prefix fixture;
  - a fixture with an unexpected re-key shows up as `unclassified`.

**Test Discovery Verified**

- `package.json:19` discovers `tests/codex-usage-repair.test.ts`. The literal
  command runs it alone. It is planned.

**Done When**

- Every case passes, and every guard's mutation goes red.
- `pnpm lint`, `pnpm build` and `pnpm test` are green.
- `amon costs repair-codex-usage --help` shows the command.

### Task 4: Rehearse on a backup copy

**Objective**

SC-06 and SC-07 on real data, through the surface a user actually touches,
before any live write.

**Files**

- None tracked. The copy and logs live in the scratchpad.

**Dependencies**

Task 3, built into `dist/`

**Behavior Measured**

- Pair the repair's own report with the Monitor HTTP surface. Serve the copy
  with `AGENTMONITOR_DB_PATH=<copy> node dist/cli.js serve --port 3999
  --no-import --no-watch --no-portless`, setting the env var before node starts.
  Kill the server by port afterwards and verify it is gone.
- The server's first startup runs the missing-cost fill on the copy. The
  "before" reading therefore comes from that first startup, so the fill cannot
  leak into the measured change.

**Implementation Steps**

1. Run `amon database backup --output <scratch>/rehearsal.db`.
2. Start the scratch server on the copy and record
   `/api/v2/monitor/stats` and `?agent=codex`.
3. Run a preview, then `--apply --json`, against the copy.
4. Restart the scratch server and record the same endpoints.
5. Re-run the scratch scripts against the copy.

**Verification**

- Expect all of the following:
  - the change in the Codex Monitor total equals the change in import cost to
    the cent, apart from sessions the report names as left with no usage;
  - other agents' totals are unchanged;
  - `unclassified` is 0;
  - OTEL ratios for the subagent sessions are within 0.95–1.02, and none moves
    away from 1;
  - a second apply reports zero;
  - the preview's counts equal the apply's.

**Done When**

- Every expectation holds. The numbers go to the user in chat, before Task 6.

### Task 5: Docs, PR and review

**Objective**

Keep the durable references current, then ship through review.

**Files**

- Modify: `docs/system/OPERATIONS.md` (the repair procedure: backup, rehearse,
  stop the server, apply, restart, verify)
- Modify: `docs/system/ARCHITECTURE.md` (the rollout owns its session's import
  rows; the subagent boundary)
- Modify: `docs/project/ROADMAP.md`
- Modify: `docs/project/BACKLOG.md` (tier span, OTEL-only requests, the
  transcript-browser hypothesis)
- Modify: `README.md` (the new command in the CLI list, if it lists commands)

**Dependencies**

Task 4

**Assumptions Verified**

- OPERATIONS already has the sections "Cost provenance and correcting a rate"
  and the Claude usage repair procedure, added in PRs #146 and #137. The new
  procedure goes next to them.

**Behavior Measured**

- The Codex review arrives as a PR review, not an issue comment. This was
  observed on PRs #144 through #146 and is recorded in memory. The monitor
  therefore polls `pulls/<n>/reviews` and `pulls/<n>/comments`.

**Implementation Steps**

1. Write the docs using ratios and row classes only.
2. Open the PR. Comment `@codex review` and monitor `pulls/<n>/reviews` and
   comments. Reply to each thread and resolve it through GraphQL.

**Verification**

- Run: `pnpm lint && pnpm build && pnpm test`
- Expect: all green. `git grep` finds no absolute spend in the diff.

**Done When**

- The PR is reviewed, its threads are resolved, and the user has approved the
  merge.

### Task 6: Live apply, after the user's go-ahead

**Objective**

Correct the install database.

**Files**

- None tracked.

**Dependencies**

Task 5 merged and rebuilt, plus the user's explicit go-ahead after reviewing
the Task 4 numbers.

**Implementation Steps**

1. Build from `main`.
2. Stop the server in tmux `agentmonitor-server`, and verify that port 3141 is
   free and the old PID has exited.
3. Run `amon database backup` and verify the backup opens.
4. Run the preview. Its counts must match the rehearsal, allowing for rollouts
   that grew since.
5. Run `--apply --json`.
6. Restart the server.

**Verification**

- Expect:
  - the Monitor Codex change matches the report;
  - other agents are unchanged;
  - a second preview reports zero.
- The backup is deleted only after the user confirms everything looks good.

**Done When**

- The live totals match the report, and the user has confirmed.

## Risks And Mitigations

- **Risk:** Codex changes how subagent rollouts or turn ids are laid out.
  - Signal: `boundary_unresolved` goes above 0, or a new `thread_spawn` rollout's
    OTEL ratio falls outside 0.95–1.02.
  - Mitigation: the file falls back to today's billing and is flagged, never
    guessed. A BACKLOG trigger calls for re-measuring on each Codex minor
    version.
- **Risk:** a rollout is appended during apply.
  - Signal: the next import reconciles that session again.
  - Mitigation: the hash is taken from the applied bytes (EV-CON-02), and the
    server is stopped during the live apply.
- **Risk:** a rollout is deleted or archived before the repair runs.
  - Signal: the report's "sessions without a rollout" count.
  - Mitigation: those sessions are left untouched. Their rows stay as stored,
    and the count is reported.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| SC-01/02 boundary | `node --import tsx --test tests/codex-import-usage.test.ts` | Boundary fixtures pass; mutations red |
| Plain ids unchanged | `node --import tsx --test tests/import.test.ts` | Id pin green |
| SC-03/05 reconcile | `node --import tsx --test tests/codex-import-usage.test.ts` | Orphans gone; tokens with cost; projection equals rows |
| SC-04 repair | `node --import tsx --test tests/codex-usage-repair.test.ts` | Preview writes nothing; second apply reports zero |
| SC-06 fidelity | Task 4 report and scratch OTEL script on the copy | Subagent ratios 0.95–1.02; none moves away from 1 |
| SC-07 surface | Task 4 `/api/v2/monitor/stats?agent=codex` before and after | Change equals the import change to the cent; `unclassified` 0 |
| Gates | `pnpm lint && pnpm build && pnpm test` | Green |

## High-Risk Readiness

### Traceability

| Contract ID | Task | Proof |
| --- | --- | --- |
| SC-01 | Task 2 | `node --import tsx --test tests/codex-import-usage.test.ts` |
| SC-02 | Task 2 | `node --import tsx --test tests/codex-import-usage.test.ts` |
| SC-03 | Task 1 | `node --import tsx --test tests/codex-import-usage.test.ts` |
| SC-04 | Task 3 | `node --import tsx --test tests/codex-usage-repair.test.ts` |
| SC-05 | Task 1 | `node --import tsx --test tests/codex-import-usage.test.ts` |
| SC-06 | Task 4 | rehearsal report plus scratch OTEL script on the copy |
| SC-07 | Task 4 | Monitor HTTP before and after on the rehearsal server |
| EV-NEG-01 | Task 1 | `node --import tsx --test tests/codex-import-usage.test.ts` |
| EV-NEG-02 | Task 3 | `node --import tsx --test tests/codex-usage-repair.test.ts` |
| EV-REC-01 | Task 1 | `node --import tsx --test tests/codex-import-usage.test.ts` |
| EV-CON-01 | Task 1 | `node --import tsx --test tests/codex-import-usage.test.ts` |
| EV-CON-02 | Task 1 | `node --import tsx --test tests/codex-import-usage.test.ts` |
| EV-LEG-01 | Task 3 | `node --import tsx --test tests/codex-usage-repair.test.ts` |
| EV-LEG-02 | Task 2 | `node --import tsx --test tests/codex-import-usage.test.ts` |

### Capability And Authority Map

| Actor | Allowed | Forbidden | Effective-runtime proof |
| --- | --- | --- | --- |
| Operator CLI (preview) | Read rollouts and the DB | Any write | The preview test snapshots `events`, `session_items`, `session_turns`, `browsing_sessions`, `session_trace_summary` and `import_state`, and asserts they are equal after the run. Bytes are not compared, because of WAL |
| Operator CLI (`--apply`) | Reconcile `import-cdx-` rows of sessions with a readable rollout | Rows from other producers or agents; sessions without a rollout; running while the server is up in the live procedure | EV-NEG-01 and EV-NEG-02 tests; the Task 6 port check |
| Auto-import / `amon import` | Reconcile the session of a file whose hash changed | Deleting rows during a date-scoped import | Task 1 date-scoped test |
| Tests | A temp DB only | The install DB | `getDb()` guard plus a resolved-path assertion in each new file |

### Side Effects And Failure Windows

| Effect | Before | After | Recovery |
| --- | --- | --- | --- |
| Session rows (update, delete, insert), projection and trace summary | Old set | Parse set | One transaction per session; rerunning converges (EV-REC-01) |
| `import_state` hash | Old hash | Hash of the applied bytes | Written in the same transaction; a mismatch triggers a reconcile on the next import |
| Server stats cache | Stale totals | Fresh totals | Server restart in Tasks 4 and 6 |
| Live DB | Pre-repair | Repaired | There is no restore command (`amon database` has only `backup`). Stop the server, move `agentmonitor.db` and its `-wal` and `-shm` sidecars aside, copy the backup in, and restart |

### Evidence Lifecycle

| Evidence | Trusted producer | Created | Claim | Consumers | Freshness |
| --- | --- | --- | --- | --- | --- |
| Corpus measurements | Scratch scripts, read-only | Task 0 | Boundary and fidelity ratios | Tasks 2 and 4 | Invalid when the corpus or Codex version changes; re-run at Task 4 |
| Rehearsal report | The repair CLI on the copy | Task 4 | Deltas, classes, OTEL ratios | The user's go-ahead; Task 6 comparison | Invalid if `main` changes after the rehearsal |
| Backup | `amon database backup` | Task 6 | Restorable pre-repair state | Recovery | Deleted only after the user confirms |

### Consumer Closure

Every consumer of Codex `import-cdx-` rows is handled together in Task 1's
per-session transaction:
- the Monitor and usage queries;
- the OTEL overlap rule;
- the Codex summary projection (turns, items, counts);
- the trace summary;
- `import_state`.

The v1 `sessions` rows hold no usage totals. Cost provenance is set by
`insertEvent` for inserts, and set to `estimated` on updates.

### Lifecycle And Compatibility

- **Rows from older parser versions** reconcile by id (EV-LEG-01).
- **The id pin keeps plain sessions' ids unchanged.** Subagent sessions re-key
  only by losing their copied-prefix ids.
- **Before Task 1 ships,** the old insert-or-ignore behavior stays. Task 2
  depends on Task 1, so no build can re-key without reconciling.

### Execution Hooks

- **Startup:** runs `runDataMigrations`, the missing-cost fill, and
  auto-import after 10 minutes. Neither touches this path destructively.
  This change adds no schema migration.
- **Rehearsal server:** runs with auto-import disabled.
- **Live apply:** runs with the server stopped.

### Capability Stop Gates

- **Task 0 gates the whole plan:**
  - each instrument must reproduce its known positive;
  - the corpus shape must still match;
  - no subagent rollout may lack a boundary.
- **Task 4 gates Task 6** on SC-06 and SC-07.
- **The fingerprint covers** host, Codex `cli_version` range, rollout count, and
  the `main` commit. A change invalidates the rehearsal.

### Readiness Review

- Deterministic validation: passed
- Adversarial critique: complete
- Closure critique: complete
- Blocking findings: none

#### Critique Log

Critiqued inline on 2026-09-24, because spawning a critic was not authorized.
Each finding was checked against code or CLI output:

- **No restore command exists.** `amon database --help` lists only `backup`.
  Recovery is now a stop, swap and restart that moves the sidecars aside.
- **The Claude repair shipped in #137, not #139.** Corrected.
- **The rehearsal server** now uses the real flags
  (`--port 3999 --no-import --no-watch`) and takes its "before" reading after
  the startup missing-cost fill.
- **The preview assertion** now compares a snapshot of the tables, because a
  byte comparison does not work under WAL.
- **`insertEvent` swallows projection failures.** The reconciliation now checks
  that projections equal the rows and rolls back on any mismatch.
- **EV-REC-01 needed a named fault seam.** It is `onAfterDelete`.
- **A skipped counter still advances the event counter.** That keeps the ids of
  the child's own events unchanged, so the only re-keying left is deleting the
  copied-prefix ids.

The closure critique re-checked every SC and EV id in the traceability table,
and checked that no task allows a live write before Task 4's gates and the
user's go-ahead.

## Handoff

Next action: Task 0, then Task 1 on branch `fix/codex-import-usage`. The live
apply (Task 6) waits for the user's go-ahead after the Task 4 numbers.
