---
date: 2026-06-29
updated: 2026-09-14
status: living
source: conversation
---

# Positioning: What AgentMonitor Is

Use this reference to decide what belongs in AgentMonitor, what should remain a
small local projection, and what should be deferred to another system.

## Product Center

AgentMonitor is a local-first observability console for coding agents. It
reconstructs live activity, historical sessions, usage, cost, quota, and session
quality from artifacts and export surfaces that Claude Code, Codex, and compatible
agents already provide.

“Agent-native” means AgentMonitor does not require an SDK call embedded inside the
third-party agent or the application it edits. Collection still uses explicit
integration surfaces: Claude hooks, Codex OTLP, local session files, and importers.

The primary user is a developer operating coding agents who needs to understand
what is running, what happened, what it cost, and how trustworthy the available
evidence is.

## What AgentMonitor Owns

1. **Agent-native collection.** Translate hooks, OTLP, session files, and imported
   artifacts into one local model without modifying the agents themselves.
2. **Coding-agent semantics.** Sessions, turns, tools, file activity, compaction,
   invocation mode, context occupancy, model usage, and provider-native quotas.
3. **Local operational UX.** A continuously useful Svelte console, SQLite store,
   agent-first CLI, and simple localhost runtime.
4. **Evidence honesty.** Make transcript, tool, usage, pricing, and source coverage
   explicit instead of treating absent evidence as zero or complete fidelity.
5. **Lean derived views.** Build rebuildable summaries and on-demand projections
   that make local operation fast without becoming a second authoritative store.

Historical browsing and search remain in scope because operators need them to
explain current behavior and review completed work. Breadth across every possible
agent and permanent archival for its own sake are not the product center.

## Collector, Console, And External Depth

General LLM-observability backends such as Langfuse assume an application can emit
SDK or OpenTelemetry traces into a dedicated backend. AgentMonitor begins one layer
earlier: third-party coding agents are the workload, and their available artifacts
are uneven.

AgentMonitor therefore owns collection and the lightweight local console. It does
not recreate a full eval platform, prompt-management system, or persisted trace
warehouse.

The 2026 trace-quality reframe implemented this boundary:

- local quality stores one content-free summary per session;
- observation detail is projected on demand from existing event and session rows;
- the old persisted trace/observation/score/prompt warehouse was removed;
- `amon warehouse publish` optionally exports content-free session aggregates to
  AgentMonitor's own Postgres schema; and
- deeper trace/observation/eval export remains deferred through the separate
  Langfuse-oriented export-state seam.

The local product must remain fully useful without Postgres, Langfuse, or a model
provider API key.

## Scope

### Own

- Claude Code and Codex depth, plus integrations that map cleanly to the same model.
- Hook, OTLP, file-watch, and historical-import ingestion.
- Monitor and Live workflows, session browsing, search, usage, cost, quota,
  analytics, skill evidence, benchmarks, and lean trace inspection.
- Provider-specific fidelity and pricing semantics.
- A single local TypeScript runtime and canonical SQLite store.
- Optional, explicit, privacy-bounded exports.

### Defer Or Decline

- A full local eval/scoring engine, prompt registry, or large trace warehouse.
- A hosted, multi-tenant service or team control plane.
- Universal archive breadth that dilutes the supported-agent fidelity model.
- Automatic policy, model-routing, or budget enforcement based solely on local
  analytics or advisory feedback.
- A second backend implementation maintained at parity with TypeScript.

## Architectural Consequences

- Raw events and parsed session history are authoritative. Summaries, analytics,
  and trace views remain derived and rebuildable.
- Source fidelity is part of the contract. Summary-only telemetry cannot render as
  transcript-complete evidence.
- CLI and UI reads share v2 domain/query boundaries so agents can retrieve the same
  data a person sees.
- SQLite remains the local operational store. Exports are optional boundaries, not
  runtime dependencies.
- New work should strengthen collection, operational understanding, and evidence
  quality before expanding backend depth or agent breadth.

## Non-Goals

- Competing with general-purpose LLM tracing/eval backends.
- Requiring users to instrument the applications their agents edit.
- Treating personal coding-agent telemetry as organization-wide adoption data.
- Turning advisory analytics into autonomous enforcement without a separate,
  explicit design and human decision.
