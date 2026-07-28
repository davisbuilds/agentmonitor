---
date: 2026-07-27
revised: 2026-07-28
author: codex-gpt-5
topic: skill-invocation-decomposition
stage: spec
status: draft
source: conversation
risk_profile: routine
readiness: ready
---

# Skill Consultation and Harness Context Telemetry Spec

## Problem

Phase 1 (`2026-07-07-skill-trigger-health-spec.md`) established a useful
measurement plane: AgentMonitor detects skill invocations across Claude Code and
Codex, attributes them to versions where possible, and exposes the results for
other tools to consume. The plane works, but the headline invocation metric
conflates events with different meanings:

- a skill's first detected consultation in a session;
- a consultation after an observed compaction;
- a repeated consultation without an observed compaction; and
- on lower-fidelity sessions, events whose relationship to compaction cannot be
  established at all.

The conflation is large enough to reverse operational conclusions. In the
2026-07-01 through 2026-07-27 Codex sample, `test-strategy` appeared to have 72
invocations but only 16 first consultations. Raw counts therefore made a
plausibly useful skill look like a severe over-triggering problem. Comparing raw
counts across harnesses compounds the error because Claude Code and Codex expose
different invocation and retention signals.

Catalog-maintenance decisions need more than a corrected count. The operator is
deciding which skills merit global exposure, which belong only in particular
projects, and which may not justify continued maintenance. Today AgentMonitor
cannot show:

- whether a skill was actually presented to a session;
- whether its presented description matched the expected profile;
- whether it was consulted broadly or only within one project;
- whether apparent non-use means "presented but not consulted," "not
  presented," or "not observable";
- whether a catalog measurement fits an authoritative harness limit; or
- which instruction files actually reached a session.

Those gaps cannot be filled by treating invocation frequency as skill value. A
rare skill may prevent an expensive mistake, while a frequently read skill may
add no marginal value. The needed product is an honest evidence plane for
portfolio decisions, not an automatic keep/remove verdict.

The same distinction applies across repositories. A profile manager can define
the desired catalog and emit an expected realization, while AgentMonitor can
observe what a harness actually presented. Filesystem state is not proof of
runtime presentation, and current filesystem state must not be used to
reconstruct what a historical session was expected to receive.

## Contract

When this ships, all of the following observable behaviors hold, verified by
`pnpm test` and the invariant checks described below.

1. **Detected consultations are decomposed without discarding uncertainty.**
   Every detected skill invocation is classified as exactly one of
   `first_read`, `rehydration_after_compaction`,
   `repeat_no_compaction`, or `unclassifiable`. An unclassifiable event carries
   a machine-readable reason rather than being forced into a plausible class.
   For every reported skill, version, harness, and window, the four class counts
   sum exactly to the existing invocation total.

2. **Engagement rates use an eligible denominator.** For every skill and
   harness, the analytics response distinguishes:

   - all sessions in the requested window;
   - sessions whose retained evidence is sufficient to classify consultations;
   - eligible sessions containing at least one `first_read`; and
   - ineligible sessions grouped by machine-readable coverage reason.

   A first-read engagement rate is calculated only from eligible sessions.
   `sessionsWithFirstRead` never exceeds `eligibleSessionsInWindow`, and the
   eligible plus ineligible session counts reconcile to `sessionsInWindow`.

3. **Project breadth is observable without becoming a value judgment.** First
   consultation sessions are attributable to a stable project identity when the
   session exposes one, with an explicit `unknown` bucket otherwise. For every
   skill and harness, the per-project session counts reconcile exactly to
   `sessionsWithFirstRead`, and the response reports the number of distinct
   observed projects with a first consultation. This makes broadly consulted
   skills distinguishable from project-concentrated skills without labeling
   either category as good, bad, global, or removable.

4. **Cross-harness comparisons are qualified by construction.** A response that
   spans multiple harnesses reports consultation metrics per harness and carries
   a structured comparability status. It never presents a pooled raw invocation
   count, first-read rate, or non-use conclusion as directly comparable when
   event semantics or coverage differ. The status names the limiting evidence,
   rather than using an unexplained warning string. A pre-existing pooled field
   retained solely for API compatibility is explicitly machine-labeled
   compatibility-only and non-comparative; new consumers use the per-harness
   decomposition.

