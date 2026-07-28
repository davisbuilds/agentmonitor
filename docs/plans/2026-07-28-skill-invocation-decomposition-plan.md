---
date: 2026-07-28
author: codex-gpt-5
topic: skill-invocation-decomposition
stage: plan
status: draft
source: conversation
risk_profile: routine
readiness: ready
---

# Skill Consultation and Harness Context Telemetry Plan

## Goal

Implement
`docs/specs/2026-07-27-skill-invocation-decomposition-spec.md` as a
reconcilable local evidence plane: preserve ordered runtime observations,
decompose every already-detected skill invocation, expose honest eligibility
and cross-harness coverage, retain per-session catalog and instruction evidence,
and compare presentation only with an immutable occurrence-valid expected
realization.

## Scope

### In Scope

- Ordered Claude Code and Codex transcript projections for skill consultations,
  compaction boundaries, Codex catalog presentations, and observable instruction
  loads.
- A stable project identity derived only from a session-reported working
  directory, with an explicit `unknown` bucket.
- A shared invocation ledger used by daily, phase-1 health, and the new
  decomposition so all three surfaces reconcile.
- Additive skill-health response fields that leave the existing top-level
  `data` and `coverage` fields compatible with the current Dojo consumer.
- A focused `/app/` Analytics Overview consumer that keeps the raw daily
  timeline and adds per-harness consultation, coverage, breadth, version, and
  exposure detail without turning those signals into value judgments.
- Per-session skill-context detail over the local v2 API.
- Immutable expected-realization storage and explicit session association over
  local, idempotent v2 API resources.
- Claude Code `InstructionsLoaded` hook coverage for newly instrumented
  sessions. Received loads are observable; instrumented sessions with no
  received asynchronous load event remain explicitly unobservable.
- One-shot reparse scheduling for already-watched Claude and Codex session
  files, fixture-backed classification oracles, reconciliation checks,
  documentation, and live smoke verification.

### Out of Scope

- Changes to the legacy `/` dashboard, a new top-level tab, or a separate skill
  recommendation/ranking surface.
- Any change to what counts as a detected invocation: Claude remains explicit
  `Skill` calls; Codex remains concrete `/<skill>/SKILL.md` command paths.
- Profile selection, profile application, or changes in the Dojo repository.
- Outcome/value scoring, removal or placement recommendations, missed-trigger
  inference, or changes to the phase-1 interrupt heuristic.
- Current-filesystem reconstruction of historical presentation or expectation.
- Remote publication, provider-policy scraping, or guessing a catalog limit.
- Claiming Claude catalog presentation is observable until a runtime
  presentation signal actually exists.

## Assumptions And Constraints

- The spec's unit of analysis is a detected consultation, not inaccessible
  model cognition. Detection semantics remain harness-qualified.
- A session is classification-eligible when the retained source preserves both
  ordered consultation evidence and compaction visibility. Eligibility does not
  require a consultation: `eligibleSessionsInWindow` is the denominator and
  `sessionsWithFirstRead` is its per-skill numerator.
- Rich analytics convert date filters to one UTC half-open interval and use
  observed session intervals, defined below. Invocation rows use occurrence
  timestamps. Generic legacy `coverage` keeps its existing start-time semantics
  and is labeled separately.
- The current Dojo runtime consumer
  (`../dojo/scripts/skill_health_runtime.py`) requires the health response's
  top-level `data` array and phase-1 row fields. The new contract is therefore
  additive: `data` and `coverage` remain, while `consultations` and
  `dataSemantics` qualify the richer result.
- Runtime catalog size is measured as exact UTF-8 bytes of the retained
  `<skills_instructions>` block under a versioned measurement method. A
  context-window token count is not comparable with that byte measurement.
  Occupancy stays `unknown` unless an associated immutable realization supplies
  a policy artifact that matches the session's harness/model/version,
  representation, method, unit, context window, and freshness requirements.
- A missing presentation block or instruction-load event is not itself an
  observed empty result. An empty result is allowed only when the runtime source
  itself exposes an explicit empty channel. In the current delivery, a Codex
  world-state record can prove observed-empty instruction reach; a Claude
  SessionStart instrumentation marker cannot.
- Claude Code's current `InstructionsLoaded` hook is asynchronous and
  non-blocking. Its documented input exposes `file_path`, `memory_type`,
  `load_reason`, and optional trigger/include fields; `compact` is a documented
  load reason. The hook stores identities and reasons, never file contents.
- Parser eligibility is conservative. Any malformed JSONL record or unsupported
  record shape that could conceal a consultation or compaction makes the
  affected session unclassifiable rather than proving no boundary occurred.
- Query and API code must remain bounded: no per-row SQL, no filesystem scans
  for historical truth, bounded request bodies, and indexed session/kind/name
  lookups.
- Existing uncommitted work is not part of this implementation. The branch
  starts from `origin/main` and already contains the source spec in commit
  `8bdd7cd`.

## Map Before You Cut

### Current data and call path

- Claude JSONL flows through `parseSessionMessages`
  (`src/parser/claude-code.ts:268`) into the shared `ParsedSession`
  (`src/parser/claude-code.ts:117`), then
  `insertParsedSession` (`src/parser/claude-code.ts:456`) atomically
  delete-and-reinserts `browsing_sessions`, `messages`, and `tool_calls`.
  The parser currently skips every non-`user`/`assistant` line, which discards
  `system/compact_boundary`.
- Codex JSONL flows through `parseCodexSessionMessages`
  (`src/parser/codex-sessions.ts:80`) into the same insertion seam. It currently
  retains only `response_item` messages plus token-count telemetry, so it drops
  top-level `compacted` records and their `replacement_history`.
- The file watcher calls those parsers in
  `syncSessionFileDetailed` (`src/watcher/index.ts:106`) and
  `syncCodexSessionFileDetailed` (`src/watcher/index.ts:193`). Unchanged
  `watched_files` hashes skip parsing; `runDataMigrations`
  (`src/db/schema.ts:729`) already uses a one-shot hash invalidation for
  occupancy backfill.
- Phase-1 counts are independently assembled in
  `getAnalyticsSkillsDaily` (`src/db/v2-queries.ts:1757`) and
  `getAnalyticsSkillsHealth` (`src/db/v2-queries.ts:2048`). They share concrete
  path/project rules but disagree on date ordering: daily marks an OTEL-backed
  canonical session before date filtering (`src/db/v2-queries.ts:1814-1826`),
  while health marks it after date filtering
  (`src/db/v2-queries.ts:2140-2150`). An out-of-window OTEL row can therefore
  suppress an in-window JSONL row in daily but not health. This is a phase-1
  reconciliation bug, not behavior both callers can preserve.
- `GET /api/v2/analytics/skills/health`
  (`src/api/v2/router.ts:606`) currently returns
  `{ data: SkillHealthRow[], coverage: AnalyticsCoverage }`.
- Claude hook payloads enter through `POST /api/events`, are validated by
  `normalizeIngestEvent` (`src/contracts/event-contract.ts:189`), and are
  persisted by `insertEvent` (`src/db/queries.ts:411`). The hook installer
  (`hooks/claude-code/install.sh:94`) has no `InstructionsLoaded` registration.
- The canonical `/app/` Analytics Overview is assembled by
  `frontend/src/lib/components/analytics/AnalyticsPage.svelte`; it already
  renders `SkillUsageTimeline.svelte`, whose raw daily data comes from
  `fetchAnalyticsSkillsDaily` (`frontend/src/lib/api/client.ts:949`) through the
  independently versioned `skills` request in
  `frontend/src/lib/stores/analytics.svelte.ts:264`. The new health request can
  use a sibling loading/error/version key so richer insight failure does not
  blank the existing daily timeline.

