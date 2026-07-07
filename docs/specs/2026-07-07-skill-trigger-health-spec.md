---
date: 2026-07-07
topic: skill-trigger-health
stage: spec
status: draft
source: conversation
---

# Skill Trigger Health & Version Attribution Spec

## Problem

Davis maintains a large catalog of agent skills (dojo) used across Claude Code
and Codex sessions. AgentMonitor already detects skill invocations in ingested
transcripts and shows daily usage counts, but the data cannot drive skill
improvement:

- Invocations carry no **skill version**, so an edit to a skill can never be
  compared against its prior behavior. The version-over-version delta is the
  core of any feedback loop, and it is currently impossible to compute.
- There is no **trigger-health** signal. Skills that never fire (dead weight in
  the session context budget), and skills that fire and are immediately
  redirected by the operator (misfires), are invisible. Dojo's own design
  principle is "the description is the trigger," yet there is no measurement of
  whether descriptions trigger correctly in real sessions.

Today, skill improvement is guesswork: edits are made on intuition and there is
no way to tell whether they helped. This spec covers phase 1 of the feedback
loop: the measurement plane in AgentMonitor, exposed so dojo (the improvement
plane) can consume it.

## Contract

When this ships, the following holds:

1. Every detected skill invocation (explicit `Skill` tool calls and Codex
   `SKILL.md` reads — the existing detection basis) is attributed to a skill
   **version** when the skill can be resolved against a configured skills
   manifest (dojo's `skills.json`). Unresolvable invocations are retained with
   an unknown version, never dropped.
2. A **trigger-health surface** reports, per skill: invocation count,
   last-invoked timestamp, a **never-fired** flag (in-catalog skills with zero
   invocations in the queried range appear explicitly rather than being
   omitted), and a **misfire rate** (fraction of invocations followed by a
   deterministic operator-redirect signal within a bounded window after the
   invocation).
3. Metrics are **backfillable**: recomputing over already-ingested historical
   transcripts populates trigger health for past sessions; no live-only hook is
   required.
4. The data is served as JSON over the existing local HTTP API so a sibling
   repo can consume it without database access.

Verified by:

- `curl -s http://127.0.0.1:3141/api/v2/analytics/skills/health | jq` returns
  per-skill entries containing name, version, invocation count, misfire rate,
  and never-fired status, including at least one never-fired catalog skill and
  at least one version-attributed skill.
- `pnpm test` passes, with fixture-backed tests proving: version join against a
  manifest, unknown-version retention, misfire detection on a redirect fixture,
  non-misfire on a clean fixture, and never-fired inclusion.
- After a historical reparse/import of pre-existing transcripts, the health
  endpoint reports invocations dated before this feature shipped.

## Success Criteria

- The same skill at two different versions is queryable as two distinct series,
  so a before/after comparison of a skill edit is a single API call.
- A catalog skill with zero invocations in the queried range appears in the
  response flagged never-fired.
- A fixture session in which the operator interrupts or redirects immediately
  after a skill fires increments that skill's misfire count; a fixture session
  where work proceeds normally does not.
- Codex-detected invocations participate in counts (version may be unknown).
- From the dojo repo, a single HTTP request retrieves everything needed to rank
  skills by misfire rate and list never-fired skills — no AgentMonitor code or
  DB access required.

## Evaluation

Mechanical/system spec: measured by the verification commands above (tests +
manual curl against seeded/imported data). No kill/scale thresholds.

The downstream bet — that this data actually improves skills — is evaluated in
a later phase by whether skill edits driven by these metrics reduce misfire
rate version-over-version; that is explicitly not a phase-1 gate.

## Scope

**In scope**

- Skill-version attribution via a configurable skills-manifest join.
- Trigger-health metrics: per-skill invocation counts, last-invoked,
  never-fired (against the configured catalog), misfire rate via a
  deterministic redirect heuristic.
- Backfill over already-ingested historical sessions.
- JSON API exposure of the above.

**Out of scope (later phases)**

- Dojo-side consumers: health reports, BACKLOG filing, skill-evals integration.
- LLM-judged outcome scoring of transcript windows.
- Session-retro qualitative feedback capture.
- Per-invocation quality scores or any live scoring pipeline.
- Dashboard/UI visualization of trigger health (API-first; UI may follow).
- Trigger-**miss** detection (skill should have fired but didn't) — requires
  intent inference; only never-fired and misfire are in phase 1.

## Assumptions And Constraints

- Dojo's generated `skills.json` manifest exposes skill name and version and is
  readable from the local filesystem; it is the catalog denominator candidate.
- Existing skill-invocation detection (explicit `Skill` tool calls, Codex
  `SKILL.md` path extraction) is the detection basis; this spec does not add
  new detection channels.
- The misfire heuristic must be deterministic and reproducible over stored
  transcripts (no model calls).
- Local-first: no external services; consistent with AgentMonitor's positioning
  as a local observability console.
- Version attribution reflects the manifest state available at
  computation time; AgentMonitor has no historical record of past manifest
  states, so backfilled attribution is approximate and should be marked as
  such.

## Open Questions

- **Misfire signal set and window**: which events count as operator redirect
  (session interrupt, lexical "no/stop/don't" in the next user prompt, prompt
  rephrase?) and how many turns/seconds after invocation the window extends.
  Needs a small fixture study before the heuristic is frozen.
- **Never-fired denominator**: dojo's `skills.json` only, or the union of
  installed skills across `~/.claude/skills`, plugins, and project catalogs?
  Phase 1 could take a single configurable manifest path and defer multi-source.
- **Backfill version semantics**: attribute old invocations to the current
  manifest version (marked approximate), or leave version unknown for sessions
  predating version capture?
- **Name collisions**: the same skill name can exist in multiple sources with
  different content; is name+version sufficient identity for phase 1?

## Handoff

Route to `write-plan` to sequence the build against this contract. The plan
lands in AgentMonitor (`docs/plans/`) since all phase-1 code changes live
there; dojo consumption is a later-phase contract of its own.
