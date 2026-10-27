---
date: 2026-10-27
author: claude
topic: usage-instrument-standardization
stage: plan
status: in-progress
source: conversation
risk_profile: routine
readiness: ready
---

# Usage Instrument Standardization Plan

## Goal

Make Claude and Codex usage follow one model:

- one imported row per API request;
- one rule that decides when OTEL usage is already covered by the import;
- one check of amon's totals against what each harness recorded itself.

This follows the 2026-10-26 ingestion source fidelity workoff
([plan](../archive/plans/2026-10-26-ingestion-source-fidelity-plan.md)), which fixed fidelity
per source but left the instruments asymmetric. The conversation of 2026-10-27
is the contract: a lightweight plan, no separate spec.

## Scope

### In Scope

- Task 1: the Codex import bills from per-request `token_usage_record` lines
  when a rollout carries them from the thread's first request. Otherwise it
  keeps the cumulative counter, unchanged.
- Task 2: the OTEL-vs-import precedence rule covers every source with an
  import instrument (Claude and Codex), and OTEL metric usage records the
  interval it covers.
- Task 3: `amon costs check-sessions` reports each source's harness total beside
  amon's, with the instrument named, and says when a source has none.

### Out of Scope

- Codex browser identity keyed by UUID (backlogged separately).
- Claude OTEL logs and metrics double-counting each other when both are
  exported. Task 2 records it as a backlog hypothesis.
- Antigravity. It has no OTEL export and records no total of its own; Task 3
  reports that rather than inventing an instrument.
- Unifying the two transcript parsers. Their formats really differ, and both
  already emit `ParsedSession`.

## Assumptions And Constraints

- The risk profile is kept `routine` because the user asked for a lightweight
  plan without a spec. Task 1 still rewrites stored rows, so it uses the
  previous workoff's live-apply procedure: stop, back up, rehearse on a copy,
  deploy while stopped, apply, verify, restart.
- Public repository: evidence in this plan, commits and PR bodies is ratios and
  row classes only.
- Pricing tables and pricing logic stay as they are.

## Map Before You Cut

- **Codex import** (`src/import/codex.ts` `parseCodexFile`): today it emits one
  `llm_response` per positive `token_count` delta, keyed
  `codex:<session>:token:<eventIndex>`. It also emits one row per compaction
  request, keyed `codex:<session>:response:<response_id>`, when the counter gap
  proves the counter left that request out.
- **Who stores those rows**: `reconcileCodexImport`
  (`src/import/codex-reconcile.ts`) owns every `import-cdx-` row of a session.
  It deletes the rows the parse no longer emits and inserts the new ones, and it
  is what the importer, the watcher-driven import and
  `costs repair-codex-usage` all call. So an instrument switch reaches stored
  sessions through the existing repair, and new sessions through normal
  import, with no separate migration.
- **Where the overlap rule is applied**:
  - `src/db/usage-reconciliation.ts` defines it;
  - `src/db/queries.ts` and `src/db/v2-queries.ts` consume it;
  - `tests/monitor-token-totals.test.ts` tests it.

  It is hard-coded to `agent_type = 'codex'` and uses
  `COALESCE(client_timestamp, created_at)`.
- **Claude OTEL metric usage**: `parseOtelMetrics` (`src/otel/parser.ts`)
  produces `ParsedMetricDelta`, which `src/api/otel.ts` stores as a synthetic
  `llm_response` with no `client_timestamp`. The rule therefore sees the
  receive time.
- **Existing checks**:
  - Claude: `checkClaudeTranscriptCosts` (`src/import/claude-cost-state.ts`),
    exposed as `costs check-claude-sessions --transcripts`.
  - Codex: only the thread-total check inside `costs repair-codex-usage`, and
    only for the sessions a repair changes.

## Task Breakdown

### Task 1: Codex import bills per request

**Objective**

