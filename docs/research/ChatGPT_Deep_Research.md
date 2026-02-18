# Local-first observability for terminal-based AI coding agents on macOS

## Executive summary

Local dev agent observability (for terminal-native coding agents) is no longer purely DIY in early 2026: both Claude Code and Codex have **first-party, local-friendly telemetry surfaces** (structured logs, lifecycle hooks, and/or OpenTelemetry export) that can be combined into a coherent “agent cockpit” without shipping your code or prompts to a third-party SaaS by default. citeturn6view2turn8view2turn13view0turn31view0

The core reason you’re losing situational awareness—multiple terminals (and sometimes tmux) each running a semi-autonomous loop—is that your “system” is now **a set of concurrent agent sessions**. To regain awareness, the highest-leverage move is to adopt (or build) a **local agent observability hub** that treats each agent turn as a unit of work and lets you answer, quickly and consistently:

- “Which sessions exist right now? Which repo/branch/cwd are they operating in?”
- “Are they idle, waiting, running a tool, or stuck?”
- “What tools/commands/files did they touch—what changed—what’s next?”
- “What did this cost (tokens/$/latency), and where did time go?”

This report found three practical building blocks already available “today”:

**Agent-native event sources (strong foundation)**  
- **Claude Code**: provides structured **hooks** at key lifecycle moments (including *PreToolUse*, *PostToolUse*, *PostToolUseFailure*, *Notification*, *TaskCompleted*, *SessionStart/End*). Hook payloads include identifiers (session_id), working directory (cwd), a pointer to the transcript file (transcript_path), tool name, and tool inputs/outputs (which—crucially—include file paths for file tools and command strings for shell tools). citeturn8view2turn8view0turn8view2turn8view3  
- Claude Code also supports exporting **OpenTelemetry metrics and logs/events** (OTLP) via environment variables. Prompt logging and tool detail logging are configurable and **disabled by default** (important for privacy). citeturn6view2turn4view0  
- Codex: offers multiple structured surfaces including (a) `codex exec --json` newline-delimited JSON state-change events, (b) a rich **app-server protocol** with events for plans and diffs, and (c) built-in **OpenTelemetry export** (logs + traces) via config. citeturn11view0turn13view0turn26view0turn31view0  

**Local-first dashboards and control planes (FOSS candidates emerging fast)**  
- The most directly on-target OSS project identified is **entity["organization","ai-observer","local ai observability tool"]**: a self-hosted, single-binary, OpenTelemetry-compatible backend designed specifically to monitor local AI coding tools (including Claude Code and Codex CLI) with a web dashboard, live updates, and import/export from local JSONL session files. It’s explicitly positioned around privacy and “zero external dependencies,” and provides macOS/Homebrew installation steps. citeturn20view0turn19view1turn19view3  
- A complementary (Codex-specific) OSS UI is **CodexMonitor**, a local desktop app that uses the Codex app-server protocol to manage multiple workspaces/threads and track unread/running state. citeturn15view1turn13view0  
- tmux-centric orchestrators (e.g., **NTM**, Claude Code Agent Farm) exist and can centralize “what’s running where,” but (today) they trend toward orchestration + coarse status rather than deep, standardized event ingestion. citeturn15view2turn22view1  

**Observability backends you can self-host (useful if you want “real observability plumbing”)**  
- If you prefer standard telemetry pipelines, both agents can speak OTLP, so you can route into general OSS backends like **entity["organization","SigNoz","open source apm"]** (OpenTelemetry-native logs/metrics/traces with ClickHouse storage) or a self-hosted **entity["organization","Grafana","observability platform"]** stack, or use tracing UIs like **entity["organization","Jaeger","distributed tracing project"]** for trace-first workflows. citeturn30search8turn30search12turn30search18turn30search17  
- LLM-oriented OSS platforms (e.g., **entity["organization","Langfuse","llm engineering platform"]**, **entity["organization","Helicone","llm observability platform"]**, **entity["organization","OpenLIT","genai observability tool"]**, **entity["organization","Opik","llm observability platform"]**) can be self-hosted and are excellent for tracing/chat/session analytics in app settings, but they do not automatically understand “local terminal sessions and file diffs” unless you feed them those events (via OTEL spans/logs, proxies, or custom ingestion). citeturn15view5turn17view0turn18view0turn18view2  

**Best workflow today (high-confidence recommendation)**  
For your exact pain—2–6 parallel terminals, sometimes tmux, and wanting a unified view of tool calls + file touches + “what next”—the best current workflow is:

