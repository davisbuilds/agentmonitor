# Vision

AgentMonitor helps people understand agent work across their workspace: what is
happening now, what happened before, and what the evidence says about how they
work with agents. Its immediate purpose is to provide an excellent monitoring,
observability, and analytics foundation. Over time, that foundation could support
a broader command center for operating agents.

This document guides product choices. [Roadmap](ROADMAP.md) owns selected work
and sequencing; [Backlog](BACKLOG.md) holds unresolved candidates. Current
behavior and implementation boundaries live in the [system references](../README.md).

## Who It Serves

AgentMonitor grows from the maintainer's own need to monitor and analyze agents
working across projects and harnesses. That daily use is its first proving
ground. The aim is also to make it useful to other people with similar needs,
without requiring them to reproduce the maintainer's workspace.

It may eventually become part of a commercial AgentOps offering. That possibility
does not commit this project to a standalone SaaS product, hosted deployment, or
team control plane. The current priority is a useful, trustworthy local product.

## Establish The Baseline First

Monitoring, historical investigation, and analytics are complementary ways to
understand the same work. They should form a coherent experience:

- **Monitor ongoing work.** Understand which agents and sessions are active,
  their recent activity, and where the available evidence indicates progress,
  failure, or a need for attention. Make stale or missing signals visible.
- **Investigate what happened.** Move from an overview to the relevant session,
  tools, transcript, and source evidence without reconstructing context across
  disconnected views. Preserve meaningful project and session relationships.
- **Analyze work over time.** Understand usage, costs, quotas, and working
  patterns across projects and harnesses. Make comparisons interpretable and
  let people examine the records behind a result.
- **Operate it dependably.** Keep setup, collection, navigation, performance,
  and recovery understandable enough for sustained everyday use. People and
  agents should be able to retrieve consistent evidence through the UI and CLI.

Success means users can answer consequential questions with confidence in the
underlying evidence and its limits. More charts, captured events, or integrations
are useful only insofar as they improve that experience.

## Principles

**Evidence must remain inspectable.** Distinguish observed activity, inferred
state, estimates, and unavailable data. Preserve provenance and coverage through
summaries and analysis. Activity and token counts alone do not establish quality,
productivity, or causation; comparisons need relevant task and outcome context.

**Keep local use valuable and privacy deliberate.** Core monitoring and analysis
should work without a hosted backend or model-provider API key. Optional external
services and model-assisted analysis can add value, with explicit data boundaries
and understandable operating costs.

**Follow useful workflows across harness boundaries.** Build depth where real
use demands it, while accommodating sources that fit the product coherently.
Neither a fixed list of agents nor an archive-versus-console category should
decide whether a capability belongs.

**Build, integrate, or replace according to value.** Mature open-source tools and
services are welcome components. Choose based on workflow fit, evidence fidelity,
integration effort, privacy, and ongoing maintenance. Existing custom code does
not oblige us to retain it, and the existence of another tool does not by itself
justify excluding a focused local capability.

## Longer-Term Direction

The broader ambition is a cohesive environment for operating agents. Questions
worth exploring after the baseline is strong include:

- Can an operator dispatch focused tasks across projects and follow their
  execution headlessly, including work started outside AgentMonitor?
- Can the system identify questionable or risky actions in the context of the
  assignment, explain the evidence, and help the operator investigate or respond?
- Can accumulated history reveal useful working patterns, antipatterns, and
  trends, with examples and limitations that make the findings actionable?

These are future product questions, not claims about shipped capabilities or
commitments to implement them next. In particular, detecting an action after it
happens is different from preventing it. Any future pause, redirect, or enforcement
capability needs an explicit authority model; analytics alone grants no authority
to act.

AgentMonitor could provide the observation and analysis foundation within a
broader AgentOps platform. Execution, retained knowledge, and other capabilities
may come from related projects or external systems. Their ownership, integration
contracts, and possible repository consolidation remain open. A coherent user
experience is the goal; a monorepo is one possible implementation choice.

## Scope Discipline

Prioritize the monitoring and analytics baseline before expanding into dispatch,
autonomous intervention, or platform consolidation. Current local storage and
trace-quality boundaries remain in force until deliberately revised; this vision
does not authorize a runtime rewrite or restoration of removed subsystems.

Revisit a boundary when a concrete workflow, recurring integration cost, or user
need justifies it. Product scope should evolve with that evidence rather than
remain fixed by historical competitor categories or presumed gaps in other tools.