### Delivery seam

The thinnest durable seam is a normalized, ordered session-context projection
attached to `ParsedSession`, persisted inside the existing delete-and-reinsert
transaction:

- `session_context_observations`: one ordered row per `consultation`,
  `compaction`, `catalog_presentation`, or transcript-derived
  `instruction_load`, with source, observed timestamp, optional skill/reason,
  and a validated bounded metadata payload.
- `session_catalog_observation_entries`: normalized entries for each catalog
  presentation, including name, description, description fingerprint, and
  runtime-exposed source location/scope.
- `browsing_sessions.project_identity` and
  `browsing_sessions.skill_context_capabilities_json`: initial session-derived
  identity plus parser diagnostics, positive/negative evidence capabilities,
  runtime harness/model/version evidence, and reason codes. Each consultation
  observation also retains the latest authoritative runtime cwd identity at
  that occurrence.

Classification remains query-time derived from ordered consultation and
compaction rows, so classifier fixes do not require another transcript reparse.
Expected realizations are separate immutable records and are never deleted by a
session reparse.

### Stable API decisions

- `GET /api/v2/analytics/skills/health` retains `data` and `coverage` exactly as
  phase 1 requires, and adds:
  - `dataSemantics`: identifies `data` as compatibility-only phase-1 rows,
    reports its legacy start-time window semantics, and sets
    `crossHarnessComparable: false` for a mixed-harness query;
  - `consultations.byHarness[]`: logical-skill rows, per-version breakdowns,
    class counts, eligible coverage, project breadth, and exposure joins;
  - `consultations.comparability`: structured status plus limiting-evidence
    codes. Current mixed Claude/Codex output is
    `not_directly_comparable/different_detection_semantics`.
- `GET /api/v2/sessions/:id/skill-context` returns the retained observation
  occurrences, capability states, classifications, catalog fingerprints and
  measurements, instruction reach, expected comparison, and budget status.
- `PUT /api/v2/skills/expected-realizations/:id` creates an immutable,
  content-hashed realization. An identical replay returns the existing
  resource; a different payload for the same ID returns `409`.
- `PUT /api/v2/sessions/:id/expected-skill-realization` explicitly associates
  one realization. It validates session existence and harness equality.
  Expected comparison then validates each catalog occurrence timestamp against
  the realization interval; an out-of-range or untimestamped occurrence is
  unavailable rather than compared. Same-association replay is idempotent and
  rebinding returns `409`.

### Phase-1 source-selection invariant

`selectPhase1Occurrences` establishes one corrected canonical algorithm before
any parser observation can enrich it:

1. Select and filter explicit Claude `Skill` tool calls exactly as today.
2. For Codex, use health's safer ordering: filter OTEL rows by the requested
   project/date first. Parse the
   concrete command; only a row yielding at least one concrete skill occurrence
   contributes rows and marks that canonical session as OTEL-selected.
3. Select Codex JSONL/tool-call rows with the same project/date rules. Suppress
   all such rows only for canonical sessions marked in step 2; otherwise retain
   every concrete detected occurrence.
4. Match each selected occurrence to an ordered parser observation by
   canonical session ID, skill name, normalized-command fingerprint, and
   within-key occurrence index. A unique match supplies order/compaction
   evidence. No or ambiguous match leaves the selected occurrence intact as
   `unclassifiable`; parser-only rows never increase the phase-1 total.

Daily, phase-1 health, and all four decomposition classes consume this selected
set. Classification is enrichment, never source replacement. The only intended
phase-1 count change is daily's out-of-window OTEL suppression bug; an
adversarial regression fixture and release note make that correction explicit.

### Rich time-window invariant

- Parse `date_from` as UTC `YYYY-MM-DDT00:00:00.000Z`; parse `date_to` as the
  next UTC midnight, producing `[from, toExclusive)`.
- Resolve a session's observed lower bound from `started_at`, else its earliest
  timestamped retained message/observation/selected occurrence. Resolve its
  upper bound from `ended_at`, else `last_item_at`, else its latest retained
  timestamp. For a currently active session, capture one response `asOf` and
  use it as the upper bound.
- A session is in the rich denominator when the observed interval overlaps the
  request interval, or when it owns a selected in-window occurrence. A bounded
  query with insufficient interval evidence and no in-window occurrence is
  reported in `windowMembershipUnobservable` outside the rate denominator.
- The rich response returns these rules in `windowSemantics`; top-level legacy
  `coverage` remains unchanged and is labeled by `dataSemantics`.

### Coverage and reason taxonomy

- Classification ineligibility uses one deterministic primary reason per
  session: `missing_ordered_session_projection`,
  `consultation_detection_unavailable`, or
  `compaction_visibility_unavailable`; parser diagnostics distinguish
  `malformed_source_record` and `unsupported_source_shape`.
- Catalog presentation uses `observable: false` with
  `presentation_signal_absent` or `harness_signal_unavailable`; an explicit
  zero-entry runtime block is the only observed-empty catalog.
- Instruction reach uses `observable: false` with
  `instruction_load_signal_absent`, `instrumented_no_events_received`, or
  `harness_signal_unavailable`. A received Claude load is observable populated;
  only an explicit runtime channel such as a Codex world-state record permits
  observed-empty.
- Expected comparison uses `unavailable` with
  `no_expected_realization`, `realization_not_valid_for_occurrence`, or
  `presentation_unobservable`.
- Budget status uses `unknown` with a structured reason such as
  `no_authoritative_limit`, `incompatible_units`,
  `measurement_unavailable`, or `limit_authority_unrecognized`.

## Task Breakdown

### Task 1: Build the transcript oracle and ordered observation parsers

**Objective**

Create redacted, hand-counted Claude and Codex fixtures and extend both parsers
to emit ordered consultations, compactions, catalog presentations, instruction
observations, source capabilities, and stable session-derived project identity.

**Files**

- Create: `src/skills/context-observations.ts`
- Create: `src/skills/invocation-detection.ts`
- Modify: `src/parser/claude-code.ts`
- Modify: `src/parser/codex-sessions.ts`
- Modify: `src/parser/antigravity-sessions.ts`
- Test: `tests/skill-context-parser.test.ts`
- Test fixture: `tests/fixtures/skill-context/claude-full.jsonl`
- Test fixture: `tests/fixtures/skill-context/codex-full.jsonl`
- Test fixture: `tests/fixtures/skill-context/codex-degraded.jsonl`
- Test fixture: `tests/fixtures/skill-context/malformed-and-unknown.jsonl`

**Dependencies**

None

**Assumptions Verified**

- `src/parser/claude-code.ts:41` already types `cwd`, `subtype`, and progress
  fields, but `parseSessionMessages` skips non-message lines at line 312.
- `src/parser/codex-sessions.ts:98-107` first parses all JSONL lines, then line
  142 rejects every non-`response_item` record after token telemetry. The same
  pass can inspect `compacted.payload.replacement_history` without another
  parse.
- `src/parser/claude-code.ts:117` is the shared parser return type used by both
  harnesses, so `contextObservations` and source capabilities have one insertion
  contract.
- `src/parser/antigravity-sessions.ts:34-50` also returns `ParsedSession` and
  reaches `insertParsedSession` through `src/watcher/index.ts:303-315`; it must
  compile and explicitly report these new capabilities unavailable.
