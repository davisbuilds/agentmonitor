---
date: 2026-11-27
author: Codex
topic: codex-context-evidence
stage: spec
status: draft
source: conversation
risk_profile: high
readiness: ready
---

# Codex Context Evidence Spec

## Problem

AgentMonitor recognizes skill-catalog text without establishing who supplied it
or whether it is a complete listing. An incremental update, user quotation, or
copied compaction history can therefore become a complete catalog occurrence.
Some nonempty instruction blocks also appear as an observed empty file list.
These errors undermine comparisons between intended and observed context.

## Contract

Codex session context distinguishes authentic historical emissions from the
latest reconstructable catalog state. Unsupported evidence remains unknown;
it cannot certify absence, complete membership, instruction reach, or budget
compliance. Existing context endpoints and analytics agree on that distinction.
Verify through `pnpm verify:skill-context-built` after `pnpm build`, plus focused
parser, persistence, watcher and session-context tests. The positive control must
recover exactly two independent source catalogs and preserve both distinct
same-name locators through an update; an empty result cannot satisfy this contract.

## Success Criteria

- **SC-01 — Provenance.** Catalog observations originate only from supported
  harness-authored developer records or corroborated fresh native checkpoints.
  User/assistant quotations and explicitly non-skill developer content are
  excluded. An explicitly typed but unsupported catalog invalidates the affected
  source's current evidence with a reason; it cannot silently preserve a healthy
  current state. Legacy developer catalogs remain supported when recognizable.
- **SC-02 — Sources and identity.** Full Host, Cloud and Selected-environment
  catalogs replace only their own source. Supported updates apply to a verified
  base by resolved locator identity. Distinct same-name skills remain distinct;
  a rename at the same locator replaces its prior identity. Alias rebinding
  changes subsequent references without rewriting earlier identities. Ambiguous
  removals, unresolved aliases and unrecognized update semantics make the affected
  current source unknown until an authoritative full catalog restores it.
- **SC-03 — History and current state.** Historical full and update occurrences
  remain distinguishable from current effective membership. An update's entries
  are not compared as a complete catalog. Current composition carries its basis
  and uncertainty; partial or unknown sources cannot produce a complete matched
  or missing-membership verdict. Repeated updates do not persist another full
  catalog copy on every occurrence. Source-qualified catalogs are not compared
  against a harness-wide expected realization unless matching source scope is
  explicitly established. The existing expected artifact has no source scope;
  these comparisons remain unavailable. Supported full legacy harness-wide
  catalogs retain complete comparison. Positively observed validated historical
  entries may contribute to exposure even when complete comparison is unavailable;
  unvalidated legacy rows and unsupported payloads contribute no exposure.
- **SC-04 — Compaction and rollback.** Replayed replacement history creates no
  fresh consultations, presentation timestamps or runtime attribution. Fresh
  checkpoint evidence requires aligned replacement metadata for the exact typed
  full catalog item with no replay history sequence, a full world-state snapshot
  with matching source body and `includeInstructions: true`, and admissible turn
  context. A copied item is not fresh even if its body matches that checkpoint.
  Uncorroborated changed context and inline thread rollback invalidate
  the reconstruction until supported full evidence restores it. Existing physical
  history-file ancestry handling remains intact.
- **SC-05 — Scope and timing.** Resumed catalogs are associated with their
  matching turn's project and model, including when the catalog precedes the turn
  context. The first following typed context closes the pending catalog batch;
  malformed context closes it as unknown. A recorded conflicting turn ID,
  subsequent user request, assistant/tool execution, terminal turn marker,
  rollback, compaction, or competing same-source catalog closes an unresolved
  batch as unknown before later context can claim it. Different-source catalogs
  may share one batch. Missing or incomplete companion context cannot borrow a
  prior turn. Historical occurrence times are preserved;
  resumed/inherited process versions remain unknown unless directly supported.
- **SC-06 — Measurements.** Retained UTF-8 block bytes retain their existing
  meaning. Update bytes and reconstructed membership do not become a native
  total-context cost or measured renderer ceiling. Budget comparison requires
  compatible units, scope and runtime evidence; otherwise it reports unknown.
- **SC-07 — Instruction presence.** A supported nonempty instruction block
  without file attribution establishes block presence with unknown file identity,
  not zero loads. Supported directory evidence may identify a file. Only a
  producer-supported explicit empty snapshot establishes observed empty.
  Unrecognized shapes remain unavailable; instruction bodies gain no new stored
  or exported copy, and referenced paths cause no filesystem reads.
