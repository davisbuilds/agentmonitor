---
date: 2026-06-15
topic: amon-cli
stage: spec
status: implemented-with-followups
source: conversation
---

# Amon CLI Spec

## Goal

Deliver first-class `amon` and `agentmonitor` executables for AgentMonitor that consolidate local runtime, import/sync, session browsing, usage, analytics, trace-quality, and hook helper workflows behind a consistent, scriptable CLI.

## Implementation Status

PR #31 implements the first-pass CLI on branch `feature/amon-cli`.

| Area | Current state |
| --- | --- |
| Executables | Implemented. `package.json` exposes `amon` and `agentmonitor`, both targeting `./dist/cli.js`. |
| Packaging | Implemented. `prepack` builds the package, `.npmignore` keeps `dist/` packable, and the build chmods `dist/cli.js` executable. |
| Runtime | Implemented. `src/runtime.ts` owns shared TypeScript runtime startup; `src/server.ts` and `amon serve` share that runtime. |
| Maintenance commands | Implemented. Import, sync, cost recalculation, and trace-quality backfill have CLI commands; old scripts are compatibility wrappers. |
| Session/live/reporting reads | Implemented. Session, pin, live, usage, analytics, and quality read commands exist with human and JSON output where planned. |
| Hook helpers | Implemented. Codex config printing and Claude hook install dry-run/force behavior exist. |
| Review follow-up | Implemented. `amon live watch` now buffers split SSE lines before parsing `data:` records. |
| Verification | Last verified with `pnpm lint`, `pnpm build`, and `pnpm test` (`541` passing tests), plus focused CLI tests. |

Known implementation divergences from the original draft:

- The CLI uses a local parser in `src/cli/args.ts` instead of `node:util` `parseArgs`. Behavior is covered, but the implementation mechanism differs.
- Dedicated test filenames from the draft were consolidated into `tests/cli-core.test.ts` and `tests/cli-commands.test.ts`.
- `live watch --kinds` is parsed but not applied to the SSE stream yet. `live items --kinds` does filter.
- `--no-color`, `NO_COLOR`, and `TERM=dumb` are effectively inert because current CLI output does not emit color.
- `serve --no-browser` is accepted but currently a no-op because `serve` does not open a browser.
- Broad maintenance commands produce summaries, but they do not yet emit rich progress diagnostics to stderr.
- Built executable and npm-pack checks were manually verified; the repo does not yet have a committed automated built-artifact E2E test.

Recommended next implementation order:

1. Task 10: Built-artifact and packaged CLI E2E tests. This protects the central promise of the PR: `amon` and `agentmonitor` are real executables.
2. Task 11: Runtime command integration tests. Runtime startup and health behavior have the broadest blast radius and are easiest to regress accidentally.
3. Task 9: `live watch --kinds`. This is a small user-visible correctness fix for an advertised flag.
4. Task 12: Reporting and maintenance contract tests. This hardens script-facing JSON and dry-run behavior after the executable/runtime paths are protected.

## Scope

### In Scope

- Add npm package executables named `amon` and `agentmonitor` that both run from the built package.
- Add a TypeScript CLI entrypoint and command modules that do not import `src/server.ts` for one-shot commands.
- Refactor server startup into reusable runtime code so `amon serve` and the existing `pnpm start` path share behavior.
- Replace the current hand-rolled maintenance script UX with equivalent `amon` commands while keeping existing `pnpm` scripts as compatibility shims.
- Implement human output plus stable `--json` output for read commands.
- Support the following command tree in the first pass:

```text
amon serve
amon open
amon status
amon health

amon import
amon sync sessions
amon costs recalc

amon sessions list
amon sessions show <id>
amon sessions messages <id>
amon sessions search <query>
amon pins list

amon live sessions
amon live items <id>
amon live watch [id]

amon usage summary
amon usage daily
amon usage models
amon usage projects
amon usage statusline
amon usage budgets
amon usage tier-feedback

amon analytics summary
amon analytics tools
amon analytics top-sessions

amon quality backfill
amon quality traces
amon quality findings
amon quality scores

amon hooks install claude
amon hooks print-codex-config
```

### Out of Scope

- PostgreSQL, DuckDB, Quack, or shared team backends.
- Self-update or installer logic.
- Rust-native CLI parity. Rust remains an alternate runtime and keeps its current `pnpm rust:*` commands.
- Full terminal TUI mode.
- Deleting/pruning sessions or other destructive data commands.
- Replacing benchmark and seed workflows; keep those as developer `pnpm` scripts for now.

## Assumptions And Constraints

