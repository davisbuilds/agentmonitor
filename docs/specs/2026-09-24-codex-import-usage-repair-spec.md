---
date: 2026-09-24
author: claude
topic: codex-import-usage-repair
stage: spec
status: draft
source: conversation
risk_profile: high
readiness: ready
---

# Codex Import Usage Repair Spec

## Problem

Imported Codex usage is the Monitor's Codex cost. Where a Codex OTEL row has an
import counterpart, the Monitor drops the OTEL row, so a Codex import error
passes straight through to the Monitor figure. Two defects inflate that figure.
Neither is visible without an independent instrument.

1. **Copied parent history.** A `thread_spawn` subagent rollout can begin with a
   copy of its parent's history, token counters included. Those counters are
   byte-identical to the parent's. The importer bills every one of them again,
   once per child. On this corpus, the copied prefix is 25–295 counters in 10 of
   47 subagent rollouts. For those sessions the imported tokens are 140–810× what
   Codex's own per-request OTEL reports. A copied prefix can also hold the
   parent's file edits, which are then counted again as the child's.
2. **Rewritten rollouts drift.** Codex rewrites some rollouts after the fact.
   Import row ids are derived from each counter's position. A re-import therefore
   inserts only ids it has not seen and refreshes model and cost on ids it has,
   while keeping each row's old tokens. The result:
   - Orphan rows survive in about 1 in 8 Codex sessions (usage and file-change rows).
   - Surviving rows carry a cost that no longer matches their tokens.

Measured 2026-09-24 against the local corpus and database. The detector's own
known positives were confirmed first. On this corpus, the correction removes
roughly 45% of stored Codex import cost.

## Contract

When this ships, the following hold:
- Every Codex session's imported rows equal what the current parser derives
  from that session's rollout file.
- A subagent's copied history contributes no events.
- A dry-run-first repair brings existing databases to that state without
  touching any other producer's rows.

Verified by `node --import tsx --test tests/codex-import-usage.test.ts tests/codex-usage-repair.test.ts`,
plus a rehearsal on a backup copy that must meet SC-06 and SC-07 before the
live database is changed.

## Success Criteria

- **SC-01 Copied history is not the child's activity.** In a `thread_spawn`
  rollout, nothing before the first `turn_context` whose turn id was issued at or
  after the rollout's own session id produces an event: no usage row and no
  file-change row. The session's start row still comes from its first
  `session_meta`. The first counter at or after that line is measured from the
  last skipped counter, or from zero when none was skipped. Non-subagent rollouts
  parse exactly as before.
- **SC-02 A child's own earlier usage is still usage.** A compacted subagent
  whose first counter follows its own turn, including one whose
  `last_token_usage` is zero, keeps billing that counter's cumulative total. A
  "total minus last request" baseline would drop real usage: on the measured
  files it moves imported tokens from 0.93–0.95× of OTEL to 0.13–0.18×.
- **SC-03 The rollout owns its session's import rows.** After a Codex file is
  imported, the set of `import-cdx-` rows for its session equals the parser's
  output for that file on these fields:
  - event id, event type, tokens, cache tokens, model, cost and timestamp.
  Consequences:
  - The parse is deduplicated by id first, and the first occurrence wins. That
    matches what insertion keeps today, since newer rollouts repeat
    `session_meta`.
  - A row whose id the parse no longer produces is removed.
  - A row with the same id keeps its row identity and `created_at`, and takes
    the parse's values.
  - An unchanged file rewrites nothing.
  - The file's recorded import hash is the hash of the content that was applied,
    so content that changes during a run is reconciled on the next import rather
    than skipped.
- **SC-04 Repair is previewed, then applied per session.**
  - `amon costs repair-codex-usage` writes nothing. It reports how many sessions
    and rows it would insert, update and delete, plus the token and cost change.
  - With `--apply`, each session changes inside one transaction.
  - A second apply reports zero changes.
- **SC-05 Derived state follows the rows.** After a session's rows change:
  - its trace summary cost matches its events;
  - its Codex summary projection holds exactly one turn and one item per
    remaining event, an updated row's item carries the row's new tokens and cost,
    and the projected message counts equal those items;
  - the Monitor cache lives inside the server process, so a separate CLI process
    cannot clear it. The server shows the repaired totals once it restarts.
- **SC-06 Fidelity against an independent instrument.** Codex OTEL reports each
  request directly, so it can check the import. For every repaired subagent
  session with OTEL coverage and no OTEL gap, the ratio of imported to OTEL
  tokens lies within 0.95–1.02 (measured: 0.976–0.994). The repair moves no
  OTEL-covered session's ratio further from 1. An OTEL gap is any hour in which
  the rollout records usage and OTEL records none.
- **SC-07 The Monitor moves by exactly the import change.** On the rehearsal copy,
  the change in the Codex Monitor total (`/api/v2/monitor/stats?agent=codex`)
  equals the change in summed Codex import cost to the cent. Other agents'
  totals do not change. The one allowed exception is a session left with no
  import usage at all, whose OTEL rows then count again; every such session is
  named in the report, and none is expected on the current corpus.
  - This shows that the OTEL overlap rule still excludes the same OTEL rows.
  - Every changed session falls into one of the measured classes:
    thread_spawn copied-prefix, orphan rows, or drifted rows. A single
    unclassified change fails the rehearsal.

## Evaluation

- **Differential over the real corpus.** This is a read-only script, never a
  test. Parse every local rollout with the old and new parser.
  - Every non-subagent file yields identical events.
  - Every changed file is a `thread_spawn` rollout. Its removed counters are
    exact copies of counters in its parent's rollout, and its removed file
    changes lie before the boundary.
