---
date: 2026-10-26
author: claude
topic: ingestion-source-fidelity
stage: spec
status: draft
source: conversation
risk_profile: high
readiness: ready
---

# Ingestion Source Fidelity Spec

## Problem

A 2026-10-26 audit compared what each harness writes with what amon stores.
Claude, Codex and Antigravity were all checked. The findings are measured on the
live store and the local source files, and recorded here as ratios and row
classes.

- **Codex OTEL fragments.** Since 2026-08-18 Codex has exported its streaming
  lifecycle as `codex.sse_event` records. The parser drops those fragments only
  for the older `codex.websocket_event` transport. On the SSE transport, every
  delta and lifecycle marker is stored as a `response` event with no content,
  usage or error. Each one also gets a projected turn. These rows are:
  - about four fifths of stored Codex OTEL rows;
  - about half of all stored events;
  - about two thirds of all projected turns.

  They inflate the Monitor session view's event count, crowd out its recent
  events list, and count as trace "generation" observations.
- **Codex compaction usage.** The import bills Codex usage from the cumulative
  `token_count` counter. That counter leaves out compaction requests.
  - Since Codex 0.154 each rollout also writes a `token_usage_record` per API
    request. Each `compacted` line names its request by
    `compaction_response_id`.
  - On the local corpus, the counter plus the compaction records equals Codex's
    own thread total exactly in all but one rollout.
  - Compactions were about 3% of 30-day Codex cost.
  - The Monitor shows the import figure, because the overlap rule prefers the
    import over OTEL, so the gap reaches the Monitor.
- **Codex tool evidence.** The rollout parser keeps tool calls but drops their
  outputs and native call ids. Every call in the sampled rollout pairs with its
  output by `call_id`.
- **Claude cost reference.** Claude transcripts now carry `cost-state`: Claude
  Code's own per-model totals, written when a process exits or resumes. Against
  one session's latest checkpoint:
  - imported cost read about 0.95 of the harness's figure;
  - the side-request model read 0;
  - uncached input was mostly missing.

  amon does not read the record.
- **Format drift.** All of the above surfaced only by hand. No detector reports
  record types the parsers do not handle.

## Contract

When this ships:
- amon stores no content-free Codex stream fragments and holds none from before.
- Codex compaction requests are billed once.
- Rollout-parsed Codex tool calls carry their call id and a result receipt.
- Claude sessions can be checked per model against Claude Code's own totals.
- The ingestion probe names unhandled record types.

Each persisted change reaches the live store only through a preview, a validated
backup, a rehearsal on a copy, and an apply with the server stopped.

Verified by `pnpm test`, and by `pnpm --silent verify probe ingestion --json`
naming a planted unknown record type. For SC-02 and SC-04, the apply is also
proven by rehearsal reports that meet the criteria below on a backup copy.

## Success Criteria

- **SC-01 Stream fragments are not events.** On both Codex transports
  (`codex.sse_event`, `codex.websocket_event`), a record whose event kind is a
  streaming fragment stores nothing: no event, turn, item or live session. The
  fragment kinds are:
  - any `response.*.delta`;
  - `response.created`, `response.in_progress` and `response.metadata`;
  - the `.added` / `.done` lifecycle markers of output items, content parts,
    output text, function-call arguments and custom tool-call input;
  - `responsesapi.websocket_timing`.

  Other records map as before:
  - `response.completed` still yields an `llm_response` with its usage;
  - `response.failed` or a transport failure still yields an `error`;
  - every other `response.*` kind (for example `response.compaction.compacting`)
    is still stored.
- **SC-02 Stored fragments are removed with their derived state.** After the
  cleanup:
  - no stored Codex OTEL row both matches the fragment predicate above and has metadata
    with exactly the keys `otel_event_name` and `event_kind`;
  - each removed row's projected turn and item, keyed by the row's event id, is
    gone;
  - each affected session's trace summary is rebuilt in the same transaction
    as the delete;
  - every other row of `events`, `session_turns` and `session_items` is
    unchanged (counts and a content digest per class, before and after);
  - the Monitor's per-agent cost totals are unchanged to the cent.
- **SC-03 Compaction requests are billed once.**
  - A rollout's import emits one usage row for each `compacted` line when all
    of the following hold:
    - its `compaction_response_id` names a `token_usage_record` of the
      rollout's own thread, past any subagent boundary;
    - the counter's gap to that record's thread total grew by exactly the
      record's usage.
  - The row prices that request's usage at the model of the turn it is in.
  - No existing import row changes its id. The positional derivation stays as
    pinned.
  - Per rollout whose compactions all have records, imported input, cached and
    output tokens equal Codex's final `thread_token_usage`.
