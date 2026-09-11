---
date: 2026-09-11
author: gpt-6-codex
topic: agent-first-cli-read-parity
stage: plan
status: in-progress
source: conversation
risk_profile: routine
readiness: ready
---

# Agent-First CLI Read Parity Plan

## Goal

Make every data product available in the Svelte `/app/` UI retrievable through
an agent-friendly `amon` command with a stable structured contract, clear filters,
predictable exit behavior, and reliable concurrent reads. Work in reviewable slices,
starting with the shared read foundation and exact Usage-page parity.

The contract comes from the 2026-09-11 conversation and live repository mapping:

- finite reads support `--json` and keep primary data on stdout;
- stream reads emit NDJSON;
- CLI payloads preserve the corresponding v2/UI coverage and pagination metadata;
- unsupported filters fail with exit 2 instead of being accepted and ignored;
- concurrent agent reads do not fail with transient SQLite lock errors under the
  verified eight-process local workload;
- each slice closes a coherent UI data surface and stops at a human review point.

## Scope

### In Scope

- Preserve a durable inventory of current UI read contracts and CLI coverage.
- First PR: concurrent read reliability, exact `usage overview` and `usage facets`
  commands, command-specific reporting filters/help, tests, and operator docs.
- Later PRs: complete Analytics, then saved analysis artifacts, then remaining
  session/live/monitor operational reads.
- Use the same query/service functions as the v2 routes so CLI and UI data semantics
  cannot drift through duplicate SQL.

### Out of Scope

- UI mutations: pin/unpin and insight generate/delete.
- A generic raw HTTP/API passthrough command.
- New analytics calculations or response fields.
- Benchmark ingestion changes; only benchmark reads belong to a later slice.
- Merging the first PR without user review.

## Assumptions And Constraints

- The Svelte call graph is the authority for "available in the UI"; route existence
  alone is insufficient.
- The strict baseline is 42 unique UI read contracts: 40 GET route templates and
  two SSE streams. Twelve have exact CLI equivalents today.
- Usage UI data is served through one `UsageOverview` scan plus `UsageFacets`.
  Existing `usage summary|daily|projects|models` commands expose only four of the
  eight overview rollups and do not reproduce the composite contract.
- Read commands should continue to work directly against the local database without
  requiring the HTTP server.
- Existing stdout/stderr separation and exit codes 0-5 remain stable.
- Required pre-push gates are `pnpm lint`, `pnpm build`, and `pnpm test`.
- The first PR is the only review point in this session. Queue Codex review after
  opening it, address all actionable findings, then stop before merge.

## Current Parity Map

Counts below are unique data contracts rather than component request counts.
Related browsing/live projections do not count as Monitor parity because their
schemas and semantics differ.

| Surface | UI read contracts | Exact CLI contracts | Remaining after baseline |
| --- | ---: | ---: | --- |
| Monitor | 8 | 0 | 8 |
| Sessions, pins, search | 8 | 5 | 3 |
| Live | 6 | 3 | 3 |
| Analytics | 10 | 3 | 7 |
| Usage | 2 | 0 | 2 |
| Trace quality | 3 | 1 | 2 |
| Insights | 1 | 0 | 1 |
| Benchmarks | 2 | 0 | 2 |
| Shared metadata | 2 | 0 | 2 |
| **Total** | **42** | **12** | **30** |

Existing exact CLI reads are:

- `sessions list`, `sessions show`, `sessions messages`, `sessions search`,
  `pins list`;
- `live sessions`, `live items`, `live watch`;
- `analytics summary`, `analytics tools`, `analytics top-sessions`;
- `quality traces`.

The CLI also has useful non-UI or no-longer-directly-consumed reads: individual
usage rollups, budgets, tier feedback, statusline output, and operational metrics.

## Map Before You Cut

- UI Usage path: `AnalyticsShell` selects Usage -> `UsageStore.fetchAll()` calls
  `fetchUsageOverview()` and `fetchFilterOptions()` calls `fetchUsageFacets()` ->
  v2 router delegates to `getUsageOverview()`/`getUsageFacets()`.
- CLI reporting path: command registration in `src/cli/commands/reporting.ts` parses
  options, calls the same functions in `src/db/v2-queries.ts`, then sends exact JSON
  or a human formatter through `src/cli/output.ts`.
