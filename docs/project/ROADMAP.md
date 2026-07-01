# Roadmap

Directional roadmap for AgentMonitor. This is a planning snapshot, not a release contract or detailed implementation log.

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