- The existing Codex path detector at
  `src/db/v2-queries.ts:958` accepts concrete `/<name>/SKILL.md` paths and
  rejects shell variables/globs; moving it to a shared module preserves the
  invocation basis.

**Implementation Steps**

1. Add normalized types for observation kind, raw ordinal, timestamp, source,
   skill identity, per-occurrence project identity, machine reason,
   presentation measurement, truncation tri-state, parser diagnostics, and
   session capability state. Make the new `ParsedSession` fields
   optional/default-empty at the shared seam and have Antigravity explicitly
   report `harness_signal_unavailable`.
2. Move Codex command/path extraction into
   `src/skills/invocation-detection.ts`; make both legacy analytics and the
   Codex parser call the same function.
3. Add a project-identity helper that lexically normalizes a session-reported
   absolute `cwd` (`path.resolve`, repeated/trailing separator removal, no
   filesystem `realpath`, case preserved) and hashes it as `sha256:<hex>`.
   Track the latest runtime cwd in raw order and stamp each consultation with
   the identity active at that occurrence; use the first observed cwd only for
   the session-level identity/display basename. Emit `null`/`unknown` when no
   runtime cwd exists, and never reconstruct it from current filesystem state.
4. Before implementing behavior, add exported parser signatures returning empty
   observations, then run the exact parser test. Record the expected red signal:
   the full fixtures expect classifiable ordered observations but receive zero.
5. In the Claude parser, assign a monotonically increasing raw ordinal across
   all valid lines/blocks; emit a consultation beside each explicit `Skill`
   tool call and a compaction for `type=system/subtype=compact_boundary`.
6. In the Codex parser, emit consultations from concrete skill paths; emit
   compactions from top-level `type=compacted`; inspect initial developer
   response items and post-compaction `replacement_history` for every
   `<skills_instructions>` occurrence rather than collapsing them.
7. Parse each presented entry's name, exact description, available file/scope,
   duplicate-preserving presentation ordinal, and description SHA-256. Measure
   the exact retained block as
   `retained_catalog_block_utf8_bytes/v1`. Fingerprint
   `skill_catalog_presentation/v1`: canonical JSON of entry objects in runtime
   order with fixed keys (`ordinal`, `name`, `description`, `sourceLocation`,
   `sourceScope`), UTF-8 encoded and SHA-256 hashed. Store the raw-block
   measurement separately from the canonical fingerprint. Support catalog tags
   split across contiguous `input_text` fragments without inserting bytes;
   malformed/incomplete tags make presentation unobservable. Leave truncation
   `unknown` unless a runtime field explicitly states true or false.
8. Record total/parsed/malformed/unsupported line counts and the recognized
   source-shape version. A malformed JSON line or unknown record shape capable
   of hiding consultation/compaction evidence makes compaction visibility
   unavailable for the session.
9. Parse Codex instruction reach only from explicit injected AGENTS metadata or
   `world_state.state.agents_md`. Set positive observability only when that
   channel exists; preserve initial/repeated reason if the runtime exposes it.
10. Assert exact fixture sequences: each full fixture contains three
   consultations around one compaction, the Codex fixture contains distinct
   initial/post-compaction presentations, and degraded/malformed/unknown-shape
   fixtures retain detected consultations while declaring classification
   unavailable. Cover explicit empty Codex instructions, duplicate catalog
   names, multiple text fragments, explicit truncation false, one/multiple/zero
   cwd values, and Antigravity regression.

**Verification**

- Run: `node --import tsx --test tests/skill-context-parser.test.ts`
- Expect: Claude and Codex full-fixture observation sequences match the
  hand-written oracle exactly; two Codex presentations retain distinct
  fingerprints; degraded/corrupt evidence stays present with a reason;
  Antigravity stays parseable with unavailable capabilities.

**Test Discovery Verified**

- Runner/discovery evidence: `package.json:19` includes
  `tests/*.test.ts`; the new test is directly under `tests/`.
- Literal proof:
  `node --import tsx --test tests/skill-context-parser.test.ts`.

**Done When**

- The full fixtures each expose exactly three consultations and one compaction
  in source order, the Codex fixture exposes exactly two catalog occurrences,
  malformed/unsupported fixtures classify zero occurrences plausibly, and the
  degraded fixture retains exactly one consultation without assigning a
  plausible class.

### Task 2: Persist observations atomically and schedule historical backfill

**Objective**

Persist the new projection through the existing session insertion transaction
and make upgraded databases reparse each already-watched Claude/Codex file once.

**Files**

- Modify: `src/db/schema.ts`
- Modify: `src/parser/claude-code.ts`
- Test: `tests/skill-context-persistence.test.ts`
- Test: `tests/skill-context-backfill-migration.test.ts`

**Dependencies**

Task 1

**Assumptions Verified**

- `src/parser/claude-code.ts:456-555` owns the shared transactional
  delete-and-reinsert path for both Claude and Codex parsed sessions.
- `src/db/schema.ts:409-541` creates `browsing_sessions`, `messages`, and
  `tool_calls` with additive column guards.
- `src/db/schema.ts:722-741` guards one-shot data changes with
  `PRAGMA user_version`; `backfillOccupancyOnUpgrade` at line 776 demonstrates
  the required `watched_files.file_hash = ''` reparse pattern.

**Implementation Steps**

1. Add `project_identity` and `skill_context_capabilities_json` to
   `browsing_sessions` through idempotent column guards.
2. Add `session_context_observations` with indexed
   `(session_id, kind, skill_name, ordinal)` access and checked JSON metadata.
   Add `session_catalog_observation_entries` keyed to a presentation
   observation and indexed by skill name.
3. Extend `insertParsedSession` to delete catalog-entry children, then context
   observations, before the existing session rows; insert the full replacement
   projection inside the same transaction. Expected-realization associations
   are deliberately untouched.
4. Add data schema v4. For pre-v4 databases, clear the `watched_files` hash for
   file-backed Claude/Codex `browsing_sessions` exactly once so normal startup
   sync backfills the projection.
5. Before adding v4, run the migration fixture expecting hashes to clear and
   record the red result (`user_version` remains 3 and hashes remain unchanged).
6. Use a real temporary SQLite file in tests. Assert initial insert, changed
   reparse replacement (no duplicated occurrences), and transaction rollback on
   an invalid child row.
7. In the migration test, assert only eligible Claude/Codex watched hashes are
   cleared, unrelated rows remain unchanged, and a second
   `runDataMigrations` call changes zero rows.

**Verification**

- Run:
  `node --import tsx --test tests/skill-context-persistence.test.ts tests/skill-context-backfill-migration.test.ts`
- Expect: replacement and rollback assertions pass; migration advances
  `user_version` from 3 to 4 and is a no-op on its second call.

**Test Discovery Verified**

- Runner/discovery evidence: `package.json:19` discovers both top-level
  `tests/*.test.ts` files.
- Literal proof:
  `node --import tsx --test tests/skill-context-persistence.test.ts tests/skill-context-backfill-migration.test.ts`.

**Done When**

- Re-inserting one fixture session changes its observation set from the old
  exact count to the new exact count with zero stale rows, and the v4 migration
  schedules each qualifying watched file no more than once.

### Task 3: Instrument Claude instruction-load reach

**Objective**

Add content-free `InstructionsLoaded` ingestion and an instrumentation marker
while preserving shell/Python installer parity, without treating asynchronous
non-delivery as observed absence.

