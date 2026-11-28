---
date: 2026-11-27
author: Codex
topic: claude-native-context-attachments
stage: spec
status: draft
source: conversation
risk_profile: high
readiness: ready
---

# Claude Native Context Attachments Spec

## Problem

Claude retains typed skill listings and instruction attachments in its session transcript.
AgentMonitor currently skips attachments, reports Claude catalog presentation as unavailable,
and relies on `InstructionsLoaded` hook delivery to establish instruction reach. The session
view therefore omits native evidence when the transcript contains it.
[Record classification](../../src/parser/record-types.ts) ·
[Hook contract](../api/event-contract.md)

## Contract

The existing Claude session skill-context endpoint exposes supported native catalog and
instruction observations from retained transcripts. It distinguishes observed evidence,
a producer-recorded empty set, and unavailable evidence. Reprocessing an eligible session
publishes one consistent projection. Verify the compiled watcher, persisted state, and
endpoint with `pnpm build` and `pnpm verify:skill-context-built`.

## Success Criteria

- **SC-01 — Skill listing evidence.** A valid initial `skill_listing` exposes ordered names,
  reported count, valid opaque native digests, source, and observation time when recorded.
  Native digests have a separate field from `descriptionFingerprint`, which stays null
  for native attachment entries. A valid later attachment appears separately. A later-only
  transcript exposes that evidence and leaves initial coverage unknown. The effective later
  catalog remains unknown.
- **SC-02 — Coverage and malformed evidence.** A supported initial attachment with count
  zero and consistently empty entries is observed empty. Missing, malformed, or unsupported
  attachments produce unavailable or partial coverage with a reason. A malformed later record
  preserves preceding valid occurrences. An inconsistent count, names, or digests makes
  coverage of the full catalog unknown. Prompt text resembling an attachment creates no
  native observation.
- **SC-03 — Instruction reach.** Supported native `instructions` and `nested_memory`
  attachments expose recorded file identity, source, and producer-recorded type, time, and
  reason where available. A native list establishes reach for the represented files.
  Completeness of the session's loaded instruction set remains unknown.
- **SC-04 — Hook overlap.** Hook-only evidence retains its current behavior. Native and hook
  evidence for the same canonical file in one session contribute one unique reached file and
  preserve both sources. Merge individual occurrences only when the evidence identifies the
  same load. Otherwise retain both observations and leave the number of physical loads
  uncertain. Distinguish recorded repeats and files with the same name at different paths.
- **SC-05 — Cost and comparison.** Catalog token cost, producer truncation, and budget
  compliance remain unknown unless matching producer evidence supports them. An initial
  listing may support a names-only comparison when the expected realization is valid at
  observation time and evidence establishes that it covers the same scope. Describe any
  difference at the name level. All native attachments leave description agreement unknown.
  Later and incomplete occurrences are ineligible for comparison against a full catalog.
  Aggregate Claude catalog exposure and its denominators stay unchanged.
- **SC-06 — Reprocessing.** Normal watcher sync replays eligible legacy transcripts once for
  this projection revision, including previously synced files with unchanged hashes and mtimes.
  Native observations and coverage publish together. After success, subsequent unchanged
  syncs leave the projection unchanged. A failed replay can retry and converges to the same
  semantic result. Missing or unreadable source preserves previously supported evidence and
  its provenance. Legacy unsupported claims remain unverified and replay eligibility alone
  establishes neither current coverage nor freshness.
- **SC-07 — Data minimization.** Storage, API responses, logs, and exports gain only the
  allowlisted metadata described here, within the existing local session access boundary.
  Attachment bodies, skill descriptions, instruction text, and unrelated payloads are excluded.
- **SC-08 — Projection bounds.** Bound additional attachment processing and projected metadata
  per record and cumulatively per session, including entry counts and field sizes. When data
  exceeds a bound, report partial or unavailable coverage using an allowlisted reason that
  identifies the reached limit. A skipped suffix leaves earlier eligible observations and
  hook evidence available. Oversized input cannot turn a working endpoint into an error,
  imply an empty catalog, or insert raw values into diagnostics.

## Evaluation

