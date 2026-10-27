---
date: 2026-09-13
topic: usage-overview-coverage-scaling
stage: plan
status: complete
source: conversation
---

# Usage Overview Coverage Scaling Plan

## Goal

Keep the exact Usage overview used by `/app/` and `amon usage overview` responsive
as retained event history grows, while preserving source coverage, distinct
sessions, Codex OTEL/import reconciliation, filters, and response compatibility.

The 150 ms number in the 2026-07-16 plan was a local acceptance threshold for one
machine, date range, and database size. It triggered this investigation but is
not a product SLO or a reason to accept a more complex storage design by itself.

## Grounded Bottleneck

The application-consistent snapshot used for this work contains about 697K
events. For `2026-07-15..2026-09-13`, the overview returns 61,915 usage-bearing
events and coverage over 430,102 matching events across 291 sessions.

Warm source-level profiling showed:

| Read | Warm median |
| --- | ---: |
| Complete overview before this slice | 309.32 ms |
| Existing matching coverage grouping | 193.22 ms |
| Usage row rollups | roughly 50-80 ms each |

The scaling problem was therefore the broader coverage denominator, not the
eight JavaScript rollups over usage-bearing rows. A daily usage cache would leave
that denominator unresolved unless it also modeled all events and the nonlocal
OTEL/import reconciliation rule.

## Alternatives Measured

| Candidate | Matching-coverage cost | Storage/write effect | Decision |
| --- | ---: | --- | --- |
| Two aggregate scans on existing indexes | about 245 ms | none | slower |
| Materialized filtered CTE | about 203 ms with high variance | none | neutral |
| One wide all-event index with the old grouped query | about 127 ms | 64.7 MB; synthetic bulk inserts +11.7% | superseded |
| Covering denominator counts plus targeted overlap subtraction | about 87 ms | 64.5 MB; synthetic bulk inserts +12.7% | selected |
| Disposable sibling derived database | not implemented | generation identity, source revisions, rebuild/retirement, pricing invalidation, and multi-process coordination | defer |

The selected path adds one partial covering index over normalized timestamp,
source, session, project, and agent. It computes total and per-source matching
counts directly, then uses the existing metric-only index to find the much
smaller overlapping Codex OTEL subset. A bounded survivor check preserves exact
distinct-session counts when every in-range row for a session is excluded.

## Workoff Sequence

1. Ship the direct denominator optimization with query-plan protection, exact
   overview-to-panel parity, a regression for fully removed sessions, and one
   SQLite snapshot per overview.
2. Observe the built CLI and `/app/` path after the one-time index build on the
   install database. Compare named ranges and matching-event counts rather than
   treating a single latency number as universal.
3. Revisit a disposable sibling store only when measured user-facing latency or
   multi-million-row growth makes the direct path materially costly. Before
   implementation, specify source revision tracking, crash-safe generation
   replacement, cross-process retirement, rebuild commands, pricing-change
   invalidation, arbitrary timestamp-bound semantics, benchmark segregation,
   and exact response parity.

## Verification Evidence

- The selected source-level overview measured 220.99 ms warm median on the frozen
  60-day snapshot, a 28.6% improvement from 309.32 ms.
- The built HTTP endpoint measured 227.14 ms over seven warm runs on the same
  snapshot and returned 104,417 bytes.
- Canonicalized full overview JSON was byte-identical before and after the query
  change.
- The session-removal regression was mutation-probed: ignoring vanished sessions
  produced `1 !== 0`, and restoring the subtraction returned the test to green.
- The query-plan regression failed before the covering index existed and passed
  after schema creation used it.