When a rollout's own-thread `token_usage_record` lines start at the thread's
first request, emit one usage row per record and no counter rows. Rollouts
without such records keep today's counter-plus-compaction path unchanged.

**Files**

- Modify: `src/import/codex.ts`
- Modify: `src/import/codex-usage-repair.ts`
- Test: `tests/codex-import-usage.test.ts`
- Test: `tests/codex-usage-repair.test.ts`
- Docs: `docs/system/ARCHITECTURE.md`, `docs/system/OPERATIONS.md`, `docs/project/BACKLOG.md`

**Dependencies**

None

**Assumptions Verified**

- `src/import/codex.ts` `parseCodexFile` already indexes own-thread records in
  `usageRecords`, and keys compaction rows by `response_id`. A per-request row
  under the same key leaves stored compaction rows with their ids.
- Measured 2026-10-27, read-only over every rollout on disk
  (`records-coverage.py`):
  - every rollout with records starts them at the thread's first request (the
    first record's `usage` equals its `thread_token_usage`);
  - their records sum exactly to the last thread total;
  - that sum is at least the final counter;
  - no response id repeats, and no record names another thread, so a copied
    subagent prefix carries none.

  The rollouts without records predate 0.154.
- `codex-usage-repair.ts` classifies a stored row the parse no longer emits as
  `orphaned` (or `copied_history`), and a new row as `appended` or
  `compaction`. An instrument switch would hide inside those classes, so it
  needs its own.

**Implementation Steps**

1. Choose the instrument per rollout: `request` when the first own-thread
   record's usage equals its thread total, otherwise `counter`.
2. On the `request` path, emit each own-thread record after the subagent
   boundary as an `llm_response`:
   - priced with the model of the latest `turn_context`, at the record's
     timestamp;
   - keyed `codex:<session>:response:<response_id>`;
   - `_usage_source` set to `compaction` when a `compacted` line names it,
     otherwise `request`.

   Counter lines then emit nothing, but still advance `eventIndex` as a copied
   subagent prefix does, so patch ids stay as they are.
3. `session_end` gains `_usage_instrument: 'request' | 'counter'`. Counter
   totals and `total_thread_tokens` stay.
4. The repair adds row class `instrument_switch`: within a session whose parse
   uses `request`, it covers stored rows the parse no longer emits and new
   `request` rows. `orphaned` and `appended` keep meaning what they did, and
   the counter-path fixtures move to a rollout whose records start mid-thread,
   the only shape that still takes that path.
5. Docs:
   - ARCHITECTURE: the Codex usage paragraph.
   - OPERATIONS: the repair's new class and the expected preview shape.
   - BACKLOG: close "Codex requests the import still does not bill" and narrow
     "Long-context tier is chosen per row" to rollouts before 0.154.

**Verification**

- Red first, on behavior:
  - a rollout with records from the start emits exactly one row per record
    (an aborted-turn request included), and none per counter;
  - a rollout whose first record starts mid-thread keeps counter rows;
  - a subagent's copied prefix emits nothing.
- Mutations, each must go red:
  - the from-thread-start check;
  - the own-thread filter;
  - the boundary skip;
  - counter lines no longer advancing `eventIndex` on the request path (patch
    ids must stay put).
- Rehearsal on a backup copy: `costs repair-codex-usage` preview, then
  `--apply`, then a second preview.

**Test Discovery Verified**

- `package.json` `test` runs `tests/*.test.ts`. Both test files exist and run
  under `node --import tsx --test tests/codex-import-usage.test.ts`.

**Done When**

- In the rehearsal and the live apply, the changed rows are
  `instrument_switch`, plus `annotated` for each `session_end` that gains
  `_usage_instrument` and any `repriced` from per-request tiers, with
  `orphaned`, `appended` and `unclassified` at zero. `counter_mismatches` stays
  empty, and a second preview changes nothing.
- Every rollout on the `request` path has imported tokens equal to Codex's
  thread total, including the aborted-turn session the old path left short.
