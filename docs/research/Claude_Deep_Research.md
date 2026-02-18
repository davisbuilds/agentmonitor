# Local-first observability for terminal AI coding agents

**The gap between production LLM observability and local dev agent monitoring is closing fast — but no single tool solves the full problem today.** Both Claude Code and Codex CLI now ship built-in OpenTelemetry support, and a wave of open-source TUI session managers emerged in late 2025. The best current workflow combines Claude Code's native hooks system with a self-hosted tracing backend (Langfuse or Phoenix) and a tmux-based session manager like Agent of Empires. For a purpose-built solution, a lightweight SQLite-backed event hub using Claude Code hooks as the primary data source can reach MVP in under two weeks.

---

## Section 1: What "observability" means for local coding agents

Production LLM observability tools (Datadog LLM Monitoring, LangSmith, Helicone) optimize for **fleet-scale metrics**: p99 latency, cost attribution across teams, A/B testing prompts, and evaluating output quality over thousands of requests. Local dev observability solves a fundamentally different problem: **maintaining situational awareness across 2–6 concurrent agent sessions** on a single machine, where the developer is the operator, the debugger, and the consumer simultaneously.

The concrete capabilities break into six layers, each progressively harder to instrument:

**Session inventory** is the foundation — knowing which agents are alive, what repo/branch each targets, the working directory, launch command, start time, and last activity timestamp. This is trivially available from tmux session metadata and process tables. **Agent state** (idle, thinking, running a tool, waiting on user input, error, retrying) requires parsing agent output or hooking into lifecycle events. **Tool-call tracing** captures the name, arguments, duration, stdout/stderr, and exit codes of every tool invocation — the most information-dense layer for debugging. **Code-action tracking** (files read/edited, diffs generated, tests run, linters invoked, build commands) often overlaps with tool calls but adds git-level semantics. **Planning visibility** — the agent's current goal, next intended steps, and internal checkpoints — is the hardest layer, requiring access to the agent's reasoning trace or structured plan output. **Cost and latency** (tokens consumed, model used, time per step, cumulative session cost) is increasingly critical as Agent Teams sessions can exceed **$20,000 for large tasks**.

Three distinct paradigms address subsets of these layers. **Tracing** (OpenTelemetry, Langfuse, Phoenix) captures hierarchical spans with parent-child relationships — ideal for tool calls and LLM invocations but requires SDK integration or API interception. **Logging** (JSONL files, structured log aggregation) captures raw events chronologically — simple to implement but lacks the relational structure needed for visualizing agent execution trees. An **agent control plane** (Agent of Empires, Claude Squad, TmuxCC) manages session lifecycle, routes user attention, and provides real-time status — but typically doesn't persist detailed traces for post-hoc analysis. The ideal local setup combines all three.

---

## Section 2: Existing tools and frameworks

### Agent/LLM tracing tools that run locally

**Langfuse** is the strongest overall candidate for self-hosted agent tracing. Licensed MIT, it deploys via a single `docker compose up` in under five minutes, running PostgreSQL + ClickHouse + a Next.js UI. With **21,900 GitHub stars** and 200+ contributors, it has the largest open-source LLM observability community. Critically, Langfuse has an **official Claude Code integration** via the hooks system — a community-maintained template (`claude-code-langfuse-template`) captures conversation transcripts, tool invocations, and cost data by attaching a `Stop` hook that sends session data to the local Langfuse instance. The data model (Traces → Observations of type SPAN, GENERATION, or EVENT) maps well to agent workflows. Langfuse also accepts standard OpenTelemetry traces via its `/api/public/otel` OTLP endpoint, enabling it to ingest data from OpenLLMetry, OpenLIT, or Claude Code's native OTel export. Recent additions (December 2025) include **filtering observations by tool calls** and dashboard widgets for tool usage analytics. Langfuse v3 migrated trace storage to ClickHouse for better analytical query performance.