- Read startup path: every reporting and session/live command calls `initSchema()`;
  every process opens the database and executes `PRAGMA journal_mode = WAL` before
  reading. Eight concurrent installed-CLI reads reproduced five lock failures.
- Filter defect class: `commonParams()` accepts a superset for every reporting
  command. This makes irrelevant flags appear valid and allowed `analytics tools
  --limit 1` to return all 65 rows. Help strings expose only a subset of the accepted
  flags, while operations docs contain removed or unsupported examples.
- Thinnest seam: retain direct query-function reuse, introduce command-specific
  parameter parsing at the reporting registration boundary, and make connection/
  initialization behavior tolerate multiple read processes. Do not add an HTTP
  dependency or a new reporting abstraction outside the CLI module.

## Task Breakdown

### Task 1: Prove and fix concurrent read reliability

**Objective**

Ensure independent agent processes can issue local read commands concurrently
without transient `SQLITE_BUSY`/`database is locked` failures.

**Files**

- Modify: `src/db/connection.ts`
- Modify, if needed after the red test identifies the initialization seam:
  `src/cli/commands/reporting.ts`
- Modify, if the shared read initializer is extracted: `src/cli/commands/sessions-live.ts`
- Test: `tests/cli-e2e.test.ts`

**Dependencies**

None

**Assumptions Verified**

- `src/db/connection.ts:29-43` opens one process-local connection and executes the
  WAL pragma before configuring other connection pragmas.
- `src/cli/commands/reporting.ts:72-76` calls the full schema initializer before
  every reporting read.
- `src/cli/commands/sessions-live.ts:9-14` has the same read initialization shape.
- `src/db/schema.ts:909-926` can perform transactional data migrations, so blindly
  removing initialization from all entry points would break upgrade behavior.

**Behavior Measured**

- Verified 2026-09-11 on installed `amon` 0.5.0 at main `75dff60`: eight concurrent
  `amon analytics summary --json` processes produced three successes and five
  `unexpected error: database is locked` exits with code 1.

**Implementation Steps**

1. Add an E2E regression that creates and initializes a temporary database once,
   then launches eight built CLI summary reads at the same time and asserts eight
   successful JSON responses with empty stderr.
2. Run the test against the current implementation and preserve the observed lock
   failures as the red proof.
3. Configure contention handling before any lock-requiring pragma and avoid
   needlessly renegotiating WAL mode on an already-WAL database.
4. If schema initialization remains the contended writer, introduce one shared
   read bootstrap that initializes a missing/outdated database but lets a current
   database enter read queries without replaying the full DDL path. Keep server and
   maintenance startup migrations authoritative.
5. Re-run the eight-process test repeatedly enough to cover at least 40 total child
   invocations without a lock failure.

**Verification**

- Run: `pnpm build && node --import tsx --test tests/cli-e2e.test.ts`
- Expect: the literal concurrent-read test reports eight successful child processes.
- Run: the concurrent test five times.
- Expect: 40/40 child reads exit 0, parse as JSON, and emit empty stderr.

**Test Discovery Verified**

- `package.json:19` discovers `tests/*.test.ts`, including `tests/cli-e2e.test.ts`.
- Literal proof: `node --import tsx --test tests/cli-e2e.test.ts` runs the target file.

**Done When**

- The previously failing eight-process read workload succeeds 40/40 times while
  preserving schema initialization for a fresh or upgrade-required database.

### Task 2: Make reporting filters explicit and fail closed

**Objective**

Give each reporting command an accurate, discoverable option contract and prevent
accepted-but-ignored flags.

**Files**

- Modify: `src/cli/commands/reporting.ts`
- Test: `tests/cli-contracts.test.ts`
- Test: `tests/cli-core.test.ts`

**Dependencies**

Task 1

**Assumptions Verified**

- `src/cli/commands/reporting.ts:15-69` parses 23 value flags and one boolean flag
  for every Usage, Analytics, and Quality command.
- `src/cli/commands/reporting.ts:89,107,129,150,169,182,205,228` advertises narrower
  and mutually inconsistent help contracts.
- `src/cli/args.ts:140-171` already rejects any flag absent from a command's allowlist
  with exit 2; the missing property is correct per-command allowlists.

**Behavior Measured**

- Verified 2026-09-11 on installed `amon` 0.5.0 at `75dff60`: `amon analytics tools
  --limit 1 --json` exited 0 and returned 65 rows, demonstrating silent no-op input.
