---
date: 2026-09-15
author: codex
topic: observed-activity
stage: plan
status: complete
source: conversation
risk_profile: routine
readiness: ready
---

# Observed Activity Plan

## Goal

Implement [the activity contract](../specs/2026-09-15-observed-activity-spec.md)
without changing the transcript browser or usage accounting.

## Scope

The initial slice adds a read endpoint and real HTTP/SQLite regression tests.
The companion execution ledger, private spool import and schema version 8 are
documented in [execution receipts](../api/execution-receipts.md). Neither slice
changes public network configuration. Live deployment remains pending review.

## Assumptions And Constraints

Verified 2026-09-15: event and browser histories have independent retention.
Source identities must remain conservative; inferred aliases require known modes.

## Map Before You Cut

`src/api/v2/router.ts` calls `src/db/v2-queries.ts`; `listBrowsingSessions` already
reconciles known Codex aliases before filters. Reuse that grammar. The events
table holds independent telemetry. The new read joins these evidence sets rather
than mutating browser rows or adding another derived persistent store.

## Task Breakdown

### Task 1: Reconciled inventory

**Objective**: expose content-free session evidence, independent of transcripts.

**Files**: Modify: `src/db/v2-queries.ts`, `src/api/v2/router.ts`, `README.md`,
`docs/system/ARCHITECTURE.md`; create `tests/v2-observed-activity.test.ts`.

**Dependencies**: None.

**Assumptions Verified**: verified 2026-09-15, `sessionListCte` reconciles UUID
aliases and `listBrowsingSessions` applies filters afterwards. Event timestamp
fallback comes from SQLite UTC `created_at`; arbitrary naive source timestamps
are not proven UTC. `createApp` permits isolated port-zero HTTP testing.

**Implementation Steps**

1. Add a callable baseline and regression tests; observe behavioral failures.
2. Implement reconciliation, coverage flags and bounded validated pagination.
3. Update reference docs and run full repository checks.

**Verification**: `node --import tsx --test tests/v2-observed-activity.test.ts`
then `pnpm lint`, `pnpm build`, `pnpm test`.

**Test Discovery Verified**: `package.json` runs `tests/*.test.ts`; the literal
command above targets the new file.

**Done When**: fixtures prove exactly three distinct identities for the Claude
overlap/event-only/transcript-only case; recognized aliases collapse and negative
controls remain distinct. Existing browser tests stay green.

## Risks And Mitigations

Unknown external identity formats remain separate, not guessed. Source dates may
be unresolved; expose that fact rather than assign an invented day. Concurrent
ingestion can change pages; report totals and document retry semantics.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Identity, privacy, dates, paging | `node --import tsx --test tests/v2-observed-activity.test.ts` | Exact fixture sets and HTTP validation pass |
| Compatibility | `node --import tsx --test tests/v2-session-identity.test.ts` | Existing behavior unchanged |
| Integration | `pnpm lint && pnpm build && pnpm test` | All gates pass |

## Handoff

Execute locally; preserve the old consumer contract until downstream migration is
tested. Reconcile executions separately, never fold launches into session totals.