- The package name remains `agentmonitor`; both `amon` and `agentmonitor` are executable aliases for the same CLI.
- Node 24 is available. The implemented CLI uses a small local parser rather than adding a parsing dependency.
- Configuration remains env-first. CLI flags override process env for the current invocation; no new persistent config file is introduced.
- One-shot commands must import shared services and query modules directly, not `src/server.ts`, because `src/server.ts` currently starts the HTTP server, watcher, quota polling, stats broadcast, and auto-import timers.
- `amon serve` must preserve the existing default bind behavior: `127.0.0.1:3141`.
- Primary command output goes to stdout. Progress, warnings, diagnostics, and errors go to stderr.
- `--json` output is a stable machine contract. Human output can evolve.
- `--dry-run` must be available for import, session sync, trace-quality backfill, and cost recalculation.
- Existing `pnpm` scripts stay working so docs, CI, and muscle memory do not break during the transition.
- The CLI should prefer the canonical Svelte `/app/` and `/api/v2/*` product contract, not legacy `/` behavior.

### CLI Contract

Global flags:

| Flag | Type | Default | Behavior |
| --- | --- | --- | --- |
| `-h, --help` | boolean | false | Print command help and ignore other flags. |
| `--version` | boolean | false | Print package version to stdout. |
| `--db-path <path>` | string | `AGENTMONITOR_DB_PATH` or `./data/agentmonitor.db` | Override SQLite DB path for this process. |
| `--url <url>` | string | `http://127.0.0.1:${AGENTMONITOR_PORT:-3141}` | HTTP target for health/open/watch commands. |
| `--json` | boolean | false | Emit structured JSON to stdout. |
| `--plain` | boolean | false | Emit stable line-oriented text where supported. |
| `-q, --quiet` | boolean | false | Suppress non-essential human success text. |
| `-v, --verbose` | boolean | false | Emit extra diagnostics to stderr. |
| `--no-color` | boolean | false | Parsed today. Meaningful enforcement is deferred until CLI output emits ANSI color. |
| `--no-input` | boolean | false | Never prompt; fail if required confirmation or input is missing. |

Command-specific flags:

| Command | Flags |
| --- | --- |
| `serve` | `--host`, `--port`, `--no-browser`, `--no-import`, `--no-watch` |
| `import` | `--source claude-code|codex|all`, `--from`, `--to`, `--dry-run`, `--force`, `--claude-dir`, `--codex-dir` |
| `sync sessions` | `--source claude|codex|all`, `--dry-run`, `--force`, `--claude-dir`, `--codex-home` |
| `sessions list` | `--project`, `--agent`, `--date-from`, `--date-to`, `--min-messages`, `--max-messages`, `--exclude-empty`, `--limit`, `--cursor` |
| `sessions messages` | `--offset`, `--limit`, `--around-ordinal` |
| `sessions search` | `--sort recent|relevance`, `--project`, `--agent`, `--limit` |
| `live sessions` | `--project`, `--agent`, `--status`, `--fidelity`, `--active-only`, `--limit`, `--cursor` |
| `live items` | `--limit`, `--cursor`, `--kinds` |
| `live watch` | `--since-now`; `--kinds` is parsed but filtering is deferred |
| `usage *` | `--date-from`, `--date-to`, `--project`, `--agent`, plus `--model`, `--provider`, `--tier` where usage endpoints support them |
| `analytics *` | `--date-from`, `--date-to`, `--project`, `--agent` |
| `quality *` | `--date-from`, `--date-to`, `--project`, `--agent`, plus command-specific filters from `/api/v2/trace-quality/*` |

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Runtime failure. |
| `2` | Invalid usage or validation failure. |
| `3` | HTTP server unavailable for commands that require it. |
| `4` | Requested resource not found. |
| `5` | Partial success, such as sync/import completed with file-level errors. |

Example invocations:

```bash
amon serve
amon open
amon import --source codex --dry-run
amon sync sessions --source all --force
amon sessions list --agent codex --exclude-empty --json
amon sessions messages abc123 --around-ordinal 80 --limit 40
amon sessions search "rate limit" --sort relevance --json
amon usage daily --date-from 2026-06-01 --json
amon usage statusline
amon quality findings --severity high --json
amon hooks print-codex-config
```

## Task Breakdown

### Task 1: Package Executable And CLI Skeleton

**Objective**

Expose `amon` and `agentmonitor` as package executables and add a tested CLI dispatcher with root help, version, global flag parsing, stdout/stderr conventions, and exit code handling.

**Files**