**Files**

- Create: `hooks/claude-code/instructions_loaded.sh`
- Create: `hooks/claude-code/python/instructions_loaded.py`
- Modify: `hooks/claude-code/session_start.sh`
- Modify: `hooks/claude-code/python/session_start.py`
- Modify: `hooks/claude-code/install.sh`
- Modify: `hooks/claude-code/README.md`
- Modify: `src/contracts/event-contract.ts`
- Test: `tests/hooks.test.ts`
- Test: `tests/claude-hook-installer.test.ts`

**Dependencies**

Task 2

**Assumptions Verified**

- `src/contracts/event-contract.ts:1-12` is the closed event-type allowlist used
  by `POST /api/events`.
- `hooks/claude-code/install.sh:79-166` selects shell/Python script paths and
  writes all Claude hook registrations; omitting either language would make
  install modes diverge.
- `hooks/claude-code/session_start.sh` and
  `hooks/claude-code/python/session_start.py` already emit SessionStart
  metadata, the correct place for the weaker "this session was configured for
  instruction telemetry" marker. It is not proof that an asynchronous
  InstructionsLoaded event was delivered.
- `tests/hooks.test.ts:17-120` provides real subprocess helpers for both hook
  languages and validates emitted event shapes through
  `normalizeIngestEvent`.

**Implementation Steps**

1. Add `instruction_load` to the event contract.
2. Implement shell and Python hooks that accept the documented
   `InstructionsLoaded` payload and send only `file_path`, `memory_type`,
   `load_reason`, `globs`, `trigger_file_path`, and `parent_file_path` in event
   metadata. Do not read the named file.
3. Register `InstructionsLoaded` with an all-reasons matcher and asynchronous
   command execution in both installer modes.
4. Have the installer set an explicit environment marker on its SessionStart
   command; have the SessionStart scripts preserve that marker as
   `instruction_load_instrumented: true`. If no load event is received, project
   `observable: false/reason: instrumented_no_events_received`; an old
   SessionStart event without the marker uses `instruction_load_signal_absent`.
5. Add shell/Python fixture tests for `session_start`, `compact`, and an
   optional-field load. Assert repeated loads produce two events rather than
   deduplicating and assert no instruction content field is emitted.
6. Before installer changes, add a temp-`HOME` test that expects an
   `InstructionsLoaded` registration and observe it fail against the current
   installer. Then test shell and Python installs, all-reasons matcher, async
   mode, instrumentation marker propagation, uninstall, and preservation of
   unrelated hook/settings entries.
7. Update the hook README's event matrix, install examples, payload privacy
   note, asynchronous delivery caveat, and unobservable-zero semantics.

**Verification**

- Run:
  `node --import tsx --test tests/hooks.test.ts tests/claude-hook-installer.test.ts`
- Expect: both hook implementations emit contract-valid content-free payloads;
  the instrumentation marker and `compact` load reason survive; both install
  modes and uninstall preserve unrelated settings.

**Test Discovery Verified**

- Runner/discovery evidence: both top-level tests are selected by
  `package.json:19`.
- Literal proof:
  `node --import tsx --test tests/hooks.test.ts tests/claude-hook-installer.test.ts`.

**Done When**

- Shell and Python modes each preserve received populated loads and distinguish
  `instrumented_no_events_received` from legacy missing telemetry, while
  neither state is mislabeled observed-empty.

### Task 4: Replace duplicate counting paths with one invocation ledger

**Objective**

Make daily analytics, phase-1 health, and consultation decomposition consume one
canonical occurrence ledger without changing the invocation definition.

**Files**

- Create: `src/skills/invocation-ledger.ts`
- Modify: `src/db/v2-queries.ts`
- Modify: `src/api/v2/types.ts`
- Test: `tests/skill-invocation-ledger.test.ts`
- Modify test: `tests/skills-health.test.ts`

**Dependencies**

Tasks 1-2

**Assumptions Verified**

- `src/db/v2-queries.ts:1757-1879` and lines 2048-2196 currently duplicate
  Claude/Codex extraction and date filtering.
- `src/db/v2-queries.ts:1793-1873` and lines 2118-2196 prefer Codex event rows
  over JSONL rows by canonical session ID after a project-matching concrete
  skill path is found, but daily marks before date filtering while health marks
  after it. Health's ordering preserves an in-window JSONL fallback and becomes
  the canonical corrected rule.
- `tests/skills-health.test.ts:255-349` already pins daily/health totals,
  version attribution, and the existing endpoint envelope.

**Implementation Steps**

1. Define a typed selected occurrence with harness, canonical session ID,
   timestamp, project fields, skill name, normalized-command fingerprint,
   within-key occurrence index, detection source, optional matched ordered
   observation, and version-attribution inputs.
2. First implement `selectPhase1Occurrences` from the existing health ordering:
   filtered explicit Claude rows; project/date-filtered concrete Codex OTEL rows
   that mark their canonical session only after yielding a skill; then filtered
   JSONL rows suppressed only for those marked sessions. Do not read parser
   observations in this step.
3. Add an adversarial parity/correction corpus before replacing either caller:
   an out-of-window concrete OTEL row plus in-window JSONL row that currently
   differs between daily and health;
   concrete
   OTEL versus multiple JSONL rows, nonconcrete OTEL with usable JSONL fallback,
   out-of-window and project-filtered OTEL rows, canonical-ID alias/mismatch,
   one command containing multiple skills, duplicate same-skill commands, and
   boundary date filters. Record the exact old daily/health results. Initially
   run the selector/reconciliation assertion red on the known mismatch, then
   lock health's date-before-suppression result as the corrected expected value.
   All cases other than that named bug must remain numerically equivalent.
4. Enrich, never replace, each selected occurrence by uniquely matching a
   parser observation on canonical session ID, skill name,
   normalized-command fingerprint, and within-key occurrence index. A missing
   or ambiguous match remains selected and becomes
   `unclassifiable/missing_ordered_session_projection`; unmatched parser rows
   do not enter the ledger.
5. Refactor `getAnalyticsSkillsDaily` and `getAnalyticsSkillsHealth` to consume
   the ledger. Preserve all `SkillHealthRow` fields, current installed-catalog
   never-fired behavior, version snapshot resolution, and the interrupt
   heuristic.
6. Assert for every post-fix case that selected ledger length, daily total, summed
   phase-1 health invocations, and later four-class total are identical for the
   same filters.
7. Run the existing phase-1 tests before and after the refactor and record the
   expected unchanged fixture rows.

**Verification**

- Run:
  `node --import tsx --test tests/skill-invocation-ledger.test.ts tests/skills-health.test.ts`
- Expect: canonical fixture count is exact, event/JSONL duplicates count once,
  nonconcrete/out-of-filter events do not suppress JSONL, and daily totals equal
  summed health invocations for every tested project/date window. The named
  out-of-window suppression fixture changes daily to the former health result;
  no other phase-1 fixture changes.

**Test Discovery Verified**

- Runner/discovery evidence: both files match `tests/*.test.ts` in
  `package.json:19`.
- Literal proof:
  `node --import tsx --test tests/skill-invocation-ledger.test.ts tests/skills-health.test.ts`.

**Done When**

- The mixed fixture's daily total, summed phase-1 health invocations, and ledger
  length are identical in every adversarial source-selection case, while all
  pre-existing phase-1 fixture rows except the named out-of-window suppression
  bug remain structurally and numerically unchanged.

