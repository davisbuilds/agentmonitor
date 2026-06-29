---
date: 2026-06-29
status: living
source: conversation
---

# Positioning — What AgentMonitor Is

> A living reference for the product's center of gravity. Use it to decide what
> belongs in the product, what to defer, and how the data model and runtime
> should be shaped. When a scope question comes up, answer it here first.

## One line

AgentMonitor is a **local-first observability console for coding agents**: it
reconstructs live activity, cost, quota, and session quality for Claude Code and
Codex from the artifacts those agents already produce — **with no
instrumentation**.

## Archetype

There are two archetypes in this space, and most tools pick one:

- **Archive / browser** — look back at what agents did; breadth across many
  agents; full-text search; historical browsing. (e.g. `agentsview`.)
- **Observability console** — watch agents live; measure cost, quota, and
  quality as they run. (e.g. Langfuse + a Datadog-style dashboard.)

**AgentMonitor is the observability console (Archetype B).** Breadth-of-agents
archival is explicitly *not* our game. The reason past mental models felt
scattered is that the codebase drifted into doing both at once — which is also
why it carries three overlapping representations of "what the agent did"
(`events`, the browse v2 tables, and `trace_quality_*`). Committing to Archetype
B is what lets the data model converge.

## Who it's for

Developers who **run** coding agents and want to see what they're doing, what
they cost, and how well they're working — *operators of agents*, not builders of
LLM apps.

This is the crucial contrast with Langfuse: a Langfuse user instruments an LLM
application **they own and control**. Our "workload" is third-party agents
(Claude Code, Codex) we **cannot modify**. We can't add an SDK call inside them.

## The Langfuse question — why this is not reinventing the wheel

Langfuse can be self-hosted, so the fair question is "why not just run Langfuse?"
Because it solves a different problem at a different layer:

- **Langfuse** is a backend you *instrument your own code into* (SDK / OpenTelemetry
  spans emitted from your application), self-hosted as a multi-container stack
  (Postgres + ClickHouse + Redis + web + worker). It is an ops deployment, and it
  assumes you control the code being traced.
- **The coding agents are not our code.** AgentMonitor's core trick is
  **zero-instrumentation, agent-native ingestion**: watching `~/.claude/projects/**`
  session files, Claude Code hooks, and Codex OTEL export, then reconstructing
  observability from what the agents already leave behind.

### What only we can build (the moat — invest here)

1. **Zero-instrumentation, agent-native ingestion.** No SDK, no code changes;
   the agents themselves are the source.
2. **Coding-agent domain model.** Sessions, turns, tool calls, file edits,
   lines added/removed, compaction events, outcomes, provider quota/plan state,
   and coding-agent pricing — not generic LLM spans.
3. **Local-first desktop UX.** One binary, one SQLite file, runs all day in the
   background. No Docker, no Postgres/ClickHouse/Redis to operate.
4. **Provider-native quota & cost** for Claude/Codex plans specifically.

### What Langfuse already nails (do not reinvent — defer to it)

Deep trace/observation/score storage, eval frameworks, prompt management, and
large-scale trace visualization. Our elaborate local `trace_quality_*` machinery
is the part that *is* reinventing Langfuse — and it is currently ~half the
database.

### The pattern: collector, not backend

Think **Vector / OpenTelemetry Collector, but for coding agents** — the
agent-native collector plus a lightweight local console, with an **optional
forward to a heavyweight backend** (Langfuse, or any OTel sink) for users who
want deep eval/trace tooling. **The collector is the moat; the backend is
pluggable.** The export seam already exists in the schema
(`trace_quality_export_state`, `provider = langfuse`) — lean into it instead of
growing a homegrown eval warehouse.

## Scope

### In scope (own it)

- Agent-native ingestion (hooks, OTEL, file-watch) and historical import.
- The coding-agent domain model and session browsing.
- The live console (Monitor / Live / SSE), cost, quota, and core usage analytics.
- A **lean** local trace/quality view — enough to understand a session locally.
- Optional **export** to Langfuse / OTel-compatible backends.

### Out of scope (defer or don't reinvent)

- A full local eval/scoring engine, prompt-management system, or large-scale
  trace warehouse → defer to Langfuse via export.
- Breadth across dozens of agents (the archive archetype) → keep Claude Code +
  Codex depth.
- Multi-user/team server or hosted SaaS.

## Architectural implications

So the foundations follow from the positioning rather than the other way around:

- **Source of truth = the event/observation stream.** The browse tables and
  trace-quality are *derived, rebuildable projections*, kept lean — not a second
  persisted warehouse.
- **Trace-quality stays a lightweight local projection** sized for the dashboard;
  depth is **exported, not stored forever**. (Directly addresses the
  `trace_quality_*` bloat and the mis-grained projection.)
- **One runtime, one canonical local store** (SQLite). Interop happens via
  OTel/Langfuse export, not a homegrown eval stack.

## Non-goals

- Not a Langfuse competitor, and not an LLM-app tracing SDK.
- Not a hosted or multi-tenant service.
- Not a universal many-agent archive.
