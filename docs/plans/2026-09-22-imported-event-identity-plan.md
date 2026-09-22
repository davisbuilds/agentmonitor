---
date: 2026-09-22
author: claude-opus-5
topic: imported-event-identity
stage: plan
status: in-progress
source: conversation
risk_profile: routine
readiness: ready
---

# Imported Event Identity Plan

## Goal

Imported Claude Code events must be keyed by an identity that cannot collide
between a transcript and its child-agent files, so that child-agent usage is
stored instead of silently discarded, while events already imported under the
positional scheme continue to deduplicate on re-import.

Target accepted in conversation on 2026-09-22, following the per-content-block
billing fix (PR #137). The collision is recorded in
[BACKLOG.md](../project/BACKLOG.md) under "Child-agent transcripts collide with
their parent's event ids".

## Scope

### In Scope

- `event_id` derivation for Claude Code imports, keyed on the producer's
  per-line `uuid` where present.
- A deduplication rule that remains correct against rows already stored under
  the legacy positional scheme.
- Attribution metadata so child-agent events are traceable to their agent file.
- Codex parity: use the producer's `ordinal` instead of a locally computed
  index.
- Recovery documentation for picking up the previously dropped back catalogue.

### Out of Scope

- Rewriting `event_id` on stored rows. No migration is performed; the
  compatibility rule in Task 2 is what makes that unnecessary.
- Splitting child-agent work into its own session identity. Events stay
  attributed to the parent `session_id`; the separate identity question remains
  owned by the "Consistent session identity" backlog item.
- Running `amon costs repair-claude-usage --apply`. Deferred by the user on
  2026-09-22; the inflated historical rows stay as they are for now.
- The remaining findings filed from the 2026-09-22 review.

## Assumptions And Constraints

- **Risk profile is routine, deliberately.** The gate's nearest trigger is
  persisted-state migration, and this plan explicitly performs none: the change
  is single-process, deterministic, locally testable, and reversible from a
  backup. It touches no credential, authority, remote, or concurrency boundary,
  so the high-risk addendum's capability and effective-runtime tables would be
  label-shaped rather than evidence. Choosing the rejected remap option instead
  — rewriting 354,813 stored `event_id` values — would flip this to `high`.
- `uuid` and `ordinal` are undocumented producer fields and may change without
  notice. The derivation therefore keeps the positional scheme as a fallback
  rather than depending on either field being present.
- Import runs single-threaded per file through `runImport`, so the dedupe
  pre-check in Task 2 cannot race a concurrent writer for the same rows.
- Recovering the back catalogue requires `amon import --force`; `import_state`
  already records these files as seen.
- **Tasks 1 and 2 must ship together** (established 2026-09-22 while
  implementing, correcting this plan's original sequencing note). `processFile`
  (`src/import/index.ts:129-172`) fully re-parses any file whose hash changed
  and re-inserts its events, and auto-import runs every
  `autoImportIntervalMinutes` (default 10). Task 1 alone would therefore
  duplicate the entire stored history of every *active* transcript within
  minutes, with no `--force` involved. This was observed directly: landing
  Task 1 turned the legacy-scheme regression test red until Task 2 landed.

## Map Before You Cut

Measured on this host on 2026-09-22 (26 top-level Claude transcripts, 28
child-agent files, ~83.6k lines; 20 Codex rollouts, 34,950 lines):

- **Every billable Claude line carries a unique `uuid`.** 30,094 of 30,094
  usage-bearing lines have one, including all 1,906 in child-agent files, with
  zero reuse anywhere in the corpus. `uuid` is absent on ~32% of lines overall
  (non-billable types), so a fallback is still required.
- **The collision is confined to child-agent files.** Zero `sessionId` values
  are claimed by more than one top-level transcript, so the legacy derivation
  was unambiguous there. Child-agent files embed the parent's `sessionId`, and
  on one measured session 267 of 267 child events collided with parent ids,
  dropping 7.2M tokens.
- **A transcript is named after its session.** All 26 top-level files have
  `basename == sessionId`; 0 of 28 child-agent files do. This is what makes
  legacy-identity ownership decidable per file in Task 2.
- **Stored identity today**: 354,813 `import-cc-` rows, 73,963 `import-cdx-`,
  527,125 NULL (hook/OTEL rows, which never carried ids).
- **Codex supplies `ordinal` on 100% of lines** and the importer never reads it.
- The data path is: `parseClaudeCodeFile` mints `event_id`
  (`src/import/claude-code.ts:158-163`) → `runImport` iterates per file
  (`src/import/index.ts:132`) → `insertEvent` returns early when the id already
  exists (`src/db/queries.ts:446-449`). The early return is why the dropped
  events never reached storage, and why `--force` alone does not recover them.
- `refreshImportedCodexEventModel` (`src/db/queries.ts:86-140`) is the only
  path that updates an existing imported row; it is Codex-only and touches only
  model and derived cost, so it does not interact with this change.

## Task Breakdown

### Task 1: Key Claude imports on the producer's line uuid

**Objective**

Derive `event_id` from the transcript's own `uuid` when present, so parent and
child-agent files cannot mint the same id for the same line number.

**Files**

- Modify: `src/import/claude-code.ts`
- Test: `tests/import.test.ts`

**Dependencies**

None

**Assumptions Verified**

- `src/import/claude-code.ts:158-163` hashes `claude-code:${sessionId}:${i}`,
  where `i` is the line index and `sessionId` falls back to the file basename
  (`:100`). A child-agent file supplies the parent's `sessionId`, so the two
  files produce identical ids for the same `i`.
- The `ClaudeCodeLogLine` interface (`src/import/claude-code.ts:26-49`) does not
  declare `uuid`; the field is present in the data but never read.

**Implementation Steps**

1. Declare `uuid?: string` on `ClaudeCodeLogLine`.
2. When `line.uuid` is a non-empty string, derive the id from
   `claude-code:uuid:${line.uuid}` under a distinct prefix (`import-ccu-`), so
   the scheme in use is legible from the stored value.
3. When `uuid` is absent, keep the positional derivation. For a transcript this
   stays byte-identical to the legacy id, which the Task 2 bridge depends on;
   for a child-agent file key it on the transcript instead of the reported
   session, or uuid-less child lines recreate the original collision.
4. Leave the `message.id` usage-dedupe from PR #137 untouched; it governs which
   line carries usage, not which id the line gets.

**Verification**

- Run: `node --import tsx --test tests/import.test.ts`
- Expect: a new test asserting that a child-agent line and a parent line at the
  same index produce different ids, and that a uuid-bearing line's id is stable
  across two parses.

**Test Discovery Verified**

- `package.json:19` runs `tests/*.test.ts`; `tests/import.test.ts` is an
  existing matched path. Execution is planned after the test exists.

**Done When**

- Parsing the measured parent/child pair yields zero shared `event_id` values
  across the two files, where it currently yields 267 of 267.

### Task 2: Keep already-imported rows deduplicating

**Objective**

A re-import of a transcript whose events were stored under the positional scheme
must not insert a second copy of those events.

**Files**

- Modify: `src/import/index.ts`
- Test: `tests/import.test.ts`

**Dependencies**

Task 1

**Assumptions Verified**

- `src/db/queries.ts:446-449` deduplicates on exact `event_id` only, so an id
  change alone would make every re-imported event look new.
- `src/import/index.ts:132-133` is the per-file branch where `import_state` is
  consulted and `--force` overrides it — the point where a file's events are
  about to be inserted and a pre-check can run once per file.

**Implementation Steps**

1. For each file about to be imported, decide whether it owns the legacy
   identity for its `sessionId`: it does when the file's basename equals the
   `sessionId` its lines report. A transcript is named after its session; a
   child-agent file is named `agent-<id>.jsonl` and reports its parent's
   session, so it never owns that identity.
2. For an owning file, compute each event's legacy positional id alongside its
   new id and skip insertion when a row already exists under the legacy id.
3. For a non-owning file, skip the legacy check entirely, so its events insert
   under their new ids — this is what recovers the dropped child-agent events.
4. Do not change `insertEvent`'s signature or the ingest contract; the
   pre-check lives in the import pipeline.

Ownership is deliberately decided per file rather than by detecting a shared
`sessionId`. An earlier draft of this rule withheld the legacy fallback from any
`sessionId` claimed by more than one discovered file, which would have stripped
it from the *parent* transcript too — every already-imported parent event would
have failed its dedupe check and been re-inserted under a new id. The
basename-ownership test keeps the parent's fallback intact while denying it to
the child.

**Verification**

- Run: `node --import tsx --test tests/import.test.ts`
- Expect: importing a fixture twice inserts its events once; importing a
  fixture whose rows were pre-seeded under legacy ids inserts nothing new; and
  a child-agent file's events insert even though the parent's legacy ids exist.
- Each re-import case must pass `force: true`. Without it `import_state` skips
  the unchanged file and the assertion passes without the dedupe path ever
  running — a green result that proves nothing.

**Test Discovery Verified**

- Same runner and path as Task 1.

**Done When**

- A forced re-import of an already-imported transcript reports zero newly
  inserted events — including when a child-agent file for the same session is
  discoverable — and the child-agent file reports its full event count.

### Task 3: Record child-agent attribution

**Objective**

Child-agent events stay attributed to the parent `session_id` for cost, while
carrying enough evidence to be separated later without a re-import.

**Files**

- Modify: `src/import/claude-code.ts`
- Test: `tests/import.test.ts`

**Dependencies**

Task 1

**Assumptions Verified**

- Child-agent files are named `agent-<id>.jsonl` under a `subagents/` directory
  and their lines carry `isSidechain: true` plus an `agentId` field; the
  importer reads neither (`isSidechain` is read only by the browsing parser at
  `src/parser/claude-code.ts:333`).

**Implementation Steps**

1. When a line is from a child-agent file, record the agent identity in the
   event's metadata (`agent_id`, and the transcript basename) without changing
   `session_id`.
2. Leave `session_id` as the parent's, so cost continues to accrue against the
   conversation that spawned the work.

**Verification**

- Run: `node --import tsx --test tests/import.test.ts`
- Expect: events parsed from a child-agent fixture carry the agent id in
  metadata and the parent's `session_id`.

**Test Discovery Verified**

- Same runner and path as Task 1.

**Done When**

- Every event from a child-agent fixture is attributable to its agent file
  through metadata alone.

### Task 4: Use the producer's ordinal for Codex

**Objective**

Replace the locally computed Codex event index with the producer-supplied
`ordinal`, which is stable against skipped and malformed lines.

**Files**

- Modify: `src/import/codex.ts`
- Test: `tests/import.test.ts`

**Dependencies**

None

**Assumptions Verified**

- `src/import/codex.ts:140,218,252,284,307` derive ids from a local
  `eventIndex` counter, and the file contains no reference to `ordinal`.
- `src/parser/codex-sessions.ts:136-146` likewise computes its own
  `sourceOrdinal`, incrementing on malformed lines and skipping blank ones.
- Every sampled Codex line (34,950 of 34,950) carries `ordinal`.

**Implementation Steps**

1. Read `ordinal` from the rollout line and use it in place of `eventIndex` in
   the id derivation when present, under a distinct prefix.
2. Retain the counter as a fallback for lines without `ordinal`.
3. Apply the Task 2 dedupe rule to Codex ids so existing `import-cdx-` rows
   continue to deduplicate.

**Verification**

- Run: `node --import tsx --test tests/import.test.ts`
- Expect: a rollout fixture with a malformed line in the middle produces ids
  that match the producer's ordinals rather than shifting.

**Test Discovery Verified**

- Same runner and path as Task 1.

**Done When**

- Codex ids follow producer ordinals, and re-importing an existing rollout
  inserts zero new events.

### Task 5: Repair compatibility, documentation, and recovery

**Objective**

Keep the usage-repair tool correct across both id schemes and document the
forced re-import that recovers the back catalogue.

**Files**

- Modify: `src/import/claude-usage-repair.ts`
- Modify: `docs/system/OPERATIONS.md`
- Modify: `docs/project/BACKLOG.md`
- Test: `tests/claude-import-usage-repair.test.ts`

**Dependencies**

Task 1, Task 2

**Assumptions Verified**

- `src/import/claude-usage-repair.ts:78-107` matches stored rows by the id the
  parser mints, so after Task 1 it would stop matching legacy rows unless it
  also computes the legacy id.
- Its existing ambiguity pre-pass reported 284 contested rows on the live store;
  those rows remain legacy-keyed and still need the guard.

**Implementation Steps**

1. Match stored rows on either the new id or the legacy id, keeping the existing
   ambiguity guard for legacy-keyed rows.
2. Document in `OPERATIONS.md` that recovering previously dropped child-agent
   usage requires `amon import --force`, and that totals will rise when it runs.
3. Update the backlog entry to record what shipped and what remains.

**Verification**

- Run: `node --import tsx --test tests/claude-import-usage-repair.test.ts`
- Expect: existing repair tests still pass, plus a case proving a legacy-keyed
  row is still matched after the derivation change.

**Test Discovery Verified**

- `package.json:19` matches `tests/claude-import-usage-repair.test.ts`, which
  already exists and passes.

**Done When**

- Repair matches legacy-keyed rows at the same rate as before the change
  (82,112 matched on the live store, within the drift of any new imports), and
  the recovery procedure is documented.

## Risks And Mitigations

- Risk: the producer stops emitting `uuid`, or emits it non-uniquely, in a
  future Claude Code version.
  Signal: a rise in positional-fallback ids, or a uniqueness assertion failing
  against real transcripts.
  Mitigation: the fallback keeps imports working; add a periodic check that
  counts usage lines whose `uuid` is missing or repeated.
- Risk: the forced re-import needed for recovery is expensive or surfaces
  unrelated drift on a large store.
  Signal: `--force` runtime, and the newly inserted event count, on a copy.
  Mitigation: rehearse against a restored backup before running on the install
  database; the dry-run counts bound the expected insert volume.
- Risk: newly imported child-agent usage is mistaken for a cost regression.
  Signal: totals rise immediately after the forced re-import.
  Mitigation: documented in `OPERATIONS.md` alongside the recovery step, and
  the insert count is reported by the import summary.
- Risk: the producer changes its file-naming convention, so a transcript is no
  longer named after its session and the Task 2 ownership test silently denies
  the legacy fallback to a file that should have it — re-inserting its already
  imported events under new ids.
  Signal: a sharp rise in inserted events on a re-import that should be a
  no-op; measurable by the import summary's insert count before applying.
  Mitigation: Task 2's test pins the no-op case, and the recovery rehearsal in
  Task 5 runs against a restored backup first. If the convention changes, fall
  back to matching on the stored row's own recorded source file.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Parent and child-agent files no longer collide | `node --import tsx --test tests/import.test.ts` | Zero shared ids across the fixture pair; currently 267 of 267 |
| Already-imported events do not duplicate | `node --import tsx --test tests/import.test.ts` | Forced second import of the same fixture inserts 0 events (forced, so `import_state` cannot mask the check) |
| Child-agent events are recoverable | `node --import tsx --test tests/import.test.ts` | Child fixture inserts its full event count despite existing parent legacy ids |
| A parent transcript with a child present still dedupes | `node --import tsx --test tests/import.test.ts` | Forced re-import of the parent inserts 0 events while its child is discoverable |
| Child-agent attribution is preserved | `node --import tsx --test tests/import.test.ts` | Metadata carries the agent id; `session_id` is the parent's |
| Codex ids follow producer ordinals | `node --import tsx --test tests/import.test.ts` | Ids unchanged by a malformed line earlier in the rollout |
| Repair still matches legacy rows | `node --import tsx --test tests/claude-import-usage-repair.test.ts` | Legacy-keyed row matched; ambiguity guard still reports contested rows |
| No regression across the suite | `pnpm lint && pnpm build && pnpm test` | Lint and build clean; full suite passes |
| Recovery volume is bounded before applying | `amon import --source claude-code --dry-run --json` on a restored backup | Reported insert count matches the expected child-agent backlog |

## Handoff

**Tasks 1, 2 and 3 are implemented** on `feat/imported-event-identity` and
verified against the real transcript pair: 0 of 267 child-agent events now
collide with their parent, where previously all 267 did, and every child event
carries its agent attribution. Lint, build and the full suite (951 tests) pass.

**Task 4 (Codex `ordinal`) is deferred to its own PR.** It needs the same legacy
bridge applied to `import-cdx-` ids, which is a separate source and a separate
review surface; nothing in Tasks 1-3 depends on it, and Codex has no observed
collision today.

**Task 5's repair-compatibility step landed early**, in the same PR as Tasks
1-3. Codex review caught that changing the derivation silently broke
`repairClaudeImportUsage`: on the live store it fell from 82,112 matched rows
and 14,690 correctable to 26,590 and 30, reclassifying the rest as having no
transcript. Corrections are now indexed under both ids. The rest of **Task 5
remains open.** The forced re-import is an operator action, deliberately
not automated, and stays deferred until the user chooses to run it — as does
`amon costs repair-claude-usage --apply`. Until that forced re-import runs, the
back catalogue of child-agent usage stays unimported; only newly changed
transcripts pick it up.