1) Use an **OTLP-first local hub** (start with ai-observer for time-to-value),  
2) Enable **agent-native telemetry** (Claude Code OTLP logs/metrics; Codex OTLP logs/traces),  
3) Add **Claude Code hooks** to capture file/tool details (and optionally summarize plans/checkpoints),  
4) For Codex “planning visibility + diffs,” either run a lightweight app-server client or adopt CodexMonitor.

This yields a practical “control-plane-lite” cockpit—without waiting for a single vendor to unify everything. citeturn20view0turn6view2turn8view2turn13view0turn15view1  

**If you build it**  
There is a clear architectural direction that aligns with where the broader observability community is heading: OpenTelemetry’s semantic convention work is expanding from “LLM calls” to “agentic systems” (tasks, actions, agents, artifacts, memory). Designing your event schema around those concepts now will reduce rewrites later. citeturn27view0turn27view1  

Confidence notes: statements about Claude Code and Codex capabilities are **high confidence** where directly documented; assessments of community projects’ maturity are **medium** because early-stage repos can change quickly; anything involving future standardization (GenAI agent semantic conventions) is **directional** but supported by active proposals. citeturn27view0  

## Scope and taxonomy

Observability, in the OpenTelemetry framing, is the ability to understand a system by asking questions about it, enabled by emitted **signals** (traces, metrics, logs). citeturn27view2turn24search29 For local coding agents, the “system” is not a deployed service; it’s your **interactive, multi-session, tool-using agent workspace** (terminals, tmux panes, repos, shells, tools, files).

Your requested capability set maps cleanly into a practical taxonomy:

**Session inventory (who/where/when)**  
State you want: active agents, repo, branch, cwd, launch command/args, start time, last activity. Codex sessions and Claude Code sessions both have persistent identifiers and on-disk transcripts, which makes stable session IDs feasible. citeturn8view2turn23search1turn23search9

**Session state (what phase)**  
At minimum: idle / thinking / running tool / waiting approval / error / retrying. Codex app-server explicitly models turn lifecycle and emits `turn/started` and `turn/completed` notifications with status values (completed / interrupted / failed). citeturn13view0 Claude Code exposes hook events tied to tool execution and failures (e.g., PostToolUseFailure) and notifications (e.g., permission prompts, idle prompts). citeturn8view2turn7search0

**Tool calls (what it invoked, how it went)**  
Logs you want: tool name, args, duration, stdout/stderr, errors.  
- Codex app-server has item types like `commandExecution` (with command, cwd, status, output aggregation, exitCode, duration) and `mcpToolCall` (server, tool, arguments, result/error). citeturn13view2turn13view0  
- Claude Code hooks provide `tool_name`, `tool_input`, `tool_response`, and failure metadata (error string, interrupt flag). citeturn8view2turn8view0  

**Code actions (what files changed / tests run / commits)**  
You generally need two complementary lenses:
- “Intentional actions” (what the agent tried to do): captured best via tool events (e.g., Write tool includes file_path, Bash tool includes command). citeturn7search9turn8view2  
- “Actual repo delta” (what changed): best captured via VCS diff/commit data. Codex app-server can emit `turn/diff/updated` with the aggregated unified diff across file changes in a turn. citeturn13view0  

**Planning visibility (current goal, next steps, checkpoints)**  
This is where vendor support varies:
- Codex app-server emits `turn/plan/updated` with structured steps and statuses (pending / inProgress / completed). citeturn13view0  
- Claude Code doesn’t advertise an identical plan event in the same way, but it does have task lifecycle hooks (TaskCompleted) and persistent transcripts you can parse; hooks can also inject/collect context at checkpoints. citeturn8view3turn9view2  

**Cost/latency**  
Both ecosystems have first-party cost/usage instrumentation options:
- Claude Code’s status line system is explicitly designed to display “context usage, costs, git status,” and it pipes JSON session data to a user script. citeturn9view0  
- Claude Code OTEL config includes controls such as enabling telemetry, exporters, export intervals, and explicit opt-in to logging user prompts, plus tool detail logging toggles. citeturn6view2turn4view0  
- Codex has OTEL config (exporter/trace_exporter, endpoints, prompt logging opt-in) and stores session transcripts locally under `CODEX_HOME` with defaults under `~/.codex`. citeturn31view0turn25view1  

### Local dev workflow observability vs production LLM observability

Production “LLM observability” is usually built around **deployed request flows**: capturing model calls inside an application, routing them through gateways, and collecting traces/logs/metrics in shared backends. Tools like Helicone are proxy/gateway-centric and describe logging requests/responses as they pass through the gateway. citeturn17view0turn16search25

