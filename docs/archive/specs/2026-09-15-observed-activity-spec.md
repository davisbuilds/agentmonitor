---
date: 2026-09-15
author: codex
topic: observed-activity
stage: spec
status: complete
source: conversation
risk_profile: routine
readiness: ready
---

# Observed Activity Spec

## Problem

Transcript inventories omit sessions known only through telemetry. Counting one
as all activity misrepresents coverage and comparisons between harnesses.

## Contract

An additive, content-free activity inventory reconciles observed session identities
across event and browser evidence without requiring a transcript. Verify with
`node --import tsx --test tests/v2-observed-activity.test.ts`.

## Success Criteria

- One Claude identity evidenced by both events and a transcript counts once;
  an event-only identity and a transcript-only identity each also count once.
- Recognized Codex rollout/native UUID aliases count once. Other providers,
  unknown producer modes, and malformed aliases remain distinct.
- Transcript availability and usage evidence are separate flags. Availability
  means retained readable content, not presence of an original file on disk.
- Benchmark events do not establish ordinary activity. Launch receipts alone
  never manufacture native sessions or token totals.
- Selection precedes filtering/pagination. Tied timestamps paginate without loss.
- Observed dates distinguish projected starts from first event evidence;
  unknown timezones are not silently interpreted as local or UTC.
- Existing session browser, usage totals, stored history and detail links remain
  unchanged. Responses contain no prompts, paths, project names or tool payloads.

## Evaluation

Use an isolated real SQLite database and HTTP requests. Assert exact identity sets,
not merely increased counts; include empty inventories, overlap, event-only,
transcript-only, malformed dates, benchmarks and tied-page boundaries.

## Scope

Includes additive session accounting and explicit coverage. Excludes changing
existing billing aggregates, reconstructing missing transcripts, remote access,
and claiming complete capture. Execution collection is a separate contract:
executions are not native sessions without source evidence linking them.

## Assumptions And Constraints

This slice is read-only over existing state, with no migration or new authority.
Session identities are source-local, scoped by harness. Subagents count separately
when their source identity is separate. Retrieval is not an atomic multi-page
snapshot; consumers must retry if inventory changes.

## Open Questions

None.

## Handoff

1. Implement the additive API, then integrate consumers after contract checks.