### Task 5: Implement classification, coverage, breadth, and exposure analytics

**Objective**

Produce per-harness logical-skill analytics whose class counts, denominators,
project breadth, version rows, and presentation joins satisfy every spec
invariant.

**Files**

- Create: `src/skills/consultation-analytics.ts`
- Modify: `src/db/v2-queries.ts`
- Modify: `src/api/v2/types.ts`
- Test: `tests/skill-consultation-analytics.test.ts`

**Dependencies**

Task 4

**Assumptions Verified**

- `src/db/v2-queries.ts:993` exposes only generic analytics coverage; it does
  not encode consultation classification capability and cannot serve as the
  new denominator.
- `src/skills/catalog.ts:133` resolves version at invocation time and already
  distinguishes approximate fallback from an exact window.
- `browsing_sessions` has session start/end, harness, project display, and the
  new Task 2 identity/capability fields needed to build a bounded session
  universe before loading observations.

**Implementation Steps**

1. Parse date filters once into the UTC `[from, toExclusive)` interval defined
   above and capture one response `asOf`. Resolve each observed session interval
   from persisted start/end/last-item/evidence timestamps. Include a session on
   observed overlap or ownership of an in-window selected occurrence; report
   unresolved membership separately as `windowMembershipUnobservable`.
2. Honor existing project/agent filters and assign one primary classification
   ineligibility reason to every included non-capable session. Return the
   explicit rich `windowSemantics` while leaving generic legacy coverage
   unchanged.
3. Classify each ledger occurrence in source order:
   - first skill occurrence before any reset: `first_read`;
   - first occurrence of that skill after the latest observed compaction:
     `rehydration_after_compaction`;
   - later occurrence without another compaction:
     `repeat_no_compaction`;
   - insufficient ordered/compaction evidence: `unclassifiable` with reason.
4. Aggregate one logical skill per harness, then version rows split by exact,
   approximate, and unknown attribution quality. Keep last-invoked and raw
   phase-1 fields separate from consultation meaning.
5. For each skill/harness report `sessionsInWindow`,
   `eligibleSessionsInWindow`, `sessionsWithFirstRead`, ineligible reason
   counts, and `firstReadEngagementRate` only when the eligible denominator is
   nonzero.
6. Count each first-read session once using the project identity stamped on its
   first-read occurrence (latest runtime cwd at that point); return
   `{id, label, sessions}` rows plus an explicit `unknown` bucket and distinct
   observed-project count. A later cwd change cannot rewrite the historical
   bucket.
7. Join presentation and classification only across sessions positively
   eligible for both. Count distinct presented sessions, then partition them
   into with-first-read and without-first-read.
8. Return per-harness results only. Add structured comparability:
   `single_harness`, `comparable`, or `not_directly_comparable`, with
   machine-readable limiting-evidence codes. Current mixed Claude/Codex
   semantics must return `different_detection_semantics`.
9. Add invariant helpers used in tests and optional development assertions:
   four classes equal ledger occurrences; eligible plus ineligible equals all;
   project buckets equal first-read sessions; exposure partitions equal the
   jointly eligible presented denominator; version rows equal logical aggregate.
10. Add UTC boundary fixtures: starts before/at/inside/after the interval; ends
   before/at/inside/toExclusive; active sessions; missing start/end; and an
   in-window occurrence owned by a session that started before the window.
   Assert `asOf`, overlap, and unknown-membership behavior exactly.
11. Prove the guard: temporarily change the post-compaction branch to
   `repeat_no_compaction`, run the exact test and observe failure, then restore
   the classifier and retain the green result.

**Verification**

- Run:
  `node --import tsx --test tests/skill-consultation-analytics.test.ts`
- Expect: the oracle returns exact `first_read=1`,
  `rehydration_after_compaction=1`, `repeat_no_compaction=1` for its full
  three-occurrence skill; every reconciliation assertion passes; the degraded
  occurrence is unclassifiable with its reason; all UTC boundary fixtures enter
  exactly the documented denominator/unknown bucket.

**Test Discovery Verified**

- Runner/discovery evidence: the test is a top-level file matched by
  `package.json:19`.
- Literal proof:
  `node --import tsx --test tests/skill-consultation-analytics.test.ts`.

**Done When**

- Every fixture occurrence belongs to exactly one class, all five invariant
  families reconcile with zero unexplained difference, and mixed-harness output
  contains no unqualified pooled consultation metric. Rich denominator boundary
  cases match the documented UTC predicate exactly.

### Task 6: Store immutable expected realizations and guarded associations

**Objective**

Create the optional authority input needed for historically valid
expected-versus-presented comparison without consulting current filesystem
state.

**Files**

- Create: `src/skills/expected-realizations.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/api/v2/types.ts`
- Test: `tests/skill-expected-realizations.test.ts`

**Dependencies**

Task 2

**Assumptions Verified**

- `src/db/schema.ts:706` already stores point-in-time catalog snapshots but
  those rows describe installed filesystem observations, not an expected
  session realization; reusing them would cross the spec's authority boundary.
- `insertParsedSession` deletes and recreates `browsing_sessions`; the expected
  association must therefore live in a separate table and survive reparse.
- The downstream distribution-profile spec defines desired-state authority;
  this repository must accept a pinned realization artifact, not derive or
  apply a profile.

**Implementation Steps**

1. Define and validate a bounded realization DTO: immutable ID, harness,
   profile/canonical revision, validity interval, sorted expected skill names
   and description fingerprints, optional policy artifacts, and explicit
   producer/artifact/revision provenance.
2. A policy artifact must be either a pinned vendor-policy snapshot or a
   reproducible version-scoped probe and include: artifact ID and content hash;
   source URI or probe identity; harness plus harness version; model/model
   version when applicable; context-window identity; runtime representation;
   limit value/unit; measurement method; observed-at; expiry/freshness policy;
   and producer provenance. `harness_runtime` is evidence only when the session
   itself reports the matching value/version—not a caller-supplied authority
   label.
3. Add `skill_expected_realizations` with canonical payload JSON and SHA-256
   content hash, plus `session_expected_skill_realizations` with one association
   per session and indexed realization lookup.
4. Implement transactional create/replay/conflict behavior. Canonicalize arrays
   before hashing so semantically identical orderings replay idempotently.
5. Implement association validation for existing session and same harness.
   Preserve the association across transcript reparse. Do not make one
   start-time check stand in for occurrence validity: the Task 7 projector must
   evaluate `validFrom <= presentation.observedAt < validTo` independently for
   every catalog occurrence.
6. Before persistence exists, add the create/replay/conflict tests and observe
   the missing-table/service red failure. Then test exact replay, content
   conflict, missing session, harness mismatch, successful association, rebind
   conflict, post-reparse preservation, and rejection of incomplete policy
   artifacts.

**Verification**

- Run:
  `node --import tsx --test tests/skill-expected-realizations.test.ts`
- Expect: valid create/association succeeds; identical replays are unchanged;
  each invalid authority/identity path returns its typed conflict or validation
  result without writing a partial row; incomplete policy evidence cannot
  authorize occupancy.

**Test Discovery Verified**

- Runner/discovery evidence: `package.json:19` selects the top-level test.
- Literal proof:
  `node --import tsx --test tests/skill-expected-realizations.test.ts`.

**Done When**

- An expected comparison can be anchored to exactly one immutable hash and
  harness-valid association, while all missing, conflicting, cross-harness, and
  incomplete-authority fixtures leave the database unchanged. Occurrence-time
  validity remains mandatory for every Task 7 comparison.