- Create: `src/cli.ts`
- Create: `src/cli/args.ts`
- Create: `src/cli/commands.ts`
- Create: `src/cli/errors.ts`
- Create: `src/cli/help.ts`
- Create: `src/cli/output.ts`
- Create: `tests/cli-core.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Dependencies**

None

**Implementation Steps**

1. Add a `#!/usr/bin/env node` shebang to `src/cli.ts`.
2. Add `bin: { "amon": "./dist/cli.js", "agentmonitor": "./dist/cli.js" }` to `package.json`.
3. Use `node:util` `parseArgs` in `src/cli/args.ts` to parse root global flags and dispatch to command handlers.
4. Read package version from package metadata for `--version`.
5. Implement root help that groups commands by runtime, data, sessions, live, reporting, quality, hooks, and meta.
6. Implement typed CLI errors in `src/cli/errors.ts` with exit code mapping.
7. Ensure errors render concise messages without stack traces unless `--verbose` is set.
8. Ensure TypeScript build preserves the shebang in `dist/cli.js`.

**Verification**

- Run: `pnpm build`
- Expect: `dist/cli.js` exists and starts with `#!/usr/bin/env node`.
- Run: `node dist/cli.js --version`
- Expect: prints `0.5.0` or the current package version to stdout and exits `0`.
- Run: `node dist/cli.js --help`
- Expect: prints root usage with `amon` command examples and exits `0`.
- Run: `node dist/cli.js nope`
- Expect: prints a concise unknown-command error to stderr and exits `2`.
- Run: `pnpm test -- tests/cli-core.test.ts`
- Expect: CLI parser and error mapping tests pass.

**Done When**

- `amon` and `agentmonitor` are declared as package executables.
- Root help and version work from the built artifact.
- Unknown commands and invalid flags exit with code `2`.
- No one-shot CLI command imports `src/server.ts`.

### Task 2: Shared Runtime Host And Runtime Commands

**Objective**

Refactor server startup into reusable runtime code and implement `amon serve`, `amon health`, `amon status`, and `amon open`.

**Files**

- Create: `src/runtime.ts`
- Create: `src/cli/commands/runtime.ts`
- Create: `tests/cli-runtime.test.ts`
- Modify: `src/server.ts`
- Modify: `src/config.ts`
- Modify: `src/app.ts`

**Dependencies**

Task 1

**Implementation Steps**

1. Move current `src/server.ts` startup behavior into `startAgentMonitorRuntime(options)` in `src/runtime.ts`.
2. Keep `src/server.ts` as a thin entrypoint that calls `startAgentMonitorRuntime({ mode: 'server' })`.
3. Add CLI overrides for host, port, DB path, no browser, no import, and no watch without introducing persistent config files.
4. Implement `amon serve` using the shared runtime and existing graceful shutdown behavior.
5. Implement `amon health` by calling `${--url}/api/health` with a short timeout.
6. Implement `amon status` with a human summary: configured DB path, DB existence, server health when reachable, and app URL.
7. Implement `amon open` by opening `${--url}/app/` with platform-specific commands: `open` on macOS, `xdg-open` on Linux, and `cmd /c start` on Windows.
8. Keep stdout reserved for the primary URL/status payload and diagnostics on stderr.

**Verification**

- Run: `pnpm build`
- Expect: build passes and `node dist/server.js` still starts the server.
- Run: `AGENTMONITOR_PORT=3999 node dist/cli.js serve --no-browser --no-import --no-watch`
- Expect: server prints a listening URL and responds at `http://127.0.0.1:3999/api/health`.
- Run: `node dist/cli.js health --url http://127.0.0.1:3999 --json`
- Expect: JSON health payload and exit `0`.
- Run: `node dist/cli.js health --url http://127.0.0.1:1`
- Expect: concise unavailable message and exit `3`.
- Run: `pnpm test -- tests/cli-runtime.test.ts`
- Expect: runtime command tests pass without leaving a running server.

**Done When**

- Existing server startup behavior is preserved.
- `amon serve` is the preferred executable entrypoint for local runtime startup.
- `amon health` distinguishes invalid usage, unavailable server, and healthy server.
- `amon open` opens `/app/`, not the legacy `/` dashboard.

### Task 3: Maintenance Commands

**Objective**

Move historical import, session sync/reparse, cost recalculation, and trace-quality backfill workflows behind `amon` commands while preserving existing `pnpm` scripts as shims.

**Files**

