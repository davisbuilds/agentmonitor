# AgentMonitor verification CLI pilot

Date: 2026-10-01

Author: Codex, with Davis

Status: pilot implemented locally, then extended the same day with read-only
probes of the installed service (see Isolation and verification boundaries). The
operations guide and executable CLI own the command/result contract and lifecycle
mechanics.

## Purpose

Give agents reliable experimental access to AgentMonitor so they can reproduce
behavior, investigate failures, measure changes, and return evidence a person can
inspect. The intended benefits are less repeated setup, less supervision, and
better-supported completion claims.

The motivating example is Lauren Tan's discussion of application-control CLIs,
verification infrastructure, and a maintained feature map in
[this talk](https://www.youtube.com/watch?v=Z-jNqqIYGm4). The transferable idea is
to improve the environment in which an agent works: provide dependable tools and
local product knowledge instead of relying on repeated prompting. The talk's
reported productivity is not evidence that this pilot will produce similar gains.

The pilot should support open-ended investigation as well as established checks.
An agent may need to keep a fixture-backed app running, explore a behavior, and
capture additional evidence before it knows which assertion is appropriate.

## Agreed scope and language

Build a **TypeScript development CLI inside AgentMonitor**, reusing the current
Node tooling, application fixtures, and Playwright infrastructure. Exercise the
**compiled application and frontend**. The driver may run through `tsx`; that
must not silently change the application under test to source modules.

TypeScript minimizes the distance to the existing verification code. Go remains
an option for a future independent runner whose primary job is orchestrating
heterogeneous processes and adapters. The pilot does not need a second runtime
or a separate repository. A small versioned JSON result contract can preserve
that future boundary without designing a general framework now.

Keep verification dependencies in the development surface. Do not make normal
application users install browsers merely to run the production CLI.

### Workflow 1: session ingestion through live browser updates

Start a disposable application with a known synthetic session, then introduce
additional transcript data. Check that the real ingestion/projection path and
API expose the expected content and that the browser updates without a reload.
Capture enough intermediate evidence to distinguish a parsing, projection,
transport, or rendering failure.

Prefer exercising the compiled watcher against an isolated transcript directory.
Direct database writes or manually emitted SSE events can provision fixtures,
but do not prove the ingestion path works. If a run covers only part of the
path, report that scope explicitly. External harness hooks and a user's live
installation are outside the initial claim.

### Workflow 2: Usage correctness and responsiveness

Use a named synthetic usage fixture with independently known event counts,
token totals, and costs. Check API results and their representation in the Usage
view. Exercise a relevant interaction such as changing a filter, rather than
treating a loaded page as sufficient evidence.

Record API timing and browser responsiveness as distinct measurements with the
fixture, environment, and warmup policy identified. Reuse the existing usage
benchmark where appropriate. Do not invent a universal latency threshold or
equate a fast endpoint with a responsive page. A performance gate requires an
explicit expectation; measurements can be useful without declaring a pass.

## Intended agent experience

The interface should let an agent:

1. Discover supported workflows, their prerequisites, and what each can prove.
2. Start an isolated environment in a known state and obtain its address and
   session handle.
3. Exercise a supported workflow or use ordinary browser/API tools to investigate.
4. Inspect results, runtime state, and supporting artifacts.
5. Stop the environment and confirm cleanup.

Support both a one-shot run with automatic cleanup and an interactive session
that stays available for investigation. The development CLI exposes `list`,
`start`, `run`, `inspect`, `advance`, and `stop`; use its help for exact syntax.

Noninteractive invocations must finish or fail clearly rather than wait for a
prompt. Separate machine-readable results on stdout from diagnostics on stderr.
Interruption and failed startup need bounded cleanup and honest partial results.

## Feature map and evidence

Keep a small executable map of supported workflows: how to reach a feature,
which fixture it needs, what outcome matters, and the existing checks that cover
it. Place it near the verification code and reuse definitions. Avoid an exhaustive
prose inventory that duplicates routes, selectors, or system documentation.

The minimum useful result identifies:

- The scenario and fixture, application/build identity, relevant environment,
  and time of observation. Account for uncommitted changes when identifying a run.
- What was checked and what was observed, including expected values where an
  assertion has a deterministic oracle.
- Whether each check passed, failed, was blocked, or was not run. Setup failure
  and missing browser tooling must not look like successful verification.
- Supporting artifacts such as logs, API observations, screenshots, browser
  traces, and measurements, with inspectable paths.
- Coverage limits and environment cleanup status.

Capture observations through the runner and underlying tools. Keep an agent's
interpretation distinguishable from those observations. Artifact existence alone
does not establish correctness, and a green result applies only to the behavior
and build actually exercised. Expected values must be capable of rejecting a
plausible wrong result, not simply mirror application calculations.

Retain useful failure evidence after stopping the app. Session lifetime is bounded;
evidence files remain in OS temporary storage until explicitly removed or reclaimed
by the OS. Copy evidence needed for longer-term review. Cleanup must not erase
the evidence needed to understand the result.

## Existing foundations

Current source inspected at base commit `c7bd2f8`:

- [`verify-skill-context-built.mjs`](../../scripts/verify-skill-context-built.mjs)
  already exercises compiled parsers, schema, API behavior, and the browser in
  an isolated fixture environment. Reuse its lessons without conflating its
  skill-context assertions with the two workflows above.
- [`live-tab.spec.ts`](../../e2e/live-tab.spec.ts) covers live rendering and
  streamed updates, with directly seeded state and emitted events.
- [`search-analytics-capabilities.spec.ts`](../../e2e/search-analytics-capabilities.spec.ts)
  covers Usage request behavior and navigation.
- [`benchmark-usage-overview.ts`](../../scripts/benchmark-usage-overview.ts)
  measures the canonical Usage API, including warmups and an optional threshold.
- [`watcher/service.ts`](../../src/watcher/service.ts) exposes explicit harness
  directory overrides that can support isolated real-file ingestion.

The CLI should compose and improve these capabilities. Existing assertions and
project checks remain useful; the pilot adds an operating interface and evidence
capture rather than establishing another independent definition of correctness.

## Isolation and verification boundaries

The pilot has two kinds of target, and results always say which one they used.

**Scenarios** use disposable databases, synthetic transcripts, and explicit local
fixture paths. They do not read or mutate the user's installed database, real
transcript collection, credentials, or running application. No paid model calls
are needed. Bind disposable services locally and identify which resources the
CLI owns. Stopping a session must affect only those resources. Choose lifecycle
mechanics that handle failed startup, interruption, repeated stop, and abandoned
sessions without relying on blindly trusting a recycled process ID.

**Probes** read the installed service. The first version excluded it entirely,
which left out the investigations agents actually run here: a slow query on the
real store, a server still running an old build, ingestion state after a restart.
Fixtures cannot reproduce that data shape or scale. The pilot's goal is to be as
useful as possible to agents working in AgentMonitor before any extraction, so
the boundary moved (decided with Davis, 2026-10-01) under these rules:

- Reads use a connection that is both `readonly` and `query_only`, never the
  application's `getDb()`, which runs migrations and whose reads can write.
- Each probe runs in a child process killed at its deadline. SQLite statements
  cannot be interrupted from JavaScript, and a long read on the installed
  database holds a WAL snapshot that blocks checkpoints; killing the process
  releases it.
- Probes that must write (`resync`) touch only a scratch database or a snapshot
  that the CLI made with SQLite's online backup. Writes to the installed database
  stay with `amon`'s own repair commands and their dry runs and backups.
- Results record the target kind and path, file sizes before and after, and the
  running server's build when health is probed. Size equality does not prove
  database identity. Ingestion records its resolved discovery scope without
  asserting it matches the running service.
- Structured observations contain counts, timings and query plans. Re-sync's
  transcript copies and scratch database are removed by default, including on
  worker failure or timeout. `--retain-transcripts` explicitly preserves copies
  for debugging. Snapshots remain full database copies; retained content is
  identified in `content_artifacts`. Logs and real-store evidence stay private.
- Probes cover what `amon` does not already expose (plans, phase timings,
  ingestion freshness, build staleness), rather than duplicating its reads.

This is application isolation for verification, not a claim to sandbox arbitrary
untrusted code. Distinguish the fixture host from the full installed service;
Portless, production configuration, provider authentication, and live deployment
health are not automatically covered by a compiled application check.

## What would make the pilot useful

- Both workflows can be discovered and run without an agent inventing temporary
  setup scripts or reconstructing fixture knowledge from scattered tests.
- A disposable instance can remain available for a real investigation and be
  stopped without disturbing another instance or the installed application.
- Correct fixture behavior passes, and a targeted wrong-but-plausible mutation
  produces the expected failure with enough evidence to locate it.
- The result makes its tested build and coverage clear; missing prerequisites,
  incomplete runs, and cleanup failures remain visible.
- A maintainer can review the key evidence without rereading an entire agent
  transcript. Browser checks exercise real behavior, not only screenshots.

Use an actual follow-up investigation to assess setup friction and review effort.
Passing the pilot's tests alone does not establish reduced supervision. No large
evaluation campaign is required to decide whether this local interface is useful.

## Deferred decisions and possible extraction

The initial implementation uses a 1,000-event usage fixture, authenticated loopback
control, one-hour interactive sessions, two-minute run deadlines, and retained
temporary artifacts. Revisit these bounds when an actual investigation exposes a
limitation; revisit product framing only when source or runtime evidence warrants it.

A second application with materially different setup can test which pieces are
truly reusable. Each repository should continue owning its fixtures and business
assertions. A shared tool could eventually own lifecycle management, capture,
inspection, and comparison, while task orchestrators consume its results.

Do not create a cross-repo framework merely because two scripts share syntax.
Extract when repeated needs justify the additional contract and maintenance.
Broader possibilities around reliable agent-operated processes and cross-platform
delegation remain exploratory; this engineering pilot is not market validation.

## Next learning step

Use the CLI on a real AgentMonitor change or investigation and assess whether the
workflow map, fixture controls, and evidence reduce reconstruction and review
work. Both workflows passing and the compiled mutation failing establish that the
pilot can observe those behaviors; they do not establish less supervision or
commercial demand. Extend a workflow when an actual task needs it, and evaluate a
second heterogeneous application before proposing a shared runner.

### First use: a slow agent-filtered Monitor read (2026-10-01)

Before the probes existed, an investigation of slow agent-filtered Monitor stats
needed hand-written scripts that copied the endpoint's SQL, a read-only
connection opened by hand, and separate commands for plans and file sizes.

With the probes:

- `probe monitor-stats --agent codex` timed the endpoint's own statements on the
  installed store. Three of its ten statements accounted for nearly all of the
  time, and each plan showed lookups through a non-covering `agent_type` index.
- `probe health` showed an unusually large WAL beside the installed database. A
  `snapshot`, which has no WAL, gave the same timings, which ruled the WAL out as
  the cause in two commands.
- `probe resync` on a full-size snapshot measured the incremental write as
  roughly an order of magnitude slower than on an empty scratch database: one
  sample, cause not yet split.

So far this is one investigation, carried out by the agent that built the probes.
Whether another agent picks them up unprompted, and whether reviewers find the
evidence enough on its own, is still open.
