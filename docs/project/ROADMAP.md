# Roadmap

AgentMonitor is a local-first observability console for coding agents. This page
records selected direction and the boundaries that guide it. The
[Backlog](BACKLOG.md) holds unresolved candidates; Git and PRs hold routine
shipment detail. [Vision](VISION.md) explains the product center and longer-term
possibilities.

## Context For Current Direction

- From late October to mid-November most effort went to cost correctness and
  the evidence behind it: Codex is billed one import row per request,
  including compaction and work spread across rollout history, OTEL usage that
  an import also covers counts once, and every source's imported totals can be
  checked against its harness's own figures. Provenance and coverage matter as
  much as headline totals.
- Analytics grew past usage. Overview opens on headlines against the period
  before, with session depth, delegated work, friction and change markers.
  Quota readings are kept as a sampled history. A Git view credits commits and
  pull requests to the sessions that made them, and cost per outcome allocates
  spend along each session's timeline to what landed.
- The login service was hardened for everyday use: a frozen server is reported
  and restarted, undelivered hook events are spooled, and lifecycle state that
  lived in loose strings and flag combinations was made explicit. The Mac mini
  now runs its own service and store; a cross-host view is deferred.
- The local gate now matches CI, and the HTTP contract suites run there.
- User-facing days use one reporting zone, while the optional warehouse export
  deliberately keeps UTC days until a consumer justifies a migration.

## Now

- Establish an excellent monitoring, observability, and analytics baseline before
  taking on dispatch, automatic intervention, or broader platform consolidation.
- Treat `/app/`, `/api/v2/*`, and the `amon` CLI as the product center, and keep
  CLI access at parity with UI data so agents can retrieve the same evidence
  without browser automation.
- Preserve v1 where ingestion, provider quotas, shared SSE, or current tests still
  depend on it; add no new product reads there.
- Close capture gaps in the sources already ingested before adding new ones:
  Codex sessions archived before their first import, Codex interruptions, and
  Codex app jobs told apart by their recorded `originator` rather than prompt
  text (Backlog: Codex archived rollout discovery, Codex interruptions are not
  recorded, Codex thread names and app-job detection).
- Extend trustworthy skill-context evidence: the
  [Codex evidence contract](../specs/2026-11-27-codex-context-evidence-spec.md)
  is implemented; native Claude attachments have a
  [separate contract](../specs/2026-11-27-claude-native-context-attachments-spec.md)
  for a subsequent implementation.
- Bring Antigravity telemetry and analytics up to par with Claude and Codex,
  now that Antigravity is in growing use. Start with investigation: inventory
  its current local stores on both Macs, compare every capture, usage, cost and
  analytics surface, and write a gap matrix and design before implementing
  (Backlog: Antigravity parity with Claude and Codex).
- Start the harness, model and plan cost comparison with its first slice: a
  read-only Claude vs Codex cost-per-outcome probe that controls for project and
  pull request size and reports whether the two agents overlap enough to compare
  (Backlog: Claude vs Codex cost per outcome).
- Fix the small reliability defects the backlog records, mostly from the
  2026-11-11 state-machine audit: CLI repairs that fail as locked beside the
  server, the operational insert that fails a request after usage is stored,
  silent watcher retries, and the unvalidated provider quota status. Confirm
  the two recorded as hypotheses (stale-lock removal, merged pull requests
  recorded as nonexistent) before fixing them.

## Focus Areas

### Evidence Fidelity And Coverage

- Use richer Codex-native sources when they can improve the current OTEL summary
  without overstating transcript fidelity.
- Make unavailable and capability-limited evidence obvious throughout Monitor and
  its live stream.
- Do not claim coverage for a source from samples of another execution mode.

### Analytics That Support Decisions

- Make comparisons interpretable: control for mix and size, state coverage, and
  link a figure to the records behind it.
- Grow cost per outcome and quota analysis from stored history rather than
  estimates, and say when history is too short.

### Dependable Operation

- Keep the login service serving under load and through restarts, and keep its
  failures visible in the CLI and the app.
- Make lifecycle state explicit where it is still assembled from loose strings
  or independent flags.

### Legacy Surface Reduction

- Move parity and ingestion-readback tests before removing the remaining v1 reads.
- Keep the existing shared SSE path while it provides value; revisit a v2-only
  stream when maintaining both broadcasters becomes a measured cost.

### Product Polish And Release Confidence

- Tighten Monitor, Sessions, Analytics and the Git view around real monitoring
  and review workflows.
- Preserve the Instrument Console design system and laptop-first layout while
  retaining usable narrow-width behavior.
- Keep a manual built-product regression path for deep links, long transcripts,
  live updates, and drill-in/navigation behavior.

### Trace Quality

- Keep the local projection lean, rebuildable, content-free at summary level, and
  honest about source coverage.
- Keep aggregate warehouse publication optional and separate from the deferred
  Langfuse trace/eval depth path.

## Next

- Harness, model and plan cost comparison: survey existing usage-measurement
  projects for logic to port, then design how quota readings join the usage
  that consumed them, so AgentMonitor can report tokens and API-equivalent cost
  per plan window and model, how that yield changes over time, and cost per
  task between models, including Gemini once Antigravity usage is captured
  (Backlog: Harness, model and plan cost comparison).
- Quota burn rate: project when each provider's windows run out at the current
  pace, now that the sampled history covers two weekly resets.
- Claude Cowork/chat as a source: finish the interactive Desktop check with a
  tool call and live delivery, then design an explicit source adapter.
- Session identity: define persisted provider-native and child-agent identity,
  with a migration plan for stored aliases that preserves links and pins. The
  migration itself needs the maintainer's approval.
- Build the cost-per-outcome comparison's API and UI if the first slice shows
  enough overlap to compare.
- Show the operational metrics that `amon ops metrics` already reads in the app.

## Later

- Support richer Codex live fidelity when a stable local or telemetry source exists.
- Context occupancy trajectory, and skill-health refinements (version
  attribution beyond the installed catalog, a validated misfire heuristic).
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
  Vision or Decisions, and detailed shipped history in Git/PRs.

## Active References

- [Architecture](../system/ARCHITECTURE.md)
- [Features](../system/FEATURES.md)
- [Operations](../system/OPERATIONS.md)
- [Vision](VISION.md)
- [Decisions](DECISIONS.md)
- [Backlog](BACKLOG.md)