- Create: `src/cli/commands/import.ts`
- Create: `src/cli/commands/sync.ts`
- Create: `src/cli/commands/costs.ts`
- Create: `src/cli/commands/quality-backfill.ts`
- Create: `tests/cli-maintenance.test.ts`
- Modify: `scripts/import.ts`
- Modify: `scripts/reparse-sessions.ts`
- Modify: `scripts/reparse-codex-sessions.ts`
- Modify: `scripts/recalculate-costs.ts`
- Modify: `scripts/backfill-trace-quality.ts`
- Modify: `src/watcher/index.ts`
- Modify: `src/import/index.ts`
- Modify: `package.json`

**Dependencies**

Tasks 1 and 2

**Implementation Steps**

1. Implement `amon import` by wrapping `runImport` with the current `--source`, `--from`, `--to`, `--dry-run`, and `--force` semantics.
2. Add `--claude-dir` and `--codex-dir` import overrides to the CLI and pass them through to `runImport`.
3. Implement `amon sync sessions` for Claude, Codex, or both. Use existing watcher sync functions and add/export discovery helpers needed for `--dry-run`.
4. Implement `amon costs recalc` with the same cost recalculation behavior as `scripts/recalculate-costs.ts`, including `--dry-run`.
5. Implement `amon quality backfill` with the same options as `scripts/backfill-trace-quality.ts`.
6. Make existing scripts call into the new command modules or shared service functions so behavior stays single-sourced.
7. For long-running or broad operations, print progress to stderr and summary data to stdout.
8. Return exit `5` when a maintenance command completes with file-level errors.

**Verification**

- Run: `node --import tsx src/cli.ts import --source all --dry-run --json`
- Expect: JSON summary with file and event counts; no DB writes.
- Run: `node --import tsx src/cli.ts sync sessions --source all --dry-run --json`
- Expect: JSON preview with discovered Claude/Codex file counts; no `watched_files` writes.
- Run: `node --import tsx src/cli.ts costs recalc --dry-run --json`
- Expect: JSON summary with updated/unchanged/unknown-model counts.
- Run: `node --import tsx src/cli.ts quality backfill --dry-run --json`
- Expect: JSON summary matching trace-quality backfill fields.
- Run: `pnpm run import -- --dry-run`
- Expect: compatibility script still works and delegates to the same behavior.
- Run: `pnpm test -- tests/cli-maintenance.test.ts`
- Expect: maintenance command tests pass with temp DB fixtures.

**Done When**

- Current maintenance workflows have `amon` equivalents.
- Existing `pnpm` scripts remain operational.
- Dry-run commands are side-effect free.
- JSON summaries are stable and suitable for automation.

### Task 4: Session, Pin, Live, And Search Commands

**Objective**

Expose the most common session browser and live inspection workflows from the CLI using the canonical v2 data/query model.

**Files**

- Create: `src/cli/commands/sessions.ts`
- Create: `src/cli/commands/pins.ts`
- Create: `src/cli/commands/live.ts`
- Create: `src/cli/formatters/sessions.ts`
- Create: `src/cli/formatters/live.ts`
- Create: `tests/cli-sessions-live.test.ts`
- Modify: `src/db/v2-queries.ts`
- Modify: `src/api/v2/types.ts`

**Dependencies**

Tasks 1 and 3

**Implementation Steps**

1. Implement `amon sessions list` on top of `listBrowsingSessions`.
2. Implement `amon sessions show <id>` on top of `getBrowsingSession` and return exit `4` for missing sessions.
3. Implement `amon sessions messages <id>` on top of `getSessionMessages`.
4. Implement `amon sessions search <query>` on top of `searchMessages`.
5. Implement `amon pins list` on top of `listPinnedMessages`.
6. Implement `amon live sessions` and `amon live items <id>` on top of live query helpers.
7. Implement `amon live watch [id]` as an HTTP SSE consumer against `/api/v2/live/stream`; require a reachable server and return exit `3` when unavailable.
8. Add terminal sanitization for all human-rendered session/message/live content.
9. Keep large message output bounded by `--limit`; do not stream entire transcripts by default.

**Verification**

- Run: `node --import tsx src/cli.ts sessions list --limit 5 --json`
- Expect: JSON object with `data`, `total`, and optional `cursor`.
- Run: `node --import tsx src/cli.ts sessions show does-not-exist`
- Expect: not-found message and exit `4`.
- Run: `node --import tsx src/cli.ts sessions search test --limit 5 --json`
- Expect: JSON search response or empty result without error.
- Run: `node --import tsx src/cli.ts live sessions --active-only --json`
- Expect: JSON live session list.
- Run: `node --import tsx src/cli.ts live watch --url http://127.0.0.1:1`
- Expect: unavailable message and exit `3`.
- Run: `pnpm test -- tests/cli-sessions-live.test.ts`
- Expect: session/live command tests pass.

