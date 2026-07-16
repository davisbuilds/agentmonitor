---
date: 2026-07-16
topic: usage-overview-performance
stage: spec
status: complete
source: conversation
---

# Usage Overview Performance Spec

## Problem

The canonical Usage view now crosses its documented performance trigger on the
current installation: a representative 30-day overview takes roughly 235 ms on
warm reads and more than 500 ms cold, while the backlog calls for revisiting the
path above 150 ms. The response is otherwise correct and consolidates the page's
panels, so the work must improve latency without weakening coverage honesty,
filter semantics, distinct-session counts, or response compatibility.

## Contract

When this ships, the Usage overview returns the same JSON contract and values as
the existing per-panel Usage endpoints while a representative 30-day warm read
completes below 150 ms median, verified by `pnpm test tests/v2-usage.test.ts` and
`pnpm bench:usage -- --date-from 2026-06-17 --date-to 2026-07-16 --runs 5`.

## Success Criteria

- The overview remains value-equivalent to the summary, daily, projects, models,
  models-daily, tiers, agents, top-sessions, and coverage responses it combines.
- Project, agent, model, provider, tier, and date filters retain their existing
  behavior, including canonical-model classification and exclusion of overlapping
  Codex OTEL usage.
- Daily gap filling, prior-period comparison, distinct session counts, coverage
  totals, top-session metadata, pricing-known counts, and cache-savings estimates
  remain exact.
- A read-only benchmark reports warmup and measured timings, response size, and
  matching/usage row counts for the Usage overview.
- On the current installation's representative 30-day window, the median of five
  warm overview reads is below 150 ms.

## Evaluation

- **Kill:** stop the direct-path approach if it cannot improve warm median latency
  by at least 25% without changing observable Usage values.
- **Scale:** consider a persisted, session-grained derived store only if the
  direct path preserves parity but still exceeds 150 ms on the representative
  window.
- **Graduate:** all behavior and contract tests pass, the benchmark is repeatable
  and read-only, and the current installation's five-run warm median is below
  150 ms.

## Scope

### In Scope

- The canonical Usage overview read path and its shared Usage calculations.
- A repeatable, read-only performance measurement for that path.
- Regression protection for response parity and any proven query-plan invariant.
- Current operational and backlog documentation for the measured performance
  boundary.

### Out of Scope

- Changes to the Usage API response shape or the Svelte Usage interface.
- Approximate counts, reduced coverage, or relaxed filtering semantics.
- General analytics, Monitor, legacy dashboard, ingestion, or pricing changes.
- A persisted rollup unless the direct path reaches the Scale condition.

## Assumptions And Constraints

- The current installation's 30-day window is the acceptance dataset; automated
  tests use isolated temporary databases and never open the install database.
- Wall-clock latency varies by machine and cache state, so correctness and query
  plan checks are deterministic gates while the 150 ms budget is a local runtime
  acceptance gate.
- The benchmark must not mutate the database or contend for runtime ownership.
- The existing v2 Usage contracts remain the source of truth for parity.

## Open Questions

- None — all decisions that affect this contract's scope, success criteria, and
  verification are settled.

## Handoff

1. Hand off to `write-plan` to sequence the build against this contract.
2. Review the contract with `verify-before-complete` inline because subagents are
   unavailable for this task.
3. Refine the contract before sequencing if repository evidence contradicts an
   assumption.