5. **Runtime catalog presentation is reported only from runtime evidence.**
   For every session where the harness exposes its presented skill catalog,
   AgentMonitor reports each observed presentation occurrence rather than
   collapsing differing initial and post-compaction presentations. Each
   occurrence reports:

   - `observable: true`;
   - the skill identities and descriptions actually presented;
   - each entry's source location or scope when the runtime exposes it, and
     `unknown` otherwise;
   - a deterministic fingerprint of the presented catalog;
   - an exact presentation-size measurement with its unit; and
   - whether truncation or omission was explicitly observed, explicitly not
     observed, or cannot be determined.

   A missing truncation marker is not interpreted as proof that truncation did
   not occur. Where no per-session presentation signal exists, the session
   reports `observable: false` with a reason; it never substitutes the installed
   filesystem catalog.

6. **Expected-versus-presented comparison requires an occurrence-valid expected
   realization.** When a session is associated with an immutable expected
   catalog realization, AgentMonitor preserves that realization's identity and
   provenance and can compare expected members and description fingerprints
   only when that specific presentation's timestamp falls within the
   realization's validity interval. Only then may it report omitted,
   unexpected, or description-mismatched skills. A session can therefore have a
   valid initial comparison and an unavailable later comparison. Without
   occurrence-valid expectation evidence, comparison reports `unavailable`; it
   must not compare a historical presentation with the current filesystem or
   silently infer the intended profile.

7. **Budget occupancy never compares incompatible or unauthoritative numbers.**
   Each catalog-size measurement and each applicable limit reports its value,
   unit, derivation method, and authority/provenance. An occupancy status is
   reported only when measurement and limit are comparable. An undocumented
   limit, an unknown session context window, an estimated value presented as
   exact, or incompatible units yields `unknown`, not an over/under-budget
   claim. An authoritative policy artifact identifies the applicable
   harness/model/version, context window, representation, unit, measurement
   method, evidence source, observation time, and freshness; a caller-supplied
   authority label alone is insufficient. Provider-policy changes can therefore
   make a result unknown without retroactively producing a false result.

8. **Catalog exposure and consultation can be joined only on jointly eligible
   sessions.** Where both runtime catalog presentation and consultation
   classification are observable, the analytics response reports, per skill
   and harness:

   - jointly eligible sessions in which the skill was presented;
   - those sessions with a first consultation; and
   - those sessions with no detected first consultation.

   The latter two counts sum exactly to the presented-session denominator.
   Sessions lacking either evidence source remain visible in coverage totals
   and cannot be counted as presented-but-unconsulted. This gives catalog
   slimming work a defensible exposure signal without claiming outcome value.

9. **Instruction-file reach distinguishes absence from missing telemetry.** For
   each session where instruction loading is observable, AgentMonitor reports
   the instruction identities that reached the session and any harness-provided
   load reason. A session without the necessary telemetry reports
   `observable: false`; it is never represented as an observed empty file list.
   Configuration for an asynchronous hook without any received load events is
   also unobservable, because non-delivery cannot prove absence. An observed
   empty list requires an explicit runtime channel that reports the empty state.
   Repeated loading after compaction remains distinguishable from initial
   loading when the harness exposes that reason.

10. **Skill identity survives version changes while preserving attribution
    quality.** A skill whose version changed within a queried window is reported
    as one logical skill with a per-version breakdown. Exact, approximate, and
    unknown version attribution remain distinguishable. The per-version
    invocation and consultation-class counts reconcile exactly to the logical
    skill aggregate.

11. **Phase 1 behavior remains available and reconcilable.** Existing version
    attribution, never-fired detection, misfire eligibility, coverage
    reporting, and daily analytics remain available. One known phase-1
    inconsistency is corrected: Codex OTEL rows are date-filtered before marking
    a canonical session as event-backed, matching health's existing behavior,
    so an out-of-window OTEL row cannot suppress an in-window JSONL fallback.
    Apart from that fixture-pinned correction, the existing harness
    source-selection and fallback rules remain the canonical occurrence set;
    richer parser evidence may classify a selected occurrence but cannot add,
    replace, or suppress one. Daily and health totals reconcile for the same
    filters and window, even if one surface points to the richer decomposition
    rather than duplicating every field.

The contract is falsified by any unexplained reconciliation failure, any rate
whose denominator includes ineligible sessions, any omission claim without a
presentation-valid expected realization, or any presentation of unavailable
telemetry as an observed empty result.

