# AGENTS.md

Real-time localhost dashboard and session browser for monitoring AI agent activity
across Claude Code and Codex: a Node/TypeScript + SQLite backend on
`127.0.0.1:3141` and a Svelte 5 SPA at `/app/`, the only human-facing surface.

## Documentation Map

Source, tests, `amon --help`, `pnpm verify --help`, and live GitHub settings are
authoritative for exact routes, response types, flags, configuration, schema, and
remote settings. These references hold intent, boundaries, and procedures:

- `docs/system/ARCHITECTURE.md` — topology, data ownership, invariants, source layout, frontend code map.
- `docs/system/FEATURES.md` — user-visible behavior and fidelity, coverage, privacy, and review boundaries.
- `docs/system/OPERATIONS.md` — setup, commands, integrations, backup/recovery, storage repair, verification.
- `docs/system/DESIGN.md` — `/app/` design system ("Instrument Console"); tokens in `frontend/src/app.css`.
- `docs/system/trace-quality.md` — local trace projection, coverage honesty, warehouse export.
- `docs/api/` — API ownership and ingest semantics; update it when a public response's documented meaning changes.
- `docs/project/` — `VISION.md`, `ROADMAP.md`, `DECISIONS.md`, `BACKLOG.md`, and
  `GIT_HISTORY_POLICY.md` (merge strategy and required checks).
- `frontend/AGENTS.md` — rules for work under `frontend/`.
- `hooks/claude-code/README.md`, `hooks/codex/README.md` — hook setup.

## Implementation Guardrails

- Extend the `/app/` product path and v2 contracts. Add no behavior to the v1 read
  endpoints (`GET /api/events|stats|sessions|filter-options`); they remain only for
  ingestion clients, SSE, provider quotas, and the parity harness.
- Keep Portless at the human-facing `amon serve` boundary
  (`https://agentmonitor.localhost`). Hook and OTEL ingestion stay on the fixed
  `127.0.0.1:3141` backend.
- Never mix `performance.now()` (monotonic, from process start) with `Date.now()`
  (epoch) in deadline math; the mix produces instant timeouts.
- **The login service runs the `dist/` of the checkout that installed it.** If
  `amon service status` shows it running, use `amon service restart`; a second
  `amon serve` on the same database is refused by the runtime lock. launchd reloads
  whatever `dist/` holds after a crash, so build experiments in a worktree.
- **Every gate reads `src/`; only the built server reads `dist/`.** `pnpm test`,
  `pnpm dev`, and `pnpm lint` run from source, so a bug in what the build emits
  passes all of them. One shipped stale pricing tables for five months, and an
  unpriced model bills as $0 rather than raising. `scripts/check-pricing-dist.mjs`
  guards that case only; any non-TS asset the build copies has the same shape. If a
  bug reproduces for the user but not in tests, suspect the built path. A rebuild is
  not live until restart: `/api/health` `build.stale` and the app's **Restart
  needed** notice say so.

## Testing

- **Local gate** (the required `Lint, Build, Test` check):
  `pnpm lint && pnpm frontend:check && pnpm frontend:test && pnpm build && pnpm test && pnpm test:parity:ts && pnpm test:v2:contract:ts`.
- The required `E2E (Playwright)` check also runs, after `pnpm build`:
  `pnpm test:browser-runtime`, `pnpm exec playwright test --project=chromium`,
  `pnpm verify:skill-context-built`, and `pnpm test:verify`. Run them locally when a
  change touches the UI, build output, or verification CLI; on macOS they use
  installed Google Chrome. `pnpm test:verify` edits a `dist` file: run it serially,
  in a worktree, never in the checkout the login service loads.
- **End-to-end path:** `pnpm --silent verify run <scenario> --json` drives the
  compiled app on a disposable database with a real browser; `verify list` maps the
  workflows (OPERATIONS.md → Verification).
- **Investigating the installed store:** use `pnpm --silent verify probe <name> --json`
  (after `pnpm build`) instead of an ad hoc script against the real database; add a
  probe when one is missing.
- **Never trust a test you haven't watched fail.** The bugs worth guarding here are
  silent (wrong costs, two chart series sharing a color, a test reading the real
  DB) and still render plausibly. Reintroduce the bug and confirm the test goes red;
  a color test once passed on broken code because its fixture had exactly as many
  models as the palette had colors.
- **Tests cannot open the install database.** Set `AGENTMONITOR_DB_PATH` to a temp
  file before importing anything that reads `config` (`config.ts` snapshots the env
  at import). Destructive fixtures assert that the open handle resolves to their temp
  path before any table-wide delete.
- **Tests remove what they create under `os.tmpdir()`.** `pnpm test` fails when an
  entry is left behind; remove each `mkdtempSync` directory in an `after()` hook.

## Working Agreement

- **Clarify before building** when a request is vague, contradictory, or skips a
  key decision; clear, well-scoped requests need no interview.
- **Fix small issues now; backlog the rest.** Fix simple, quick, or blocking
  issues in this repo as part of the current change and call them out. Record in
  `docs/project/BACKLOG.md` only what can't be finished now or needs the
  maintainer's decision; don't open a branch or PR just for a backlog entry.
- **Keep docs current** when a change makes a documented contract, boundary,
  procedure, or direction stale.
- **Planning and continuity.** Reuse clear task context. Save planning docs when
  decisions, acceptance, or coordination need persistence. Leave a brief handoff
  only when needed to resume unfinished work. Commit shared docs and keep status
  current. Before archiving, preserve lasting decisions and open work in
  maintained docs and repair links. Keep tracked docs suitable for public
  readers and private evidence local.
- **TDD:** red/green for features, major refactors and large changes; the red
  test must fail on the behavior, not on a missing symbol. For smaller edits, run
  the relevant existing checks.
- **Commit and push.** Commit coherent chunks, staging by explicit path. Push
  your task branch and open a PR once the work is complete and the local gate
  passes; don't push directly to `main`.
- **Merge** only under the standing merge authority in the maintainer's workspace
  instructions, or when the maintainer asks. Without those instructions in
  context, leave the PR for the maintainer.
- **History and deploys.** Squash is disabled: merge commit by default, rebase
  only when the branch's commits are already clean. Branch protection requires
  every review thread resolved. A merge deploys and publishes nothing: installs
  run from a local checkout's `dist/`.
- **Re-ground after compaction** in source, this file, the owning docs, and
  recent commits. A summary and your own earlier proposals are not user approval.