- Verified on the same build: `amon usage summary --days 7 --json` exited 2 although
  `docs/system/OPERATIONS.md:117` documents that invocation.

**Implementation Steps**

1. Replace `commonParams()` with small parsers for Usage, Analytics, and trace-list
   contracts, parameterized only where a command genuinely supports pagination or
   specialized quality filters.
2. Validate dates through `parseDateOption`; keep numeric validation for limits,
   offsets, and score bounds.
3. Update every reporting command's usage/help string to list all accepted filters.
4. Add negative tests showing `analytics tools --limit 1` and unrelated Usage/
   Quality flags fail with exit 2 and no stdout unless the command implements them.
5. Add positive help tests for the shared date/project/agent filters and the Usage
   model/provider/tier filters.

**Verification**

- Run: `node --import tsx --test tests/cli-contracts.test.ts tests/cli-core.test.ts`
- Expect: supported filters reach the query payload; unsupported flags exit 2 with
  no stdout; command help exactly names the supported options.

**Test Discovery Verified**

- `package.json:19` discovers both literal `tests/*.test.ts` files.
- Literal proof: the verification command names both changed test files.

**Done When**

- No reporting command accepts an option that its implementation ignores, and an
  agent can discover every accepted option from that command's `--help` output.

### Task 3: Add exact Usage overview and facets commands

**Objective**

Close the current Usage UI read gap with two commands that expose the same optimized
composite and self-excluding-facet contracts.

**Files**

- Modify: `src/cli/commands/reporting.ts`
- Modify: `src/cli/formatters/reporting.ts`
- Test: `tests/cli-contracts.test.ts`

**Dependencies**

Tasks 1-2

**Assumptions Verified**

- `src/db/v2-queries.ts:3383-3434` owns the self-excluding `UsageFacets` calculation.
- `src/db/v2-queries.ts:3443-3457` owns the one-scan `UsageOverview` with eight
  rollups and one coverage block.
- `src/api/v2/types.ts:1018-1038` defines the exact UI response fields.
- `frontend/src/lib/stores/usage.svelte.ts:192-232,307-326` consumes these two
  contracts for every Usage panel and filter option.

**Implementation Steps**

1. Register `usage overview` with date/project/agent/model/provider/tier filters.
2. Emit the unmodified `getUsageOverview()` object under `--json`; provide a concise
   human summary without removing any JSON fields.
3. Register `usage facets` with the same filters and emit the unmodified
   `getUsageFacets()` object under `--json`.
4. Add seeded-fixture tests that deep-compare CLI JSON to the owning query functions,
   including all eight overview keys and all five facet arrays.
5. Confirm classification filters change the result and self-excluding facets keep
   the selected dimension available rather than passing on an empty fixture.

**Verification**

- Run: `node --import tsx --test tests/cli-contracts.test.ts`
- Expect: exact deep equality for overview/facets, with two seeded usage events and
  a non-empty project/model facet baseline.

**Test Discovery Verified**

- `package.json:19` discovers `tests/cli-contracts.test.ts`.
- Literal proof: the verification command runs that exact file.

**Done When**

- One `amon usage overview --json` response contains `summary`, `daily`, `projects`,
  `models`, `models_daily`, `tiers`, `agents`, `top_sessions`, and `coverage`, and
  equals the v2 query result for the same non-empty filters.
- `amon usage facets --json` returns all five self-excluding option lists for the
  same date slice and equals the v2 query result.

### Task 4: Document and ship the first review slice

**Objective**

Make the new agent-facing contract durable, pass required gates, and present one
unmerged PR for user review after Codex findings are resolved.

**Files**

- Modify: `README.md`
- Modify: `docs/system/OPERATIONS.md`
- Modify: `docs/system/FEATURES.md`
- Modify: `docs/plans/2026-09-11-agent-first-cli-read-parity-plan.md`

**Dependencies**

Tasks 1-3

**Assumptions Verified**

- `docs/system/OPERATIONS.md:95-123` is the operator command catalog and currently
  includes unsupported `--days`, ignored `--limit`, and removed `quality findings`
  examples.
- `README.md:122` provides the top-level CLI discovery example.
- The project working agreement requires README updates when API response shapes
  change; this slice preserves API shapes but adds user-visible CLI contracts, so
  the command catalog and feature reference must still be updated.

**Implementation Steps**

1. Document `usage overview`, `usage facets`, exact supported filters, JSON/stdout
   behavior, and concurrent local-read expectations.
