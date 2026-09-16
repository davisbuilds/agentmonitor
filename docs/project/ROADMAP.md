# Roadmap

- Added a content-free observed-session API that reconciles event and browser
  evidence, including event-only sessions, with explicit transcript/usage coverage.
  Existing browser and billing semantics remain unchanged.

Directional snapshot for AgentMonitor. The Roadmap owns current direction and a
small set of recent milestones. Detailed shipped history belongs to commits and
pull requests; current behavior belongs to the system references.

## Recent Milestones

- **Daily activity accounting (2026-09-16):** an aggregate-only read distinguishes
  daily active conversations, delegated agents, internal jobs and unclassified
  evidence. Codex native lineage and creation time survive parsing; retained
  projections require deliberate reparse after upgrade.

- **Session-list identity (2026-09-15):** Sessions API/CLI reads reconcile known
  Codex JSONL/import/OTEL aliases before filtering and pagination, preserving
  original detail links and all stored history. Usage and browser coverage remain
  explicitly distinct.

- **Summary timestamp integrity (2026-09-15):** database-time fallbacks retain
  explicit UTC markers; an opt-in, digest-checked historical repair covers proven
  session/turn/item timestamps with rollback, replay and non-target-data checks.
- **Agent-first CLI read parity (2026-09-13, PR #126):** the CLI now exposes all
  current Svelte read contracts, including Monitor, Analytics, Usage, Insights,
  Benchmarks, Trace Quality, live/session detail, and operational metadata through
  stable JSON output.
- **Usage and Monitor scaling (2026-09-11 through 2026-09-13, PRs #122 and #128):**
  Monitor stopped queueing redundant Usage reads, and the Usage overview gained a
  timestamp-first source-count path. On the named 697K-event snapshot, the final
  source-level 60-day overview measured a 220.99 ms warm median and the built HTTP
  path 227.14 ms. The historical 150 ms figure remains a revisit trigger, not a
  product SLO.
- **Canonical Svelte surface (2026-09-10):** the legacy static dashboard was
  removed; `/` redirects to `/app/`, and Monitor reads use v2 while the remaining v1
  reads serve test compatibility.
- **Benchmarks and operational metrics (2026-09-02 through 2026-09-04):** segregated
  benchmark import/read/UI paths, Pareto comparison, date-aware pricing, and
  content-free OTEL operational metrics shipped without contaminating personal
  usage totals.
- **Lean trace quality and aggregate export (2026-06 through 2026-07):** local trace
  quality became one summary per session plus on-demand observations; the old
  warehouse was removed, and optional content-free Postgres publication shipped.

## Now

- Treat `/app/`, `/api/v2/*`, and the `amon` CLI as the product center.
- Preserve v1 where ingestion, provider quotas, shared SSE, or current tests still
  depend on it; avoid adding new product reads there.
- Improve Live fidelity and operator clarity, especially around summary-only data,
  session noise, and provider capability differences.
- Keep CLI access at parity with UI data so agents can retrieve and process the
  same evidence without browser automation.

## Focus Areas

### Legacy Surface Reduction

- Move parity and ingestion-readback tests before removing the remaining v1 reads.
- Keep the existing shared SSE path while it provides value; revisit a v2-only
  stream when maintaining both broadcasters becomes a measured cost.

### Live Fidelity And Operator Clarity

- Use richer Codex-native sources when they can improve the current OTEL summary
  without overstating transcript fidelity.
- Make unavailable and capability-limited evidence obvious throughout Live and
  Monitor.
- Improve grouping, filtering, and lifecycle presentation when real sessions show
  persistent noise.

### Product Polish And Release Confidence

- Tighten Monitor, Live, Sessions, Search, and Analytics around real monitoring and
  review workflows.
- Preserve the Instrument Console design system and laptop-first layout while
  retaining usable narrow-width behavior.
- Keep a manual built-product regression path for deep links, long transcripts,
  live updates, and drawer/navigation behavior.

### Trace Quality

- Keep the local projection lean, rebuildable, content-free at summary level, and
  honest about source coverage.
- Keep aggregate warehouse publication optional and separate from the deferred
  Langfuse trace/eval depth path.

## Next

- Ground and rank the open items in [BACKLOG.md](BACKLOG.md), including the newly
  imported cross-repository pattern hypotheses, before promoting one to a plan.
- Tighten v2 contract and built-runtime coverage where real consumer failures expose
  gaps.
- Improve integration and capture/redaction explanations in the product and CLI.

## Later

- Support richer Codex live fidelity when a stable local or telemetry source exists.
- Revisit packaging after the canonical web/runtime contract is stable.
- Add agent integrations when they map cleanly to the existing fidelity and data
  model.
- Build the deferred redaction-aware Langfuse depth export if local review workflows
  demonstrate a need for external eval tooling.
- Let medallion own any conforming assistant/coding-agent warehouse view and keep
  personal AgentMonitor data outside adoption KPIs.

## Working Principles

- Extend `/app/`, v2, and `amon` before adding compatibility behavior.
- Treat missing evidence as unavailable rather than zero.
- Keep source events and parsed sessions authoritative; derived stores must be
  rebuildable and parity-checked.
- Put future work in Backlog, current direction here, durable rationale in
  Positioning or Decisions, and detailed shipped history in Git/PRs.

## Active References

- [Architecture](../system/ARCHITECTURE.md)
- [Features](../system/FEATURES.md)
- [Operations](../system/OPERATIONS.md)
- [Positioning](POSITIONING.md)
- [Decisions](DECISIONS.md)
- [Backlog](BACKLOG.md)
