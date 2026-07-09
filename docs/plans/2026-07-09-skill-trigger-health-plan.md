---
date: 2026-07-09
topic: skill-trigger-health
stage: plan
status: in-progress
source: conversation
---

# Skill Trigger Health & Version Attribution Plan

## Goal

Implement the contract in
`docs/specs/2026-07-07-skill-trigger-health-spec.md`: version-attributed skill
invocations, per-skill trigger health (invocation count, last-invoked,
never-fired, interrupt-based misfire rate), computable over already-ingested
history, served as JSON at `GET /api/v2/analytics/skills/health`.

## Scope

In: installed-catalog scanner + config, catalog version snapshots, health
query, v2 endpoint, tests, doc updates. Out (per spec): dojo-side consumers,
LLM judging, UI, trigger-miss detection, lexical/rephrase misfire signals.

## Assumptions And Constraints

- Skill detection basis is unchanged: explicit `Skill` tool calls
  (`tool_calls.tool_name = 'Skill'`, skill name in `input_json.skill`) and
  Codex `SKILL.md` path extraction, exactly as `getAnalyticsSkillsDaily`
  (`src/db/v2-queries.ts:1742`) already does.
- Misfire heuristic (frozen by spec): the next `user`-role message after the
  invoking assistant message contains the literal prefix
  `[Request interrupted by user`. Verified present in real transcripts
  (covers both the plain and `for tool use` variants) and preserved verbatim
  by the parser: text blocks are stored as-is into `messages.content`
  (`src/parser/claude-code.ts:342`).
- Codex-detected invocations count toward invocation totals but are excluded
  from the misfire denominator in phase 1 (no assistant-turn linkage in the
  Codex event model). Documented in FEATURES.md as part of Task 5.
- Installed catalogs (`~/.claude/skills`, `~/.codex/skills`) are symlink farms
  into `~/.agents/skills`; the scanner must resolve symlinks and dedupe by
  skill name.
- No YAML dependency exists in `package.json`; frontmatter parsing is a
  line-anchored regex over the first `---` block (only `version:` is needed).
- **Query-time computation is the backfill mechanism**: metrics are computed
  over existing `tool_calls`/`messages`/`events` rows, so historical sessions
  are covered with no reingest. Only catalog version snapshots are persisted
  (point-in-time data that cannot be recovered later).

## Map Before You Cut

Traced ground:

- Invocation extraction and JS-side aggregation pattern:
  `getAnalyticsSkillsDaily` (`src/db/v2-queries.ts:1742`) — explicit `Skill`
  rows join `browsing_sessions` and `messages` for timestamp; two further
  Codex queries reuse `extractCodexSkillNamesFromCommand`. The health query
  follows this exact pattern rather than inventing a new pipeline.
- Turn linkage for misfire: `tool_calls.message_id` → `messages.id`, and
  `messages(session_id, ordinal)` is indexed
  (`src/db/schema.ts:463`); the parser assigns `message_ordinal` to each tool
  call at extraction (`src/parser/claude-code.ts:366`).
- Endpoint seam: `/analytics/skills/daily` handler (`src/api/v2/router.ts:588`)
  with `readAnalyticsParams` (`src/api/v2/router.ts:403`) and
  `AnalyticsParams` (`src/api/v2/types.ts:951`).
- Config seam: `AGENTMONITOR_*` env parsing lives in `src/config.ts` (e.g.
  `AGENTMONITOR_PROJECTS_DIR` override at `src/config.ts:102`).
- Schema additions use idempotent `CREATE TABLE IF NOT EXISTS` blocks in
  `src/db/schema.ts` (existing convention; no migration framework).
- Test discovery: `package.json:19` runs `node --import tsx --test
  tests/*.test.ts tests/codebase/*.test.ts` — new test files must sit directly
  in `tests/` to be discovered.

Seam decision: **persist only catalog snapshots; compute everything else at
query time.** A pure query-time version join could only ever show the
currently-installed version, which fails the spec's two-versions-as-two-series
criterion; stamping invocations at ingest would touch every ingest path
(watcher, import, reparse). A snapshot table written by one code path, joined
by invocation timestamp, is the thinnest cut that satisfies the contract.

## Task Breakdown

### Task 0: Operator prerequisite — refresh the dojo→global skill sync