Extend the built oracle with a disposable database and sanitized Claude fixtures. The positive
fixture has two initial skills, a later listing naming a different skill, two instruction files,
and overlapping hook and native evidence for one file. Assert exact ordered occurrences,
availability, unique reached identities, and evidence sources through the compiled endpoint.
Verify an explicit-empty initial listing and the existing hook-only states. For a proven
same-scope initial listing, assert the exact missing and extra skill names. Give one shared
name a native digest equal to the expected description fingerprint and assert unknown
description agreement. Repeat with unproven scope and assert unknown comparison. Compare
aggregate exposure with the old projection over the same inputs. Run the focused session
skill-context, parser, and persistence tests alongside the built oracle.

## Scope

Claude skill-listing attachments, native instruction and nested-memory reach, hook
reconciliation, and replay of eligible retained Claude transcripts. Aggregate catalog
exposure, parent-child aggregation, permission timelines, prompt reconstruction, token
estimation, changes to consultation counts, and new export surfaces are outside the scope.

## Assumptions And Constraints

- Observed `skill_listing` attachments carry `names`, `digests`, `skillCount`, and `isInitial`.
  `isInitial: false` establishes a later observation. How later attachments compose and account
  for removals remains unverified. The producer has not established the digest algorithm or the
  data that the digest represents.
- Native `instructions.files` entries can carry `path`, `type`, and `content`. A
  `nested_memory` attachment carries a path and body. Use native `changed` and `reason`
  only where their meanings are established. A bare path identifies a file and supplies no
  evidence of a physical load's trigger or time.
- File identity uses the recorded path and deterministic lexical normalization within the
  owning session. The projector may read its existing transcript inputs. It has no authority
  to resolve attachment paths on disk or reconstruct the provider prompt.

## Open Questions

None blocking. Effective catalog composition is outside this contract pending a supported
producer contract or controlled positive and negative evidence.

## Authority And Safety

- The local writer may project data from existing transcript inputs into the AgentMonitor
  store. The endpoint may expose allowlisted metadata for the requested session.
  Transcripts, hooks, and Claude configuration are outside the writer's mutation authority.
- Treat transcript content as data. Paths in attachments cannot trigger file reads or expand
  source scope. Unsupported shapes cannot expand collection or imply complete coverage.
  Diagnostics use allowlisted reason codes and contain no attachment payload or raw parser error.
- An interrupted replay leaves either the previous coherent projection or the complete new
  projection. Source identity, observations, and coverage agree after retry. A later hook
  event may add evidence while preserving retained native observations.

## Evaluation Scenarios

- **EV-NEG-01 (SC-02, SC-07).** A user message mimics a skill attachment. A malformed native
  attachment contains a body sentinel and refers to a file outside the fixture. The imitation
  creates no observation, the malformed record communicates uncertainty, the referenced
  file stays unread, and the sentinel appears in no new projection, response, or log.
- **EV-NEG-02 (SC-07, SC-08).** Append an attachment above the per-record limit to a session
  with two valid earlier observations, then exceed the cumulative bound using small records.
  The endpoint returns normally and retains previously eligible observations. Each exceeded
  limit produces an allowlisted coverage reason without echoing a sentinel from the input.
  Neither case becomes an observed-empty catalog.
- **EV-REC-01 (SC-06).** Interrupt replacement after parsing a changed source and before
  publication completes. The endpoint serves the previous coherent projection. A successful
  retry publishes the new coherent projection and removes obsolete native rows.
- **EV-CON-01 (SC-04, SC-06).** Replay a transcript twice while an overlapping hook event
  arrives. Either arrival order yields one listing per source occurrence, one unique reach
  entry for the overlapping file, and consistent provenance. A separate repeated load stays
  visible.
- **EV-LEG-01 (SC-02, SC-06).** An older cached session with an unchanged hash and mtime
  acquires the new observations through normal watcher sync. The next unchanged sync leaves
  them alone. A hook-only session and a stored session whose source is missing keep their
  previously supported evidence. Missing source and unknown attachment shapes produce neither
  a new coverage claim nor an observed-empty catalog.

## Readiness Review

- Deterministic validation: passed
- Adversarial critique: complete
- Closure critique: complete
- Blocking findings: none
