# Roadmap

Directional roadmap for AgentMonitor. This is a planning snapshot, not a release contract or detailed implementation log.

## Completed Highlights

Concise record of shipped work that has left `BACKLOG.md`. Newest first.

- Stable Portless operator origin (2026-07-14) — *What:* `amon serve` remains the
  single built-product launcher and now wraps the fixed `127.0.0.1:3141` runtime
  with pinned, package-local Portless at `https://agentmonitor.localhost`; the
  named root redirects to canonical `/app/`, Ctrl-C removes the route, and
  `--no-portless` preserves direct startup. Hook and OTEL ingestion remain on
  loopback rather than inheriting browser HTTPS concerns. *Why:* give the local
  console one stable human-facing origin without destabilizing its machine-facing
  ingestion contract.
- Pricing tables reach `dist/`, and the cwd stops deciding which DB you read (2026-07-13) — *What:* the build ran `cp -r src/pricing/data dist/pricing/data`, which creates the directory on the first run but on every run after descends into it and writes `dist/pricing/data/data/`, freezing the JSON the runtime reads at the first build (2026-02-19). Opus 4.8, Fable 5, Sonnet 5 and the GPT-5.6 tiers all landed in `src/` and none reached `dist/`. Fixed by clearing the destination first, plus `scripts/check-pricing-dist.mjs` in `pnpm build`. Separately, the default DB path was cwd-relative, so `amon serve` from outside the repo silently created a second database and auto-imported into it; it now follows the install, resolved through one shared resolver so `amon status` cannot disagree with the server. *Why it hid for five months:* every gate reads `src/` — `tsc`, `pnpm test` and `pnpm dev` all run from source, and only `amon serve` loads `dist/`. An unpriced model bills as $0 rather than raising, so the dashboard stayed plausible while under-reporting the most-used models entirely. Events written while the build was stale carry `cost_usd = 0`; `amon costs recalc` repairs them. Any non-TS asset the build copies into `dist/` has this shape and no gate would catch it.
- GPT-5.6 pricing + Codex attribution backport (2026-07-12) — *What:* added standard API pricing for `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, including the unsuffixed Sol alias, cache-write charges, and full-request long-context tiers above 272K; usage classification exposes the durable Sol/Terra/Luna tiers. Codex historical import now follows each JSONL `turn_context` model rather than stamping current `config.toml`, with a one-shot hash invalidation and narrowly scoped duplicate refresh that corrects model/cost plus trace summaries while leaving legacy config-only logs untouched. *Why:* the pricing table alone would have mislabeled real Terra and Luna sessions as whichever model happened to be configured during import.
- Skill trigger health, phase 1 (2026-07-09) — *What:* `/api/v2/analytics/skills/health` reports per-skill invocations, last-invoked, never-fired flags, an interrupt-based misfire rate (with `misfireEligible` denominator), and the skill version installed at each invocation. Computed at query time over existing `tool_calls`/`messages`/`events` rows (historical backfill, no reingest) with a TTL-throttled catalog-snapshot refresh; installed catalogs configurable via `AGENTMONITOR_SKILL_CATALOG_DIRS`. *Why:* the measurement plane for a skill feedback loop — version-over-version comparison of skill edits. Verified on the live 1.1GB DB (79 rows over 639 invocations). Dojo-side consumer + signal widening are phase 2 (see BACKLOG). Spec/plan: `docs/specs/2026-07-07-skill-trigger-health-spec.md`, `docs/plans/2026-07-09-skill-trigger-health-plan.md`.
- Context occupancy gauge + backfill (2026-07-07) — *What:* per-session context-window occupancy on Monitor cards and the Live inspector, resolved through a shared per-agent window resolver. `insertParsedSession` writes occupancy on the initial-sync/import path so cards populate on boot; a one-shot `runDataMigrations` step (`user_version` 1→2, `backfillOccupancyOnUpgrade`) invalidates the `watched_files` hash for null-occupancy Claude/Codex sessions once so an already-synced DB backfills on the next startup sync. *Why:* idle/historical sessions previously showed occupancy only after their next live turn. Gated to Claude/Codex; one-time bounded reparse on upgrade. Plan: `docs/plans/2026-07-07-context-occupancy-gauge-plan.md`.
- Invocation-mode pill (headless/interactive) — *What:* the file watcher stamps `sessions.metadata.mode` from the JSONL as it parses (verified end-to-end within ~1s), with `session_parsed` refreshing the open Monitor and auto-import as backstop; historical sessions backfill via `setSessionMode` on `amon import --force`. Required fixing a chokidar-5 regression to watch directories, not globs — which unblocked all live file-tailing. Also corrected Codex `cli_version`/`originator` metadata mislabeling in `src/import/codex.ts`. *Why:* distinguish `claude -p` headless runs from interactive sessions in the operator surface.
- Pricing data currency (2026-07-08) — *What:* prompt-size price tiers in `calculate()` (optional `tiers` array selecting rates by uncached input + cacheRead + cacheWrite), applied to `gemini-3.1-pro-preview` and `gemini-2.5-pro` >200K tiers; added `gemini-3.5-flash` and `claude-fable-5` with Antigravity id/display aliases and a `fable` classifier tier. *Why:* keep local cost estimates faithful to published provider pricing. Note: new tiers affect newly-calculated costs only; large historical Gemini sessions need an `amon reparse`/maintenance recalc to pick up the correction.

## Now

- Reduce remaining legacy `/` dashboard reliance now that the Svelte app and `/api/v2/*` contract are the clear product center.
- Keep only the durable v1 localhost behavior that still serves ingest, SSE, provider quota, or legacy compatibility needs.
- Improve the Live surface, especially around fidelity boundaries, session noise, and operator clarity when data is summary-only.
- Use the shipped `amon` / `agentmonitor` CLI as the primary operator command surface for runtime checks, maintenance, and local reporting.

## Focus Areas

### Legacy Surface Reduction

- Define cutover gates for replacing or redirecting the legacy `/` dashboard with the Svelte app.
- Preserve v1 endpoints intentionally where they support ingest clients, SSE compatibility, provider quota bridge behavior, or low-risk legacy access.
- Remove legacy-only UI paths once the Svelte app covers the corresponding operator workflows and manual regression checks are stable.

### Live Fidelity and Operator Clarity

- Improve Codex live projection beyond the current summary-first OTEL path where richer local or telemetry sources are available.
- Make fidelity boundaries obvious in the UI so operators can distinguish transcript-capable sessions from summary-only sessions without guessing.
- Reduce session noise through better grouping, filtering, and session lifecycle presentation in Live and Monitor views.

### Product Polish and Release Confidence

- Continue tightening Monitor, Live, Sessions (Browse / Pinned sub-views), Search, and the consolidated Analytics tab (Overview / Usage / Insights sub-views) around real review and monitoring workflows.
- The "Instrument Console" Svelte redesign is **shipped (Phases 1–6)**: every `/app/` tab is on the design tokens — foundation (tokens + type + shell), shared primitives, Monitor, Sessions/Search, the consolidated Analytics group, and the Live operator view. IA consolidations: Usage + Insights → Analytics sub-views; Pinned → a Sessions sub-view. Mobile was intentionally deprioritized (laptop-first; agents run on-device).
- The first-class CLI is **shipped** with `amon` as the preferred executable and `agentmonitor` as an alias. Keep new maintenance and reporting workflows discoverable there before adding more package scripts.
- Maintain a manual regression checklist for the canonical Svelte app, especially around deep links, long transcripts, live updates, and drawer/navigation behavior.
- Prefer small UI refinements that reduce ambiguity over larger redesigns unless operator workflows show a clear gap.

### Trace Quality

- **Reframed (2026-06) to a lean, collector-not-backend view** — shipped: one trace per session served from the content-free `session_trace_summary`, detail projected on-demand, and three `/api/v2/trace-quality/{traces,traces/:id,traces/:id/observations}` reads. The persisted trace/observation/score/prompt warehouse (~half the DB) was removed and is reclaimed via the opt-in `pnpm reclaim:trace-quality`. The eval depth (scores/findings/prompts) is **deferred to the export**, not reinvented locally. See [../system/trace-quality.md](../system/trace-quality.md) and [POSITIONING.md](POSITIONING.md).
- Keep coverage honesty as a first principle: summary-only telemetry (e.g. Codex OTEL) must never render as full fidelity in the UI or API.
- The content-free aggregate export is **shipped** as `amon warehouse publish`: it publishes `session_trace_summary` into AgentMonitor's own `agentmonitor.runs` schema/table with lineage and an optional `medallion_bi` grant. The Langfuse depth path remains deferred via `trace_quality_export_state`.

## Next

- Define and verify parity gates for retiring or sharply reducing reliance on the legacy `/` dashboard.
- Tighten v2 contract coverage and runtime testing for the TypeScript backend.
- Keep improving session browsing, search, analytics, and live inspection where real operator workflows expose gaps.
- Make integration behavior and capture/redaction settings easier to understand from the product surface, CLI, and docs.

## Later

- Support richer Codex-native live fidelity beyond the current OTEL summary path.
- Revisit packaging or alternate runtime distribution work once the canonical web contract is stable.
- Expand multi-agent support where new integrations can map cleanly onto the existing monitor, history, and live models.
- Build the **deferred Langfuse trace-quality depth export**: forward the on-demand projection to Langfuse for trace/eval depth via the dormant `trace_quality_export_state` seam. Keep it manual-first, redaction-aware, dry-run-previewable, and never required for local functionality.
- Optional medallion-owned follow-up: add an adoption-KPI-excluded assistant/coding-agent usage view over `agentmonitor.runs`; do not fold AgentMonitor's personal account telemetry into `gold.adoption_kpis_daily`.

## Working Principles

- Prefer extending `/app/` and `/api/v2/*` over adding new behavior to the legacy `/` surface.
- Keep fidelity honest in both product UI and API responses, especially when Claude and Codex capabilities differ.
- Favor docs and plans that age well: roadmap for direction, plan docs for implementation detail, architecture docs for system shape.

## Active References

- Repo convergence plan: [../plans/2026-04-08-repo-convergence-implementation.md](../plans/2026-04-08-repo-convergence-implementation.md)
- Architecture overview: [../system/ARCHITECTURE.md](../system/ARCHITECTURE.md)
- Product surface reference: [../system/FEATURES.md](../system/FEATURES.md)