**Objective**: Installed skill copies must carry `version:` frontmatter or all
version attribution resolves to unknown.

**Files**: none in this repo (dojo `skill-standardizer` sync; installed copies
under `~/.agents/skills/`, last synced 2026-06-20, predating dojo's version
frontmatter — verified 0/28 installed copies have `version:` vs 55/56 dojo
canonicals).

**Dependencies**: None.

**Implementation Steps**:
1. From dojo, run the skill-standardizer sync to refresh `~/.agents/skills`.

**Verification**: `grep -l '^version:' ~/.claude/skills/*/SKILL.md | wc -l`
→ greater than 0 (expect ≈ the number of dojo-sourced skills).

**Done When**: installed catalogs expose `version:` for dojo-sourced skills.

**Assumptions Verified**: `~/.claude/skills/write-spec/SKILL.md` (via its
`~/.agents/skills` symlink target) lacks the `version: 1.0.0` line present in
`~/Dev/dojo/skills/write-spec/SKILL.md:5`; diff shows the version line is the
only frontmatter difference, i.e. staleness, not stripping.

### Task 1: Catalog scanner + config

**Objective**: Enumerate installed skills with their versions from configured
catalog directories.

**Files**: `src/skills/catalog.ts` (new), `src/config.ts`,
`tests/skill-catalog.test.ts` (new).

**Dependencies**: None.

**Implementation Steps**:
1. Add `skillCatalogDirs: string[]` to config in `src/config.ts`, parsed from
   `AGENTMONITOR_SKILL_CATALOG_DIRS` (path-list, `:`-delimited), defaulting to
   `~/.claude/skills` and `~/.codex/skills` (expand `~` as existing config
   code does for the projects dir).
2. In `src/skills/catalog.ts`, implement `scanSkillCatalogs(dirs): CatalogSkill[]`
   where `CatalogSkill = { name, version: string | null, dir }`:
   read each `<dir>/<skill>/SKILL.md` (following symlinks via normal fs reads),
   extract `version:` with a line-anchored regex inside the leading `---`
   block, dedupe by skill directory name (first catalog dir wins), skip
   unreadable entries without throwing.
3. Unit tests against a fixture catalog directory created in a temp dir:
   versioned skill, version-less skill, symlinked skill dir, duplicate name
   across two catalog dirs, missing SKILL.md.

**Verification**: `pnpm test` — `tests/skill-catalog.test.ts` passes all
fixture cases; `pnpm lint` clean.

**Done When**: scanner returns name+version for versioned skills, `version:
null` (never a dropped row) for version-less ones, and dedupes symlinked
duplicates — contract clause 1's resolution source exists.

**Assumptions Verified**: no YAML parser in `package.json` dependencies
(checked); `~/.claude/skills` entries are symlinks to `~/.agents/skills`
(checked via `ls -la`); env-parsing conventions at `src/config.ts:102`.

### Task 2: Catalog version snapshots

**Objective**: Persist point-in-time (name, version) observations so past
invocations can be attributed to the version installed at that time.

**Files**: `src/db/schema.ts`, `src/skills/catalog.ts`,
`tests/skill-catalog.test.ts`.

**Dependencies**: Task 1.

**Implementation Steps**:
1. Add `CREATE TABLE IF NOT EXISTS skill_catalog_snapshots (name TEXT NOT
   NULL, version TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT
   NULL, PRIMARY KEY (name, version))` to `src/db/schema.ts`, following the
   existing idempotent-exec convention.
2. In `src/skills/catalog.ts`, implement `refreshCatalogSnapshots(db, skills,
   now)`: upsert each scanned skill — insert new (name, version) pairs with
   `first_seen_at = last_seen_at = now`, bump `last_seen_at` for existing
   pairs.
3. Implement `resolveVersionAt(snapshots, name, timestamp)`: the (name,
   version) row whose `[first_seen_at, last_seen_at]` window covers the
   timestamp; if none covers it, the row with the earliest `first_seen_at`
   for that name, flagged `approximate: true` (spec: backfilled attribution is
   approximate); no rows → `version: null`.
4. Unit tests: fresh insert, `last_seen_at` bump, two versions of one skill
   resolving differently on either side of the version boundary, pre-history
   timestamp resolving approximate, unknown skill resolving null.

