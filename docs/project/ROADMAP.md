# Roadmap

- Added a content-free observed-session API that reconciles event and browser
  evidence, including event-only sessions, with explicit transcript/usage coverage.
  Existing browser and billing semantics remain unchanged.

Directional snapshot for AgentMonitor. The Roadmap owns current direction and a
small set of recent milestones. Detailed shipped history belongs to commits and
pull requests; current behavior belongs to the system references.

## Recent Milestones

- **Browser-safe local API and quick fixes (2026-09-23):** web pages can no
  longer write to the local server. Writes with a foreign `Origin` get `403`, and
  a loopback-bound server refuses non-loopback `Host` names, which blocks DNS
  rebinding. Local clients stay trusted, including their ability to end a
  session. Unhandled errors return a bare 500 rather than a stack trace, and
  malformed OTLP timestamps no longer throw. Also fixed: hooks now work in repos
  with no commits, a full `costs recalc` keeps captured benchmark costs,
  `formatNumber` moves to the next unit when rounding reaches 1000, and each
  Antigravity generation is timestamped and priced at its own time. The most
  frequent CI flake is fixed at its measured cause: 200k synchronous inserts
  blocked the in-process test server past Node's 5s keep-alive timeout, so
  the next `fetch` reused a dead socket. The test now lowers the evidence cap
  instead.

- **Local-time days (2026-09-23, PR #142):** every user-facing day is a local
  day in one reporting zone (`AGENTMONITOR_TIMEZONE`, default the host's).
  Date filters, daily buckets, active-day counts, the heatmap, skill and
  trace-quality windows, budgets and daily activity all share
  `src/util/local-day.ts`, replacing a mix of UTC-day reads and a hardcoded
  `America/New_York`. The warehouse export keeps UTC days by design.

- **Pricing and read-surface correctness (2026-09-23, PRs #140-#141):** Claude
  Opus 5.5 and Fable 5.1 are priced (both off the 0.1x cache-read convention),
  and `amon costs recalc --missing-only` backfills rows imported before a model
  had a rate card without touching captured costs. The Monitor feed and session
  list now exclude benchmark rows, usage/analytics reject unparseable dates
  instead of reporting $0, the Monitor's `limit=0` takes a ceiling, the session
  browser's `date_to` survives DST, and Hour-of-Week buckets by local time.

- **Imported event identity (2026-09-22, PRs #137-#139):** Claude Code imports
  bill one event per assistant turn rather than one per content block, and
  imported events are keyed on the transcript line's own identifier instead of
  its position. A child-agent transcript reports its parent's session, so the old
  positional scheme minted colliding ids and dropped delegated-agent usage
  entirely; those events now import, attributed to the parent conversation and
  tagged with their agent. Rows imported under the old scheme keep deduplicating
  through an ownership rule rather than a migration. `amon costs
  repair-claude-usage` corrects already-stored inflation and re-derives affected
  session summaries; rows whose transcript is gone are reported, not guessed at.
  Codex ids were measured and deliberately left positional, with two guards
  against accidental re-keying.

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