- **SC-04 The repair brings stored sessions to compaction billing.**
  - `amon costs repair-codex-usage`:
    - classifies the new rows as `compaction`;
    - for every changed plain session holding usage records, checks the result
      against Codex's thread total, not the cumulative counter;
    - names each session it cannot reconcile.
  - On the rehearsal copy:
    - the Codex Monitor total changes by exactly the inserted rows' cost, less
      the cost of OTEL rows newly covered by the overlap rule, to the cent;
    - every newly covered OTEL row lies after its session's previous last
      import usage row, and no later than the new last one. This happens only
      when a compaction becomes the session's latest import usage row;
    - no OTEL row is re-exposed;
    - other agents' totals are unchanged;
    - a second apply reports zero changes.
- **SC-05 Codex tool calls carry their evidence.** In the session browser and
  live view, a rollout-parsed Codex tool call carries its native call id. Where
  the rollout records an output, the call has a result receipt carrying:
  - success or failure;
  - the exit code and duration, where Codex recorded them;
  - an output preview, bounded in size, only when the live capture policy
    allows tool output.

  Further constraints:
  - Human-turn, message-role and usage counts are unchanged.
  - A full parse and an incremental parse of the same file store identical
    messages.
  - The projection's per-capability levels change only where that capability is
    earned.
  - The session's `fidelity` stays `summary` while reasoning content is absent.
- **SC-06 Claude sessions check per model against `cost-state`.** For each
  session whose transcript holds a `cost-state` record, a read-only check
  reports per model:
  - Claude Code's cost and tokens at the latest checkpoint;
  - amon's imported cost for the same session up to that checkpoint;
  - their ratio;
  - every model the harness billed that amon holds no rows for.
- **SC-07 Unhandled record types are reported.** The ingestion probe reports,
  per source (Claude transcripts, Codex rollouts), each record type the parsers
  do not handle and how many lines carry it. Known types are listed explicitly;
  nothing is inferred from a type's name.

## Evaluation

- **Differential over the local corpus.** This is read-only, never a test.
  - Every rollout without `token_usage_record` lines parses byte-identically
    before and after SC-03.
  - Every rollout with them differs only by the compaction rows.
  - Imported tokens equal the thread total wherever every compaction has a
    record. Measured 2026-10-26: 20 of 21 rollouts are exact. The other has
    three compactions without a record and is reported, not guessed.
- **Fixtures** are synthetic and built from the measured shapes:
  - fragments of every kind on both transports;
  - fragment-like rows with extra metadata;
  - `response.completed` and `response.compaction.compacting` rows;
  - a rollout whose counter already includes a compaction;
  - a compaction whose record is missing or belongs to another thread;
  - a subagent rollout with a copied prefix;
  - a Claude transcript with and without `cost-state`;
  - a transcript and rollout with an unknown record type.
- **Mutation.** Each guard is reintroduced and must go red:
  - the SSE transport left out of the filter;
  - the cleanup without its metadata-key guard;
  - compaction rows emitted without the gap check;
  - a compaction row advancing the positional event index;
  - the repair check left on the counter;
  - receipts emitted when capture is off;
  - the probe treating any known type as unknown.

## Scope

### In Scope

- The Codex OTEL fragment filter, and the one-off cleanup of stored fragments
  with their derived turns, items and trace summaries.
- Compaction billing in the Codex import, and its repair through the existing
  repair command.
- Codex rollout call ids and result receipts in the session browser and live
  projection, and a forced resync to apply them.
- A per-model Claude `cost-state` check.
- An unhandled-record-type report in the ingestion probe.
- Backlog, architecture, features and operations updates for each.

### Out of Scope

- **Keying Codex browser rows by session UUID instead of the rollout basename.**
  This is a backlog entry; it is a separate identity migration.
- **Projected turns for Codex OTEL events that carry no item.** Fragments are
  removed; the remaining item-less turns are left and recorded in the backlog.
- **Claude OTEL ingestion and the OTLP traces route.** These are existing backlog
  entries.
- **Antigravity.** No local telemetry exporter exists (measured 2026-10-26), and
  step payloads remain undecoded.
- **Reasoning content for Codex.** It is encrypted unless Codex reasoning
  summaries are enabled.

## Assumptions And Constraints

- Stored fragment rows carry only `otel_event_name` and `event_kind` in their
  metadata, and no usage or error. This was measured across every stored kind on
  2026-10-26. A row with any other key is not a fragment, by definition.
- The Codex import rows are the only `import-cdx-` producer. Compaction rows take
  ids derived from the session id and the request's `response_id`, so they never
  collide with positional ids.
- The prior repair contract still holds for everything it governs: rollout
  ownership, per-session transactions, and derived-state updates. See
  `docs/archive/specs/2026-09-24-codex-import-usage-repair-spec.md`.
- While the login service is stopped for an apply, hook and OTEL deliveries are
  refused and lost. Session-file imports backfill usage and transcripts, but not
  hook-only events. Each stop is kept to the apply itself.