## Success Criteria

- A transcript-level check of a full-fidelity fixture returns the same
  `first_read`, `rehydration_after_compaction`, and
  `repeat_no_compaction` counts as the analytics response, with zero
  unclassifiable events.
- The equivalent degraded-fidelity fixture retains every detected invocation,
  assigns unsupported classifications to `unclassifiable`, and exposes the
  coverage reason.
- For a skill and time window, the operator can distinguish broad
  cross-project consultation from consultation concentrated in one project,
  separately for each harness.
- For a session with observable catalog presentation, the operator can inspect
  exactly what was presented and reproduce its fingerprint and size
  measurement from the retained source evidence.
- When presentation provenance is observable, the operator can distinguish a
  globally or profile-exposed skill whose consultations are concentrated in one
  project from a skill whose exposure was already project-local. Unknown
  provenance remains explicit rather than being inferred from the skill name.
- Omitted or description-mismatched skills appear only when a valid expected
  realization was associated with that session. The same observation without
  that realization reports comparison unavailable.
- A portfolio review can identify evidence-backed candidates for closer
  evaluation: skills broadly presented but not consulted in jointly eligible
  sessions, skills consulted only in a narrow project set, and skills whose
  descriptions were not presented as expected.
- No API response or product label calls a skill low-value, redundant, global,
  project-local, or removable based only on the signals in this contract.
- Instruction-file reach answers "observed loaded," "observed no loads," and
  "not observable" as three distinct states.
- A skill used in one harness and not observed in another is shown as asymmetric
  evidence, not as globally unused.
- The class-decomposition, catalog-presentation, expected-versus-presented,
  project-breadth, and instruction-reach analyses are reproducible from the
  local product without bespoke transcript scripts.
- The `/app/` Analytics Overview keeps raw invocation volume distinguishable
  from per-harness first-read engagement and exposes coverage, project breadth,
  version, and presentation-join detail without pooled cross-harness or
  skill-value labels.

## Evaluation

This is a system/measurement contract, not a product or experiment bet, so no
kill, scale, or graduate thresholds apply.

Correctness is evaluated against independent, hand-checked fixture oracles and
the following invariant classes:

- **Consultation classification:** a full-fidelity multi-session corpus includes
  first consultations, multiple reads, compaction boundaries, post-compaction
  reads, two harnesses, and a degraded session. Every detected invocation is
  accounted for exactly once.
- **Coverage and denominators:** eligible and ineligible sessions reconcile to
  all sessions; first-read sessions do not exceed eligible sessions; every
  ineligible session has a reason.
- **Project breadth:** per-project first-read session counts, including
  `unknown`, reconcile to the first-read session total without counting a
  session twice for the same skill.
- **Runtime presentation:** known initial and post-compaction catalog blocks
  reproduce their respective entry sets, descriptions, available source
  provenance, exact-size measurements, and fingerprints without being
  incorrectly collapsed. Removing the presentation signal changes the result
  to `observable: false`, not an empty catalog.
- **Expected comparison:** matching, omitted, unexpected, and
  description-mismatched entries are correct against a pinned realization.
  Missing, unrelated, or temporally invalid realization evidence makes the
  comparison unavailable.
- **Budget honesty:** comparable measurements and limits produce the expected
  occupancy status; unknown authority, incompatible units, and unavailable
  context-window evidence each produce `unknown`.
- **Exposure join:** presented-with-first-read plus
  presented-without-first-read equals jointly eligible presented sessions.
  Sessions with missing presentation or classification evidence do not enter
  that denominator.
- **Instruction reach:** observed populated, observed empty, and unobservable
  fixtures remain distinct, and harness-provided load reasons survive.
- **Version aggregation:** per-version counts, including approximate and unknown
  attribution, reconcile to the logical skill aggregate.
- **Cross-harness safety:** mixed-harness output preserves per-harness values and
  the structured comparability status.

For a fixed live-data window and harness, decomposed counts must also match an
independent transcript parse exactly, or every discrepancy must identify the
affected session and an already-disclosed coverage reason. There is no numeric
tolerance for unexplained discrepancies.

`pnpm lint`, `pnpm build`, and `pnpm test` must all pass. A seeded local API
response must additionally satisfy the reconciliation invariants using
`curl -s http://127.0.0.1:3141/api/v2/analytics/skills/health | jq -e`.

## Scope

### In Scope