**Done When**

- CLI session reads use the same data semantics as `/api/v2/sessions`.
- Missing resources have deterministic exit `4`.
- Human output is compact and terminal-safe.
- SSE watch behavior is explicit about requiring a running server.

### Task 5: Usage, Analytics, And Quality Read Commands

**Objective**

Expose reporting workflows from the CLI for usage, analytics, and trace-quality reads with shared filters and stable JSON output.

**Files**

- Create: `src/cli/commands/usage.ts`
- Create: `src/cli/commands/analytics.ts`
- Create: `src/cli/commands/quality.ts`
- Create: `src/cli/formatters/usage.ts`
- Create: `src/cli/formatters/analytics.ts`
- Create: `src/cli/formatters/quality.ts`
- Create: `tests/cli-reporting.test.ts`
- Modify: `src/db/v2-queries.ts`
- Modify: `src/trace-quality/queries.ts`
- Modify: `src/trace-quality/findings.ts`
- Modify: `src/usage/budgets.ts`
- Modify: `src/usage/tier-feedback.ts`

**Dependencies**

Tasks 1 and 3

**Implementation Steps**

1. Add a shared filter parser for `--date-from`, `--date-to`, `--project`, `--agent`, `--model`, `--provider`, and `--tier`.
2. Implement `usage summary`, `usage daily`, `usage models`, `usage projects`, `usage statusline`, `usage budgets`, and `usage tier-feedback`.
3. Implement `analytics summary`, `analytics tools`, and `analytics top-sessions`.
4. Implement `quality traces`, `quality findings`, and `quality scores`.
5. Include coverage metadata in JSON output exactly as query helpers return it.
6. Keep `usage statusline` one-line and human-first; support `--plain` for stable status bar text.
7. Ensure unknown or unsupported filters fail with exit `2`, not silent no-ops.

**Verification**

- Run: `node --import tsx src/cli.ts usage summary --json`
- Expect: JSON usage summary with coverage metadata when applicable.
- Run: `node --import tsx src/cli.ts usage daily --date-from 2026-06-01 --json`
- Expect: JSON daily data and coverage object.
- Run: `node --import tsx src/cli.ts usage statusline --plain`
- Expect: one line suitable for shell prompts.
- Run: `node --import tsx src/cli.ts analytics tools --json`
- Expect: JSON data and coverage object.
- Run: `node --import tsx src/cli.ts quality findings --severity high --json`
- Expect: JSON findings response, possibly empty.
- Run: `pnpm test -- tests/cli-reporting.test.ts`
- Expect: reporting command tests pass.

**Done When**

- Reporting commands cover the high-value app panels from the terminal.
- JSON output preserves coverage honesty from the existing query layer.
- Human output is concise enough for repeated operator use.
- Invalid filters fail early with actionable errors.

### Task 6: Hook Helper Commands

**Objective**

Make integration setup discoverable through `amon hooks` without hiding what will be changed.

**Files**

- Create: `src/cli/commands/hooks.ts`
- Create: `tests/cli-hooks.test.ts`
- Modify: `hooks/claude-code/install.sh`
- Modify: `hooks/claude-code/README.md`
- Modify: `hooks/codex/README.md`

**Dependencies**

Task 1

**Implementation Steps**

1. Implement `amon hooks print-codex-config` to print the TOML snippet for Codex OTEL setup using the effective `--url`.
2. Implement `amon hooks install claude` as a wrapper around `hooks/claude-code/install.sh`.
3. Support `--dry-run` for Claude hook install by printing the command and target files without changing them.
4. Require confirmation for Claude hook install when stdin is a TTY; require `--force` or fail under `--no-input`.
5. Do not accept secrets through CLI flags.
6. Update hook docs to mention the new commands while keeping manual setup instructions.

**Verification**

- Run: `node --import tsx src/cli.ts hooks print-codex-config --url http://127.0.0.1:3141`
- Expect: TOML snippet points to `http://127.0.0.1:3141/api/otel/v1/logs`.
- Run: `node --import tsx src/cli.ts hooks install claude --dry-run --no-input`
- Expect: preview output and no file modifications.
- Run: `node --import tsx src/cli.ts hooks install claude --no-input`
- Expect: exits `2` with a message requiring `--force`.
- Run: `pnpm test -- tests/cli-hooks.test.ts`
- Expect: hook helper tests pass.

**Done When**

