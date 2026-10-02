# AGENTS.md

Real-time localhost dashboard and session browser for monitoring AI agent activity across Claude Code and Codex.

## Project Snapshot

- Backend: Node.js + TypeScript + Express + SQLite (`better-sqlite3`).
- Svelte 5 frontend: Vite SPA served at `/app/` — the sole human-facing surface. `/` redirects to `/app/`.
- The legacy static HTML/vanilla-JS dashboard (`public/`) was removed 2026-09-10. Its v1 read endpoints (`GET /api/events|stats|sessions|filter-options`) remain — no product consumer, but the `tests/parity/*` harness and ingestion-readback tests still exercise them.
- Transport: HTTP ingestion + Server-Sent Events for live updates.
- Session ingestion: chokidar file-watcher discovers `~/.claude/projects/**/*.jsonl` automatically.
- Default bind: `127.0.0.1:3141`.
- Operator origin: `amon serve` exposes `https://agentmonitor.localhost` through
  pinned Portless while hooks and OTEL keep using the direct bind.

## Documentation Map

Source, tests, `amon --help`, and live GitHub settings are authoritative for exact
routes, response types, flags, configuration parsing, schema details, and remote
repository settings. The tracked references below preserve the intent, boundaries,
and procedures that those executable surfaces do not explain on their own.

- `docs/system/ARCHITECTURE.md` — system topology, data ownership, critical invariants, and recovery relationships.
- `docs/system/FEATURES.md` — user-visible behavior plus fidelity, coverage, privacy, and human-review boundaries.
- `docs/system/OPERATIONS.md` — local setup, runtime operation, integrations, backup/recovery, and verification workflows.
- `docs/system/DESIGN.md` — Svelte `/app/` design system ("Instrument Console"): color/type/space/radius tokens, layout language, accessibility floor. Tokens live in `frontend/src/app.css` `@theme`.
- `docs/system/trace-quality.md` — lean local trace/observation projection, coverage and payload-policy honesty, aggregate warehouse export, and deferred Langfuse depth.
- `docs/api/` — API ownership and externally consumed ingest semantics; exact routes remain source-owned.
- `docs/project/VISION.md` — product purpose, the monitoring/observability/analytics baseline, guiding principles, and possible future role in a broader AgentOps platform.
- `docs/project/ROADMAP.md` — selected direction and milestones needed to explain it.
- `docs/project/DECISIONS.md` — durable decisions that are no longer active
  follow-ups.
- `docs/project/BACKLOG.md` — future-only work with evidence and revisit triggers.
- `docs/project/GIT_HISTORY_POLICY.md` — intended merge/history policy, current verification method, and rationale.
- `frontend/AGENTS.md` — domain-specific guidance.
- `hooks/claude-code/README.md`, `hooks/codex/README.md` — hook setup details.

## Command Quickstart

```bash
pnpm install
pnpm dev          # terminal 1: server in watch mode
pnpm frontend:dev # terminal 2: Svelte at :5173 with API proxy

pnpm build
pnpm link --global
amon serve        # compiled app at https://agentmonitor.localhost
```

Full command catalog (build, test, parity, import, reparse, seed, bench) is in `docs/system/OPERATIONS.md`.

## Implementation Guardrails

- Keep TypeScript ESM import style consistent (existing `.js` extension pattern in TS imports).
- Keep v1 SQL in `src/db/queries.ts`, v2 SQL in `src/db/v2-queries.ts`. Keep v2 route handlers in `src/api/v2/router.ts`.
- Prefer extending the Svelte `/app/` product path and v2 contracts; do not add new behavior to the v1 read endpoints (they are retained only for ingestion clients, SSE, provider quotas, and the parity test harness).
- Keep Portless at the human-facing `amon serve` boundary. Do not route hook or
  OTEL ingestion away from the fixed `127.0.0.1:3141` backend.
- If a public API response shape changes, update the owning contract or reference
  when its statement changes; route exact shapes through source and tests.