- Decomposing the existing detected skill-invocation basis into consultation
  classes while retaining unclassifiable events.
- Reporting eligible-session engagement and explicit coverage reasons.
- Reporting first-consultation breadth by observed project.
- Preserving safe cross-harness comparability semantics.
- Reporting per-session runtime catalog presentation where observable.
- Comparing observed presentation with an immutable, occurrence-valid expected
  realization when one is available.
- Reporting catalog measurements, limits, and occupancy with units, methods,
  and provenance.
- Reporting presented-versus-consulted evidence over jointly eligible sessions.
- Reporting observable instruction-file reach.
- Aggregating logical skill identity across versions without losing attribution
  quality.
- Exposing the evidence over AgentMonitor's local JSON API.
- Surfacing the aggregate, per-harness consultation evidence in the canonical
  `/app/` Analytics Overview while preserving uncertainty and avoiding
  value/removal labels.

### Out of Scope

- Deciding whether a skill improved an outcome or created marginal value.
- Automatically recommending, disabling, deleting, globalizing, localizing, or
  otherwise changing a skill or distribution profile.
- Defining or applying the desired skill profile; another system may supply an
  expected realization, but AgentMonitor remains the observation plane.
- Treating current installed filesystem state as historical session truth.
- Filesystem, cross-machine, or canonical-versus-installed drift detection.
- Widening or replacing the existing misfire heuristic.
- Broadening which events count as detected skill invocations.
- Inferring a missed trigger where no skill consultation was detected.
- Remote telemetry publication or any dependency on an external service.
- Changes to the legacy `/` dashboard or an automated recommendation/ranking
  surface.
- Outcome experiments or qualitative review needed to decide whether a
  low-frequency skill should actually be removed.

## Assumptions And Constraints

- Raw Codex session records expose compaction events and presented catalog
  blocks in the audited version, although current AgentMonitor ingestion does
  not retain all of those signals.
- No equivalent per-session Claude Code catalog-presentation signal is currently
  known. Unless one is observed, Claude catalog presentation remains
  `observable: false`; an installed-catalog scan is a different fact and cannot
  substitute for it.
- Codex and Claude Code do not expose identical skill-event semantics.
  Classification names describe detected consultation evidence, not a claim
  about inaccessible model-internal state.
- Claude Code instruction reach is observable only for sessions carrying the
  relevant received instruction-load telemetry. Older or uninstrumented
  sessions remain unobservable; configuration for an asynchronous hook is not
  receipt evidence.
- Project identity can be absent or ambiguous. Such sessions remain in an
  explicit `unknown` project bucket and are not guessed from unrelated current
  state. Where a harness reports cwd changes, first-consultation breadth uses
  the project identity observed at that consultation rather than rewriting
  history from the session's final cwd.
- An expected realization is optional input from an external profile authority.
  Raw presentation observation remains useful without it, and unavailable
  comparison does not invalidate the observation.
- Expected realization provenance must be immutable enough to establish what
  was intended for the specific presentation occurrence. A mutable path or
  today's installed catalog is insufficient historical evidence by itself.
- Harness limits and context windows can change. Unknown or stale policy
  evidence degrades budget status to `unknown`, never to a guessed result.
- Historical ingestion fidelity is uneven. The contract exposes that ceiling
  through eligibility and reasoned coverage rather than silently shrinking the
  denominator. A malformed or unsupported record that could conceal a
  consultation or compaction degrades the affected session to unclassifiable.
- AgentMonitor is local-first. Session identifiers, project identities,
  instruction paths, and catalog contents are not published externally by this
  contract.
- Invocation, presentation, and project-breadth signals are portfolio-screening
  evidence only. Final slimming decisions require qualitative or
  outcome-oriented evaluation outside this contract.

## Open Questions

None. Unknown future harness capabilities and policy values are contained by the
observable/unknown states above and do not change the current contract.

## Handoff

1. Fresh `gpt-5.6-terra` high-effort critique and closure completed on
   2026-07-28 with both cross-repository audits, the distribution-profile
   contract, downstream consumer, and implementation source in context.
2. Blocking findings were revised: canonical phase-1 source selection,
   asynchronous instruction non-delivery, occurrence-time realization validity,
   policy authority, parser completeness, and mixed-harness compatibility.
3. Execute
   `docs/plans/2026-07-28-skill-invocation-decomposition-plan.md`.
