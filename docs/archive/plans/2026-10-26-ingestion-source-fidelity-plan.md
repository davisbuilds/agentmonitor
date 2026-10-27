---
date: 2026-10-26
author: claude
topic: ingestion-source-fidelity
stage: plan
status: complete
source: conversation
spec: docs/archive/specs/2026-10-26-ingestion-source-fidelity-spec.md
risk_profile: high
readiness: ready
---

# Ingestion Source Fidelity Plan

## Goal

This plan delivers the contract in
`docs/archive/specs/2026-10-26-ingestion-source-fidelity-spec.md`, criteria SC-01 to
SC-07. It is the workoff of the 2026-10-26 source audit across Claude, Codex and
Antigravity.

The user approved applying the migrations and deletions to the live store on
2026-10-26, provided that backups are made and the results validated.

## Scope

### In Scope

- Tasks 0 to 6 below, each shipped as its own PR, in this order.
- The live applies of Tasks 2, 3 and 4, through the gated procedure in
  [Map Before You Cut](#map-before-you-cut).
- Backlog and reference-doc reconciliation inside each task's PR.

### Out of Scope

These come from the spec's Out of Scope list. Each has a backlog owner:

- Codex browser identity keyed by session UUID.
- Item-less projected turns.
- Claude OTEL.
- Antigravity.
- Codex reasoning content.

## Assumptions And Constraints

- Builds and gates run in `~/Dev/.worktrees/agentmonitor-source-fidelity`,
  never in the main checkout. The live service loads the main checkout's
  `dist/`, so a deploy is: merge, then `git pull --ff-only` in the main
  checkout, then `pnpm build`, then `amon service restart`.
- Pre-push gates for every PR:
  - `pnpm lint`;
  - `pnpm build`;
  - `pnpm test`;
  - `pnpm verify:skill-context-built`;
  - `pnpm exec playwright test --project=chromium`;
  - `pnpm frontend:check` and `pnpm frontend:test` when the frontend changes;
  - `pnpm test:verify` in the worktree.
- Every PR gets `@codex review`. Merges use merge commits only, after the
  unresolved review threads have been checked through GraphQL.
- Tracked docs, commits and PR bodies carry ratios and row classes only.
- Tests never open the install DB. Investigation of the real store is
  read-only, or runs on a copy.

## Map Before You Cut

**Live-apply procedure.** Tasks 2, 3 and 4 share this procedure:

1. Preview against the live store, read-only, and record its digest and counts.
2. Run `amon service stop`.
3. Run `amon database backup --output data/backups/pre-<task>-2026-10-DD.db`.
   Validation is built into the command. Then check `PRAGMA integrity_check`
   and per-class row counts on the backup.
4. Copy the backup to the scratchpad. Apply there, and check the task's spec
   criteria on the copy (the rehearsal).
5. Apply to the live store with the preview's digest. If the inventory changed,
   preview again.
6. Run `amon service restart`. Validate through `/api/health` and the product
   surface: `/api/v2/monitor/stats` and the session endpoints.
7. Delete the rehearsal copy. Keep the backup until the user approves deleting
   it.

For Tasks 3 and 4 the deploy itself writes: on restart, the server's
auto-import and watcher reconcile every changed rollout under the new parser.
So the order is:

- stop the service;
- back up;
- rehearse on the copy with the new build;
- deploy the build (`git pull --ff-only`, then `pnpm build`) while the service
  is still stopped;
- apply the repair or resync;
- only then restart.

Task 2's build (Task 1) only stops writing fragments, so it deploys first by
itself.

**Data paths.** All measured on 2026-10-26:

- **OTEL logs.** `src/otel/parser.ts` maps an event name and kind to an event
  type; a `null` type is dropped (line 593).
  - The `codex.websocket_event` branch skips `SKIPPED_CODEX_WEBSOCKET_RESPONSE_KINDS`
    (line 376).
  - The `codex.sse_event` branch maps any `response.*` kind to `response`
    (line 512).
- **Fan-out of each stored row.** For a Codex row, `insertEvent`
  (`src/db/queries.ts`) calls `syncCodexSummaryLiveEvent`
  (`src/live/codex-adapter.ts:346`). That always ensures one projected turn,
  keyed `source_turn_id = event_id`, plus an item when one can be built.
  Fragment rows build none.
  - `src/trace-quality/projection.ts:409` counts `response` rows as
    `generation` observations.
  - `src/live/projector.ts` exposes `removeProjectedSourceEvent` and
    `recountProjectedSummaryMessages`.
- **Codex import.** `parseCodexFile` (`src/import/codex.ts`) bills from
  `token_count` deltas, with positional ids `codex:<session>:token:<eventIndex>`.
  The id derivation is pinned by the tests named in the BACKLOG entry "Codex
  event ids are positional".
  - `reconcileCodexRollout` keeps a session's `import-cdx-` rows equal to the
    parse.
  - `repairCodexImportUsage` (`src/import/codex-usage-repair.ts`) runs that
    reconcile across rollouts. It also checks each plain session against the
    final counter (lines 229-237).
- **Monitor overlap.** `overlappingCodexOtelUsageCondition`
  (`src/db/usage-reconciliation.ts:15`) drops a Codex OTEL usage row when the
  same session has an import usage row at the same timestamp or later.
- **Runtime ownership.** `acquireRuntimeOwnership` / `readRuntimeOwner`
  (`src/runtime-ownership.ts`). The existing repair command does not take
  ownership.
- **Consumers of the fragment rows.** These must agree after cleanup:
  - the Monitor session detail `event_count` and recent events;
  - the trace summary;
  - the live turns;
  - the `/api/v2/monitor/stats` cost, which carries no fragment cost.

## Task Breakdown

### Task 0: Prove the apply gates on this host

**Objective**

Before any live apply, establish that the gates the procedure relies on
actually behave as assumed.

**Files**

- None (observation only)

**Dependencies**

None

**Implementation Steps**

1. Check that `readRuntimeOwner` on the live DB names the running service's PID.
2. Check that `amon database backup` to the scratchpad produces a file that
   passes `PRAGMA integrity_check`, with row counts equal to the source for
   `events`, `session_turns`, `session_items` and `browsing_sessions`. The
   source is read through `mode=ro`.
3. Check that `amon service stop` leaves no process on `:3141`, and that the
   service stays stopped for 30 s, i.e. no launchd respawn.
4. Check that `amon service restart` brings `/api/health` back to ok.

**Verification**

- Run:
  ```sh
  sqlite3 <backup> 'PRAGMA integrity_check'
  lsof -iTCP:3141 -sTCP:LISTEN
  curl -s 127.0.0.1:3141/api/health
  ```
- Expect: `ok`; no listener while stopped; health is ok after restart.

**Done When**

- All four observations hold. If one fails, live applies stop until it is
  understood.

### Task 1: Drop Codex stream fragments at ingest (SC-01)

**Objective**

On both Codex transports, the fragment kinds store nothing.

**Files**

- Modify: `src/otel/parser.ts`
- Test: `tests/otel.test.ts`
- Modify: `docs/system/ARCHITECTURE.md`

**Dependencies**

None

**Assumptions Verified**

- `src/otel/parser.ts:376-388`: the websocket skip set exists.
- `src/otel/parser.ts:507-513`: the SSE branch has no skip.
- Every stored SSE `response` row carries only `otel_event_name` and
  `event_kind`. This was measured on the live store, over every kind.

**Implementation Steps**

1. Replace the websocket-only set with one exported predicate,
   `isCodexStreamFragmentKind(kind)`. It covers:
   - the existing kinds;
   - `response.metadata`;
   - `response.function_call_arguments.done`;
   - `response.custom_tool_call_input.done`;
   - any `response.*.delta`.
2. Apply the predicate in both the SSE branch and the websocket branch.
3. Write the test before the fix and watch it fail on behavior: SSE fragments
   of each kind store no event and no live session.
   `response.completed`, `response.failed` and `response.compaction.compacting`
   still map.

**Verification**

- Run: `node --import tsx --test --test-name-pattern "stream fragment|websocket" tests/otel.test.ts`
- Expect: pass. The new test fails when the SSE branch skips the predicate
  (mutation).

**Test Discovery Verified**

- `tests/otel.test.ts` matches the `tests/*.test.ts` glob in `package.json`'s
  `test` script (observed).

**Done When**

- The test is green and its mutation is red, and the full gates pass.

### Task 2: Remove stored fragments and their derived state (SC-02)

**Objective**

A previewed, digest-gated cleanup removes the fragment rows from the live
store. The rows' turns and items go with them, and the affected trace summaries
are rebuilt, all in one transaction.

**Files**

- Create: `src/db/prune-codex-fragments.ts`
- Modify: `src/cli/commands/database.ts`
  - this adds `amon database prune-codex-fragments [--apply --expect-digest <sha>]`
- Test: `tests/prune-codex-fragments.test.ts`
- Modify: `docs/system/OPERATIONS.md`, `docs/project/BACKLOG.md`

**Dependencies**

Task 0. Task 1 must be deployed first, so that no new fragments arrive.

**Assumptions Verified**

- `src/db/repair-summary-timestamps.ts`: the preview-digest-apply pattern.
- `src/trace-quality/summary.ts`: `maintainSessionTraceSummary(sessionId)`
  re-derives a summary through `getDb()`.
- `session_turns.source_turn_id` equals the event's `event_id` for Codex OTEL
  summary turns (`src/live/codex-adapter.ts:400`).
- No trigger or FTS index hangs off `events`. The only triggers are on
  `messages` (observed in `sqlite_master`).

**Implementation Steps**

1. **Inventory.** Select Codex `source='otel'` rows with
   `event_type='response'`, an `otel_event_name` of `codex.sse_event` or
   `codex.websocket_event`, a fragment kind (by Task 1's predicate), and
   metadata with exactly those two keys. The digest covers the sorted ids. The
   preview reports:
   - the row count;
   - the affected sessions;
   - the turns and items to remove;
   - the digest.
2. **Apply.** Take runtime ownership. In one immediate transaction:
   - recompute the inventory, and refuse on a digest mismatch;
   - delete each row's turns and items by session and source id;
   - delete the rows;
   - recount the projected message counts;
   - rebuild each affected session's trace summary.

   Then release ownership.
3. **Tests**, on a temp DB:
   - EV-NEG-01: neighbouring rows survive;
   - EV-NEG-03: refuses while another process holds ownership;
   - EV-REC-01: a stale digest changes nothing, and an injected failure rolls
     back;
   - EV-CON-01: a second apply removes 0.
4. **Live apply** through the procedure. Then run `amon database compact
   --backup <path>` to reclaim the free pages.
5. **Docs.** Add the operator procedure to OPERATIONS, and add the item-less
   turns backlog entry.

**Verification**

- Run: `node --import tsx --test tests/prune-codex-fragments.test.ts`
- Expect: pass. Each mutation is red: drop the metadata-key guard, skip the
  turn delete, skip the summary rebuild, skip the ownership check.
- On the rehearsal copy and then live, compare before and after:
  - per-class counts and a content digest of non-fragment rows of `events`,
    `session_turns` and `session_items`: unchanged;
  - `/api/v2/monitor/stats` cost per agent: unchanged to the cent;
  - the sample session's `event_count`: reduced by exactly its fragment count;
  - its recent events: show no `response` fragment.

**Test Discovery Verified**

- The new file matches the `tests/*.test.ts` glob (pattern observed; the file
  will exist after this task).

**Done When**

- The live store holds zero rows matching the inventory.
- Non-fragment digests and Monitor costs are unchanged.
- The backup is validated and kept.

### Task 3: Bill Codex compactions and repair stored sessions (SC-03, SC-04)

**Objective**

The import emits one row per compaction request that Codex recorded. The
existing repair brings stored sessions to the same state, and is checked
against Codex's thread total.

**Files**

- Modify: `src/import/codex.ts`
- Modify: `src/import/codex-usage-repair.ts`
- Modify: `src/cli/commands/maintenance.ts`
  - the repair takes runtime ownership on `--apply`
- Test: `tests/codex-import-usage.test.ts`, `tests/codex-usage-repair.test.ts`
- Modify: `docs/system/ARCHITECTURE.md`, `docs/project/BACKLOG.md`
  - resolve "Codex requests that only OTEL records", and note the remaining
    case without a record

**Dependencies**

Task 0.

**Assumptions Verified**

- `src/import/codex.ts:206-260`: positional ids from `eventIndex` over emitted
  deltas.
- `src/import/codex-usage-repair.ts:229-237`: the final-counter check.
- Corpus differential (2026-10-26, read-only): the final counter plus the
  records named by `compacted.compaction_response_id` equals the final
  `thread_token_usage` in every rollout but one. The remaining rollout's gap is
  a request from an aborted turn that no `compacted` line names.
- No copied subagent prefix in the 30-day corpus contains a usage record, and
  every record's `thread_id` equals its rollout's own session id.

**Implementation Steps**

1. **Index the records.** Index `token_usage_record` lines by `response_id`,
   keeping only those of the rollout's own `thread_id` and past the subagent
   boundary.
2. **Hold each compaction.** At each `compacted` line, hold the named record as
   pending. Do not touch `eventIndex`.
3. **Emit at the next counter.** At the next `token_count`, emit the pending
   records only if both hold:
   - the counter did not reset;
   - (last record's `thread_token_usage` − counter total) grew by exactly
     their usage, for input, cached and output alike.
   - At end of file, the same check runs against the last counter.
   - Each emitted row has the id `import-cdx-` + a hash of
     `codex:<session>:response:<response_id>`, the turn's model, the record's
     timestamp, and metadata `{ _usage_source: 'compaction' }`.
   - Count `_compactions_unbilled` on `session_end` for any held record that
     fails the check.
4. **Record the thread total.** Write the final `thread_token_usage` on
   `session_end`. The repair's plain-session check compares against it when
   present, and against the counter otherwise. Add the row class `compaction`.
5. **Take ownership** in `costs repair-codex-usage --apply`.
6. **Tests.** Write these before the code and watch them fail on behavior:
   - fixtures for compaction billed;
   - counter already inclusive → none;
   - foreign thread → none;
   - missing record → none plus counted;
   - reset → none;
   - pre-record rollout byte-identical (EV-LEG-01);
   - existing ids unchanged;
   - repair classes and the thread check.
7. **Corpus differential** (read-only script in the scratchpad): every rollout
   is identical except for added compaction rows, and imported tokens equal the
   thread total where every compaction has a record.
8. **Live apply** through the procedure, using `amon costs repair-codex-usage`
   preview, then `--apply`.

**Verification**

- Run: `node --import tsx --test tests/codex-import-usage.test.ts tests/codex-usage-repair.test.ts`
- Expect: pass. Each mutation is red: no gap check, advancing `eventIndex`,
  counter-only check, foreign-thread record admitted.
- Rehearsal:
  - the Codex `/api/v2/monitor/stats` cost delta equals the inserted cost, less
    the newly covered OTEL cost, to the cent;
  - other agents are unchanged;
  - a second apply reports 0 changes.

**Test Discovery Verified**

- Both test files exist and match the `tests/*.test.ts` glob (observed).

**Done When**

- The live repair is applied.
- The sampled session's Monitor cost moves from about 0.96 to about 1.00 of
  its priced `token_usage_record` total.
- The repair names the one rollout without records.

### Task 4: Codex tool call ids and result receipts (SC-05)

**Objective**

Rollout-parsed Codex tool calls carry their `call_id` and a result receipt.
Existing ordinals do not move.

**Files**

- Modify: `src/parser/codex-sessions.ts`
- Modify: `src/live/codex-adapter.ts`
  - the capabilities that are earned
- Test: `tests/codex-session-lineage.test.ts` or a new
  `tests/codex-tool-evidence.test.ts`
- Modify: `docs/system/FEATURES.md`, `docs/system/trace-quality.md`,
  `docs/project/BACKLOG.md`
  - resolve "Decide the Codex tool-result evidence boundary"

**Dependencies**

Task 0. Tasks 1-3 should be merged first, to keep each review separate.

**Assumptions Verified**

- `src/parser/codex-sessions.ts:422-450`: tool calls are emitted with
  `tool_use_id: null` and no output.
- Outputs (`function_call_output`, `custom_tool_call_output`) have no `name` or
  `role`, so they fall through at line 459.
- Every call pairs with an output by `call_id` in the sampled rollout.
- `item_completed` carries `exit_code`, `duration` and `status` for
  `CommandExecution`.
- No pinned messages exist (observed 2026-10-26).

**Implementation Steps**

1. **Decide the placement and the preview policy.** This is decided at the
   start of the task and recorded in the PR, and the backlog entry is resolved
   accordingly.
   - **Placement:** the default is to attach the receipt to the call's message,
     so ordinals are unchanged. Because a call and its output can land in
     different incremental chunks, this needs a bounded update of the call's
     message. A new message with a stable ordinal is the alternative.
   - **Preview policy:** the default is to store exit code, duration and status
     always, and an output preview only under the existing tool-argument
     capture setting.
2. **Fill the ids.** Fill `tool_use_id` and the block id from `call_id`.
3. **Tests**, written first:
   - full-vs-incremental equality;
   - unchanged human-turn and usage counts;
   - receipts absent when capture is off;
   - an orphan output.
4. **Live apply.** Use the procedure with
   `amon sync sessions --source codex --force`, after a backup.

**Verification**

- Run: `node --import tsx --test tests/codex-tool-evidence.test.ts`
- Expect: pass. Each mutation is red: drop the call-id pairing, emit a preview
  with capture off, shift an ordinal.

**Test Discovery Verified**

- Planned: the new file matches `tests/*.test.ts`. This will be observed when
  it is created.

**Done When**

- The sampled session's browser messages show paired calls and receipts.
- Counts are unchanged.
- `fidelity` stays `summary`, and the capabilities state what is carried.

### Task 5: Per-model Claude check against `cost-state` (SC-06)

**Objective**

A read-only report compares each Claude session's latest `cost-state` with
amon's imported cost per model, up to that checkpoint.

**Files**

- Create: `src/import/claude-cost-state.ts`
- Modify: `src/cli/commands/maintenance.ts`
  - adds `costs check-claude-sessions --transcripts`
- Test: `tests/claude-cost-state.test.ts`
- Modify: `docs/project/BACKLOG.md`
  - record the per-model split in "Imported Claude cost runs below Claude
    Code's own running cost"

**Dependencies**

None

**Assumptions Verified**

- `checkClaudeSessionCosts` (`src/db/queries.ts:1730`) compares only the
  statusline's whole-session cost.
- `cost-state` lines have no timestamp, are written at process exit or resume,
  and carry `modelUsage.<model>.{costUSD,inputTokens,outputTokens,cacheReadInputTokens,cacheCreationInputTokens}`.
- Their cut is the timestamp of the nearest preceding timestamped line
  (observed in this session's transcript).

**Implementation Steps**

1. **Read the checkpoint.** Read the latest `cost-state` and its cut from the
   parent transcript. It is session-cumulative, including subagents.
2. **Compute amon's side.** Sum imported `claude_code` cost per model for the
   session, with `client_timestamp` at or before the cut.
3. **Report** per model: harness cost, amon cost and their ratio; the models
   missing from amon; and the no-checkpoint case (EV-LEG-03).

**Verification**

- Run: `node --import tsx --test tests/claude-cost-state.test.ts`
- Expect: pass. Each mutation is red: ignore the cut, treat a missing
  checkpoint as 0.

**Test Discovery Verified**

- Planned: matches `tests/*.test.ts`.

**Done When**

- On the live store, the sampled session reports about 0.95 overall, with the
  side-request model listed as missing.

### Task 6: Unhandled record types in the ingestion probe (SC-07)

**Objective**

The ingestion probe names the record types the parsers do not handle.

**Files**

- Modify: `scripts/verify/probe.ts`
  - plus the ingestion probe's module
- Test: `scripts/verify/probe.integration.test.ts`
- Modify: `docs/system/OPERATIONS.md`

**Dependencies**

None

**Assumptions Verified**

- `scripts/verify/probe.integration.test.ts:156-173` already runs the
  `ingestion` probe against fixture homes, with `claudeDir` / `codexHome`
  overrides.

**Implementation Steps**

1. **Declare the handled types.** Export explicit handled-type lists next to
   each parser, with a test that every type a parser branches on is listed.
2. **Tally the rest.** The probe tallies `type`, and `payload.type` for Codex,
   over discovered files and reports the unlisted ones with line counts.
3. **Positive control.** A fixture with an unknown type must be reported; a
   fixture with only handled types reports none.

**Verification**

- Run: `pnpm test:verify` in the worktree.
- Expect: the probe integration test passes. It is red if the probe ignores the
  lists.

**Test Discovery Verified**

- `scripts/verify/probe.integration.test.ts` exists and runs under
  `test:verify` (observed).

**Done When**

- Against the live home, the probe lists the 2026-10-26 unhandled types until
  Tasks 3-5 handle them.

## Risks And Mitigations

- **Codex changes its rollout or OTEL schema mid-workoff.**
  - Signal: the Task 3 differential or the Task 6 probe reports new types or
    mismatches.
  - Mitigation: the gap check fails closed (no row), and the probe names the
    type.
- **The live store changes between preview and apply.**
  - Signal: a digest mismatch.
  - Mitigation: the apply refuses, and the preview runs again.
- **A compaction model differs from its turn's model.**
  - Signal: the import/OTEL ratio for compaction-heavy sessions leaves 0.98–1.02.
  - Mitigation: the row carries `_usage_source: 'compaction'`, so it can be
    repriced by class.
- **Downtime loses hook and OTEL deliveries.**
  - Signal: a gap in hook rows during the apply window.
  - Mitigation: each stop is kept to the apply; file imports backfill usage.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| SC-01 | `node --import tsx --test tests/otel.test.ts` | SSE and websocket fragments store nothing; mutation red |
| SC-02 | `node --import tsx --test tests/prune-codex-fragments.test.ts`, then the rehearsal comparison | zero fragments; non-fragment digests and Monitor cost unchanged |
| SC-03 | `node --import tsx --test tests/codex-import-usage.test.ts` plus the corpus differential | compaction rows only; thread totals equal in every rollout but one |
| SC-04 | `node --import tsx --test tests/codex-usage-repair.test.ts`, then the rehearsal | cost delta accounted to the cent; second apply 0 |
| SC-05 | `node --import tsx --test tests/codex-tool-evidence.test.ts` | paired ids; full equals incremental; counts unchanged |
| SC-06 | `node --import tsx --test tests/claude-cost-state.test.ts` | per-model ratios; missing models named |
| SC-07 | `pnpm test:verify` | planted unknown type reported |

## High-Risk Readiness

### Traceability

| Contract ID | Task | Proof |
| --- | --- | --- |
| SC-01 | Task 1 | `node --import tsx --test tests/otel.test.ts` |
| SC-02 | Task 2 | `node --import tsx --test tests/prune-codex-fragments.test.ts` |
| SC-03 | Task 3 | `node --import tsx --test tests/codex-import-usage.test.ts` |
| SC-04 | Task 3 | `node --import tsx --test tests/codex-usage-repair.test.ts` |
| SC-05 | Task 4 | `node --import tsx --test tests/codex-tool-evidence.test.ts` |
| SC-06 | Task 5 | `node --import tsx --test tests/claude-cost-state.test.ts` |
| SC-07 | Task 6 | `pnpm test:verify` |
| EV-NEG-01 | Task 2 | prune test: neighbouring rows survive |
| EV-NEG-02 | Task 3 | import test: inclusive counter, reset, foreign thread, missing record |
| EV-NEG-03 | Task 0, Tasks 2-3 | prune and repair tests: ownership held → refused, unchanged |
| EV-REC-01 | Task 2 | prune test: stale digest and injected failure leave rows |
| EV-REC-02 | Task 0, Tasks 2-3 | `sqlite3 <backup> 'PRAGMA integrity_check'` plus row counts |
| EV-CON-01 | Tasks 2-3 | second apply reports 0; auto-import between applies converges |
| EV-LEG-01 | Task 3 | import test plus corpus differential: pre-record rollout byte-identical |
| EV-LEG-02 | Task 3 | repair test: missing record named by the thread check |
| EV-LEG-03 | Task 5 | cost-state test: no checkpoint reported, no ratio |

### Capability And Authority Map

| Actor | Allowed | Forbidden | Effective-runtime proof |
| --- | --- | --- | --- |
| Agent as operator | preview anything read-only; apply Tasks 2-4 through the procedure | apply with the service running; touch rows outside the class; delete backups | Task 0 observations; the ownership refusal test |
| Login service | store non-fragment OTEL; auto-import changed rollouts | start while an apply holds ownership | `acquireRuntimeOwnership` raises `RuntimeOwnershipError` (test) |
| Tests | temp databases only | open the install DB | `getDb()` guard under the test runner |

### Side Effects And Failure Windows

| Effect | Before | After | Recovery |
| --- | --- | --- | --- |
| Service stop | Running, healthy | No listener | `amon service restart` |
| Backup | Live DB only | Validated copy in `data/backups/` | Restore by copying it back with the service stopped |
| Fragment prune (one transaction) | Fragments, turns, summaries | None of them; summaries rebuilt | Rollback on failure; restore from the backup |
| Compaction repair (per-session transactions) | Counter rows only | Plus compaction rows | Rerun completes it; restore from the backup |
| Codex forced resync | Messages without receipts | With receipts | Rerun; restore from the backup |
| Compact | Free pages | Reclaimed | Compact takes its own backup first |

### Evidence Lifecycle

| Evidence | Trusted producer | Created | Claim | Consumers | Freshness |
| --- | --- | --- | --- | --- | --- |
| Preview digest | The prune/repair inventory | Step 1 of the procedure | The exact row set to change | The apply | Recomputed inside the apply's transaction |
| Backup validation | `amon database backup` plus `integrity_check` | Step 3 | The pre-apply state is restorable | The rehearsal, recovery | Valid only for the store at stop time |
| Rehearsal report | The apply on a copy | Step 4 | The spec criteria hold | The live apply decision | Void once the live store changes (digest) |

### Consumer Closure

- **Fragment removal.** Consumers: the events row, its projected turn and item,
  the message counts, the trace summary, and the Monitor detail. All are updated
  in one transaction, except the in-process Monitor cache, which a restart
  clears.
- **Compaction rows.** Consumers: the repair report classes, the plain-session
  check, the overlap rule, the projected turn and item (through the existing
  reconcile), and the trace summary. All are covered by the reconcile path that
  SC-05 of the prior repair spec already proves.

### Lifecycle And Compatibility

- **Older rollouts.** Rollouts without records parse byte-identically.
- **Older OTEL.** Stored fragments from before Task 1 are removed by Task 2.
- **Rolling deploy.** The Mac mini's amon is not running. A later `git pull` and
  rebuild there would need the same prune if it ever served data.

### Execution Hooks

- `pnpm build` / `postinstall`: none touch the DB.
- Server startup runs schema migrations and backfills. During an apply the
  service is stopped and ownership is held, so none run mid-apply.

### Capability Stop Gates

- Task 0 proves ownership, backup validity, the service stop without respawn,
  and the restart. Tasks 2-4 stop if any gate fails.

### Readiness Review

- Deterministic validation: passed
- Adversarial critique: complete
- Closure critique: complete
- Blocking findings: none

Critiqued inline on 2026-10-26.

- **Deploy before backup.** Deploying the Task 3 or Task 4 build lets
  auto-import rewrite active sessions before any backup exists → the procedure
  now backs up and rehearses before the deploy, and restarts only after the
  apply.
- **Predicate drift.** The prune predicate could drift from the ingest filter
  → Task 2 imports Task 1's exported predicate, not a copy.
- **Summary rebuild connection.** `maintainSessionTraceSummary` reads through
  `getDb()` → Task 2 runs as an `amon` command on that same connection, so the
  rebuild joins the transaction.

The closure critique re-checked each SC and EV id against a task and a proof
(Traceability). The live-apply order is checked against the Side Effects table.

## Progress

- **Tasks 0-2: done.**
  - Merged in #219 and applied live on 2026-10-26, with the backup
    `data/backups/pre-fragment-prune-2026-10-26.db` taken first.
  - Non-fragment digests and Monitor costs were unchanged, and a second
    preview reported 0.
  - The store was compacted afterwards and shrank by about a third.
- **Task 3: done.**
  - Merged in #220 and applied live on 2026-10-26, with the backup
    `data/backups/pre-compaction-repair-2026-10-26.db` taken first.
  - The live preview matched the rehearsal.
  - The Codex Monitor total moved by exactly the rehearsed amount.
  - A sampled session's Monitor cost now equals its priced
    `token_usage_record` total.
  - Rehearsal moved subagents to the thread-total check (see the spec's
    critique log).
- **Task 5: done in #221.** Missing models are split into those no transcript
  recorded and those the import missed.
- **Task 4: done.**
  - Merged in #222 and applied live on 2026-10-27, with the backup
    `data/backups/pre-codex-resync-2026-10-27.db` taken first.
  - Receipts attach to the call's message, and carry the output's arrival time,
    its size, and a preview under tool-argument capture.
  - The defaults were confirmed on 2026-10-26. No exit code or status is
    stored, because Codex links none to the call (see the spec's critique log).
    Receipts project as `completed` with `outcome: unrecorded`.
  - The live resync matched its rehearsal. No Codex session changed its message
    or human-turn counts. Other sources' messages and every event were
    byte-identical, and Monitor costs were unchanged.
  - Receipts exist only where the rollout is still on disk: about one stored
    Codex call in six has one. Every linked call but one, whose rollout holds no
    output for it, has its receipt.
- **Task 6: done in #223.** The first live probe run reported two Claude types
  the catalog does not list, both backlogged.