### Task 7: Project per-session catalog, comparison, budget, and instruction evidence

**Objective**

Assemble the complete per-session skill-context DTO with distinct observable
states, occurrence-level presentation, guarded expected comparison, honest
budget status, and instruction reach.

**Files**

- Create: `src/skills/session-skill-context.ts`
- Modify: `src/api/v2/types.ts`
- Test: `tests/session-skill-context.test.ts`

**Dependencies**

Tasks 3, 5, and 6

**Assumptions Verified**

- Task 1 retains each Codex presentation occurrence and entry separately, which
  is required to compare initial and post-compaction catalogs without
  collapsing them.
- `events.metadata` is already bounded by `insertEvent`
  (`src/db/queries.ts:411`) and can supply Claude instruction identities/reasons
  without adding instruction contents to the browser projection.
- `browsing_sessions.context_window_tokens` is a token unit, while the selected
  runtime catalog measurement is UTF-8 bytes; the projector must reject that
  comparison as incompatible.

**Implementation Steps**

1. Load one session's capabilities and ordered observations in bounded queries;
   load catalog entries in one indexed query and Claude instruction events in
   one indexed query.
2. Return every catalog occurrence with entries, fingerprints, exact
   measurement, method, unit, provenance, and truncation tri-state. Return
   `observable: false` rather than an empty list when the signal is absent.
3. Resolve the associated expected realization, if any. For each observable
   presentation independently require a timestamp and
   `validFrom <= observedAt < validTo` (when bounded) before comparing by skill
   name plus description fingerprint. Return sorted matching, omitted,
   unexpected, and description-mismatched sets per occurrence.
4. If the realization is absent/invalid or presentation is unobservable, return
   `comparison.status=unavailable` with the exact reason and no inferred diff.
   A session spanning `validTo` may therefore have a valid initial comparison
   and unavailable post-expiry comparison.
5. Compare presentation measurement with a policy limit only when artifact
   hash, harness/model/version, context-window identity, representation,
   value/unit/method, observed-at/freshness, and authority evidence all match
   the specific session occurrence. Return used/limit/ratio only for a valid
   pair; otherwise return `unknown` with the limiting reason. Never compare byte
   size with session context-window tokens.
6. Project Claude instruction reach from the SessionStart observability marker
   plus received `instruction_load` events: at least one received event is
   observable populated, while marker-with-zero-events remains
   `observable:false/instrumented_no_events_received`. Project Codex reach only
   from its explicit transcript channel, which can prove an empty list.
   Preserve repeated occurrences and `compact` reasons.
7. Fixture-test observed populated, observed empty, unobservable, two differing
   presentations, valid initial plus post-expiry unavailable comparison,
   untimestamped occurrence, active/unknown-ended session, no realization,
   incomplete/stale/mismatched policy artifacts, compatible byte limit,
   incompatible token limit, missing async delivery, and repeated compact
   loads.

**Verification**

- Run:
  `node --import tsx --test tests/session-skill-context.test.ts`
- Expect: all three instruction states differ; two catalog occurrences remain
  distinct; comparison appears only for the valid association; only the
  occurrence-valid comparison has a diff; only the fully matching authoritative
  byte-policy fixture has a numeric occupancy ratio.

**Test Discovery Verified**

- Runner/discovery evidence: `package.json:19` selects the top-level test.
- Literal proof:
  `node --import tsx --test tests/session-skill-context.test.ts`.

**Done When**

- The per-session oracle reproduces both presentation fingerprints and exact
  byte sizes, emits one valid expected diff, suppresses the post-expiry and
  untimestamped diffs, keeps Claude marker-with-zero-events unobservable, and
  computes occupancy for exactly the one fully matching authoritative limit
  fixture.

### Task 8: Expose additive v2 contracts without breaking Dojo

**Objective**

Wire the new read/write resources and additive health decomposition into the v2
router with bounded validation and phase-1 compatibility.

**Files**

- Modify: `src/api/v2/router.ts`
- Modify: `src/api/v2/types.ts`
- Modify: `src/db/v2-queries.ts`
- Test: `tests/skill-context-api.test.ts`
- Modify test: `tests/skills-health.test.ts`

**Dependencies**

Tasks 4-7

**Assumptions Verified**

- `src/api/v2/router.ts:408` centralizes analytics query parsing and lines
  606-618 own the existing health envelope.
- `src/api/v2/router.ts:126-191` already owns `/sessions/:id` read resources,
  so skill context belongs beside those routes.
- `tests/skills-health.test.ts:330` pins the current top-level `data` and
  `coverage` contract.
- `../dojo/scripts/skill_health_runtime.py` reads `payload["data"]` and ignores
  additive top-level fields; retaining the array and row shape closes the known
  downstream compatibility requirement.

**Implementation Steps**

1. Add typed response DTOs for data semantics, consultation analytics,
   comparability, session context, realization create, and association results.
   Keep persistence types private to the skill services.
2. Extend the health handler with `dataSemantics` and `consultations`, preserving
   the existing `data` and `coverage` values for the same request. Mark mixed
   legacy rows `compatibilityOnly: true/crossHarnessComparable: false`; require
   all new analytics consumers to use `consultations.byHarness`.
3. Add `GET /sessions/:id/skill-context`; return `404` for an unknown session
   and the explicit observable/unavailable states for a known one.
4. Add `PUT /skills/expected-realizations/:id` and
   `PUT /sessions/:id/expected-skill-realization`. Enforce JSON object bodies,
   maximum entry/description/provenance sizes, ISO timestamps, declared units,
   and the Task 6 conflict semantics. Return `201` create, `200` idempotent
   replay, `400` malformed, `404` unknown dependency, `409` immutable/rebind
   conflict, and `422` harness or policy-semantic mismatch. An out-of-range
   presentation remains a successful read with comparison unavailable, not an
   association error.
5. Add API fixtures for one harness, mixed harnesses, degraded coverage, session
   context, valid realization lifecycle, and each error status.
6. Write the route/status tests before wiring the handlers and record the
   expected `404`/missing-field red results. Add a contract test that runs the
   current Dojo extraction assumptions against the enriched health payload:
   top-level `data` is an array and every legacy row still has `name`,
   `invocations`, and `neverFired`.
7. Keep CI independent of sibling repositories, but add a Task 10 local
   compatibility smoke that invokes the actual
   `../dojo/scripts/skill_health_runtime.py` extractor against the seeded built
   server and confirms it accepts the additive response unchanged.

**Verification**

- Run:
  `node --import tsx --test tests/skill-context-api.test.ts tests/skills-health.test.ts`
- Expect: all endpoint/status fixtures pass; the legacy consumer-shape
  assertion passes unchanged; mixed-harness output is explicitly qualified.

**Test Discovery Verified**

- Runner/discovery evidence: both tests match `tests/*.test.ts` in
  `package.json:19`.
- Literal proof:
  `node --import tsx --test tests/skill-context-api.test.ts tests/skills-health.test.ts`.

**Done When**

- Existing health clients can read the same phase-1 rows, while a new client can
  retrieve every contract signal through the three added v2 resources with the
  documented deterministic status codes. Mixed legacy rows are
  machine-labeled compatibility-only and non-comparative.

### Task 9: Add skill consultation insight to the `/app/` Analytics Overview

**Objective**

Keep the existing raw invocation timeline and add a focused, coverage-honest
Analytics panel for per-harness first reads, rehydrations, repeats,
unclassifiable evidence, project breadth, exposure gaps, and version detail.