- Claude and Antigravity Monitor costs are unchanged, to the cent. The Codex
  total moves by no more than the newly billed requests plus the per-request
  repricing, and the PR states which.

### Task 2: One OTEL precedence rule

**Objective**

An OTEL usage row from any source with an import instrument (Claude, Codex) is
left out of usage rollups when the session's import has usage at or after the
start of the interval that row covers.

**Files**

- Modify: `src/db/usage-reconciliation.ts`
- Modify: `src/db/queries.ts`, `src/db/v2-queries.ts` (rename of the consumed condition)
- Modify: `src/otel/parser.ts`, `src/api/otel.ts`
- Test: `tests/monitor-token-totals.test.ts`, `tests/otel.test.ts`
- Docs: `docs/system/ARCHITECTURE.md` (Usage, Pricing, And Analytics), `docs/project/BACKLOG.md`

**Dependencies**

None

**Assumptions Verified**

- Observed 2026-10-27 on a scratch DB with the built server: one Claude
  transcript request, plus the matching `claude_code.cost.usage` point for the
  same session, made both `/api/v2/monitor/stats?agent=claude_code` and Usage
  report twice the request's cost.
- `src/api/otel.ts` stores metric usage without `client_timestamp`, so a point
  exported after the session's last transcript row would escape a
  timestamp-only rule.

**Implementation Steps**