**Verification**: `pnpm test` — snapshot upsert and resolution cases pass,
including the two-versions boundary case (traces to the spec's
two-distinct-series success criterion).

**Done When**: after a simulated version bump between two refreshes,
invocation timestamps on either side resolve to different versions.

**Assumptions Verified**: `src/db/schema.ts:451-523` uses idempotent
`CREATE TABLE IF NOT EXISTS` exec blocks with no separate migration framework;
new tables are additive.

### Task 3: Trigger-health query

**Objective**: Compute per-skill health rows (invocations, last-invoked,
never-fired, misfire) over existing data.

**Files**: `src/db/v2-queries.ts`, `src/api/v2/types.ts`,
`tests/skills-health.test.ts` (new).

**Dependencies**: Tasks 1–2.

**Implementation Steps**:
1. Add types to `src/api/v2/types.ts`: `SkillHealthRow { name, version,
   versionApproximate, invocations, lastInvokedAt, neverFired, misfires,
   misfireRate }` (misfire fields null for skills whose invocations are all
   Codex-sourced).
2. In `src/db/v2-queries.ts`, add `getAnalyticsSkillsHealth(params:
   AnalyticsParams)`, modeled on `getAnalyticsSkillsDaily`
   (`src/db/v2-queries.ts:1742`):
   a. Explicit invocations: extend the existing explicit-`Skill` query to also
      select the invoking message's `session_id` and `ordinal` (via
      `tool_calls.message_id` → `messages.id`).
   b. Misfire per explicit invocation: one query loading, per session, the
      ordinal + content-prefix of user-role messages (uses
      `idx_messages_session_role`); in JS, an invocation misfires when the
      first user message with greater ordinal in the same session starts a
      text block with `[Request interrupted by user`. Group in JS like the
      existing accumulator pattern; no per-row correlated subqueries.
   c. Codex invocations: reuse the two existing Codex extraction queries;
      count toward invocations only.
   d. Version: `resolveVersionAt` against the snapshot table per invocation
      timestamp; aggregate rows keyed by (name, version).
   e. Never-fired: scanned catalog names with zero invocations in range are
      emitted with `neverFired: true`, `invocations: 0`.
3. Fixture tests in `tests/skills-health.test.ts` (flat in `tests/`, matching
   the runner glob at `package.json:19`): seed an in-memory/temp DB with (i) a
   session whose skill-invoking turn is followed by an interrupt-marker user
   message → misfire counted; (ii) a clean session → no misfire; (iii) a
   Codex-style invocation → counted, misfire null; (iv) a catalog fixture with
   an uninvoked skill → never-fired row present; (v) an invocation whose skill
   is absent from the catalog → retained with null version.

