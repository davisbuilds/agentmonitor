---
date: 2026-09-23
author: claude
topic: local-time-days
stage: plan
status: in-progress
source: conversation
risk_profile: routine
readiness: ready
---

# Local-Time Days Plan

## Goal

Every user-facing surface answers "which day is this?" the same way: the
operator's local calendar day. A date filter (`date_from`/`date_to`) selects
local days, and every daily bucket, day count, and weekday/hour cell is computed
in local time, so the heatmap, usage, analytics, skills, activity, session
browser, Monitor and budgets agree with each other and with the dates the
frontend already sends.

Accepted in conversation 2026-09-23 ("standardize on local time everywhere",
operator zone EST/EDT), after PR #141 made only the heatmap local.

## Scope

### In Scope

- One module, `src/util/local-day.ts`, that owns day math: the reporting zone,
  a timestamp's local day, a local day's UTC instant bounds, and a
  timestamp's local weekday/hour.
- A configurable reporting zone, `AGENTMONITOR_TIMEZONE`, defaulting to the
  host zone. It replaces the `America/New_York` hardcoded in
  `getDailyConversationActivity`, which is right for one operator only.
- Every date filter and day bucket listed in the map below.
- Docs: README (`/activity/*` currently documents "inclusive UTC calendar"
  dates), FEATURES, OPERATIONS (the new env var), BACKLOG, ROADMAP.

### Out of Scope

- **Warehouse export** (`src/warehouse/*`). It writes a `day` column into a
  persisted Postgres table; switching its basis would mix UTC and local days in
  one table. That is a data migration with its own decision, so it stays UTC
  and is recorded in BACKLOG.
- v1 hourly buckets (`src/db/queries.ts:1296`): hour-granular instants, not days.
- Calendar-only arithmetic on date strings (`enumerateDateRange`,
  `addDaysToDateString`): stepping `2026-03-08` to `2026-03-09` is
  zone-independent and stays as is.

## Assumptions And Constraints

- The frontend already sends local dates: `localDateString` in
  `frontend/src/lib/stores/analytics-filters.svelte.ts` and `usage-state.ts`.
  The server's UTC reading is the whole mismatch; no frontend change needed.
- The Monitor sends full ISO timestamps as `date_from`. A timestamp is an
  instant and must pass through unchanged; only bare dates are days.
- Stored timestamps are mixed: ISO with `Z`, ISO with an offset, and SQLite's
  zone-less `YYYY-MM-DD HH:MM:SS` (UTC). The helper must read all three.
- Day math uses `Intl` with a named zone, not SQLite `localtime`, which follows
  the process `TZ` and cannot honor a configured zone.
- Instant bounds come from local midnights, so DST days are 23 or 25 hours long
  without special cases.

## Map Before You Cut

Inventory taken 2026-09-23 from `main` at `56f6938`
(`grep` for `date_from|date_to`, `slice(0, 10)`, `date(`, `strftime(`):

| Kind | Site | Today |
|---|---|---|
| filter | `buildUsageFilterState` | `datetime(ts) >= datetime(date)` = UTC midnight |
| filter | `buildAnalyticsFilterState` | UTC, or `localtime` behind #141's heatmap-only option |
| filter | `listBrowsingSessions` | string compare vs UTC day |
| filter | `listMonitorSessions` | `datetime(?, '+1 day')`, UTC |
| filter | `listObservedSessions`, `listObservedExecutions` | `T00:00:00.000Z` |
| filter | `getDailyConversationActivity` | reads a padded window, buckets in hardcoded NY |
| filter | skills `invocation-ledger.ts` | string compare + `nextUtcDate` |
| filter | skills `consultation-analytics.ts` | `slice(0, 10)` bounds |
| filter | `trace-quality/on-demand.ts` | `datetime(date)`, UTC |
| filter | budgets `periodRange` | already local dates; fixed by the usage filter |
| bucket | usage daily / models daily / skills daily | `timestamp.slice(0, 10)` |
| bucket | analytics activity, `active_days` | SQLite `date(started_at)` |
| bucket | Hour-of-Week | SQLite `localtime` |
| bucket | `resolveUsageDateBounds`, `inclusiveDateSpanDays` | `slice(0, 10)` of earliest/latest |

## Task Breakdown

### Task 1: Local-day module