- Codex setup can be copied from CLI output.
- Claude hook installation has safe dry-run and non-interactive behavior.
- Existing manual hook docs remain complete.

### Task 7: Documentation, Compatibility Scripts, And Release Notes

**Objective**

Document `amon` as the official CLI entrypoint, keep existing commands discoverable, and update project reference docs.

**Files**

- Modify: `README.md`
- Modify: `docs/system/OPERATIONS.md`
- Modify: `docs/system/FEATURES.md`
- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `docs/project/CURRENT_STATE.md`
- Modify: `docs/project/ROADMAP.md`
- Modify: `package.json`

**Dependencies**

Tasks 1 through 6

**Implementation Steps**

1. Add quick-start examples using `amon serve`, `amon open`, and `amon health`.
2. Add an `AgentMonitor CLI` section to operations docs with command groups, output contracts, and environment precedence.
3. Update the common command catalog to show `amon` equivalents next to compatibility `pnpm` scripts.
4. Update architecture docs to mention the CLI as an operator surface over the TS runtime and v2 data/query layer.
5. Update current-state and roadmap docs so future work understands `amon` is the preferred local operator command.
6. Keep benchmark, seed, parity, and Rust commands documented as `pnpm` workflows.
7. Add package scripts for local development convenience if useful, for example `pnpm cli -- --help`, without making them the official user-facing surface.

**Verification**

- Run: `rg -n "amon|agentmonitor cli|pnpm run import|reparse:sessions" README.md docs/system docs/project package.json`
- Expect: docs mention `amon` and retain compatibility command references where appropriate.
- Run: `pnpm lint`
- Expect: lint passes.
- Run: `pnpm build`
- Expect: docs changes do not affect build; CLI still builds.

**Done When**

- The docs identify `amon` as the official executable.
- Existing `pnpm` compatibility workflows remain discoverable.
- Reference docs match shipped CLI behavior.

### Task 8: End-To-End Verification And Regression Coverage

**Objective**

Verify the completed CLI against the same gates expected for TypeScript/frontend-adjacent changes and add focused regression coverage for executable packaging.

**Files**

- Create: `tests/cli-e2e.test.ts`
- Modify: `tests/codebase/dead-code.test.ts`
- Modify: `package.json`

**Dependencies**

Tasks 1 through 7

**Implementation Steps**

1. Add an end-to-end CLI test that builds the package and invokes `node dist/cli.js --help`.
2. Add a packaging assertion that `package.json` exposes `bin.amon`.
3. Add a smoke test for JSON output from a direct DB read command against a temp DB.
4. Add a smoke test for an HTTP-backed failure path, such as `health --url http://127.0.0.1:1`.
5. Ensure dead-code tests know about the CLI entrypoint and command modules.
6. Run the full required pre-push suite.

**Verification**

- Run: `pnpm lint`
- Expect: no lint errors.
- Run: `pnpm build`
- Expect: `dist/cli.js` and `dist/server.js` build successfully.
- Run: `pnpm test`
- Expect: full self-contained TypeScript test suite passes.
- Run: `node dist/cli.js --help`
- Expect: root CLI help prints and exits `0`.
- Run: `node dist/cli.js health --url http://127.0.0.1:1`
- Expect: unavailable message and exit `3`.

**Done When**

- The complete required TS gate passes: `pnpm lint`, `pnpm build`, `pnpm test`.
- Executable packaging is covered by tests.
- Failure modes have deterministic exit codes.

### Task 9: Apply `live watch --kinds`

**Objective**

Make the advertised `amon live watch --kinds <csv>` flag meaningful so watch output can be narrowed to relevant live item kinds without post-processing.

**Files**

- Modify: `src/cli/commands/sessions-live.ts`
- Modify: `tests/cli-commands.test.ts`
- Modify: `docs/system/OPERATIONS.md`

**Dependencies**

Tasks 1 and 4

**Implementation Steps**

1. Parse `--kinds` for `live watch` into a normalized string array.
2. Keep `/api/v2/live/stream` compatibility by applying the filter client-side first.
3. For each SSE `data:` payload, parse the JSON event safely.
4. Treat event payload kind fields as the match target: `payload.kind`, `payload.item.kind`, or another explicit live item kind field if the event shape evolves.
5. Always allow connection/control events that do not represent live items only if they are needed for operator context; otherwise suppress them when `--kinds` is set.
6. Keep malformed `data:` lines visible rather than crashing, because this command is an operator stream.
7. Update help/docs to show `live watch --kinds message,tool_call`.

**Verification**