- **SC-08 — Stored evidence.** Previously derived Codex context is distinguishable
  from evidence validated by this contract. Until successful reprocessing, all
  affected context and consultation consumers report its coverage as unverified;
  they cannot continue treating old quoted/copied records as proven observations.
  Normal source synchronization reprocesses eligible retained files even when
  their content hash or modification time is unchanged. Source-missing sessions
  remain inspectable with explicit unknown context coverage.
- **SC-09 — Atomicity and isolation.** A successful reprocess publishes coherent
  observations, capabilities and current state together. Repeated or incremental
  synchronization converges to the same semantic result as full parsing. Failed
  parsing does not destroy unrelated messages, usage, hook events or other agents'
  data. Production reprocessing and service rollout remain separate from tests.
- **SC-10 — Bounds.** Catalog payloads, composition and retained observation
  history have explicit finite limits. Oversize input produces bounded partial or
  unknown evidence with machine-readable reasons, not an endpoint failure or a
  complete empty result. Prior eligible retained history remains inspectable.
  Diagnostics cannot contain arbitrary input text. Whole and incremental parses
  apply the same limits, including cumulative historical entry counts.

## Evaluation

Use sanitized fixtures through the compiled parser, temporary SQLite store,
watcher and v2 endpoint. Establish positive controls with two full-source catalogs,
distinct same-name locators, one rename, and successive updates; assert exact
historical occurrences and current membership. Exercise the same stream whole
and split across catalog/context boundaries. Assert downstream comparison and
consultation analytics, not just parser metadata. Existing source and built
skill-context checks must continue to pass with corrected expectations for
previously accepted copied or quoted records.

## Scope

Codex catalog provenance and composition, context timing, compaction/rollback
boundaries, instruction presence, affected stored-evidence refresh, and existing
read consumers. Claude native attachment implementation, Agy parity, permission
timelines, subtree aggregation, tokenization, new hooks, exports, and a shared
Dojo runtime dependency are excluded. Dojo's published synthetic grammar cases
may inform tests; Amon remains independently usable.

## Assumptions And Constraints

- Transcript records are untrusted input; supported provenance describes the
  harness record, not cryptographic attestation or complete provider input.
- Future format changes are irreducible uncertainty. Typed unknown input is
  observable uncertainty with a reason, never a fabricated empty set.
- Existing local access and capture boundaries remain in force. New derived
  metadata is bounded and content-minimized; no new dependency is required.
- Historical events and current composition have different meanings. Consumers
  may inspect retained old data without using it as verified current evidence.

## Open Questions

None blocking. Full native history reconstruction beyond supported checkpoints
is excluded; an unsupported boundary remains unknown until fresh evidence.

## Authority And Safety

The existing local writer may read configured transcript sources and replace
derived context for their owning sessions. It cannot modify native logs, execute
their contents, read paths named in instruction blocks, or broaden export scope.
API readers expose allowlisted metadata and no new instruction body. Reprocessing
cannot use current filesystem contents to invent historical file identity.
Partial failure preserves a coherent prior or completed projection while retaining
the validation-version distinction; retries cannot increase event multiplicity.

## Evaluation Scenarios

- **EV-NEG-01 (SC-01, SC-03, SC-07).** User-pasted catalog and instruction text,
  non-skill developer payload and unsupported typed update produce no false
  complete-catalog or zero-instruction claim. A body sentinel and external file
  path trigger neither a new content copy nor a file read. An oversized catalog
  and a sequence exceeding retained-history limits leave the endpoint available
  with partial/unknown evidence (SC-10). A source-qualified Host-only listing
  cannot claim omitted Cloud skills against a harness-wide expected artifact.
- **EV-REC-01 (SC-02, SC-04, SC-05).** Stop after a catalog but before its companion
  context; resume with valid or malformed context. Exercise unsupported delta,
  compaction and rollback followed by a full refresh. Unknown state is visible
  during the gap and exact membership recovers without duplicated consultations.
  Include a replay-marked replacement with an otherwise matching checkpoint and
  an intervening turn boundary followed by an unrelated valid context.
- **EV-CON-01 (SC-08, SC-09).** Replay and resync the same source, including split
  appends and an interrupted publication, through the normal writer. Readers see
  coherent previous or new state; successful retries converge to the same
  observations and leave other sessions and usage untouched.
- **EV-LEG-01 (SC-01, SC-08).** Recognizable legacy developer catalogs remain
  readable. An unchanged file with an old derived-evidence version reparses once;
  unavailable source and stale stored quoted records cannot certify context in
  either session detail or aggregate consultation analytics.

## Readiness Review

- Deterministic validation: passed
- Adversarial critique: complete
- Closure critique: complete
- Blocking findings: none

Review tightened source scope, replay provenance, companion boundaries and
bounded overflow behavior. Closure review found no remaining blocking findings.