**Objective** One tested home for all day math.

**Files**
- Create: `src/util/local-day.ts`
- Modify: `src/config.ts`
- Test: `tests/local-day.test.ts`

**Dependencies** None

**Assumptions Verified**
- `src/config.ts` snapshots env at import (AGENTS.md), so the zone is read
  there and the helpers also accept an explicit zone for tests.

**Implementation Steps**
1. `reportingTimeZone()`: `AGENTMONITOR_TIMEZONE`, validated as an IANA zone,
   else the host zone from `Intl`.
2. `localDayOf(timestamp, zone)`, `localDayStart(day, zone)`,
   `localDayEndExclusive(day, zone)`, `localWeekdayHour(timestamp, zone)`.
3. `dateParamLowerBound(param)` / `dateParamUpperExclusive(param)`: a bare day
   maps to its local midnights; a timestamp stays an instant.

**Verification** `node --import tsx --test tests/local-day.test.ts`

**Done When** Both DST transitions, east- and west-of-UTC zones, and all three
stored timestamp formats map to the expected day and bounds.

### Task 2: Filters

**Objective** Every date filter selects local days.

**Files** `src/db/v2-queries.ts`, `src/skills/invocation-ledger.ts`,
`src/skills/consultation-analytics.ts`, `src/trace-quality/on-demand.ts`

**Dependencies** Task 1

**Assumptions Verified** See the map; each filter site was read on `56f6938`.

**Implementation Steps** Replace each UTC bound with the Task 1 bounds, comparing
via `datetime()` wherever the column is not a normalized ISO instant.

**Verification** `tests/local-time-days.test.ts` seeds rows either side of a
local midnight and asserts each surface's window.

**Done When** A session at 23:30 local (04:30Z next day) is inside that local
day on every filtered surface, and outside the next.

### Task 3: Buckets

**Objective** Every daily and weekday/hour bucket is local.

**Files** `src/db/v2-queries.ts`

**Dependencies** Task 1

**Implementation Steps** Replace `slice(0, 10)` and SQLite `date()`/`localtime`
bucketing with `localDayOf` / `localWeekdayHour`; the heatmap buckets in JS.
Drop #141's `localDays` option, since every window is now local.

**Verification** Same test file: a late-evening event lands in its local day's
bucket in usage daily, analytics activity, skills daily, and the heatmap.

**Done When** Filter and bucket agree on every surface: no row is selected into
one day and plotted on another.

### Task 4: Docs

**Objective** Docs describe local days and the one UTC exception.

**Files** `README.md`, `docs/system/FEATURES.md`, `docs/system/OPERATIONS.md`,
`docs/project/BACKLOG.md`, `docs/project/ROADMAP.md`

**Dependencies** Tasks 2 and 3

**Implementation Steps** Rewrite the UTC-day statements, add
`AGENTMONITOR_TIMEZONE` to OPERATIONS, retire the backlog entries this closes
(the heatmap-window and budget-window mismatches), and add the warehouse one.

**Verification** `grep -rn -i 'utc calendar\|utc day' README.md docs/system`

**Done When** No doc describes a UTC day for a user-facing surface; the
warehouse exception and the env var are documented.

## Risks And Mitigations

- **Tests that assumed UTC days.** Existing fixtures seed midday UTC times, which
  are the same day in most zones, but a CI runner in UTC and a laptop in EDT can
  disagree near midnight. Mitigation: suites pin `AGENTMONITOR_TIMEZONE`.
- **Index loss** where a filter wraps a column in `datetime()`. Bounds are
  instants, so the comparisons stay range scans on already-normalized columns;
  check `EXPLAIN QUERY PLAN` on usage summary before and after.
- **`getDailyConversationActivity` output changes shape** only in its
  `timezone` field, which now reports the configured zone instead of a constant.

## Verification Matrix

| Requirement | Proof command | Expected signal |
|---|---|---|
| Day math is DST-correct | `tests/local-day.test.ts` | 23h/25h days bounded at local midnights |
| Filters select local days | `tests/local-time-days.test.ts` | edge rows in the right day on each surface |
| Buckets match filters | same | edge rows plotted on the selected day |
| No regressions | `pnpm lint && pnpm build && pnpm test` | green |
| Guards bite | revert each site's change | its test goes red |