2. Remove or replace stale command examples and update the plan's completed-task
   markers while keeping later phases future-facing.
3. Run focused tests, then `pnpm lint`, `pnpm build`, and `pnpm test`.
4. Commit logical chunks, push the branch, open one PR, and queue Codex review.
5. Query unresolved GitHub review threads from the first review poll, address every
   actionable finding, resolve addressed threads, rerun relevant gates, and push.
6. Stop with the PR open and unmerged for user review.

**Verification**

- Run: `pnpm lint && pnpm build && pnpm test`
- Expect: all required gates pass.
- Run: built CLI help and JSON smoke checks from `dist/cli.js`.
- Expect: new commands appear in root help, command help lists exact filters, and
  both JSON documents parse without stderr.

**Done When**

- The first PR contains the read foundation and Usage parity changes enumerated in
  Tasks 1-4, contains none of the later Analytics/artifact/Monitor commands, has
  green required gates and completed Codex review, has zero unresolved actionable
  threads, and remains unmerged.

### Task 5: Complete Analytics reads in the second PR

**Objective**

Expose the seven Analytics UI contracts still missing from the CLI.

**Files**

- Modify: `src/cli/commands/reporting.ts`
- Modify: `src/cli/formatters/reporting.ts`
- Test: `tests/cli-contracts.test.ts`
- Modify: `README.md`
- Modify: `docs/system/OPERATIONS.md`
- Modify: `docs/system/FEATURES.md`

**Dependencies**

First PR merged after user review

**Assumptions Verified**

- `frontend/src/lib/stores/analytics.svelte.ts:191-402` consumes ten Analytics
  contracts; only summary, tools, and top sessions are registered in
  `src/cli/commands/reporting.ts:196-222`.

**Implementation Steps**

1. Add `analytics activity`, `analytics projects`, `analytics agents`,
   `analytics velocity`, and `analytics hour-of-week`.
2. Add nested `analytics skills daily` and `analytics skills health` commands.
3. Preserve each endpoint's exact coverage/data-semantics envelope under `--json`.
4. Apply the explicit Analytics filter parser from Task 2 and add exact-shape tests.

**Verification**

- Run focused CLI contract tests and all required pre-push gates.
- Expect: ten of ten Analytics UI reads have exact CLI equivalents.

**Test Discovery Verified**

- `package.json:19` discovers `tests/cli-contracts.test.ts`.
- Literal proof: `node --import tsx --test tests/cli-contracts.test.ts`.

**Done When**

- Every Analytics overview and Skills read used by the UI has a discoverable command
  whose JSON equals the owning query/service result for a non-empty fixture.

### Task 6: Add saved-analysis artifact reads in the third PR

**Objective**

Expose trace detail, observations, saved insights, benchmark studies, and shared
metadata for downstream agent analysis.

**Files**

- Modify or create domain command modules under `src/cli/commands/`
- Modify: `src/cli/register.ts`
- Test: `tests/cli-contracts.test.ts`
- Modify relevant system docs

**Dependencies**

Task 5 merged

**Assumptions Verified**

- Current UI gaps are trace detail/observations (2), insight list (1), benchmark
  list/detail (2), and shared project/agent metadata (2).

**Implementation Steps**

1. Add `quality trace <id>` and `quality observations <id>` with pagination.
2. Add read-only `insights list` and `insights show <id>`; the latter exposes the
   existing detail route even though the current UI selects from full list rows.
3. Add `benchmarks list` and `benchmarks show <study-id>`.
4. Add discoverable project/agent facet commands at a noun that can be reused by
   later domains; avoid duplicating aggregation queries.

**Verification**

- Run domain-focused contract tests and all required pre-push gates.
- Expect: exact JSON shapes, stable not-found exit 4, and preserved pagination.

**Test Discovery Verified**

- Keep tests under the `tests/*.test.ts` pattern from `package.json:19` and run each
  changed file literally before the full suite.

**Done When**

- All seven artifact/metadata reads are available with exact JSON and deterministic
  missing-record behavior.

### Task 7: Close session, Live, and Monitor operational reads

**Objective**

Finish strict UI read parity without conflating distinct projections.

**Files**

- Modify: `src/cli/commands/sessions-live.ts`
- Create or modify a Monitor command module under `src/cli/commands/`
- Modify: `src/cli/register.ts`
- Test: `tests/cli-contracts.test.ts`
- Test stream behavior in `tests/cli-commands.test.ts`
- Modify relevant system docs