- Run: `node --import tsx --test tests/cli-commands.test.ts`
- Expect: live watch tests cover chunk-split SSE lines and kind filtering.
- Run: `pnpm lint`
- Expect: no lint errors.
- Run: `pnpm build`
- Expect: CLI builds.

**Done When**

- `amon live watch --kinds message,tool_call` suppresses unmatched live item events.
- Split SSE line buffering still works.
- Unavailable-server behavior still returns exit `3`.

### Task 10: Add Built-Artifact And Packaged CLI E2E Tests

**Objective**

Move the manual executable and npm pack smoke checks into committed tests so future packaging changes cannot silently break `amon` or `agentmonitor`.

**Files**

- Create: `tests/cli-e2e.test.ts`
- Modify: `package.json`
- Modify: `tests/codebase/dead-code.test.ts` if needed

**Dependencies**

Tasks 1 and 8

**Implementation Steps**

1. Add a Node test that assumes `pnpm build` has run and invokes `./dist/cli.js --help`.
2. Assert `dist/cli.js` starts with `#!/usr/bin/env node`.
3. Assert `dist/cli.js` is executable on POSIX platforms.
4. Add a dry-run pack check that verifies `dist/cli.js` is included and has executable mode.
5. Assert both package aliases still point to `./dist/cli.js`.
6. Keep the test skipped or diagnostic when `dist/` is absent, unless it is wired into a build-first script.
7. Add a package script such as `test:cli-e2e` if running it inside normal `pnpm test` would make the suite order-dependent.

**Verification**

- Run: `pnpm build`
- Expect: build succeeds and `dist/cli.js` exists.
- Run: `node --test tests/cli-e2e.test.ts`
- Expect: built CLI and pack checks pass.
- Run: `pnpm lint`
- Expect: no lint errors.

**Done When**

- The executable packaging checks from PR #31 are automated.
- `amon` and `agentmonitor` alias regressions fail tests.
- The test command is documented in `docs/system/OPERATIONS.md` if it is not part of `pnpm test`.

### Task 11: Add Runtime Command Integration Tests

**Objective**

Cover the highest-risk runtime CLI paths with tests that prove `serve`, `health`, `status`, and unavailable-server behavior keep working as the runtime evolves.

**Files**

- Create: `tests/cli-runtime.test.ts`
- Modify: `src/runtime.ts` if test hooks are needed
- Modify: `src/cli/commands/runtime.ts` if command seams need tightening

**Dependencies**

Tasks 1, 2, and 10

**Implementation Steps**

1. Start `amon serve --no-import --no-watch` on an ephemeral or test-selected port from a child process.
2. Wait for `/api/health` to respond before assertions.
3. Assert `amon health --url <test-url> --json` returns a health payload and exit `0`.
4. Assert `amon status --url <test-url> --json` reports `server_reachable: true`.
5. Assert `amon health --url http://127.0.0.1:1` exits `3`.
6. Ensure the child process is always terminated and no timers or watcher processes are left running.
7. Keep the test isolated with a temporary `AGENTMONITOR_DB_PATH`.

**Verification**

- Run: `node --import tsx --test tests/cli-runtime.test.ts`
- Expect: runtime CLI tests pass and leave no running server.
- Run: `pnpm test`
- Expect: full suite remains stable if the test is included in the default suite.

**Done When**

- Runtime command coverage is automated.
- Server-unavailable exit behavior is covered.
- Test cleanup is deterministic on success and failure.

### Task 12: Expand Reporting And Maintenance Contract Tests

**Objective**

Strengthen confidence in JSON contracts and dry-run side-effect guarantees for the commands most likely to be used by scripts.

**Files**

- Create or extend: `tests/cli-commands.test.ts`
- Optionally create: `tests/cli-maintenance.test.ts`
- Optionally create: `tests/cli-reporting.test.ts`

**Dependencies**

Tasks 3 and 5

**Implementation Steps**

1. Add JSON-shape tests for `usage daily`, `usage models`, `usage projects`, `analytics tools`, `quality findings`, and `quality scores`.
2. Add invalid-filter tests that assert exit `2`, especially for numeric score filters and invalid enum-ish filters where the query layer validates.
3. Add dry-run side-effect tests for `import`, `costs recalc`, and `quality backfill` against temporary databases.
4. Add a partial-success test for session sync errors if it can be induced deterministically without brittle filesystem races.
5. Assert coverage metadata is preserved in JSON output where the underlying query returns it.
6. Keep fixtures minimal so the CLI tests remain fast and readable.

**Verification**

