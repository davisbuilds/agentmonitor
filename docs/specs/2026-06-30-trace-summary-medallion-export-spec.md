---
date: 2026-06-30
topic: trace-summary-medallion-export
stage: spec
status: draft
source: conversation
---

# Trace-Summary Medallion Export Spec

## Goal

Publish AgentMonitor's content-free `session_trace_summary` rows into the shared
Postgres warehouse so the portfolio BI (Metabase) can show amon's per-session
agent telemetry alongside prism and medallion. This is the **deferred aggregate
export** the trace-quality reframe was shaped for — the summary's columns already
line up with medallion's `silver.agent_runs` shape, so the work is publish
plumbing, not a reshape.

**Semantics, not just columns.** amon's rows carry the *column shape* of
`silver.agent_runs` (tokens, latency, model, quality) but the *grain and
semantics* of `silver.assistant_runs`: a personal, configured `account`,
content-free operational volumetrics, and — per medallion's own note — data that
must **not** be folded into the org-wide utilization KPI (gold). This distinction
drives Model A and the follow-up shape below; getting it wrong would push amon
into medallion's `agent_runs`/gold path, which medallion's `silver.sql`
explicitly warns against.

The export is **opt-in, optional, and standalone**: amon takes no runtime
dependency on the warehouse, never imports a Postgres driver unless the export
runs, and never blocks ingest or local use. It mirrors prism's proven
`PostgresInsightSink` pattern (own schema + `medallion_bi` grant + idempotent
publish), keeping amon a **collector that never depends on medallion at runtime**.

## Background

Verified against code this session (seam-first):

- **Producer:** `session_trace_summary` is amon's only persisted, content-free,
  per-session rollup (columns: `session_id, trace_id, agent_type, project,
  primary_model, started_at, ended_at, observation_count, error_count, tokens_in,
  tokens_out, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms_total,
  coverage_json, quality_score, quality_grade, projection_version, updated_at`).
  No message text. `ensureSessionTraceSummaryBackfill()` self-heals it.
- **Consumer contract (medallion surfaces, verified in `silver.sql` + `gold.sql`):**
  - `silver.agent_runs` is a **view over `bronze.langfuse_raw`** reading
    `payload ->> {user_id, session_id, model, input_tokens, output_tokens,
    latency_ms, quality_score, start_time}`, keyed on `user_id → employee_id`, and
    **wired into `gold.adoption_kpis_daily`** (the org-wide utilization KPI).
    amon's summary columns map 1:1 to its *columns*.
  - `silver.assistant_runs` is a content-free **account-grain** view
    (`payload ->> 'account' AS employee_id`) over `bronze.claude_raw` +
    `bronze.chatgpt_raw`, carrying only volumetrics (provider/model/started_at),
    and **does not feed the org-wide adoption KPI**. Current `gold.sql` rolls it
    into a separate `gold.assistant_usage_daily` surface (`day × provider × model`,
    no identity column). Note: `silver.sql` still contains a stale "not wired into
    gold yet" comment, but `gold.sql` and current docs are authoritative here.
  - **amon belongs with `assistant_runs` semantically** (personal account,
    content-free, not the org-wide adoption KPI) while being a metric *superset*
    of it. So the row shape borrows `agent_runs` columns but the **grain,
    identity, and adoption-KPI exclusion follow `assistant_runs`.**