- **Fixtures** are built from the measured shapes, with synthetic content:
  - full copied prefix;
  - compacted child whose first counter reports no request of its own;
  - child whose first counter follows its own tool call;
  - a duplicate counter just after the boundary;
  - a plain session;
  - a rewritten file that is shorter than its previous import.
- **Instrument controls.** Each detector must first see a known positive. The
  copy detector must find the parent-matched prefix in a copied-prefix fixture,
  and the orphan detector must find the rows left by a shortened re-import.
- **Mutation.** Each guard is reintroduced and must go red. That covers:
  - billing from zero before the boundary;
  - reseeding from "total minus last";
  - skipping the orphan delete;
  - updating cost without tokens;
  - replacing `created_at` on a surviving id.

## Scope

### In Scope

- The Codex importer's event derivation (usage and file changes) for
  `thread_spawn` rollouts.
- Making the re-import of a changed Codex file reconcile the session's import
  rows, whether triggered by auto-import, `amon import`, or `--force`.
- A preview-first repair command for existing databases, with its derived-state
  updates.
- The operator procedure, including a backup and a rehearsal on a copy, in
  OPERATIONS.

### Out of Scope

- **Long-context tier selection for spans of several requests.** Pricing picks a
  tier from the size of a row's token change. After SC-01, that affects only
  the rare rows spanning more than one request, about half of 1% of the
  correction. Backlog entry.
- **Requests OTEL sees but the rollout never records.** OTEL shows a constant
  small excess per session. Backlog entry.
- **Copied history in the transcript browser and skill or tool analytics.** That
  surface is not cost. It stays a backlog hypothesis until measured.
- **Unpriced models such as `gpt-5.4-mini`.** Tracked with the unpriced-model
  bounty item.
- **Codex OTEL, Claude, Antigravity and benchmark rows.** The repair never
  touches them.

## Assumptions And Constraints

- Codex turn ids are UUIDv7, and their leading 48 bits are the issue time. This
  was verified for every `thread_spawn` rollout in the corpus: all have turn
  ids, and all have a boundary. If a future rollout has none, the rule falls back
  to today's billing and the repair reports the session as
  `boundary_unresolved`. It does not guess.
- The copied lines are re-stamped with the spawn time, so timestamps cannot mark
  the boundary.
- The Codex import rows are the only producer of `import-cdx-` ids, and those ids
  are unique to a session. There are no foreign keys to `events`.
- The public repo takes ratios and row classes only. It never takes absolute
  spend.

## Authority And Safety

- **Actors.**
  - The operator runs the repair and may pass `--apply`, but only after a
    verified backup, a rehearsal on a copy that meets SC-06 and SC-07, and with
    the server stopped.
  - The server's auto-import and `amon import` reconcile only files whose
    content hash changed.
  - No actor may change rows whose id does not start with `import-cdx-`, whose
    `source` is not `import`, or whose agent is not `codex`.
- **Evidence.** A session's rows may be changed only from that session's rollout
  file, read in the same run.
  - A session with no rollout on disk is reported and left untouched. Missing
    history is not evidence.
  - A file whose parse fails, or yields no `session_meta` id, is skipped and
    reported. It never empties a session.
- **Atomicity.** Each session's replacement and its derived-state updates commit
  or roll back together, so a crash leaves every session wholly old or wholly
  new. Rerunning finishes the rest, because the operation is a set equality, not
  a sequence of increments.
- **Concurrency.** Auto-import and the repair apply the same reconciliation. If
  they interleave, the final state is the same whichever commits last. Contention
  waits on SQLite's busy timeout; it never partially writes.

## Evaluation Scenarios

- **EV-NEG-01:** a repair over a database holding Codex OTEL, Claude, benchmark
  and API rows for the same session ids changes none of them.
- **EV-NEG-02:** a session whose rollout is missing, or whose file fails to
  parse, keeps every row, and is counted in the report.
- **EV-REC-01:** a failure injected after one session's delete and before its
  insert leaves that session exactly as before. Rerunning then completes it.
- **EV-CON-01:** running the repair twice, or running auto-import between two
  applies, leaves the same rows as a single apply, and the second apply reports
  zero changes.
- **EV-CON-02:** a rollout appended between the repair's read and its commit ends
  up, after the next import, with rows equal to the appended content. No row
  stays lost because an import hash claimed content that was never applied.
- **EV-LEG-01:** rows stored by an older parser, under ids the new parse no
  longer produces and with no cost provenance, are replaced. The new rows are
  labelled `estimated`.
- **EV-LEG-02:** a rollout with no turn ids is billed as today and reported as
  `boundary_unresolved`.

## Open Questions

- None.

## Readiness Review

- Deterministic validation: passed
- Adversarial critique: complete
- Closure critique: complete
- Blocking findings: none

### Critique Log

Critiqued inline on 2026-09-24, because spawning a critic was not authorized.
Each adversarial finding was checked against code or data, and its fix is in
the section named:

- Copied prefixes also carry file edits (measured) → SC-01.
- Newer rollouts repeat `session_meta`, so one parse can hold duplicate ids
  (measured: `session_start` only) → SC-03.
- A rollout appended during a repair could be lost, because the import hash
  would claim content that was never applied → SC-03 and EV-CON-02.
- The Monitor cache lives inside the server process, so a CLI cannot clear it
  → SC-05, and `--apply` runs with the server stopped.
- The summary projection makes one turn and one item per event, and an update
  does not refresh an existing item's payload → SC-05.
- A session left with no import usage re-exposes its OTEL rows → SC-07.

The closure critique tightened the Contract and Scope wording to "events", and
replaced SC-07's share-of-change bound with "no unclassified change".