- Run: `node --import tsx --test tests/cli-commands.test.ts`
- Expect: expanded CLI command tests pass.
- Run: `pnpm test`
- Expect: full suite passes.

**Done When**

- Script-facing JSON outputs are covered by regression tests.
- Dry-run commands prove they do not write to source tables/state tables.
- Invalid filters fail with deterministic exit code `2`.

## Risks And Mitigations

- Risk: CLI one-shot commands accidentally start watchers, timers, or the server.
  Mitigation: Forbid importing `src/server.ts` from CLI command modules and cover this with code review plus targeted tests.
- Risk: Direct SQLite reads diverge from `/api/v2/*` behavior.
  Mitigation: CLI read commands must call the same query helpers used by `src/api/v2/router.ts`.
- Risk: Hand-rolled parsing becomes inconsistent across commands.
  Mitigation: Centralize parsing helpers in `src/cli/args.ts`, reuse command descriptors, and test invalid usage paths.
- Risk: Human output leaks raw terminal escape sequences from agent content.
  Mitigation: Sanitize all human-rendered agent-controlled text in `src/cli/output.ts`.
- Risk: Existing script users are broken.
  Mitigation: Keep package scripts and script files as compatibility shims through this implementation pass.
- Risk: Two executable names create unclear docs.
  Mitigation: Documentation states `amon` is the short preferred command and `agentmonitor` is the explicit alias; root help uses the invoked command name.
- Risk: `live watch` appears usable without a running server.
  Mitigation: Make it explicitly HTTP/SSE-backed and return exit `3` when unavailable.
- Risk: `live watch --kinds` remains parsed but ineffective.
  Mitigation: Implement client-side filtering first and add regression coverage before considering server-side SSE filtering.
- Risk: Package executable behavior regresses because build/pack checks are manual.
  Mitigation: Add built-artifact and npm pack tests as the next follow-up task.
- Risk: Adding persistent CLI config creates another source of truth.
  Mitigation: Do not add config files in this pass; use flags over env over existing defaults.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| `amon` executable is packaged | `pnpm build && ./dist/cli.js --help` | Help prints with `amon` usage and exit `0`. |
| Package exposes executables | `node -e "const p=require('./package.json'); if(!p.bin?.amon || !p.bin?.agentmonitor) process.exit(1)"` | Exit `0`. |
| Root version works | `node dist/cli.js --version` | Prints package version to stdout. |
| Invalid usage is deterministic | `node dist/cli.js nope` | Exits `2` with concise stderr message. |
| Server startup still works | `node dist/server.js` | Starts existing runtime behavior on configured host/port. |
| CLI serve works | `AGENTMONITOR_PORT=3999 node dist/cli.js serve --no-browser --no-import --no-watch` | `/api/health` responds on port `3999`. |
| Health unavailable path works | `node dist/cli.js health --url http://127.0.0.1:1` | Exits `3`. |
| Import dry-run is side-effect free | `node --import tsx src/cli.ts import --dry-run --json` | JSON summary, no import-state writes. |
| Session list JSON works | `node --import tsx src/cli.ts sessions list --limit 5 --json` | JSON object includes `data` and `total`. |
| Usage JSON includes coverage | `node --import tsx src/cli.ts usage daily --json` | JSON response includes usage data and coverage where applicable. |
| Quality findings work | `node --import tsx src/cli.ts quality findings --json` | JSON findings response, possibly empty. |
| Hook dry-run is safe | `node --import tsx src/cli.ts hooks install claude --dry-run --no-input` | Preview only, exit `0`. |
| Live watch buffers split SSE lines | `node --import tsx --test tests/cli-commands.test.ts` | Test `live watch preserves SSE data lines split across chunks` passes. |
| Built CLI E2E is automated | `pnpm build && node --test tests/cli-e2e.test.ts` | Built executable and npm pack checks pass. |
| Runtime commands are integration-tested | `node --import tsx --test tests/cli-runtime.test.ts` | Serve, health, status, and unavailable paths pass. |
| Live watch kind filtering works | `node --import tsx --test tests/cli-commands.test.ts` | `live watch --kinds` suppresses unmatched events. |
| Required TS gate passes | `pnpm lint && pnpm build && pnpm test` | All commands pass. |

## Handoff

1. Implement Task 10, then Task 11, then Task 9, then Task 12.
2. Defer `--no-color` and `serve --no-browser` cleanup until the CLI adds color or browser-opening behavior.
3. Keep Rust-native CLI parity, TUI mode, destructive data commands, self-update logic, and seed/bench replacement out of scope unless the product direction changes.