- **Why not ride the Langfuse path for the aggregate:** `silver.agent_runs` reads
  `bronze.langfuse_raw`, so a Langfuse export would in principle land amon there
  "for free." We reject this for the aggregate: Langfuse models
  `trace → observation → score`, not flat fact rows, so carrying a per-session
  rollup means synthesizing a fake single-span trace as a transport envelope —
  more moving parts (a running Langfuse + medallion's bronze loader), a runtime
  Langfuse dependency, a harder content-free proof (rich payloads invite text),
  and it would land in the `agent_runs`/gold path we specifically want to avoid.
  Langfuse stays the home for **depth** (trace/eval), not the aggregate.
- **Precedent:** prism's `src/prism/sinks/postgres.py` writes its **own `insight`
  schema** (never medallion's bronze/silver/gold), grants the `medallion_bi` read
  role so one Metabase login reads both, and is idempotent (delete-then-insert per
  `run_id`). It lazily imports `psycopg` behind an opt-in `warehouse` extra. Prism
  also checks `pg_roles` before granting and silently skips the grant when the BI
  role is absent; amon should copy that pattern rather than issuing a failing
  `GRANT` inside a transaction.
- **BI role nuance:** medallion creates `medallion_bi` as a gold-only role; prism
  intentionally extends that same role to `insight.*`. amon's grant to
  `agentmonitor.*` is the same intentional BI-surface extension, not inherited
  access from medallion's gold grants.
- **medallion is a single-operator learning playground** modeling enterprise
  employee/org analytics (`employee_id` grain, `medallion_bi` role, release
  ledgers). So model the real org-warehouse scaffolding: a configured
  `account → employee_id` identity (matching `assistant_runs`) and release
  lineage — but no differential privacy (that fits prism's content-derived
  clusters, not amon's operational telemetry).

**Decisions locked (this session):** Landing **Model A** — amon owns an
`agentmonitor` schema in the shared Postgres, never touching medallion's schemas.
Identity is a **configured `account` label** (→ `employee_id`), mirroring
`silver.assistant_runs`. The export is **content-free + lineage**; no DP. The
optional medallion follow-up (below) targets an **`assistant_runs`-style,
adoption-KPI-excluded** surface, **not** `agent_runs` /
`gold.adoption_kpis_daily`. It may later roll into a dedicated assistant/coding
usage gold surface analogous to `gold.assistant_usage_daily`. `pg` is a normal
dependency (accepted), lazily imported so the server/ingest path never loads it.

## Scope

### In Scope

- An opt-in `agentmonitor.runs` fact (one row per account/session, upsert by
  `(account, session_id)`) + an `agentmonitor.publish_run` lineage ledger, in the
  shared Postgres; a `medallion_bi` grant so BI reads it.
- A pure mapping layer (summary row → warehouse row; content-free allowlist +
  value-shape guard; lineage), unit-tested with no DB.
- An opt-in Postgres sink (lazy-imported `pg`), and a `--dry-run` that emits the
  planned rows + counts without connecting.
- A CLI command (`amon warehouse publish`) and config/env wiring.
- Docs (OPERATIONS command, a `trace-quality.md` export section).

### Out of Scope

- **Any medallion-repo change.** Model A needs none; a future
  adoption-KPI-excluded, `assistant_runs`-style conforming view over
  `agentmonitor.runs` is medallion's call and a separate effort (noted in
  Handoff). Explicitly **not** a `silver.agent_runs_all` UNION into the org-KPI
  fact — that contradicts medallion's stated design. A later dedicated
  coding-agent usage gold surface may be reasonable, mirroring
  `gold.assistant_usage_daily`, but that belongs in medallion.
- **The Langfuse depth export** (forwarding the on-demand projection for
  trace/eval tooling) — a distinct later spec; this is the aggregate path only,
  and by design does **not** route through Langfuse (see Background).
- **Retraction / tombstones.** The upsert never removes a warehouse row whose
  session later drops from source (local redaction/deletion). Documented as a
  known limitation; a delete/tombstone path is a follow-up, not this spec.
- Differential privacy / heavy anonymization (wrong tool for content-free
  operational metrics; see Background).
- A small-batch "release gate." Reconsidered this session: a `cell_min`-style
  suppression is meaningful for prism's *aggregated clusters* but not for a
  *row-level per-session fact* (suppressing a batch of 4 while publishing a batch
  of 5 single-session rows gives zero privacy). Dropped as a pillar; an optional
  operator `--min-batch` guard (default off) is all that remains (Task 2).
- Auto-publish on ingest, schedulers, or a network dependency in the server path.

## Assumptions And Constraints

- **`pg` is a normal dependency, lazily imported.** It goes in `dependencies`
  (accepted this session), `@types/pg` in `devDependencies`. It is *installed*
  for everyone but *imported* only when the sink runs (`await import('pg')`), so
  the server/ingest runtime never loads it. The opt-in is DSN presence, not
  install. (Note: npm `optionalDependencies` are installed by default too — they
  are **not** the equivalent of prism's pip `warehouse` extra — so we don't lean
  on that framing.) A clear, actionable error is thrown if the DSN is absent.
- **Content-free invariant (two layers).** (1) *Allowlist:* the row's key set must
  equal the explicit `WarehouseRunRow` allowlist derived from
  `session_trace_summary` — no message/text/payload fields leave. (2)
  *Value-shape guard:* all text-like columns are asserted by field shape:
  `model`, `project`, `agent_type`, `quality_grade`, and `account` are short,
  bounded, non-free-text values; IDs (`session_id`, `published_run_id`) are
  bounded opaque IDs; timestamps/dates (`started_at`, `day`) are ISO/date-shaped.
  This catches content smuggled into an allowlisted column (which a name-only
  denylist would miss). The CLI may self-heal the local summary first, which can
  read source tables locally, but those source rows are never mapped or sent to
  Postgres.
- **Summary source seam.** The warehouse command should not reuse
  `listSessionTraces()` because that API maps `session_trace_summary` into the
  UI/API trace shape and drops/renames fields the export needs. Add a small raw
  summary read helper for warehouse publishing, sharing the same date-window
  semantics as the trace-quality list.
- **Standalone.** Nothing in `src/server.ts` / ingest imports the warehouse module;
  it is reachable only via the explicit CLI command (and its own tests).
- **Idempotent, with a known no-retraction limit.** The fact upserts by
  `(account, session_id)` (re-publishing a session for the same account replaces
  that row); each invocation appends one `publish_run` ledger row. This diverges
  from prism's delete-then-insert because amon's grain is a continuous
  per-session fact, not a per-run mart (verified against both schemas). Trade-off:
  an upsert never *removes* a row whose session later drops from source — tracked
  as the out-of-scope tombstone follow-up.
- **`account` identity is pinned by default.** The fact key is
  `(account, session_id)`; publishing the same real session under two `account`
  values would double-count in any per-day aggregate. So `account` comes from
  config; the CLI `--account` override is allowed but warns and records the
  effective account in lineage so identity drift for a session is visible.
- **Config pattern.** New env vars follow `src/config.ts`'s `parseEnv*` helpers and
  a structured `warehouse` config section. CLI registers via `registerCommand`.
- TDD: pure mapping/content-free logic is red/green unit-tested; the live publish
  path is manually verified against a running medallion Postgres (documented).

## Task Breakdown

### Task 1: Warehouse config + lazy `pg` dependency + row contract

**Objective**

Add an opt-in `warehouse` config section, the lazy `pg` dependency, and the
typed published-row + ledger contract — with no behavior wired yet.

**Files**

- Modify: `src/config.ts` (new `warehouse` config from env)
- Modify: `package.json` (`pg` in `dependencies`, `@types/pg` in
  `devDependencies`)
- Create: `src/warehouse/types.ts` (`WarehouseRunRow`, `PublishLineage`, `WarehouseConfig`)

**Dependencies**

None

**Implementation Steps**

1. Add a `warehouse` config block read from env via the existing `parseEnv*`
   helpers: `AGENTMONITOR_WAREHOUSE_DSN` (Postgres DSN; export disabled if unset),
   `AGENTMONITOR_WAREHOUSE_ACCOUNT` (the `account`→`employee_id` label; default
   e.g. `local`), `AGENTMONITOR_WAREHOUSE_SCHEMA` (default `agentmonitor`),
   `AGENTMONITOR_WAREHOUSE_BI_ROLE` (default `medallion_bi`). `enabled` is derived
   as `Boolean(dsn)`.
2. Add `pg` to `dependencies` and `@types/pg` to `devDependencies`. It stays out
   of the server/ingest runtime by being imported lazily in the sink only (Task 3),
   not by being uninstalled.
3. Define `WarehouseRunRow` (account, session_id, model, input_tokens,
   output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms,
   observation_count, error_count, quality_score, quality_grade, project,
   agent_type, started_at, day, published_run_id) and `PublishLineage` (run_id,
   created_at, account, window_start, window_end, sessions_published,
   sessions_suppressed, min_batch, amon_version, grant_role, grant_skipped).

**Verification**

- Run: `pnpm build`
- Expect: compiles; `config.warehouse` present and disabled when no DSN env.
- Run: `node --input-type=module -e "const { config } = await import('./dist/config.js'); console.log(config.warehouse.enabled)"`
  with no warehouse env set
- Expect: prints `false`; no throw and no `pg` load.

**Done When**

- Config + lazy dep + contract types exist and compile; export is inert with no DSN.

### Task 2: Pure mapping + content-free guard + lineage (no DB)

**Objective**

Map a `session_trace_summary` row to a `WarehouseRunRow`, enforce the content-free
invariant (allowlist **and** value-shape), and build lineage — all pure and
unit-tested without a database.

**Files**

- Create: `src/warehouse/source.ts` (`listWarehouseSessionTraceSummaries`)
- Create: `src/warehouse/runs-export.ts` (`mapSummaryToRunRow`, `assertContentFree`,
  `applyMinBatch`, `buildLineage`)
- Test: `tests/warehouse-runs-export.test.ts`

**Dependencies**

Task 1

**Implementation Steps**

1. `listWarehouseSessionTraceSummaries(params)`: read raw `session_trace_summary`
   rows for `date_from`/`date_to` over `COALESCE(started_at, updated_at)` with the
   same date-only `date_to` exclusive-next-day semantics as `listSessionTraces`.
   Return the full summary row shape needed by the mapper, not the UI/API
   `TraceQualityTrace` shape.
2. `mapSummaryToRunRow(summary, account, runId)`: map columns (`tokens_in`→
   `input_tokens`, `tokens_out`→`output_tokens`, `latency_ms_total`→`latency_ms`,
   `primary_model`→`model`, …), derive `day` from `started_at` (UTC date), stamp
   `account` + `published_run_id`.
3. `assertContentFree(row)`, two layers:
   - **Allowlist as set-equality:** the row's own-key set must *equal* the explicit
     `WarehouseRunRow` allowlist — not a subset check. Extra keys fail; missing
     keys fail. This is stronger than a name denylist and independent of source
     field names.
   - **Value-shape guard:** each text-like column must pass a field-specific
     shape: `model`, `project`, `agent_type`, `quality_grade`, and `account` are
     short bounded strings (e.g. ≤128 chars, no newlines); IDs (`session_id`,
     `published_run_id`) are bounded opaque IDs; dates/timestamps (`started_at`,
     `day`) are ISO/date-shaped. Numeric/metric columns (`input_tokens`,
     `output_tokens`, `cost_usd`, `latency_ms`, …) are asserted numeric — note
     `output_tokens` is an intended aggregate, so nothing bans the substring
     `output`.
4. `applyMinBatch(rows, minBatch)`: optional operator guard (default `minBatch = 0`
   = publish all). When set, publish nothing if `rows.length < minBatch`. This is
   **not** a privacy control (a per-session fact has no k-anonymity); it only
   prevents fat-finger tiny/manual publishes. Returns `{ published, suppressed }`.
5. `buildLineage(...)`: assemble the `PublishLineage` for the ledger row, including
   the effective `account`, window, counts, `amon_version` (from the public
   `packageVersion()` helper in `src/cli/package.ts`), `grant_role`, and (set later
   by the sink) `grant_skipped`.

**Verification**

- Run: `pnpm test tests/warehouse-runs-export.test.ts`
- Expect: source helper returns raw summary rows with correct inclusive/exclusive
  date semantics; column mapping exact (incl. `day` and token/latency renames); an
  extra or missing key trips the set-equality allowlist; a long/newline-bearing
  value in a text-like column trips the field-specific value-shape guard; IDs and
  dates are shape-checked; `output_tokens` remains allowed; with `minBatch` set,
  a smaller batch yields zero published rows + correct
  `sessions_suppressed`, and with `minBatch = 0` everything publishes.

**Done When**

- Mapping + two-layer content-free guard + optional min-batch + lineage are pure,
  correct, and unit-tested.

### Task 3: Opt-in Postgres sink (lazy `pg`) + dry-run

**Objective**

Publish the gated rows into `<schema>.runs` (upsert by `(account, session_id)`) +
append a `<schema>.publish_run` ledger row + grant `medallion_bi`, mirroring
prism's sink — with a `--dry-run` that plans without connecting.

**Files**

- Create: `src/warehouse/postgres-sink.ts` (`publishRuns(rows, lineage, config)`,
  `planRuns(...)` for dry-run)
- Test: `tests/warehouse-postgres-sink.test.ts` (dry-run plan only; no live DB)

**Dependencies**

Task 2

**Implementation Steps**

1. `planRuns`: return the exact SQL + row counts the publish would execute
   (schema/table DDL, the upsert, the ledger insert, the grant) without importing
   `pg` — this is the dry-run output and the unit-test surface.
2. `publishRuns`: lazily `await import('pg')` (clear error if missing); in one
   transaction — `CREATE SCHEMA IF NOT EXISTS`; `CREATE TABLE IF NOT EXISTS`
   `runs` (PK `(account, session_id)`) and `publish_run` (PK `run_id`); `INSERT …
   ON CONFLICT (account, session_id) DO UPDATE` for each run row; insert the
   lineage row; check `pg_roles` for the configured BI role before granting; only
   then issue `GRANT USAGE` + `GRANT SELECT`. If the role is absent, continue the
   publish and report `grant_skipped: true` with the role name in the result and
   lineage metadata. Do not issue a failing `GRANT` inside the transaction; that
   would abort the publish.
3. Validate `schema`/`bi_role` identifiers (regex) before interpolating, per the
   prism sink.

**Verification**

- Run: `pnpm test tests/warehouse-postgres-sink.test.ts`
- Expect: `planRuns` emits idempotent upsert SQL keyed on `(account, session_id)`,
  a ledger insert, and BI-role lookup/grant steps; no `pg` import occurs in the
  dry-run path. Unit tests cover both role-present and role-absent grant planning.
- Run: `pnpm build`
- Expect: compiles with `pg` only as a lazy import.

**Done When**

- The sink publishes idempotently + grants BI, and a dry-run plans it with no DB and no `pg` import.

### Task 4: `amon warehouse publish` CLI command

**Objective**

Expose the export as an explicit CLI command that reads the summary (self-healing
first), maps + gates, and publishes or dry-runs.

**Files**

- Create: `src/cli/commands/warehouse.ts` (`registerWarehouseCommands`)
- Modify: the CLI command registry entrypoint to register the new group
- Test: `tests/cli-contracts.test.ts` (dry-run contract)

**Dependencies**

Task 3

**Implementation Steps**

1. Register `warehouse publish` (group `Warehouse Commands`) with `--dry-run`,
   `--date-from`/`--date-to` (window over `COALESCE(started_at, updated_at)`,
   matching the trace-quality list date semantics), `--account` (override the
   config label), and `--min-batch` (optional operator guard, default 0).
2. Handler: `initSchema()` + `ensureSessionTraceSummaryBackfill()` (self-heal like
   `quality traces`; may full-backfill if any summary row is stale or missing
   `trace_id`), read raw `session_trace_summary` rows for the window through the
   warehouse summary helper, map + `assertContentFree` + `applyMinBatch`, then
   `planRuns` (dry-run → print plan + counts) or `publishRuns` (live).
3. `--account` override: since the fact key is `(account, session_id)`, publishing
   the same sessions under a different account double-counts. So default `account`
   to config; when `--account` is passed, emit a visible warning and record the
   effective account in lineage. (Config-pinned is the happy path.)
4. Fail with actionable guidance when no DSN is configured (point at the env var);
   never throw an unhandled error.
5. Use the existing global `--json` contract (`pnpm cli -- --json ...` /
   installed `amon --json ...`) or explicitly accept a local `--json` flag if this
   command keeps the docs' `warehouse publish --dry-run --json` form. Current CLI
   parsing treats `--json` as global before the command.

**Verification**

- Run: `pnpm test tests/cli-contracts.test.ts`
- Expect: JSON dry-run exits 0 and reports planned/suppressed counts over seeded
  summaries, with no DSN required and no DB write. Use whichever JSON invocation
  the implementation supports (`pnpm cli -- --json warehouse publish --dry-run`, or
  local `warehouse publish --dry-run --json` if the command accepts a local flag).
- Run: `pnpm cli -- warehouse publish` with no DSN
- Expect: exit non-zero with a clear "set AGENTMONITOR_WAREHOUSE_DSN" message.

**Done When**

- The command dry-runs with no warehouse, publishes when configured, and self-heals the summary.

### Task 5: Docs

**Objective**

Document the export as the realized deferred export, with the medallion-side
unification noted as an optional future follow-up.

**Files**

- Modify: `docs/system/trace-quality.md` — **supersede** (not just edit) the
  "Deferred Export" section's medallion bullet: it currently says publish *into
  `silver.agent_runs`* with delete-then-insert; Model A reverses both (own
  `agentmonitor.runs`, upsert), so call out the change explicitly.
- Modify: `docs/system/OPERATIONS.md` (a "Warehouse Export" command section + the
  new `AGENTMONITOR_WAREHOUSE_*` env vars)
- Modify: `docs/project/ROADMAP.md` (move the medallion aggregate export to shipped;
  keep Langfuse depth deferred)

**Dependencies**

Task 4

**Implementation Steps**

1. Document the contract (`agentmonitor.runs` columns, `(account, session_id)`
   idempotency + the no-retraction limit, `publish_run` lineage, the
   `account → employee_id` mapping mirroring `silver.assistant_runs`, and the
   intentional `medallion_bi` grant/reporting extension to the `agentmonitor`
   schema).
2. Document the opt-in env vars + `pnpm cli -- warehouse publish [--dry-run]`, and
   the two-layer content-free guard (allowlist + value-shape), the optional
   `--min-batch` operator guard (and why it is not a privacy control and why no DP).
3. Note the optional medallion follow-up: an **adoption-KPI-excluded,
   `assistant_runs`-style** conforming view over `agentmonitor.runs` (e.g.
   `silver.coding_agent_runs`, or a UNION branch into `assistant_runs`), and
   potentially a dedicated coding-agent usage gold surface analogous to
   `gold.assistant_usage_daily`. Do **not** add a `silver.agent_runs_all` UNION into
   the org-KPI fact — medallion explicitly keeps personal assistant usage separate
   from `gold.adoption_kpis_daily`. medallion's call, no amon change required.

**Verification**

- Run: `rg -n "warehouse publish|agentmonitor.runs|AGENTMONITOR_WAREHOUSE" docs`
- Expect: the command, contract, and env vars are documented; no stale "deferred" claim for the medallion path.

**Done When**

- Docs describe the shipped export and the optional medallion-side unification.

## Risks And Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| `pg` in the server/ingest runtime path | Low | Med | `pg` is a normal dependency (accepted) but imported lazily only in the sink; server/ingest never import the warehouse module (grep-verified). Disabled with no DSN. |
| A future summary column leaks text | Low | High | `assertContentFree` uses set-equality on the allowlist **and** a value-shape guard on text columns, so both an added column and text smuggled into an allowlisted column fail; source rows are never mapped. |
| Re-publishing duplicates or loses rows | Med | Med | Upsert by `(account, session_id)` (idempotent per account); lineage ledger records each run. Known limit: no retraction of dropped sessions (out-of-scope tombstone follow-up). |
| Same session double-counted under two accounts | Med | Med | `account` is config-pinned by default; `--account` override warns and is recorded in lineage so identity drift is visible. |
| Writing into medallion's schemas couples the repos | Low | High | Model A: amon owns the `agentmonitor` schema and only grants `medallion_bi`; medallion's bronze/silver/gold untouched. |
| Follow-up mixes amon into the org-wide adoption KPI | Med | Med | Follow-up is explicitly an `assistant_runs`-style, adoption-KPI-excluded view — not `silver.agent_runs_all`; a dedicated coding-agent usage gold surface may be OK, but `gold.adoption_kpis_daily` is not. |
| `medallion_bi` role absent on a fresh warehouse | Med | Low | Copy prism's `pg_roles` pre-check before granting; never issue a failing `GRANT` inside the transaction. Publish/dry-run output and lineage report `grant_skipped` with the role name so BI access gaps are visible. |
| Identity (`account`) misused as a person | Low | Med | Configured label, documented as `→ employee_id` (mirrors `assistant_runs`); defaults to a clear placeholder, not a real identity. |
| Live publish untested in CI (no Postgres) | Med | Low | Dry-run `planRuns` is fully unit-tested; the live path is documented for manual verification against medallion. |

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Lazy dep, inert without DSN | `pnpm build && node --input-type=module -e "const { config } = await import('./dist/config.js'); console.log(config.warehouse.enabled)"` | compiles; prints `false`; no `pg` load |
| Mapping + source read + content-free + min-batch correct | `pnpm test tests/warehouse-runs-export.test.ts` | raw summary read preserves date semantics; exact column map; extra/missing key rejected (set-equality); text-like field shapes rejected when unsafe; `output_tokens` allowed; sub-`minBatch` batch suppressed, `minBatch=0` publishes all |
| Idempotent publish plan, BI grant | `pnpm test tests/warehouse-postgres-sink.test.ts` | upsert-by-`(account, session_id)` SQL + ledger insert + `medallion_bi` lookup/grant reporting; role-present and role-absent cases covered; no `pg` in dry-run |
| CLI dry-run with no warehouse | `pnpm cli -- --json warehouse publish --dry-run` (or documented local-flag equivalent) | exit 0; planned/suppressed counts; no DB write |
| Clear failure with no DSN | `pnpm cli -- warehouse publish` (no DSN) | non-zero exit; actionable env-var message |
| Standalone (server never imports it) | `rg -n "warehouse/" src/server.ts src/runtime.ts` | no match |
| Full gate | `pnpm lint && pnpm build && pnpm test` (clean env) | green |
| Docs current | `rg -n "warehouse publish\|agentmonitor.runs" docs` | command + contract documented |

## Handoff

- Execute Tasks 1–5 in a separate session; the live publish path is verified
  manually against a running medallion Postgres (`AGENTMONITOR_WAREHOUSE_DSN`), the
  rest in CI via dry-run + unit tests.
- After landing, confirm in Metabase that `agentmonitor.runs` is readable via
  `medallion_bi` and joins prism/medallion on `day`; this is an intentional
  extension of the BI role to amon's own schema, like prism's `insight.*` grant.
- **Optional medallion follow-up (separate, medallion-owned):** add a
  **adoption-KPI-excluded, `assistant_runs`-style** conforming view over
  `agentmonitor.runs` — e.g. `silver.coding_agent_runs`, or a UNION branch folded
  into `silver.assistant_runs` — keyed on `account → employee_id`. A dedicated
  coding-agent usage gold surface analogous to `gold.assistant_usage_daily` may be
  reasonable. Do **not** add a `silver.agent_runs_all` UNION into the
  langfuse-sourced, adoption-KPI-wired `silver.agent_runs`: mixing personal
  `account` volumetrics into `gold.adoption_kpis_daily` would produce a
  meaningless org-utilization number. No amon change is required; track it in
  `~/Dev/medallion`'s backlog.
- The **Langfuse depth export** (forwarding the on-demand projection via the dormant
  `trace_quality_export_state` seam) remains a distinct later spec.

### Next Steps

1. Execute Tasks 1–5 in a separate session, then verify the live publish against medallion.
2. Open the optional medallion follow-up (adoption-KPI-excluded,
   `assistant_runs`-style view over `agentmonitor.runs`, possibly with a dedicated
   usage gold surface) in the medallion repo.
3. Refine this spec before implementation.