Local dev agent observability differs in key ways:

- The “service boundary” is your laptop; data residency and “don’t ship my code/prompts” constraints are higher. Claude Code and Codex both ship defaults where raw prompt logging is **off unless explicitly enabled**. citeturn6view2turn31view0  
- You care about **terminal session topology** (panes/windows) and **repo context** (branch/worktree). tmux can list panes across the server with formatted metadata, which is the raw material for a robust session inventory view. citeturn24search16  
- You often need a blend of observability and orchestration: not just “what happened,” but “pause/interrupt/resume” and “show me the diff.” Codex app-server sits closer to an agent control plane than a pure logging interface (thread lifecycle APIs + plan/diff events). citeturn13view1turn13view0  

### Tracing vs logging vs “agent control plane”

OpenTelemetry’s concepts are useful, but you need to map them to dev-agent reality.

- **Logs:** timestamped messages that may not be tied to a request; useful for event streams and audit trails. citeturn27view2  
- **Traces:** correlated spans with hierarchy; useful to see a whole “turn” as a structured unit and drill into tool sub-steps. OpenTelemetry describes traces as a collection of “structured logs with context, correlation, hierarchy.” citeturn27view3  
- **Agent control plane:** APIs/UI that can enumerate sessions, start/resume them, interrupt them, and surface the plan/diff artifacts. Codex app-server is a concrete example (thread/list, thread/start/resume, turn/* notifications, diff/plan updates). citeturn13view1turn13view0  

## Existing tools and frameworks

This section prioritizes FOSS/self-host options, but starts with the most important fact: **your best instrumentation hooks are already in the agents**.

image_group{"layout":"carousel","aspect_ratio":"16:9","query":["AI Observer dashboard screenshot GitHub ai-observer","Dimillian CodexMonitor screenshot","Langfuse traces UI screenshot","SigNoz tracing UI screenshot"],"num_per_query":1}

### Agent-native instrumentation surfaces

**Claude Code (core event surfaces you can mine locally)**  
- **Hooks**: Claude Code can execute user-defined hooks on lifecycle events. Hook inputs include `session_id`, `cwd`, `transcript_path`, `hook_event_name`, plus tool metadata (tool name/input/response) for tool-related events; there is a dedicated failure event (PostToolUseFailure) that includes error text. citeturn7search0turn8view2turn8view0  
- **File awareness via tools**: Hook examples show file tools with `file_path` in tool_input (e.g., Write), meaning you can log exactly what files the agent attempted to modify. citeturn7search9turn8view2  
- **Task checkpoints**: TaskCompleted hooks fire when tasks are marked complete (including teammate/agent-team contexts) and can block completion by exiting with a specific code, which is a pragmatic “checkpoint gate.” citeturn8view3  
- **Status line**: Claude Code can run an arbitrary script for a persistent status line; the script receives JSON session data and is explicitly positioned for context usage, cost tracking, and distinguishing multiple sessions. citeturn9view0  
- **OpenTelemetry export (metrics + logs)**: Claude Code documents environment variables for OTEL exporters, endpoints, export intervals, and explicit opt-ins for user prompt logging (`OTEL_LOG_USER_PROMPTS`) and tool detail logging (`OTEL_LOG_TOOL_DETAILS`), both disabled by default. citeturn6view2turn4view0  
- **On-disk project storage**: Claude Code documents per-project storage for auto memory under `~/.claude/projects/<project>/memory/`, derived from git repo root, with separate directories for git worktrees. This implies a stable mapping from “repo/worktree → Claude storage namespace.” citeturn9view1 Subagent transcripts are stored separately (agent-{agentId}.jsonl) and persist across main conversation compaction, with cleanup behavior governed by `cleanupPeriodDays` (default 30 days per docs). citeturn9view2  

**Codex (core event surfaces you can mine locally)**  
- **Session persistence + resume**: Codex stores session transcripts under `~/.codex/sessions/` and supports resuming via `codex resume` and `codex exec resume`, preserving transcript, plan history, and approvals. citeturn23search1turn11view1turn23search9  
- **Structured run output**: In non-interactive mode, `codex exec --json` (aka `--experimental-json`) prints newline-delimited JSON events (one per state change), which is usable as a direct local ingestion source. citeturn11view0turn11view1  
- **App-server protocol (richest “control plane + observability” source)**: Codex app-server emits server-initiated notifications for thread lifecycle and turn lifecycle, including:
  - `turn/started` and `turn/completed` with status (completed/interrupted/failed)  
  - `turn/diff/updated` (aggregated unified diff across file changes)  
  - `turn/plan/updated` (structured plan steps + statuses)  
  - item-level events including `commandExecution` (command, cwd, duration, exitCode), `fileChange` (path + diff), and `mcpToolCall` (server/tool/arguments/result/error). citeturn13view0turn13view2  
- **OpenTelemetry export (logs + traces)**: Codex config includes OTEL exporter options and a prompt-logging opt-in (`otel.log_user_prompt`). Config reference enumerates exporter/trace_exporter keys, endpoints, headers, and protocol modes. citeturn26view0turn31view0 The sample config shows OTEL is disabled by default and provides example `[otel.exporter."otlp-http"]` configuration, which makes local OTLP routing straightforward. citeturn31view0  
- **Local state model**: Codex documents `CODEX_HOME` (default `~/.codex`) and lists typical files including config.toml, auth, history.jsonl, logs, caches. citeturn25view1turn23search9  

### Local-first dashboards and orchestration tools

**entity["organization","ai-observer","local ai observability tool"] (MIT) — unified local dashboard for Claude Code + Codex**  
License + self-host: MIT-licensed. Runs as a local server with embedded frontend; positioned as “self-hosted, single-binary, OpenTelemetry-compatible backend” with “zero external dependencies.” citeturn20view0  
How it works (architecture, storage, UI): Describes OTLP ingestion (HTTP/JSON + HTTP/Protobuf), a real-time web dashboard via WebSocket, and a DuckDB-powered analytics store; it also supports importing historical session logs from tool-specific file locations and exporting to Parquet (optionally with a DuckDB “views” database). citeturn20view0turn19view3  
Integrations: Provides explicit setup guidance for Claude Code OTEL export and Codex OTEL export, and can import Claude Code and Codex session JSONL files (Claude Code under `~/.claude/projects/**/*.jsonl`, Codex under `~/.codex/sessions/*.jsonl` per project docs). citeturn19view3turn23search1turn23search9  
Maturity signals: early-stage (hundreds of stars, low commit count) but tightly scoped to the local-agent observability problem and appears actively used by its author. citeturn20view0  

**CodexMonitor (MIT) — Codex multi-workspace “situation room”**  
License + self-host: MIT licensed. citeturn15view1  
How it works: Runs one `codex app-server` per workspace, persists workspaces, resumes threads, tracks unread/running state, and provides thread management including stop/interrupt of in-flight turns. citeturn15view1turn13view1  
Fit: Extremely relevant for your “planning visibility + what changed” needs on Codex because the app-server protocol explicitly emits plan and diff updates. citeturn13view0turn13view2  
Momentum: very new (near-term repo activity), so treat as fast-moving. citeturn15view1  

**NTM (MIT) — tmux orchestration with a TUI + robot API**  
License + self-host: MIT. citeturn15view2  
How it works: Orchestrates multiple agents inside a named tmux session, supports machine-readable outputs (robot mode) to list sessions and send prompts programmatically, and includes installation + shell integration guidance. citeturn15view2  
Fit: Strong for “session inventory across panes” if you commit to tmux-centric workflows; weaker for deep tool-call/file-diff observability unless you extend or pipe in agent-native telemetry.

**Claude Code Agent Farm (MIT) — high-parallel Claude orchestration + tmux health dashboard**  
License + self-host: MIT. citeturn22view1  
How it works: Spawns many Claude Code sessions in tmux panes, monitors “agent health” (context usage, status, errors), maintains state files for external monitoring, and provides tmux-centric viewing. citeturn15view4turn22view1  
Fit: Overkill for 2–6 sessions unless you want “agent farm” workflows; useful as a reference for how people build tmux-centered monitoring loops. citeturn22view1  

**CCDash (MIT) — Claude Code monitoring + task scheduling web app**  
License + self-host: MIT. citeturn21view0  
How it works: Explicitly describes monitoring Claude Code execution status and task scheduling; exposes tech stack (Go/Gin/DuckDB backend, Next.js frontend) and includes deployment notes and basic security controls. citeturn21view0turn15view3  
Fit: Potentially useful for Claude-specific “what’s running” visibility; unclear (from docs alone) how deeply it captures tool calls / file diffs vs higher-level status.

### Self-hosted observability backends and LLM observability platforms

These tools are valuable when you want either (a) a robust OTLP pipeline, or (b) LLM-native analytics UI. None of them automatically solve terminal session inventory—your hub must still attach repo/branch/cwd metadata.

**entity["organization","OpenTelemetry","observability framework"] + Collector (standards backbone)**  
OpenTelemetry is explicitly positioned as a vendor-neutral OSS framework for generating/collecting/exporting traces, metrics, logs. citeturn24search29turn27view2  
The OpenTelemetry Collector quickstart shows the canonical local pattern: listen on 4317 (gRPC) and 4318 (HTTP) for OTLP. citeturn30search11turn30search7 This matters because Claude Code and Codex OTEL configs are OTLP-based. citeturn6view2turn31view0  

**entity["organization","SigNoz","open source apm"] (OSS) — unified logs/metrics/traces backend**  
SigNoz positions itself as OpenTelemetry-native observability (logs, traces, metrics) and an OSS alternative to commercial APM tools. citeturn30search8turn30search4  
Its architecture documentation describes telemetry flowing into a SigNoz OpenTelemetry collector and then into ClickHouse for analytics. citeturn30search12turn30search0  
Fit: Heavier than a “single-binary hub,” but strong if you want mature observability primitives and already think in OTEL terms.

**entity["organization","Jaeger","distributed tracing project"] (OSS tracing UI)**  
Jaeger is a distributed tracing platform; official docs emphasize OTEL instrumentation as the recommended path (with older Jaeger SDKs deprecated). citeturn30search17turn30search13  
Fit: Codex traces export cleanly into trace UIs; Claude Code (as documented) exports metrics + logs rather than traces, so Jaeger won’t be a full solution by itself. citeturn6view2turn31view0  

**entity["organization","Langfuse","llm engineering platform"] (MIT core; self-hostable) — LLM tracing + evals**  
License + self-host: MIT for core repo, with exceptions for enterprise folders; self-host docs describe Docker-based deployment and mention some add-on features requiring a license key. citeturn14view3turn15view5turn10search8  
Architecture: two application containers (web + worker) plus Postgres, ClickHouse, and Redis/Valkey cache. citeturn15view5  
OTEL integration: Langfuse documents OTEL ingestion as a way to export traces into Langfuse using OpenTelemetry SDKs. citeturn16search15turn16search30  
Fit: Great UI for traces and agent graphs, but you must map your local agent events (tool calls, file diffs, tmux metadata) into trace/log primitives you send to Langfuse.

**entity["organization","Helicone","llm observability platform"] (Apache-2.0; self-hostable) — gateway/proxy logging**  
License + self-host: Apache-2.0 and supports self-hosting via docker-compose workflow. citeturn17view0turn16search4  
Architecture: multiple services including web frontend, proxy logging worker, server components, and storage including ClickHouse and object storage (Minio), plus Supabase as app DB/auth. citeturn17view0  
Fit: Excellent if you route LLM calls through its gateway. For local terminal agents, you’d adopt it only if you can point the agent at Helicone’s gateway or otherwise instrument events into it.

**entity["organization","OpenLIT","genai observability tool"] (Apache-2.0) — OTEL-native GenAI observability**  
OpenLIT is Apache-2.0 licensed and positions itself as OpenTelemetry-native observability for GenAI (traces + metrics) with dashboards and SDKs. citeturn18view0turn17view1  
Fit: Best when you are instrumenting your own code (SDK integration). For CLI agent observability, it’s primarily a backend/UI target once you emit the right OTEL signals.

**entity["organization","Opik","llm observability platform"] (Apache-2.0) — OSS tracing/evals/monitoring**  
Opik is Apache-2.0 licensed and positions itself as end-to-end tracing/evaluation/monitoring for LLM apps and agentic workflows. citeturn18view2turn17view3  
Fit: Similar to Langfuse: powerful once your agent emits structured traces/logs, but doesn’t inherently solve terminal multi-session awareness without additional metadata + ingestion.

**OpenLLMetry (Apache-2.0) — instrumentation layer**  
OpenLLMetry is explicitly Apache-2.0 and provides OpenTelemetry instrumentations for LLM providers and vector DBs, outputting standard OTEL data that can be sent to your observability stack. citeturn17view2turn16search13  
Fit: Useful if you build a custom wrapper/agent loop and want “automatic-ish” span emission; less directly applicable if you rely purely on closed-source CLIs and their built-in logs.

### Standards direction: semantic conventions for agent systems

There is an active OpenTelemetry semantic conventions proposal to cover “agentic systems” (tasks, actions, agents, teams, artifacts, memory) to standardize telemetry across complex AI workflows. citeturn27view0  
Why it matters for you: your desired observability fields (tool calls, diffs, plans, checkpoints) align almost one-to-one with the “tasks/actions/artifacts/memory” vocabulary that’s emerging as the standard shape. citeturn27view0turn27view1  

## Shortlist and comparison table

Scoring rubric: 1 (poor) to 5 (excellent) for your use case: “local-first situational awareness across multiple concurrent terminal agent sessions (Claude Code + Codex), with tool calls + file changes + planning visibility.” Scores are an evidence-informed judgment based on documented capabilities and typical setup complexity; they are not vendor benchmarks.

| Tool | Local-first UX | Self-host simplicity | Tool-call + file-change ingest | Multi-session support | Time-to-value | Extensibility (APIs/OTEL) | Notes / best fit |
|---|---:|---:|---:|---:|---:|---:|---|
| AI Observer | 5 | 5 | 3 | 4 | 5 | 4 | Best “single cockpit” start; strongest if you embrace OTEL + log import |
| CodexMonitor | 4 | 4 | 4 | 5 | 4 | 3 | Best Codex visibility (plan/diff) via app-server; Codex-only |
| SigNoz | 3 | 3 | 4 | 4 | 2 | 5 | Most “real observability backend” for OTEL signals; heavier ops |
| Langfuse (self-host) | 3 | 3 | 3 | 4 | 2 | 5 | Great for tracing/agent graphs; needs you to map local agent events into traces |
| OpenLIT | 3 | 3 | 3 | 3 | 2 | 5 | OTEL-native dashboards; best with SDK-instrumented pipelines |
| NTM (tmux control plane) | 4 | 4 | 2 | 5 | 4 | 3 | Great pane/session orchestration; observability depth depends on extensions |

Evidence anchors for the shortlist:
- AI Observer: single-binary OTEL backend + dashboard + import paths and setup instructions for Claude Code and Codex. citeturn20view0turn19view3  
- CodexMonitor: orchestrates multiple Codex workspaces/threads and uses app-server protocol. citeturn15view1turn13view1  
- SigNoz: OTEL-native OSS backend with ClickHouse architecture and unified signals. citeturn30search8turn30search12  
- Langfuse: MIT core, self-host architecture, OTEL ingestion. citeturn14view3turn15view5turn16search15  
- OpenLIT: Apache-2.0 OTEL-native SDK + dashboards. citeturn18view0turn17view1  
- NTM: tmux-based multi-agent orchestration with CLI/robot API. citeturn15view2  

## Best workflow today on macOS

This workflow assumes your priority is: **unified situational awareness** (current sessions, what they’re doing, what they touched, what’s next), while keeping telemetry local.

### Core idea

1) Make **OTLP (OpenTelemetry Protocol)** your “wire format” for anything that can speak it,  
2) Treat each agent session as `session_id` / `thread-id` / “trace root,”  
3) Add missing “local dev context” (repo/branch/cwd/terminal pane) as attributes whenever you can.

OpenTelemetry’s value here is correlation: logs/metrics/traces become navigable when they share consistent context fields. citeturn27view2turn24search5  

### Step-by-step setup

**Step A — Stand up a local hub (fastest path: AI Observer)**  
AI Observer documents a Homebrew install flow for macOS Apple Silicon and runs as a local server. citeturn19view1turn20view0  
Once running, it can receive OTLP directly and display dashboards/metrics/logs/traces. citeturn20view0  

**Step B — Enable Claude Code telemetry (OTEL logs + metrics)**  
Claude Code telemetry requires setting `CLAUDE_CODE_ENABLE_TELEMETRY=1` and configuring OTEL exporters and OTLP endpoints via environment variables. citeturn6view2  
Important privacy control: logging user prompt content is explicitly opt-in (`OTEL_LOG_USER_PROMPTS`) and disabled by default; tool detail logging is also opt-in. citeturn6view2turn4view0  

Practical recommendation: keep prompt logging disabled initially; enable tool detail logging only once you’re comfortable with redaction and storage. (This is especially important for shell commands that may include secrets in arguments.)

**Step C — Enable Codex telemetry (OTEL logs + traces)**  
Codex supports OpenTelemetry config under `[otel]`, disabled by default. citeturn31view0  
The sample config shows how to set `exporter` and `trace_exporter` and configure `otel.exporter."otlp-http"` endpoints. citeturn31view0turn26view0  
Codex also documents `CODEX_HOME` defaulting to `~/.codex`, which is where config.toml lives. citeturn25view1  

**Step D — Capture tool calls + file touches with high fidelity**

- **Claude Code**: add hooks for `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` to emit structured events into your hub. Hooks receive tool inputs/outputs, plus `cwd` and a pointer to the transcript file. citeturn7search0turn8view2turn8view0  
  - For file tools like Write, the hook input includes `file_path`; for Bash, it includes the command. citeturn7search9turn8view2  
  - This is the cleanest way to answer “what files did the agent touch?” without OS-level interception.

- **Codex**: if you want deep planning/diff visibility, consume **app-server events**:
  - `turn/plan/updated` answers “what’s next,”  
  - `turn/diff/updated` and `fileChange` items answer “what changed,”  
  - `commandExecution` items answer “what commands/tools ran and how long they took.” citeturn13view0turn13view2  

If you don’t want to build an app-server client immediately, CodexMonitor is the ready-made version of this idea. citeturn15view1turn13view0  

**Step E — Make tmux a first-class “session inventory” input (if you use tmux)**  
For tmux-based workflows, the simplest durable inventory is: enumerate all panes in the tmux server and attach metadata like current path and pane/session IDs. tmux supports listing panes across the server and formatting each line via `-F`. citeturn24search16  

From there, a lightweight “inventory loop” can enrich each pane with git repo and branch (by running `git` in that pane’s current path) and associate it with an agent session id whenever possible (e.g., from agent logs, or by naming panes). tmux status/pane formats can include the current working directory (`#{pane_current_path}`), and tmux can also run external commands for richer status content. citeturn24search19turn24search3  

### What you get with this workflow

- A unified dashboard across tools for costs, errors, and (for Codex) trace timelines if exported. citeturn20view0turn31view0  
- For Claude Code: reliable tool/file audit via hooks + optionally via OTEL logs/events. citeturn8view2turn6view2  
- For Codex: structured plan + diff + tool/command events (best via app-server; second-best via saved session JSONL and `--json` output). citeturn13view0turn23search1turn11view0  

## Build blueprint for a local agent observability hub

This section is a recommended architecture if you decide to build a dedicated local-first “agent observability hub” that aggregates multiple terminals and multiple agent types, with an MVP feasible in ~1–2 weeks.

### Design goals and constraints

- **Local-first by default:** store everything on-disk locally; no external SaaS dependency. (The popularity of “single binary” local backends in this niche is exemplified by AI Observer’s design choices.) citeturn20view0  
- **Multi-agent, multi-session:** treat session/thread IDs as first-class and stable (Codex thread IDs; Claude Code session_id). citeturn13view1turn7search0  
- **Plan/diff/tool fidelity:** use agent-native event streams where available (Codex app-server, Claude Code hooks). citeturn13view0turn8view2  
- **OTEL-compatible:** where possible, map everything into OTEL logs/metrics/traces so you can swap backends. OpenTelemetry already frames observability as emitted signals (traces/metrics/logs). citeturn27view2turn24search29  

### Event schema

A pragmatic schema should blend:
- “classic observability” context (timestamps, duration, status, error),
- “local dev” context (repo/branch/cwd, tmux pane/window, command used to launch),
- “agentic system” concepts (task, action, artifact, memory), matching the direction of emerging OpenTelemetry agentic semantic conventions. citeturn27view0  

Below is an example event envelope (conceptual, not a formal standard):

```json
{
  "ts": "2026-02-18T03:21:45.123Z",
  "event_type": "tool.call.finished",
  "agent": {
    "agent_type": "claude_code|codex",
    "session_id": "abc123",
    "subagent_id": "agent-xyz",
    "state": "running|idle|waiting|error"
  },
  "workspace": {
    "repo_root": "/path/to/repo",
    "branch": "feature/foo",
    "cwd": "/path/to/repo/subdir",
    "git_worktree": "/path/to/worktree"
  },
  "terminal": {
    "mux": "tmux|none",
    "tmux_session": "s1",
    "tmux_window": "w3",
    "tmux_pane": "%7",
    "tty": "/dev/ttys004"
  },
  "task": {
    "task_id": "task-001",
    "goal": "Implement X",
    "plan_step": "Run tests",
    "plan_status": "inProgress"
  },
  "tool": {
    "name": "Bash|Write|mcpToolCall|commandExecution",
    "args": {"command": "npm test"},
    "duration_ms": 9234,
    "exit_code": 0,
    "stdout_ref": "artifact://logs/...",
    "stderr_ref": "artifact://logs/..."
  },
  "code": {
    "files_read": ["/path/a.ts"],
    "files_written": ["/path/b.ts"],
    "diff_unified_ref": "artifact://diffs/...",
    "tests_run": ["npm test"]
  },
  "cost": {
    "model": "…",
    "tokens_in": 1234,
    "tokens_out": 567,
    "usd": 0.12
  },
  "error": {
    "message": null,
    "retrying": false
  }
}
```

The “task/action/artifact/memory” vocabulary is deliberately aligned with the OpenTelemetry proposal for agentic systems (tasks and actions as minimal trackable units; artifacts as tangible inputs/outputs; memory as persistent context). citeturn27view0  

### Capture approach

A layered capture strategy minimizes fragility:

**First (MVP): consume agent-native sources**
- **Codex app-server** for plan/diff/tool/command events (highest fidelity). citeturn13view0turn13view2  
- **Claude Code hooks** for tool/file events plus failures and permission prompts. citeturn8view2turn7search0  
- **OTLP ingestion** for whatever the agents emit via OpenTelemetry (Codex logs+traces; Claude logs+metrics). citeturn31view0turn6view2  

**Second: parse on-disk transcripts for backfill**
- Codex sessions are stored under `~/.codex/sessions/`. citeturn23search1turn23search9  
- Claude Code maintains per-project storage under `~/.claude/projects/…` (documented at least for memory and referenced by transcript_path in hooks). citeturn9view1turn7search0  

**Third (optional): terminal/mux discovery**
- For tmux users, query tmux pane inventory (pane IDs + current paths) and join that to agent sessions via cwd matching and/or explicit pane naming. tmux supports listing panes across the server with formatted output. citeturn24search16  

**Later (nice-to-have): PTY interception / shell wrapping**
- PTY interception is powerful but invasive; it tends to be brittle and OS/version dependent. In most cases, agent-native hooks + OTEL traces already cover the highest-value questions with lower risk.

### Storage choices

A strong local-first pattern is:
- **Append-only event log** (JSONL) for durability and easy export,
- plus a **local analytical store** for fast queries and dashboards.

AI Observer’s design (“DuckDB-powered storage” + Parquet export) is a concrete example of this approach working in practice for local agent telemetry. citeturn20view0turn19view3  
If you instead want a more “standard observability backend” posture, SigNoz and Langfuse show the ClickHouse model for high-volume analytics, but that’s usually beyond MVP needs on a laptop. citeturn30search12turn15view5  

### UI options

Two UI surfaces tend to fit local dev best:

- **Local web UI**: easiest for multi-session overview, filtering, diff viewing, and timeline charts (AI Observer, CCDash, Langfuse-style UIs). citeturn20view0turn21view0turn15view5  
- **TUI dashboard**: ideal for staying “in terminal land,” especially with tmux, and for quick session commands (“interrupt,” “show diff,” “jump to repo”). NTM demonstrates the viability of rich TUIs for multi-agent orchestration. citeturn15view2  

A hybrid pattern is common: TUI for quick control + web UI for deep drill-down.

### MVP milestones (1–2 weeks)

**MVP (week 1)**  
- Implement session registry:
  - Codex: connect to app-server; ingest thread + turn lifecycle; store `turn/plan/updated` and `turn/diff/updated`. citeturn13view0  
  - Claude Code: ingest hooks for PreToolUse/PostToolUse/PostToolUseFailure; store tool/file events. citeturn8view2  
- Minimal web UI:
  - Session list (repo/cwd inferred; last activity; state),
  - Per-session timeline: “turns,” tool calls, failures, approvals.

**MVP (week 2)**  
- Add OTLP receiver (logs/metrics/traces) so you can ingest whatever the agents already emit. The OTEL collector quickstart demonstrates the local port conventions (4317/4318), which you can mimic or embed. citeturn30search11turn30search7  
- Add tmux inventory join (if tmux detected) via `list-panes -a -F` to attach pane IDs and current paths. citeturn24search16  
- Implement redaction controls (prompts off by default; opt-in per source), matching the agents’ own “prompt logging is opt-in” posture. citeturn6view2turn31view0  

**Nice-to-haves**  
- “Plan checkpoints” UI (turn plan step statuses; Claude task completion gates). citeturn13view0turn8view3  
- Diff viewer with per-turn aggregation (Codex gives you `turn/diff/updated`; for Claude, compute from git status or from tool events). citeturn13view0turn7search9  
- Export: Parquet/JSONL; local retention policies (Codex and Claude both already have retention/cleanup knobs in their ecosystems). citeturn9view2turn25view1turn20view0