1. `ParsedMetricDelta` gains `client_timestamp` (the point's `timeUnixNano`)
   and `covers_from`:
   - for a delta point, its `startTimeUnixNano`;
   - for a cumulative point, the previous point's time in the same series, or
     the series start for its first point.
2. `src/api/otel.ts` stores both: `client_timestamp`, and
   `metadata._covers_from`.
3. `overlappingOtelUsageCondition(alias)` replaces the Codex-only condition:
   - `agent_type IN ('codex', 'claude_code')`;
   - an import usage row of the same session and agent exists at or after
     `COALESCE(_covers_from, client_timestamp, created_at)`.

   Codex OTEL rows carry no `_covers_from`, so their behavior is unchanged.
4. Rename every consumer, and update the comments that say "Codex".
5. BACKLOG: add a hypothesis entry, "Claude OTEL logs and metrics may
   double-count each other when both carry cost", with how to test it.

**Verification**

- Red first, on behavior:
  - Claude import plus a covering metric point counts once;
  - a point whose interval starts after the last imported request still counts
    (live tail);
  - a point exported after the last request, but whose interval started before
    it, is covered.
- Mutations: drop `claude_code` from the agent list; ignore `_covers_from`.
- The existing Codex overlap tests pass unchanged.
- `verify probe hotspots` before and after, on the built server: the Monitor
  stats read does not regress beyond noise.

**Test Discovery Verified**

- Both test files are in `tests/*.test.ts`.

**Done When**

- The scratch-DB experiment above reports the request's cost once.
- Live Monitor costs are unchanged for every agent: the stored Claude OTEL rows
  carry no cost, and the Codex semantics are untouched.

### Task 3: One harness-total check

**Objective**

`amon costs check-sessions [--source claude|codex|antigravity|all] [--limit <n>]`
reports, per recent session:

- the harness's own total and amon's;
- the instrument and its unit;
- a status.

Codex is checked against its thread total in tokens, Claude against
`cost-state` in dollars. Antigravity is reported as having no instrument.

**Files**

- Create: `src/import/session-total-check.ts`
- Modify: `src/import/claude-cost-state.ts` (reuse; no behavior change)
- Modify: `src/db/queries.ts` (the stored Codex import token sum per session)
- Modify: `src/cli/commands/maintenance.ts`
- Test: `tests/session-total-check.test.ts`
- Docs: `docs/system/OPERATIONS.md`

**Dependencies**

Task 1, which changes what a Codex match means: after the switch, a mismatch is
drift between stored rows and the rollout.

**Assumptions Verified**

- `checkClaudeTranscriptCosts` returns per-session checks with `status`,
  `harness_cost_usd`, `amon_cost_usd` and `ratio`.
- The thread-total comparison in `codex-usage-repair.ts` uses imported
  `tokens_in + tokens_out + cache_read + cache_write` against thread
  `input + output`.

**Implementation Steps**

1. Codex check: take recent rollouts by mtime and read the last own-thread
   record's thread total. Compare it with the stored import token sum for the
   session. The statuses are:
   - `checked`;
   - `no_thread_total` (before 0.154);
   - `not_imported`.
2. Claude check: map `checkClaudeTranscriptCosts` into the shared row shape.
   Keep its per-model detail under `detail`.
3. Antigravity: one source-level row, `no_instrument`.
4. The JSON report carries a per-source summary (`checked`, `matched`,
   `median_ratio`) and the rows. The text output is one line per session.
5. `costs check-claude-sessions --transcripts` keeps working, and its help
   points to the new command.

**Verification**

- Red first:
  - a Codex session whose stored rows fall short of its thread total reports a
    ratio below 1 and a status of `checked`;
  - a rollout before 0.154 reports `no_thread_total`;
  - Antigravity reports `no_instrument`.
- Mutation: compare against the counter instead of the thread total.
- Live, read-only: every recent Codex session on the `request` path has
  ratio 1. The Claude rows match `check-claude-sessions --transcripts`.

**Test Discovery Verified**

- `tests/session-total-check.test.ts` falls under `tests/*.test.ts`.

**Done When**

- One command answers "does amon agree with the harness" for every source, and
  names the source that cannot be checked.

## Risks And Mitigations

- Risk: a later Codex version writes records that do not start at the thread's
  first request, for example when it resumes an older session.
  Signal: `_usage_instrument: 'counter'` on a 0.154+ rollout.
  Mitigation: the counter path is kept unchanged, and the Task 3 check reports
  the session's ratio.
- Risk: Claude Code changes its metric temporality or start times.
  Signal: Task 3 Claude ratios rise above 1 on sessions with OTEL usage.
  Mitigation: the rule falls back to the point time. The tests pin both
  temporalities.
- Risk: the rule's `json_extract` slows the Monitor read.
  Signal: `verify probe hotspots` regression.
  Mitigation: evaluate it only for OTEL rows, or store `covers_from` in
  `client_timestamp`-adjacent form if needed.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Codex per-request rows | `node --import tsx --test tests/codex-import-usage.test.ts` | pass; mutations red |
| Repair names the switch | `amon costs repair-codex-usage --json` on a rehearsal copy | only `instrument_switch`/`repriced` rows; empty `counter_mismatches`; second preview 0 |
| One precedence rule | `node --import tsx --test tests/monitor-token-totals.test.ts tests/otel.test.ts` | pass; mutations red |
| No Claude double count | scratch-DB experiment with the built server | the request's cost once |
| One check | `amon costs check-sessions --source all --json` | per-source summary; Codex ratio 1 on the request path |
| Gates | `pnpm lint && pnpm build && pnpm test`, Playwright, `pnpm verify:skill-context-built`, `pnpm test:verify` | all pass |

## Progress

- **Task 1: implemented, not yet merged or applied.**
  - The rehearsal on a backup copy changed only `instrument_switch` rows plus
    one `annotated` `session_end` per rollout. `orphaned`, `appended` and
    `unclassified` were 0, no session mismatched its thread total, and a
    second preview changed nothing.
  - Against the live store, every switched session but one kept identical
    tokens and identical cost, so per-request pricing moved nothing. The one
    that changed gained the aborted-turn request the counter had missed.
  - Claude and Antigravity Monitor costs were unchanged. The Codex Monitor
    moved by that request's cost, because newly covered OTEL rows offset the
    rest of the import change.
  - Mutations: every new guard goes red. The copied-prefix `!inherited` guard
    from the compaction work survives, because a copied prefix carries the
    parent's thread id and the own-thread filter already excludes it.