**Phoenix by Arize** offers the lowest-friction setup: `pip install arize-phoenix && python -m phoenix.server.main serve` starts a fully functional tracing UI at localhost:6006 with zero Docker dependencies. Licensed Elastic License v2 (open source but not OSI-approved — you cannot offer it as a managed service), Phoenix is **OpenTelemetry-native** and accepts OTLP traces directly. With **8,500 stars**, it provides purpose-built LLM visualization including span kinds for AGENT, TOOL, RETRIEVER, and EMBEDDING operations. Phoenix v13.0.3 (February 14, 2026) added Claude Opus 4.6 playground support and a CLI for fetching traces for use with coding agents. Phoenix stores data in PostgreSQL locally and understands the OpenInference semantic conventions, which provide richer span-type discrimination than the still-experimental OTel GenAI conventions.

**OpenLIT** (Apache 2.0, **2,100 stars**) differentiates through pure OpenTelemetry compliance — it stores everything in ClickHouse using standard OTel semantic conventions, meaning traces can simultaneously feed Grafana, Prometheus, Jaeger, or any OTLP-compatible backend. The one-line `openlit.init()` auto-instruments 50+ LLM providers. The tradeoff is ClickHouse dependency (heavier than SQLite/Postgres for simple setups) and a less mature UI compared to Langfuse or Phoenix.

**LiteLLM** (MIT, **~22,000 stars**) is not an observability tool per se but an **LLM proxy/gateway** that sits between agents and API providers. It logs all LLM calls and can forward them to Langfuse, Phoenix, or any OTEL backend via its callback system. The key use case: set `ANTHROPIC_BASE_URL=http://localhost:4000` to route Claude Code traffic through LiteLLM, capturing every API call with token counts, latency, and cost — then export to Langfuse for visualization. LiteLLM adds ~8ms P95 latency at 1,000 RPS, negligible for interactive coding.

**AgentOps** (MIT, **5,300 stars**) is purpose-built for agent monitoring with session replay and step-by-step execution graphs. Self-hosting requires Supabase, making it heavier to deploy than Langfuse. **Laminar** (YC S24, Rust-based) offers a unique feature: browser session recordings synced with agent traces, useful for web-scraping agents but less relevant for terminal workflows. **Helicone** (Apache 2.0, **~4,800 stars**) excels at cost optimization with built-in caching that reduces API costs 20–30%, but its proxy-based architecture only captures API calls, not internal agent logic.

**Lunary's GitHub repository was deleted in December 2025**, making new self-hosted deployments impossible. Avoid it. W&B Weave and HoneyHive require cloud accounts or enterprise licenses for self-hosting — disqualified for fully local setups.

### Claude Code's native observability surface

Claude Code provides three complementary observability mechanisms that make it the most instrumentable coding agent available:

**Session logs** are stored as JSONL files in `~/.claude/projects/<encoded-directory>/<session-uuid>.jsonl`, with each line containing typed JSON objects (`user`, `assistant`, `tool_use`, `tool_result`) including token usage and cost data. A global `~/.claude/history.jsonl` indexes every prompt with timestamps, project paths, and session IDs. Session metadata lives in `sessions-index.json` per project. **Default retention is 30 days**, configurable via `cleanupPeriodDays` in `~/.claude/settings.json`.

**Built-in OpenTelemetry** is activated by setting environment variables:
```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```
This exports metrics (`claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.lines_of_code.count`, `claude_code.commit.count`) and events (`claude_code.tool_result`, `claude_code.api_request`, `claude_code.tool_decision`) via OTLP. A known subtlety: the rich event data (token counts, tool usage, API details) ships exclusively via the OTel **logs/events protocol**, not as traditional metrics — backends must ingest OTLP logs to get full data.

The **hooks system** is the most powerful mechanism. Twelve event types (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `Notification`, `TaskCompleted`, and others) fire at agent lifecycle points. Hooks receive JSON on stdin with `session_id`, `cwd`, `tool_name`, `tool_input`, and event-specific fields. Hook types include shell commands, LLM-evaluated prompts, and sub-agents. This enables rich custom observability without modifying Claude Code itself.

Third-party tools leveraging these surfaces include **claude-code-otel** (full OTel Collector + Grafana dashboards), **claude_telemetry/claudia** (drop-in CLI replacement forwarding to Logfire/Sentry/Honeycomb), and **claude-code-hooks-multi-agent-observability** (Vue + SQLite real-time dashboard using hooks).