**Files**

- Modify: `frontend/src/lib/api/client.ts`
- Modify: `frontend/src/lib/stores/analytics.svelte.ts`
- Create: `frontend/src/lib/components/analytics/SkillConsultationInsights.svelte`
- Modify: `frontend/src/lib/components/analytics/AnalyticsPage.svelte`
- Modify: `frontend/src/lib/analytics-state.ts`
- Create: `scripts/verify-skill-context-built.mjs`
- Test: `tests/analytics-state.test.ts`
- Test: `e2e/skill-consultation-analytics.spec.ts`

**Dependencies**

Task 8

**Assumptions Verified**

- `frontend/AGENTS.md` names `/app/` as the canonical product surface and
  `frontend/src/lib/components/analytics/` as the Analytics Overview component
  boundary.
- `frontend/src/lib/components/analytics/AnalyticsPage.svelte:1-74` owns the
  Overview composition and already places `SkillUsageTimeline` in its main
  column.
- `frontend/src/lib/stores/analytics.svelte.ts:34-110` gives each Overview panel
  an independent request version, loading state, error state, and coverage
  slot; richer health can fail independently of raw daily skill usage.
- `frontend/src/lib/api/client.ts:949-952` is the typed daily-skill client seam.
- `frontend/src/lib/analytics-state.ts:90-160` and
  `tests/analytics-state.test.ts` own the portable Overview CSV contract.
- `playwright.config.ts:8` discovers browser tests under `e2e/`; no component
  test runner is configured.

**Implementation Steps**

1. Add frontend DTOs that mirror the Task 8 public response—not persistence
   types—including `dataSemantics`, per-harness logical skills, version
   breakdown, class counts, rich coverage/window semantics, project breadth,
   exposure join, and structured comparability. Add
   `fetchAnalyticsSkillsHealth(params)`.
2. Add a separate `skillConsultations` panel key, request version, loading/error
   state, and result to `analytics.svelte.ts`. Fetch health with the same shared
   date/project/agent parameters as daily skills, but do not make either request
   depend on the other.
3. Before rendering the component, add a browser fixture that expects a
   "Skill consultations" region and observe the missing-region red result.
4. Create `SkillConsultationInsights.svelte` using the Instrument Console tokens
   and existing `Panel`, `Badge`, and table patterns. In an all-agent query,
   render separate Claude and Codex sections plus the structured comparability
   explanation; never sum their metrics into a headline.
5. Make the primary scan row per logical skill show:
   `sessionsWithFirstRead / eligibleSessionsInWindow` and engagement rate;
   rehydration, repeat, and unclassifiable occurrence counts; distinct observed
   projects; and presented-without-first-read over jointly eligible presented
   sessions. Use `—`/reason labels instead of zero when a metric is unavailable.
6. Provide an accessible expandable detail per skill for version attribution
   quality/counts, project buckets including `unknown`, classification
   ineligibility reasons, and exposure eligibility. Do not label any row
   low-value, redundant, global, local, or removable.
7. Keep `SkillUsageTimeline` immediately above the new panel and relabel its
   explanatory copy as raw phase-1 invocation volume. The new panel explains
   that first reads measure engagement, rehydrations reflect observed
   compaction, and none of the signals measure outcome value.
8. Add loading, independent error, empty, mixed-harness, single-harness,
   unclassifiable-heavy, zero-eligible, and partial-presentation states. Ensure
   the shared agent filter collapses the view to the selected harness without a
   stale mixed-harness warning.
9. Extend Overview CSV export with a `Skill Consultations By Harness` section
   carrying harness, skill, first/eligible/rate, four class counts, project
   breadth, exposure denominator/split, and comparability code. Keep the
   existing `Skills By Day` section unchanged.
10. Add `scripts/verify-skill-context-built.mjs`: create a validated temp
    directory/SQLite path; seed deterministic Claude and Codex oracle sessions
    through built `dist/` parser/schema modules; choose an unused loopback port;
    spawn `node dist/server.js`; assert the health/session-context/realization
    API invariants; run the Playwright test against that origin; terminate the
    child; and remove only its validated temp directory. The browser test asserts
    both harness headings, non-comparability copy, exact oracle values,
    expandable version/coverage detail, agent-filter behavior, and
    keyboard-accessible expansion. Pass the spawned origin to the test as
    `AGENTMONITOR_E2E_URL`; the spec reads that variable rather than importing
    source modules or assuming a fixed port. Capture desktop and narrow-viewport
    screenshots for visual inspection without making pixels the correctness
    oracle.

**Verification**

- Run: `node --import tsx --test tests/analytics-state.test.ts`
- Run: `pnpm frontend:check`
- Run: `pnpm build`
- Run: `node scripts/verify-skill-context-built.mjs`
- Expect: CSV preserves the daily section and adds exact per-harness rows;
  Svelte checks/build pass; built API invariants pass; the browser shows
  separate harness evidence, truthful unavailable states, and
  filter-responsive detail at desktop and narrow widths.

**Test Discovery Verified**

- Runner/discovery evidence: `tests/analytics-state.test.ts` matches
  `package.json:19`; `playwright.config.ts` selects
  `e2e/skill-consultation-analytics.spec.ts`.
- Literal proof:
  `node --import tsx --test tests/analytics-state.test.ts` and
  `node scripts/verify-skill-context-built.mjs` (which invokes the exact
  Playwright file with `--project=chromium`).

**Done When**

- The Analytics Overview preserves the raw daily chart and renders every richer
  metric per harness, the oracle's first/eligible/class/project/exposure values
  are visible without pooled cross-harness claims, all unavailable states carry
  reasons, and frontend check/build/browser gates pass.

### Task 10: Document, backfill, benchmark, and verify the built runtime

**Objective**

Update durable references, prove the one-shot backfill and query cost on local
data, and verify source plus built-server behavior before marking the spec
shipped.

**Files**

- Modify: `README.md`
- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `docs/system/FEATURES.md`
- Modify: `docs/system/OPERATIONS.md`
- Modify: `docs/project/ROADMAP.md`
- Modify: `docs/specs/2026-07-27-skill-invocation-decomposition-spec.md`
- Modify: `docs/plans/2026-07-28-skill-invocation-decomposition-plan.md`

**Dependencies**

Tasks 1-9

**Assumptions Verified**

- The project guardrail requires `README.md` in the same change as any API
  response-shape change.
- `docs/system/ARCHITECTURE.md:126` documents parser persistence and one-shot
  watched-file backfill; this feature extends the same lifecycle.
- `docs/system/FEATURES.md:90,173` and
  `docs/project/ROADMAP.md:58` currently describe phase-1 skill health and need
  additive phase-2 semantics.
- `docs/system/OPERATIONS.md:269` distinguishes event import from session-browser
  sync and documents `amon sync sessions --source all --force`, the manual
  recovery path if automatic reparse is interrupted.

**Implementation Steps**

1. Document the new schemas, parser evidence/capability states, shared ledger,
   classification rules, expected-realization authority boundary, hook event,
   endpoints, status codes, and additive health compatibility.
2. State explicitly that invocation/presentation/breadth are screening evidence,
   not value or removal recommendations; current filesystem state is not
   historical runtime truth.
3. On a copied local database, run the v4 migration and normal session sync.
   Record eligible files scheduled, projection rows created, and a second-start
   no-op. If interrupted, verify the documented forced-sync recovery.