- The public repository takes ratios and row classes only.
- `data/backups/pre-claude-repair-2026-09-27.db` is kept. New backups are deleted
  only with the user's approval.

## Authority And Safety

- **Actors.**
  - The operator (here the agent, under the user's 2026-10-26 approval) may apply
    the fragment cleanup and the usage repair to the live store. Each apply
    requires:
    - a preview whose digest is passed to the apply;
    - a backup made by `amon database backup` and validated;
    - a rehearsal on a copy that meets SC-02 or SC-04;
    - the login service stopped.
  - The server stops storing fragments once its build carries SC-01. Its
    auto-import reconciles only rollouts whose content changed.
- **Forbidden.**
  - No apply may change a row outside its class:
    - the cleanup touches only Codex OTEL rows that match the SC-01 predicate
      and the exact metadata keys, plus the projected turns and items keyed by
      their ids;
    - the repair touches only `import-cdx-` rows.
  - No apply runs while another process holds the database's runtime
    ownership. An apply takes that ownership itself, so a server cannot start
    mid-apply. This guards against a second writer, and against the in-process
    Monitor cache showing stale totals.
- **Evidence freshness.** An apply recomputes its inventory inside its
  transaction. When the inventory's digest differs from the preview's, it changes
  nothing and asks for a new preview.
- **Recovery.**
  - Each apply is one transaction per unit (the whole cleanup, or one repair
    session), so a crash leaves each unit wholly old or wholly new.
  - The validated backup restores the pre-apply store. The rehearsal copy proves
    that the backup opens, and holds the expected counts, before the live apply.

## Evaluation Scenarios

- **EV-NEG-01:** a cleanup over a store whose fragment sessions also hold the
  following leaves all of them unchanged:
  - `response.completed` rows;
  - `response.compaction.compacting` rows;
  - fragment-kind rows with extra metadata;
  - Codex import rows;
  - Claude rows.
- **EV-NEG-02:** a rollout produces no compaction row in any of these cases:
  - its counter already includes the compaction;
  - its counter resets between the record and the next counter (the gap check
    fails closed);
  - the named record belongs to another thread, or lies before the subagent
    boundary;
  - no record has the named `response_id`.
- **EV-NEG-03:** the cleanup or repair apply refuses while the runtime lock is
  held, and the store is unchanged.
- **EV-REC-01:** an apply given a stale digest changes nothing. A failure
  injected mid-cleanup leaves every row as before.
- **EV-REC-02:** the backup taken before the live apply passes its validation,
  and holds the pre-apply row counts.
- **EV-CON-01:**
  - a second cleanup apply removes zero rows;
  - a second repair apply reports zero changes;
  - an auto-import between two repair applies leaves the same rows as one
    apply.
- **EV-LEG-01:** a rollout written before `token_usage_record` existed parses
  byte-identically to the current parser.
- **EV-LEG-02:** a compaction with no record yields no row, and the repair's
  thread-total check names the session.
- **EV-LEG-03:** a Claude transcript without `cost-state` is reported as having
  no checkpoint. It is never given a ratio.

## Open Questions

- None blocking. SC-05's receipt placement leaves existing ordinals unchanged,
  either by attaching to the call's message or by stable ids. That choice is made
  in the plan task, and is proven by the full-vs-incremental equality. No pins
  exist on Codex sessions today (measured 2026-10-26).

## Readiness Review

- Deterministic validation: passed
- Adversarial critique: complete
- Closure critique: complete
- Blocking findings: none

### Critique Log

Critiqued inline on 2026-10-26, because spawning a critic was not authorized.
Each finding was checked against code or data, and its fix is in the section
named.

- **Crash window.** A crash between the fragment delete and the summary rebuild
  would leave summaries counting removed rows → SC-02 now rebuilds them in the
  same transaction.
- **Monitor accounting.** The overlap rule excludes OTEL rows at or before a
  session's latest import usage row. A compaction that becomes the latest row
  newly covers its own OTEL counterpart, so "rises by exactly the inserted
  cost" could fail on a correct repair → SC-04 accounts for newly covered rows
  and bounds where they may lie.
- **Counter resets.** A reset between a record and the next counter makes the
  gap meaningless → EV-NEG-02 fails closed.
- **No lock check.** The existing repair command relies on the operator
  stopping the server and does not check ownership → Authority And Safety
  requires each apply to take runtime ownership, and EV-NEG-03 covers it.
- **Downtime loss.** Hook and OTEL deliveries are lost while the service is
  stopped → recorded under Assumptions And Constraints.

The closure critique re-read the revised contract against the audit's goal.
Each finding maps to one criterion. Both persisted changes keep a preview,
backup, rehearsal and lock gate. Nothing in scope depends on the out-of-scope
identity migration.