**Verification**: `pnpm test` — all five fixture cases pass (these are the
spec's fixture-backed test clauses verbatim); negative path (ii) proves the
heuristic doesn't over-fire.

**Done When**: contract clause 2's four metrics come back correct for every
fixture, and unresolvable invocations are retained (clause 1).

**Assumptions Verified**: interrupt marker text survives ingestion — parser
pushes text blocks verbatim (`src/parser/claude-code.ts:342`) into
`messages.content`; marker string confirmed in a real transcript
(`~/.claude/projects/.../a008a99b….jsonl`); ordinal linkage exists at
`src/parser/claude-code.ts:366` and `src/db/schema.ts:509-511`.

### Task 4: v2 endpoint

**Objective**: Serve health data as JSON so dojo can consume it over HTTP.

**Files**: `src/api/v2/router.ts`, `src/server.ts` (only if catalog refresh is
wired at startup), `tests/skills-health.test.ts`.

**Dependencies**: Task 3.

**Implementation Steps**:
1. Add `v2Router.get('/analytics/skills/health', …)` next to the daily
   handler (`src/api/v2/router.ts:588`), using `readAnalyticsParams`; before
   querying, run scan+`refreshCatalogSnapshots` guarded by a 60s in-memory TTL
   so repeated calls don't rescan the filesystem.
2. Response shape: `{ data: SkillHealthRow[], coverage }`, matching the daily
   endpoint's envelope.
3. Endpoint test: boot the router against the seeded fixture DB (same pattern
   as `tests/v2-api.test.ts`), assert the envelope and one row of each fixture
   kind.

**Verification**:
- `pnpm test` and `pnpm build` pass.
- Manual: `curl -s http://127.0.0.1:3141/api/v2/analytics/skills/health | jq`
  returns rows with name/version/invocations/misfireRate/neverFired, includes
  a never-fired skill and (post-Task-0) a version-attributed skill.
- Backfill proof: same curl with `date_from` predating this feature returns
  historical invocations (query-time computation over existing rows).

**Done When**: the spec's curl verification passes end-to-end on real local
data.

**Assumptions Verified**: daily handler envelope and error pattern at
`src/api/v2/router.ts:588-599`; `readAnalyticsParams` at
`src/api/v2/router.ts:403`.

### Task 5: Docs + lifecycle

**Objective**: Keep reference docs and lifecycle frontmatter honest.

**Files**: `README.md`, `docs/system/FEATURES.md`,
`docs/system/OPERATIONS.md`,
`docs/specs/2026-07-07-skill-trigger-health-spec.md`, this plan.

**Dependencies**: Task 4.

**Implementation Steps**:
1. Document the new endpoint in `README.md` (repo guardrail: API shape changes
   update README in the same change) and `docs/system/FEATURES.md`, including
   the Codex-misfire-exclusion caveat.
2. Add `AGENTMONITOR_SKILL_CATALOG_DIRS` to the env-var catalog in
   `docs/system/OPERATIONS.md`.
3. Flip spec + plan `status:` per lifecycle (`in-progress` at start of
   execution, `complete`/`shipped` when landed).

**Verification**: `rg -n "skills/health" README.md docs/system/FEATURES.md`
returns hits; `pnpm lint` clean.

**Done When**: docs match shipped behavior; lifecycle frontmatter is current.

## Risks And Mitigations

- **Stale sync leaves all versions unknown** → Task 0 is an explicit gated
  prerequisite with its own verification; the endpoint still functions
  (null versions) if skipped, so it degrades rather than breaks.
- **Marker-variant drift** (`[Request interrupted by user for tool use]`,
  future harness wording) → prefix match on `[Request interrupted by user`,
  fixture-pinned; wording changes in future Claude Code releases are an
  accepted, revisitable dependency.
- **Full-corpus scan cost at query time** → follows the existing
  `getAnalyticsSkillsDaily` full-scan precedent (same table sizes, same JS
  aggregation); user-message misfire lookup rides `idx_messages_session_role`.
  If latency becomes real, a persisted rollup is a later optimization, not a
  contract change.
- **Codex misfire blind spot** → scoped out explicitly in phase 1 and
  documented; misfire fields are null rather than silently zero, so consumers
  can't mistake absence for health.
- **Symlinked duplicate skills across the two catalog dirs** → dedupe by name
  in the scanner (Task 1 fixture covers it), consistent with the spec's
  assumption that installed copies share dojo-sourced name+version identity.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Version attribution incl. unknown retention (clause 1) | `pnpm test` (Task 2 boundary + Task 3 fixture v); `curl -s localhost:3141/api/v2/analytics/skills/health \| jq '.data[] \| select(.version != null)'` | boundary test passes; curl returns ≥1 version-attributed row post-Task-0 |
| Trigger-health metrics (clause 2) | `pnpm test` (Task 3 fixtures i–iv; Task 4 endpoint test) | misfire counted on interrupt fixture, absent on clean fixture, never-fired row present |
| Backfill over ingested history (clause 3) | `curl -s 'localhost:3141/api/v2/analytics/skills/health?date_from=2026-01-01' \| jq` | invocations dated before this feature shipped appear |
| JSON over local HTTP API (clause 4) | `curl -s localhost:3141/api/v2/analytics/skills/health \| jq '.data, .coverage'` | daily-endpoint-style envelope with SkillHealthRow fields |
| Repo gates | `pnpm lint && pnpm build && pnpm test` | all pass; new test files matched by `tests/*.test.ts` runner glob |

## Handoff

Execute tasks in order (0 → 5) in an AgentMonitor session; each task is
independently verifiable. Task 0 runs from dojo (skill-standardizer). After
Task 5, phase 2 (dojo-side consumer: health report → BACKLOG/skill-evals) gets
its own spec in dojo.
