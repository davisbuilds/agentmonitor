# Roadmap

Directional roadmap for AgentMonitor. This is a planning snapshot, not a release contract or detailed implementation log.

## Now

- Reduce remaining legacy `/` dashboard reliance now that the Svelte app and `/api/v2/*` contract are the clear product center.
- Keep only the durable v1 localhost behavior that still serves ingest, SSE, provider quota, or legacy compatibility needs.
- Keep converging the Rust backend onto the same canonical web contract instead of letting it evolve as a separate product shape.
- Improve the Live surface, especially around fidelity boundaries, session noise, and operator clarity when data is summary-only.

## Focus Areas

### Legacy Surface Reduction

- Define cutover gates for replacing or redirecting the legacy `/` dashboard with the Svelte app.
- Preserve v1 endpoints intentionally where they support ingest clients, SSE compatibility, provider quota bridge behavior, or low-risk legacy access.
- Remove legacy-only UI paths once the Svelte app covers the corresponding operator workflows and manual regression checks are stable.

### Live Fidelity and Operator Clarity

- Improve Codex live projection beyond the current summary-first OTEL path where richer local or telemetry sources are available.
- Make fidelity boundaries obvious in the UI so operators can distinguish transcript-capable sessions from summary-only sessions without guessing.
- Reduce session noise through better grouping, filtering, and session lifecycle presentation in Live and Monitor views.

### Rust Runtime Decision Path

- Decide what Rust must prove to remain a maintained alternate runtime now that desktop packaging is not imminent.
- Keep Rust parity focused on the canonical `/app` and `/api/v2/*` contract instead of broadening it into an independent product surface.
- Use shared contract and runtime tests to make gaps explicit before any default-runtime or distribution decision.

### Product Polish and Release Confidence

- Continue tightening Monitor, Live, Sessions (Browse / Pinned sub-views), Search, and the consolidated Analytics tab (Overview / Usage / Insights sub-views) around real review and monitoring workflows.
- The "Instrument Console" Svelte redesign is **shipped (Phases 1–6)**: every `/app/` tab is on the design tokens — foundation (tokens + type + shell), shared primitives, Monitor, Sessions/Search, the consolidated Analytics group, and the Live operator view. IA consolidations: Usage + Insights → Analytics sub-views; Pinned → a Sessions sub-view. Mobile was intentionally deprioritized (laptop-first; agents run on-device).
- Maintain a manual regression checklist for the canonical Svelte app, especially around deep links, long transcripts, live updates, and drawer/navigation behavior.
- Prefer small UI refinements that reduce ambiguity over larger redesigns unless operator workflows show a clear gap.

### Trace Quality

- The local trace-quality layer is **shipped**: additive projection of existing sources into a trace/observation graph, `/api/v2/trace-quality/*` read/score/prompt/findings APIs, prompt-version attribution, a deterministic read-only findings taxonomy, and the Svelte Quality sub-view (Explorer + Dashboards). See [../system/trace-quality.md](../system/trace-quality.md).
- Keep coverage honesty as a first principle: summary-only telemetry (e.g. Codex OTEL) must never render as full transcript fidelity in the UI or API.
- The optional Langfuse export adapter is **deferred** (see Later); the local model stands on its own and remains Langfuse-independent.

## Next

- Define and verify parity gates for retiring or sharply reducing reliance on the legacy `/` dashboard.
- Tighten v2 contract coverage and runtime parity testing across the TypeScript and Rust backends.
- Keep improving session browsing, search, analytics, and live inspection where real operator workflows expose gaps.
- Make integration behavior and capture/redaction settings easier to understand from the product surface and docs.

## Later

- Support richer Codex-native live fidelity beyond the current OTEL summary path.
- Revisit packaging or alternate runtime distribution work once the canonical web contract is stable.
- Expand multi-agent support where new integrations can map cleanly onto the existing monitor, history, and live models.
- Build the optional, disabled-by-default Langfuse export adapter (deferred trace-quality spec Task 10) if real demand appears. The transport decision is settled — the Langfuse ingestion API (batch) — and must stay manual-first, redaction-aware, dry-run-previewable, and non-required for local functionality.

## Working Principles

- Prefer extending `/app/` and `/api/v2/*` over adding new behavior to the legacy `/` surface.
- Treat Rust as a runtime convergence effort, not a forked product direction.
- Keep fidelity honest in both product UI and API responses, especially when Claude and Codex capabilities differ.
- Favor docs and plans that age well: roadmap for direction, plan docs for implementation detail, architecture docs for system shape.

## Active References

- Repo convergence plan: [../plans/2026-04-08-repo-convergence-implementation.md](../plans/2026-04-08-repo-convergence-implementation.md)
- Rust runtime convergence plan: [../plans/2026-04-10-rust-runtime-convergence.md](../plans/2026-04-10-rust-runtime-convergence.md)
- Architecture overview: [../system/ARCHITECTURE.md](../system/ARCHITECTURE.md)
- Product surface reference: [../system/FEATURES.md](../system/FEATURES.md)