### Codex CLI's observability surface

Codex CLI (rewritten in Rust in 2025) has **built-in OpenTelemetry** configured via `~/.codex/config.toml`:
```toml
[otel]
exporter = { otlp-http = { endpoint = "http://localhost:4318/v1/logs" } }
```
Exported events include `codex.tool_result`, `codex.api_request`, `codex.user_prompt`, and `codex.tool_decision`. OTel metrics cover `codex.api_request`, `codex.tool.call` with duration histograms. Codex also supports MCP (as both client and server via `codex mcp-server`), and `RUST_LOG` enables debug output. However, Codex **lacks a hooks system** comparable to Claude Code — its observability surface is limited to OTel export and structured output from `codex exec`.

### Terminal session managers for multiple agents

A new category of tools emerged in late 2025 specifically for this problem:

**Agent of Empires** (`brew install njbrake/aoe/aoe`) is the most complete TUI session manager, written in Rust with Ratatui. It auto-detects Claude Code, Codex CLI, Gemini CLI, OpenCode, and Mistral Vibe agents, provides status detection (running/waiting/idle), git worktree support for parallel branches, Docker sandboxing, inline diff views, and session grouping. Sessions persist as tmux sessions — closing the TUI doesn't stop agents.

**Claude Squad** (`brew install claude-squad`) manages multiple agents in tmux with git worktrees for isolated codebases and auto-accept/YOLO mode for background task completion. **TmuxCC** (`cargo install tmuxcc`) provides a Ratatui TUI with agent-specific parsers for status detection via pane content capture. **Agent Tmux Monitor** uses Claude Code hooks (not output parsing) for ~300ms refresh data collection with zero performance impact. **Agent Manager X** is a native Swift macOS app with global hotkey (Ctrl+Space), mini floating display, audio notifications, and CPU/RAM usage per session.

For web-based monitoring, **Agent Overseer** (`brew install agent-overseer`) launches agents in PTYs and streams output to a browser with Tailscale support for mobile access. **claude-code-hooks-multi-agent-observability** provides a Vue dashboard backed by SQLite, receiving real-time data from Claude Code hooks via HTTP POST.

### OpenTelemetry for local agent tracing

The **OTel GenAI Semantic Conventions** (experimental since v1.37) define spans for `chat`, `invoke_agent`, `execute_tool`, and `create_agent` operations with attributes like `gen_ai.request.model`, `gen_ai.usage.input_tokens`, and `gen_ai.tool.name`. Three auto-instrumentation ecosystems exist: **OpenLLMetry** by Traceloop (broadest coverage — OpenAI, Anthropic, Cohere, LlamaIndex, LangChain, Bedrock, Pinecone, Chroma), **OpenInference** by Arize (8 span kinds including AGENT and TOOL), and the **official OTel Python contrib** GenAI instrumentation for OpenAI. The OWASP Agent Observability Standard (AOS) extends OTel with `agent.thought` and `agent.reasoning` attributes for planning visibility.

For local backends, **Jaeger all-in-one** (`docker run jaegertracing/all-in-one`) provides the simplest trace visualization at localhost:16686. Phoenix runs without Docker. Both accept OTLP on ports 4317 (gRPC) and 4318 (HTTP).

---

## Section 3: Shortlist and comparison