**Dependencies**

Task 6 merged

**Assumptions Verified**

- Remaining browsing reads are session activity, children, and per-session pins.
- Remaining Live reads are settings, session detail, and turns.
- Monitor has eight distinct contracts and its event/session projections are not
  substitutes for browsing-session or Live schemas.

**Implementation Steps**

1. Add the three remaining browsing-session commands.
2. Add the three remaining Live commands.
3. Add Monitor stats, events, sessions, filter options, tools, detail, transcript,
   and the legacy Monitor event stream under an explicit Monitor namespace.
4. Preserve pagination and stream framing; do not fold Monitor reads into similarly
   named browsing/live commands.
5. Re-run the UI call-graph inventory and require 42/42 exact read-contract coverage.

**Verification**

- Run focused command/stream contract tests and all required pre-push gates.
- Expect: the mechanically regenerated parity inventory reports 42 UI contracts and
  42 exact CLI equivalents, including both SSE schemas.

**Test Discovery Verified**

- `package.json:19` discovers both target test files; run them literally before the
  full suite.

**Done When**

- Every GET or SSE contract called by the current UI has a distinct, discoverable,
  agent-safe CLI path with equivalent structured data.

## Risks And Mitigations

### First PR implementation status (2026-09-11)

- Tasks 1-3 are implemented on `feat/agent-first-cli-usage-parity`.
- The original installed-CLI workload reproduced five lock failures across eight
  concurrent reads. The regression was observed red while a WAL writer held a
  transaction, then passed after the read bootstrap change.
- The built CLI completed 40/40 repeated concurrent reads with empty stderr.
- `usage overview --json` and `usage facets --json` deep-match their owning v2
  query functions on a non-empty fixture.
- Unsupported reporting filters now exit 2 instead of being silently ignored, and
  each command's help lists its accepted filters.
- Required gates pass: `pnpm lint`, `pnpm build`, and `pnpm test` (893 tests).
- Task 4 remains open until the PR is published, Codex review findings are handled,
  and the unmerged PR is handed to the user.

- Risk: a longer busy timeout could hide schema-startup contention rather than remove
  it. Signal: concurrent tests become slow or intermittently approach the timeout.
  Mitigation: measure child duration and avoid repeated lock-requiring startup work
  on already-current databases.
- Risk: skipping schema initialization on reads could make an upgraded install fail
  with missing columns. Signal: an old-schema fixture fails only through the CLI.
  Mitigation: pair current-database fast path tests with a fresh/upgrade fixture that
  proves required initialization still occurs.
- Risk: exact UI parity can be overstated when two surfaces share fields but not
  semantics. Signal: a proposed command calls a different query than the UI route.
  Mitigation: contract tests compare against the owning v2 query/service function,
  and the final inventory treats each distinct projection separately.
- Risk: future UI work changes the 42-contract baseline. Signal: frontend call-graph
  scan differs at the start of a later task. Mitigation: re-run the inventory at each
  PR boundary and update this plan rather than treating the dated count as permanent.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Concurrent local reads | Concurrent built-CLI E2E test, five repetitions | 40/40 child reads exit 0 with valid JSON and empty stderr |
| Unsupported flags fail closed | CLI contract negative tests | Exit 2, empty stdout, named unknown option |
| Help is discoverable | CLI core/help tests and built help smoke | Every accepted reporting filter appears in command help |
| Usage overview parity | Seeded deep-equality contract test | All eight rollups and coverage equal `getUsageOverview()` |
| Usage facets parity | Seeded deep-equality contract test | All five arrays equal `getUsageFacets()` under filters |
| Built artifact is authoritative | `pnpm build` plus `dist/cli.js` smokes | New commands appear and JSON parses from built CLI |
| Regression safety | `pnpm lint && pnpm build && pnpm test` | All required gates pass |
| First review stop | GitHub PR/review-thread query | Codex complete, zero unresolved actionable threads, PR open/unmerged |

## Handoff

Execution begins on `feat/agent-first-cli-usage-parity`. Complete Tasks 1-4 in the
first PR, queue Codex review, address findings, and stop before merge for user review.
Tasks 5-7 remain the ordered workoff sequence for later PRs and should be re-grounded
against the current Svelte call graph before execution.

Plan complete and saved to docs/plans/2026-09-11-agent-first-cli-read-parity-plan.md.
