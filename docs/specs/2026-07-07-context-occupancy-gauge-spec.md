---
date: 2026-07-07
topic: context-occupancy-gauge
stage: spec
status: draft
source: conversation
---

# Context Occupancy Gauge Spec

## Problem

When watching live coding-agent sessions in AgentMonitor, an operator cannot tell
how full each session's context window is. Claude Code's `/context` answers this
inside a single TUI as a point-in-time snapshot, but it is ephemeral (computed
in-process, never written to disk), scoped to one session, and invisible to anyone
not sitting at that terminal. So the operator has no cross-session, at-a-glance
read on "which sessions are near their window limit and about to compact" — the
signal that predicts degraded output and forced context loss. The raw ingredient
already flows through the pipeline (per-request token usage for both Claude and
Codex, plus Codex's own reported window size), but nothing surfaces it as
occupancy.

## Contract

When this ships, every live Claude Code and Codex session exposes its **current
context-window occupancy** — used tokens, window size, and percent full — through
the live API, and that occupancy renders on the session's monitor card and in the
session detail/inspector surface, verified by `pnpm test` (occupancy derivation
and denominator-resolution unit tests) and `pnpm build`.

Occupancy is defined from the **most recent request's prompt size**, not a
cumulative session total:

- **Claude Code:** used tokens = the latest assistant turn's
  `input + cache_read + cache_creation` input tokens; window resolves to the
  session's active context window (see Assumptions on the 1M default).
- **Codex:** used tokens = the latest turn's `last_token_usage` input (inclusive
  of cached input); window = the session's reported `model_context_window` when
  present, else the configured Codex default.

Falsifiable behaviors:

- For a Codex session whose latest request reports `N` input tokens against a
  `W`-token window, the live API reports `used = N`, `window = W`, and
  `pct = round(N / W)` — asserted by a unit test over a fixture transcript.
- For a Claude session whose latest assistant turn reports input+cache totals
  summing to `N`, the live API reports `used = N` against the resolved window —
  asserted by a unit test over a fixture transcript.
- A session with no usable usage yet reports occupancy as unavailable (not `0%`
  and not a crash) — asserted by a unit test.

## Success Criteria

- Each active Claude Code and Codex session shows a compact occupancy indicator
  (percent full, styled by fill level) on its monitor card, consistent with the
  existing quota-pill treatment.
- Selecting a session reveals a fuller occupancy readout (used / window / percent)
  in its detail/inspector surface.
- Occupancy updates live as new turns arrive over the existing streaming channel,
  without a manual refresh.
- Occupancy numbers reflect the latest request's prompt size, so they fall after a
  compaction rather than only ever rising.
- A session-lifetime **occupancy trajectory** (fill over time, with compaction
  drop-offs visible) renders in the detail/inspector surface. This outcome is
  included but **may be deferred to the backlog** if it materially expands the
  change; the current-fill gauge and card indicator are the firm contract.
- Antigravity sessions and non-live/historical rows degrade cleanly: they show no
  occupancy indicator rather than a wrong or zeroed one.

## Evaluation

Measured by deterministic tests, not a product metric:

- `pnpm test` passes, including new unit tests that derive occupancy from Claude
  and Codex fixture transcripts and that resolve the window denominator (Codex
  reported window, Codex default, Claude 1M default) correctly.
- `pnpm build` and `pnpm lint` pass; `pnpm frontend:check` passes for touched
  Svelte/TS.
- Manual live check: with a real active Claude and Codex session, the card
  indicator and detail readout render and update, and the reported percent tracks
  the agent's own sense of remaining context within rounding.

## Scope

### In Scope

- Deriving current context-window occupancy for live Claude Code and Codex
  sessions from data already ingested, plus persisting Codex's reported window
  size that is currently parsed and discarded.
- Resolving a context-window denominator per session, including a
  model-to-window default lookup for Claude (none exists today) and a Codex
  default when the transcript omits the window.
- Exposing occupancy (used, window, percent) on the live session payload and its
  incremental streaming updates.
- Rendering a compact occupancy indicator on the monitor card and a fuller readout
  in the session detail/inspector surface.
- A session-lifetime occupancy trajectory view (deferrable to backlog per Success
  Criteria).

### Out of Scope

- The per-category composition breakdown (system prompt / tools / agents / memory
  / skills / messages) that `/context` shows. It is not present in any ingested
  data source and cannot be reproduced faithfully; estimating it is explicitly
  excluded.
- Antigravity occupancy — its sessions carry no token/window data.
- Occupancy for historical (non-live) sessions as a first-class surface.
- Any alerting, enforcement, or auto-compaction action based on occupancy.

## Assumptions And Constraints

- Claude sessions default to a **1M-token** context window in this operator's
  environment; the resolved window must default to 1M for Claude unless a smaller
  window is positively known. The transcript does not always state the active
  window, so the denominator is a resolved default, not a guarantee; a session
  whose observed occupancy exceeds the assumed window must not render a
  nonsensical `>100%` (resolve upward to the next known tier or mark unavailable).
- Codex reports `model_context_window` in its token-count events when available;
  the working default when absent is approximately **256K** and must be
  configurable rather than hard-coded to a single literal.
- Occupancy is inherently an approximation of the agent's own internal count;
  the contract requires tracking within rounding, not exact parity with the TUI.
- The change must not alter existing billing/cost derivation, which consumes the
  same Codex cumulative usage that occupancy must deliberately avoid using as its
  numerator.
- Occupancy must ride the existing live projection and streaming path; it must not
  require a new schema for historical data.

## Open Questions

- How to positively detect a non-default Claude window (e.g. a 200K session) from
  the transcript, if at all — or whether the resolved default plus an
  observed-peak upward correction is sufficient for v1.
- Trajectory retention: how many samples per session to keep for the trajectory
  view, and whether they live only in the live projection (lost on restart) or are
  persisted. Resolving this decides whether the trajectory ships now or defers.
- Exact Codex default window value and how it varies by Codex model.

## Handoff

1. Hand off to `write-plan` to sequence the build against this contract.
2. Review the contract with a critique subagent (or `verify-before-complete`
   inline if subagents are unavailable).
3. Refine the contract before sequencing.