| Tool | Local-first UX | Self-host simplicity | Tool-call + file events | Concurrent sessions | Setup time | Extensibility | Best for |
|---|---|---|---|---|---|---|---|
| **Langfuse** | ✅ Fully offline | Docker Compose (5 min) | ✅ Via hooks + OTLP | ✅ Session grouping | ~10 min | OTLP, SDKs, hooks, REST API | Full tracing + cost |
| **Phoenix** | ✅ Fully offline | `pip install` (1 min) | ✅ Via OTLP + OpenInference | ✅ Multi-project | ~3 min | OTLP, auto-instrumentation | Lightweight tracing |
| **Agent of Empires** | ✅ Fully offline | `brew install` (1 min) | ⚠️ Status only, no deep tracing | ✅ Multi-agent TUI | ~2 min | Per-repo config, tmux | Session management |
| **claude-code-hooks-obs** | ✅ Fully offline | Bun + SQLite | ✅ All hook events | ✅ Per-agent swim lanes | ~15 min | Vue dashboard, SQLite | Claude Code multi-agent |
| **LiteLLM + Langfuse** | ✅ Fully offline | Docker Compose + pip | ✅ API calls + callbacks | ✅ Per-key tracking | ~20 min | 100+ providers, OTLP | API interception |
| **OpenLIT** | ✅ Fully offline | Docker Compose | ✅ Via OTLP + SDK | ✅ Multi-env dashboards | ~15 min | Any OTLP backend | OTel-native infra |
| **Agent Tmux Monitor** | ✅ Fully offline | curl install script | ⚠️ Cost + status via hooks | ✅ Claude Code sessions | ~5 min | Hook-based, Rust | Lightweight tmux |
| **AgentPulse** | ✅ Fully offline | pip + Docker | ✅ Decorator-based | ✅ Multiple agents | ~10 min | Python SDK, SQLite | Cost tracking |

The two strongest combinations for the stated use case (2–6 terminals, Claude Code + Codex, macOS):

- **For immediate value**: Agent of Empires (session management) + Langfuse self-hosted (deep tracing via Claude Code hooks + Codex OTel)
- **For maximum simplicity**: Phoenix (single pip install) + Claude Code's native OTel export + Agent Tmux Monitor (status overview)

---

## Section 4: Best workflow today

No single tool provides session management, deep tracing, cost tracking, and planning visibility in one package. Here is the most practical composite workflow for macOS, achievable in under an hour:

**Step 1 — Install session management (5 minutes)**
```bash
brew install njbrake/aoe/aoe
# Or for lighter weight:
brew install claude-squad
```
Agent of Empires gives you a TUI dashboard for launching, monitoring, and switching between agent sessions. It auto-detects Claude Code and Codex CLI, shows status (thinking/waiting/idle), and manages git worktrees for parallel branches.

**Step 2 — Deploy Langfuse locally (10 minutes)**
```bash
git clone https://github.com/langfuse/langfuse.git && cd langfuse
docker compose up -d
# UI at http://localhost:3000 — create project, get API keys
```

**Step 3 — Configure Claude Code hooks for Langfuse (10 minutes)**

Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.claude/hooks/send_to_langfuse.py"
      }]
    }],
    "PostToolUse": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.claude/hooks/log_tool_use.py"
      }]
    }]
  }
}
```
The hook scripts read JSON from stdin (containing `session_id`, `tool_name`, `tool_input`, `cwd`) and POST to Langfuse's API. Use the `claude-code-langfuse-template` from GitHub as a starting point.

**Step 4 — Enable Claude Code's native OTel export (2 minutes)**
```bash
# Add to ~/.zshrc or tmux session environment
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/api/public/otel
```
This sends token usage, cost, tool decisions, and API request events directly to Langfuse's OTLP endpoint.

**Step 5 — Configure Codex CLI OTel export (2 minutes)**

Add to `~/.codex/config.toml`:
```toml
[otel]
exporter = { otlp-http = { endpoint = "http://localhost:3000/api/public/otel/v1/logs" } }
```

**Step 6 — Optional: LiteLLM proxy for unified cost tracking (5 minutes)**
```bash
pip install 'litellm[proxy]'
litellm --config litellm_config.yaml
# Set ANTHROPIC_BASE_URL=http://localhost:4000 for Claude Code
```

**Daily workflow**: Launch Agent of Empires (`aoe`), create sessions for each task (it handles tmux + git worktrees), work across agents using the TUI. Open Langfuse at localhost:3000 for deep trace inspection, cost analysis, and tool-call debugging. Use `aoe` for quick status checks and session switching, Langfuse for post-hoc analysis and debugging failed tool calls.

---

## Section 5: Build-it-yourself architecture

### Event schema

The schema aligns with OTel GenAI Semantic Conventions while adding agent-session and file-operation fields missing from the standard:

```sql
CREATE TABLE events (
  id            TEXT PRIMARY KEY,        -- ULID for time-ordered IDs
  timestamp     TEXT NOT NULL,           -- ISO 8601 with timezone
  session_id    TEXT NOT NULL,           -- agent session identifier
  agent_type    TEXT NOT NULL,           -- 'claude_code' | 'codex' | 'custom'
  agent_pid     INTEGER,                -- OS process ID
  repo          TEXT,                    -- git remote URL or local path
  branch        TEXT,                    -- current git branch
  cwd           TEXT,                    -- working directory

  -- Event classification
  event_type    TEXT NOT NULL,           -- 'tool_call' | 'tool_result' | 'llm_request' |
                                        -- 'llm_response' | 'file_change' | 'git_commit' |
                                        -- 'state_change' | 'plan_step' | 'error' | 'session_lifecycle'
  event_subtype TEXT,                    -- e.g., 'Bash', 'Edit', 'Read', 'Write' for tool_call

  -- Tool call fields
  tool_name     TEXT,
  tool_args     TEXT,                    -- JSON
  tool_duration_ms INTEGER,
  tool_exit_code   INTEGER,
  tool_stdout   TEXT,                    -- truncated to 4KB
  tool_stderr   TEXT,

  -- LLM fields
  model         TEXT,                    -- 'claude-sonnet-4' | 'o3-mini'
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_usd      REAL,
  latency_ms    INTEGER,

  -- File/git fields
  file_path     TEXT,
  file_op       TEXT,                    -- 'read' | 'create' | 'edit' | 'delete'
  diff          TEXT,                    -- unified diff for edits
  commit_hash   TEXT,

  -- Planning fields
  goal          TEXT,                    -- current agent goal/task
  plan_step     TEXT,                    -- structured plan step description
  plan_index    INTEGER,                -- step number in plan

  -- State
  agent_state   TEXT,                    -- 'idle' | 'thinking' | 'tool_running' | 'waiting_user' | 'error'

  -- Extensibility
  metadata      TEXT                     -- JSON blob for arbitrary extra data
);

