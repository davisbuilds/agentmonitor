# Roadmap

AgentMonitor is a local-first observability console for coding agents. This page
records selected direction and the boundaries that guide it. The
[Backlog](BACKLOG.md) holds unresolved candidates; Git and PRs hold routine
shipment detail. [Positioning](POSITIONING.md) explains the product center.

## Context For Current Direction

- Recent import repairs reconcile copied Codex subagent history and rewritten
  rollouts, and distinguish producer-reported costs from estimates. Claude
  transcript imports now use producer line identity with a legacy bridge so
  child-agent usage can be captured without duplicating old rows. These
  changes make provenance and coverage as important as headline totals.
- User-facing days use one reporting zone, while the optional warehouse export
  deliberately keeps UTC days until a consumer justifies a migration. A
  content-free observed-session inventory reconciles event and browser evidence
  without claiming that either has complete capture.

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

- Ground and rank the open items in [BACKLOG.md](BACKLOG.md), including the
  cross-repository pattern hypotheses, before selecting implementation.
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
- Let aggregate warehouse consumers own conforming assistant/coding-agent views;
  keep personal AgentMonitor data outside organization adoption KPIs.

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