4. Benchmark the health query before/after on the same fixed window and inspect
   `EXPLAIN QUERY PLAN`. Add test assertions naming the expected event-session,
   observation, and catalog-entry indexes; if latency materially regresses,
   batch the ledger reads before considering a persisted rollup.
5. Independently parse a fixed live-data window and compare per-session
   consultation classes to the API. Every difference must identify the session
   and an already-reported coverage reason.
6. Run the exact targeted tests, then `pnpm lint`, `pnpm build`, `pnpm test`,
   `pnpm frontend:check`, and
   `node scripts/verify-skill-context-built.mjs`. Do not rely only on `tsx`
   source.
7. With the built seeded server still available through the script's controlled
   fixture mode, optionally import the actual sibling
   `../dojo/scripts/skill_health_runtime.py` and call
   `load_health_rows(url=<seeded-health-url>, path=None)`. Assert it returns the
   seeded legacy rows. Skip with an explicit message when the sibling is absent;
   keep this out of CI because `~/Dev` is not a monorepo and the in-repo DTO
   test remains the required portable gate.
8. Mark the spec `status: shipped` and plan `status: complete` only after all
   fixture, live reconciliation, and built-runtime checks pass.

**Verification**

- Run: `pnpm lint`
- Run: `pnpm build`
- Run: `pnpm test`
- Run: `pnpm frontend:check`
- Run: `node scripts/verify-skill-context-built.mjs`
- Expect: all repository gates pass; built-server JSON exposes both legacy and
  rich fields for the internally seeded session; expected realization
  create/replay works; the fixed live window has zero unexplained
  reconciliation differences; the actual Dojo extractor accepts the enriched
  response in the controlled smoke.

**Done When**

- All repository and frontend gates pass, the self-contained verifier proves
  built API plus Analytics behavior, migration reparse occurs exactly once per
  qualifying file, and the fixed live window has zero unexplained class/count
  differences.

## Risks And Mitigations

- Risk: Harness JSONL shapes change after the audited versions.
  Signal: parser fixtures pass but new sessions report
  `presentation_signal_absent` or an increasing unclassifiable share.
  Mitigation: keep raw-shape parsing isolated in
  `context-observations.ts`, preserve unknown states, and add a redacted fixture
  before supporting each new shape.
- Risk: Claude asynchronous instruction hooks arrive after a detail request.
  Signal: an instrumented active session reports
  `instrumented_no_events_received`, then gains received load occurrences.
  Mitigation: keep the zero-event state unobservable, expose observation
  timestamps, and document eventual consistency; never turn asynchronous
  absence into a historical non-load claim.
- Risk: Reparse cost is noticeable on a large upgraded session corpus.
  Signal: v4 schedules many watched files and startup sync duration rises.
  Mitigation: use the proven one-shot hash invalidation, keep parsing linear,
  log the scheduled count, and retain `amon sync sessions --source all --force`
  as recovery rather than reparsing on every boot.
- Risk: A profile authority emits malformed, mutable, or stale expectation
  evidence.
  Signal: content hash conflict, missing immutable revision, harness mismatch,
  or invalid validity interval.
  Mitigation: reject association, preserve observed presentation independently,
  and return comparison unavailable with a reason.
- Risk: Runtime catalog limits or measurement units change.
  Signal: unrecognized authority, method, or unit pair.
  Mitigation: degrade occupancy to `unknown`; add a new recognized pairing only
  with a pinned provider/runtime evidence fixture.
- Risk: Shared-ledger refactoring changes a phase-1 total.
  Signal: existing health/daily fixtures or fixed-window live reconciliation
  diverge.
  Mitigation: land the ledger before classification, pin the one intentional
  daily correction (out-of-window OTEL no longer suppresses in-window JSONL),
  keep every other old fixture expectation, and block later tasks until any
  additional difference is explained.
- Risk: Rich consultation detail overwhelms the existing Analytics Overview.
  Signal: the panel requires horizontal scanning for routine questions or hides
  uncertainty behind dense numeric columns.
  Mitigation: keep raw volume separate, group by harness, put the five primary
  screening measures in the scan row, progressively disclose version/project/
  reason detail, and validate desktop plus narrow layouts with real oracle data.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Four-way classification and degraded retention | `node --import tsx --test tests/skill-context-parser.test.ts tests/skill-consultation-analytics.test.ts` | Full oracle is exactly 1/1/1/0; degraded occurrence is retained as unclassifiable |
| Eligible denominator and reasoned coverage | `node --import tsx --test tests/skill-consultation-analytics.test.ts` | Eligible + reason buckets equals all sessions; first-read sessions never exceed eligible |
| Project breadth | `node --import tsx --test tests/skill-consultation-analytics.test.ts` | Project buckets including unknown equal first-read sessions exactly |
| Cross-harness qualification | `node --import tsx --test tests/skill-context-api.test.ts` | Mixed Claude/Codex response is per-harness and reports `different_detection_semantics` |
| Runtime presentation occurrences | `node --import tsx --test tests/skill-context-parser.test.ts tests/session-skill-context.test.ts` | Initial and post-compaction occurrences retain different reproducible fingerprints and byte sizes |
| Expected-realization authority | `node --import tsx --test tests/skill-expected-realizations.test.ts tests/session-skill-context.test.ts` | Diff exists only for one immutable association whose validity covers that presentation occurrence |
| Budget honesty | `node --import tsx --test tests/session-skill-context.test.ts` | One compatible authoritative pair computes; incompatible/unknown cases remain unknown |
| Exposure join | `node --import tsx --test tests/skill-consultation-analytics.test.ts` | With-first plus without-first equals jointly eligible presented sessions |
| Instruction reach | `node --import tsx --test tests/hooks.test.ts tests/claude-hook-installer.test.ts tests/session-skill-context.test.ts` | Received Claude loads are populated; Claude zero-event instrumentation is unobservable; explicit Codex empty differs; compact reason survives |
| Logical skill/version reconciliation | `node --import tsx --test tests/skill-consultation-analytics.test.ts tests/skills-health.test.ts` | Version quality rows sum to logical aggregate and phase-1 totals |
| Phase-1 and Dojo compatibility | `node --import tsx --test tests/skill-invocation-ledger.test.ts tests/skills-health.test.ts tests/skill-context-api.test.ts` | Daily equals health; legacy `data` rows retain required fields |
| Historical backfill | `node --import tsx --test tests/skill-context-backfill-migration.test.ts` | v4 schedules qualifying files once and is idempotent |
| Analytics skill insight | `node --import tsx --test tests/analytics-state.test.ts && pnpm frontend:check && pnpm build && node scripts/verify-skill-context-built.mjs` | Raw daily timeline remains; per-harness consultation/coverage/version/project/exposure detail renders without pooled or value claims |
| Full source and built-runtime gates | `pnpm lint && pnpm build && pnpm test && pnpm frontend:check && node scripts/verify-skill-context-built.mjs` | Gates pass and built API/UI satisfy legacy/rich contracts with zero unexplained live differences |

## Handoff

1. Critique closure is complete: a `gpt-5.6-terra` high-effort reviewer returned
   `READY` after the source-selection correction, async-instruction boundary,
   authority/window fixes, and Analytics scope were revised.
2. Execute Tasks 1-10 in order on
   `feat/skill-invocation-decomposition`, committing coherent green slices and
   never pushing without explicit instruction.
3. Keep the one phase-1 daily correction isolated and fixture-pinned; stop
   execution if any additional legacy total changes without an explained
   coverage/source reason.