CREATE INDEX idx_session ON events(session_id, timestamp);
CREATE INDEX idx_type ON events(event_type, timestamp);
CREATE INDEX idx_repo ON events(repo, branch);
```

### Capture approach (ranked by signal richness)

**Claude Code hooks** (primary, highest signal) — The `PostToolUse`, `PreToolUse`, `Stop`, `SessionStart`, `SessionEnd`, and `TaskCompleted` hooks fire at every significant lifecycle point. Each receives JSON on stdin containing `session_id`, `tool_name`, `tool_input`, and `cwd`. A hook script POSTs this JSON to the local hub's HTTP endpoint. Hooks are non-blocking when configured correctly (async fire-and-forget via `curl &`). This is the single richest data source because it captures tool calls with full arguments, session lifecycle, and sub-agent activity.

**OTel export** (secondary, both agents) — Both Claude Code and Codex CLI export OTLP events. Run a lightweight OTEL Collector (or accept OTLP directly in the hub) to ingest `token.usage`, `cost.usage`, `api_request`, and `tool_result` events. This provides cost/latency data that hooks alone may not capture cleanly.

**Filesystem watcher** (supplementary) — `fswatch` on macOS monitors working directories for file creates/modifies/deletes. Debounce events (500ms window), compute diffs against git HEAD, and emit `file_change` events. This catches file changes regardless of which agent made them.

**Git hooks** (supplementary) — `post-commit` hooks capture commit hash, message, and diff summary. Install via a shared git template directory or per-repo `.git/hooks/`.

**Process table polling** (lightweight) — Every 2 seconds, poll `ps aux | grep -E 'claude|codex'` to detect running agent processes, their PIDs, and working directories. Combined with tmux `list-panes -F`, this provides the session inventory layer.

### Storage recommendation: SQLite

**SQLite wins for this use case** over both JSONL and a full OTEL Collector + database stack. It handles **30,000–40,000 inserts/second** (vastly exceeding agent event rates of ~1–10 events/second per session), supports concurrent reads for the UI while a single writer ingests events (WAL mode), provides immediate SQL queryability via `json_extract()` for the metadata column, and has universal tooling support (Datasette for instant web UI, DuckDB for analytical queries via `sqlite_scanner` with zero data migration). A typical day of 6 agent sessions generates <50MB of SQLite data. For archival, export to Parquet monthly.

JSONL is appropriate only as a buffer format (e.g., Claude Code's native session logs). A full OTEL Collector → Jaeger/Tempo stack adds unnecessary infrastructure complexity for a single-developer local setup.

### UI options

For a **TUI dashboard** (recommended for MVP): **Ratatui** (Rust) is the proven choice — Agent of Empires, TmuxCC, and Agent Tmux Monitor all use it, demonstrating it handles this exact domain well. Ratatui uses 30–40% less memory and 15% lower CPU than Bubbletea equivalents. **Textual** (Python) is faster to prototype if Rust is not your primary language, with CSS-like styling and async support. **Bubbletea** (Go) sits in between — the Elm architecture enforces clean state management.

For a **local web UI**: A Bun/Hono server reading from SQLite + htmx for real-time updates provides the lowest complexity. The `claude-code-hooks-multi-agent-observability` project demonstrates this pattern (Bun server → SQLite → WebSocket → Vue client). Next.js is overkill for a single-user local dashboard.

### MVP milestones (two-week plan)

**Week 1 — Core pipeline + CLI (days 1–5)**

Days 1–2: SQLite schema, HTTP ingest endpoint (Bun or Python FastAPI), and Claude Code hook scripts that POST `PostToolUse`, `Stop`, `SessionStart`, and `SessionEnd` events. Validate data flows from a single Claude Code session to SQLite.

Days 3–4: Add Codex CLI OTel ingestion (accept OTLP HTTP on a `/v1/logs` endpoint, parse into the same SQLite schema). Add filesystem watcher (fswatch → debounced file_change events). Add process table poller for session inventory.

Day 5: CLI query tool (`hub status` shows active sessions; `hub trace <session_id>` shows recent tool calls; `hub cost` shows cumulative spend). This provides immediate value even without a UI.

**Week 2 — TUI dashboard + polish (days 6–10)**

Days 6–8: Ratatui or Textual TUI with three panels — session list (left), event timeline (center), detail view (right). Real-time updates via SQLite polling (500ms interval) or Unix socket notifications from the ingest endpoint.

Days 9–10: Add cost aggregation dashboard (per-session, per-model, per-day), tmux integration (`hub attach <session>` to jump to a tmux pane), and git-diff inline display for file_change events.

**Nice-to-haves (week 3+):**
- Planning visibility via Claude Code's `--output-format stream-json` parsed in real time
- MCP server exposing the hub's data so agents can query their own history
- Anomaly alerts (e.g., agent stuck in error loop, cost exceeding threshold)
- DuckDB analytics layer for cross-session trend analysis
- Web UI with Tailscale for mobile monitoring
- Export to Langfuse/Phoenix for richer visualization when needed

---

## Section 6: Executive summary and deliverables

### Executive summary

Local-first observability for AI coding agents is a rapidly emerging category driven by the "parallel coding agent lifestyle" — developers routinely running 2–6+ agents simultaneously across tmux sessions. As of February 2026, both Claude Code and Codex CLI have **built-in OpenTelemetry export** and Claude Code additionally provides a **12-event hooks system** that enables deep instrumentation without wrappers or proxies.

The open-source ecosystem splits into two tiers. **Tracing platforms** (Langfuse at 21.9K stars, Phoenix at 8.5K, OpenLIT at 2.1K) provide rich trace visualization and cost analytics but were designed for production LLM apps, not multi-terminal dev workflows. **Session managers** (Agent of Empires, Claude Squad, TmuxCC, Agent Tmux Monitor) provide real-time multi-agent TUI dashboards but lack persistent tracing and deep analytics. No single tool bridges both tiers.

The **recommended workflow today** pairs Agent of Empires for session management with self-hosted Langfuse for deep tracing, connected via Claude Code hooks and native OTel export. This provides session inventory, state detection, tool-call tracing, cost tracking, and file-change visibility across both Claude Code and Codex CLI sessions on macOS.

For a custom build, the architecture is straightforward: Claude Code hooks + Codex OTel export → HTTP ingest endpoint → SQLite → TUI or web dashboard. A working MVP (CLI + basic TUI) is achievable in one week; a polished dashboard in two. The key design decision is to use **Claude Code hooks as the primary data source** (highest signal, lowest latency, richest context) rather than PTY interception or API proxying, supplemented by OTel for Codex and filesystem watching for git-level awareness.

### Comparison table

| Capability | Langfuse | Phoenix | Agent of Empires | claude-code-hooks-obs | LiteLLM | Custom Hub |
|---|---|---|---|---|---|---|
| Session inventory | ⚠️ Manual | ⚠️ Manual | ✅ Auto-detect | ✅ Via hooks | ❌ | ✅ |
| Agent state | ❌ | ❌ | ✅ Real-time | ✅ Real-time | ❌ | ✅ |
| Tool-call tracing | ✅ Full | ✅ Full | ❌ | ✅ Full | ⚠️ API only | ✅ |
| File/diff tracking | ⚠️ Via events | ⚠️ Via events | ✅ Diff view | ❌ | ❌ | ✅ |
| Planning visibility | ⚠️ If instrumented | ⚠️ If instrumented | ❌ | ❌ | ❌ | ✅ Possible |
| Cost/tokens | ✅ | ✅ | ⚠️ Via hooks | ❌ | ✅ | ✅ |
| Multi-agent support | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| No cloud dependency | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Setup time | 10 min | 3 min | 2 min | 15 min | 5 min | 1–2 weeks |

### Build blueprint

```
┌─────────────────────────────────────────────────────┐
│                    macOS Developer                   │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐  │
│  │Claude CC│ │Claude CC│ │Codex CLI│ │Codex CLI│  │
│  │Session 1│ │Session 2│ │Session 3│ │Session 4│  │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘  │
│       │            │           │            │       │
│  ┌────▼────────────▼───┐ ┌────▼────────────▼───┐  │
│  │  Claude Code Hooks  │ │   OTLP HTTP Export   │  │
│  │  (PostToolUse, Stop,│ │   (codex OTel config)│  │
│  │   SessionStart...)  │ │                      │  │
│  └────────┬────────────┘ └──────────┬───────────┘  │
│           │     ┌───────────┐       │              │
│           │     │ fswatch   │       │              │
│           │     │ (file Δ)  │       │              │
│           │     └─────┬─────┘       │              │
│           ▼           ▼             ▼              │
│  ┌─────────────────────────────────────────────┐   │
│  │         Local Hub (Bun/Python HTTP)         │   │
│  │   POST /events   POST /otel/v1/logs         │   │
│  └──────────────────┬──────────────────────────┘   │
│                     ▼                               │
│  ┌─────────────────────────────────────────────┐   │
│  │              SQLite (WAL mode)               │   │
│  │         events table + indices               │   │
│  └──────────┬──────────────┬───────────────────┘   │
│             ▼              ▼                        │
│  ┌──────────────┐ ┌───────────────┐                │
│  │  TUI (Ratatui│ │  Web UI (htmx │                │
│  │  or Textual) │ │  + Bun serve) │                │
│  └──────────────┘ └───────────────┘                │
└─────────────────────────────────────────────────────┘
```

**Key data flows**: Claude Code hooks fire shell commands that `curl` POST JSON to `localhost:9876/events`. Codex CLI's OTel config sends OTLP HTTP to `localhost:9876/otel/v1/logs`. fswatch monitors working directories and POSTs file-change events. A process poller runs every 2 seconds to update session inventory. The TUI polls SQLite every 500ms for real-time display. Total resource footprint: <100MB RAM, <1% CPU.

### Conclusion

The local AI agent observability space crossed an inflection point in late 2025. Both major coding agents now emit structured telemetry, Claude Code's hooks system provides deep extensibility, and a dozen open-source session managers have appeared. The ecosystem's weakness is fragmentation — tracing tools don't manage sessions, session managers don't persist traces, and neither provides planning visibility. The most impactful near-term build is not another tracing platform but a **thin integration layer** that unifies Claude Code hooks, Codex OTel, filesystem events, and process inventory into a single SQLite-backed event store with a TUI. This fills the gap that neither Langfuse nor Agent of Empires covers alone, while remaining simple enough to ship in two weeks.