- **`performance.now()` vs `Date.now()`**: Never mix these in deadline calculations. `performance.now()` returns monotonic ms from process start; `Date.now()` returns epoch ms (~1.7 trillion). Mixing them produces instant timeouts.
- **Codex OTEL drop-out**: if Codex terminal activity is visible but `source=otel` stops updating, verify Codex is exporting OTLP to `127.0.0.1:3141` and not a stale endpoint (e.g. an old `:3142` runtime config).
- **Provider quotas**: Monitor header uses provider-native snapshots only. Codex from local `codex app-server`; Claude requires the statusline bridge or renders as unavailable rather than estimated.
- **Every gate reads `src/`; only the built server reads `dist/`**: `pnpm test` (tsx), `pnpm dev` (tsx) and `pnpm lint` all run from source. `amon serve` — how the tool is actually used — loads `dist/`. So a bug in what the build *emits* passes lint, build, and test simultaneously. This shipped stale pricing tables for five months (`cp -r` nesting into `dist/pricing/data/data/`), and an unpriced model bills as **$0 rather than raising**, so the dashboard stayed plausible while under-reporting the top models. `scripts/check-pricing-dist.mjs` guards that one case; the class is wider — any non-TS asset the build copies has this shape. If a bug reproduces for the user but not in tests, check whether they run the built path while you are testing `src/`. A rebuild is not live until the server restarts: `/api/health` `build.stale` (and the app's **Restart needed** notice) says when the running server is older than `dist/`.

## Testing

- **Pre-push** (matches required CI): `pnpm lint`, `pnpm build`, `pnpm test`. If Svelte/frontend TS touched, also run `pnpm frontend:check` (svelte-check) and `pnpm frontend:test` (Vitest — unit tests for the `/app/` stores + pure logic, in the `frontend/` workspace; `svelte-check` only type-checks, it never runs the rune code).
- **TDD**: red/green for new features, major refactors, and large changes. The red step must fail for the behavior you're about to fix, not merely because a symbol is missing — write the signature first, then a test that fails on the behavior (see "Never trust a test you haven't watched fail" below). Skip the red step for code with no behavior to assert, and cover it after. For smaller edits, still run the relevant existing tests before wrapping up.
- **E2E**: `pnpm exec playwright test`.
- **Investigating the installed store**: before writing an ad hoc script against the real database, use the verification probes (`pnpm build`, then `pnpm --silent verify probe <name> --json`; see `docs/system/OPERATIONS.md` → Probing the installed service). They read safely (read-only connection, deadline-killed child, snapshots for anything that writes) and record evidence: `health`, `ingestion`, `monitor-stats`, `hotspots` (slowest reads behind the routes), `plans` (an index's effect), `index-audit` (which events indexes statements still need), `reclaim` (what compaction would free), `resync`. When an investigation needs a script the probes lack, add it as a probe.
- **Sanity**: `GET /api/health`.
- **Never trust a test you haven't watched fail.** Before claiming a test or CI guard covers a bug, reintroduce the bug and confirm it goes red. The failures worth guarding here are the silent ones — wrong costs, two chart series sharing a color, a test reading the real DB — and they all still render a plausible-looking result, so green on fixed code proves nothing on its own. A Top Models color test once passed against the broken implementation because the fixture had 6 models and the palette has 6 colors.
- **Tests cannot open the install database**: `getDb()` throws under the test runner if the resolved path is `<install-root>/data/agentmonitor.db`. Point `AGENTMONITOR_DB_PATH` at a temp file *before* importing anything that reads `config` — `config.ts` snapshots the env when it is imported, so an early import silently pins the default. Destructive fixtures must also assert that the opened database handle resolves to their intended temp path immediately before any table-wide delete.
- **Session-browser recovery is separate from event import**: `import_state`
  protects `events`, while `watched_files` protects
  `browsing_sessions`/`messages`/`tool_calls`. If those browser tables are lost
  but `watched_files` survives, normal startup skips unchanged JSONLs and leaves
  analytics plausibly sparse. Startup warns when a currently discoverable
  Claude/Codex file is cached as parsed but has no browser projection. Preserve
  the DB first, then run
  `amon sync sessions --source all --force`; `amon import --force` alone does not
  rebuild tool-call or inferred-skill history.

## Working Agreement

- **Push back before building.** If a request is incoherent or self-contradictory, or a spec/plan is vague or skips key decisions, stop and interview me — ask clarifying questions and confirm intent before writing code or changing files. Don't guess at scope or comply silently. (Clear, well-scoped requests don't need this.)
- **Keep docs current.** Update the owning reference when a change alters its stated behavior, procedure, contract, or direction. Reconcile an affected Backlog entry as work lands; update Roadmap when selected direction changes.
- **Commit logically.** Commit completed work in coherent chunks as you proceed. Push only when explicitly asked.
- **Log durable follow-ups in `BACKLOG.md`.** Fix simple issues inline. For durable work, record What, Why or evidence, and a Next action or Revisit trigger; date volatile claims or mark them as hypotheses. Agents may execute entries directly. Use issues when discussion or coordination helps, keep one detailed owner, and reconcile affected entries as work lands.
- **Re-ground after compaction.** A compaction summary loses precise paths, context, and verification state — before continuing, re-read this project's `AGENTS.md`, its reference docs, and recent commits.
