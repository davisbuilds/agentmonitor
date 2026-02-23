---
date: 2026-02-23
topic: macos-desktop-dmg
stage: implementation-plan
status: draft
source: conversation
---

# AgentStats macOS Desktop + DMG Implementation Plan

## Goal

Ship AgentStats as a polished macOS desktop app with signed and notarized DMG distribution while preserving existing local-first ingest, SQLite persistence, and real-time dashboard behavior.

## Scope

### In Scope

- Electron desktop shell around the existing Node/Express service and static dashboard.
- Service lifecycle refactor so desktop runtime can start and stop backend deterministically.
- Desktop-safe configuration and data path strategy for macOS app data directories.
- Secure BrowserWindow defaults and minimal preload/IPC surface.
- Native module rebuild workflow for `better-sqlite3` in Electron builds.
- DMG and ZIP packaging with reproducible build commands.
- Developer ID signing, notarization, stapling, and Gatekeeper verification in CI.
- Hook onboarding updates so Claude Code and Codex integration remains functional.
- Release and migration documentation for new and existing users.

### Out of Scope

- Full Rust rewrite of backend logic.
- Mac App Store packaging and review process.
- Windows and Linux desktop packaging in this first implementation pass.
- API contract redesign for existing ingest endpoints.

## Assumptions And Constraints

- Existing API and SSE behavior must remain compatible with current hooks and frontend.
- SQL ownership remains in `src/db/queries.ts` per repo guardrails.
- TypeScript ESM import style with `.js` suffix remains consistent.
- Runtime artifacts (`data/`, `*.db`, generated CSS output) are not committed.
- `better-sqlite3` requires Electron ABI-compatible rebuild during packaging.
- Outside-App-Store macOS distribution requires Developer ID signing and notarization.
- Node baseline should be updated to align with current Electron ecosystem direction.
- Initial architecture keeps localhost HTTP/SSE internally to minimize migration risk.

## Task Breakdown

### Task 1: Record architecture decision and delivery constraints

**Objective**

Create a decision record that locks scope, architecture, and migration boundaries before implementation.

**Files**

- Create: `docs/plans/adr/2026-02-23-desktop-architecture.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/plans/2026-02-23-macos-desktop-dmg-implementation.md`

**Dependencies**

None

**Implementation Steps**

1. Write ADR describing Electron-first approach and rationale.
2. Capture alternatives considered: Tauri sidecar and full Rust rewrite.
3. Document explicit non-goals and phase boundaries.
4. Add source links used for the architecture choice.

**Verification**

- Run: `rg -n "Electron-first|Tauri|Rust rewrite|non-goal" docs/plans/adr/2026-02-23-desktop-architecture.md docs/ARCHITECTURE.md`
- Expect: matches for architecture choice, alternatives, and constraints.

**Done When**

- ADR exists and is linked from architecture docs.
- Scope and non-goals are explicit enough to prevent drift.

### Task 2: Extract managed service lifecycle from bootstrap

**Objective**

Refactor startup side effects in `src/server.ts` into a reusable lifecycle module suitable for desktop main-process ownership.

**Files**

- Create: `src/runtime/service.ts`
- Modify: `src/server.ts`
- Modify: `src/app.ts`
- Test: `tests/runtime/service-lifecycle.test.ts`

**Dependencies**

- Task 1

**Implementation Steps**

1. Create `startAgentStatsService()` and `stopAgentStatsService()` APIs in `src/runtime/service.ts`.
2. Move timers, auto-import scheduling, and shutdown cleanup into lifecycle-managed code.
3. Keep `src/server.ts` as CLI entrypoint delegating to runtime service.
4. Add lifecycle tests for start, stop, and repeated start-stop cycles.

**Verification**

- Run: `pnpm run test -- tests/runtime/service-lifecycle.test.ts`
- Expect: lifecycle tests pass with no leaked intervals or open handles.

**Done When**

- Runtime module has no module-load side effects.
- CLI server still starts successfully through delegated lifecycle API.

### Task 3: Implement desktop-safe config and path resolution

**Objective**

Remove hardcoded machine defaults and support injected desktop paths for DB and project resolution.

**Files**

- Modify: `src/config.ts`
- Modify: `src/db/connection.ts`
- Modify: `src/util/git-branch.ts`
- Test: `tests/config.desktop-paths.test.ts`

**Dependencies**

- Task 2

**Implementation Steps**

1. Add config resolution order: env override, injected desktop values, CLI fallback.
2. Replace hardcoded `/Users/dg-mac-mini/Dev` default with configurable or computed path.
3. Ensure DB initialization creates parent directories for desktop app data location.
4. Add tests covering desktop mode defaults and env override precedence.

**Verification**

- Run: `pnpm run test -- tests/config.desktop-paths.test.ts`
- Expect: tests confirm path resolution behavior across desktop and CLI modes.

**Done When**

- No host-specific absolute paths remain in runtime defaults.
- Desktop path injection works without breaking existing env-based workflows.

### Task 4: Add Electron scaffold and local desktop dev workflow

**Objective**

Introduce Electron app structure that starts backend runtime and loads dashboard in a native window.

**Files**

- Create: `desktop/main.ts`
- Create: `desktop/preload.ts`
- Create: `desktop/window.ts`
- Create: `desktop/types.ts`
- Modify: `package.json`
- Create: `tsconfig.desktop.json`
- Test: `tests/desktop/main-process.test.ts`

**Dependencies**

- Task 2
- Task 3

**Implementation Steps**

1. Add Electron main process bootstrap with app lifecycle handlers.
2. Start runtime service on app ready and wait for readiness before loading UI URL.
3. Implement single-instance lock and macOS activate behavior.
4. Add `desktop:dev` script for local desktop iteration.
5. Add test coverage for service startup and window initialization behavior.

**Verification**

- Run: `pnpm run test -- tests/desktop/main-process.test.ts`
- Expect: main-process behavior tests pass.
- Run: `pnpm run desktop:dev`
- Expect: native window opens and dashboard renders without manual server start.

**Done When**

- Desktop shell launches from one command.
- Dashboard is usable with backend managed by Electron process.

### Task 5: Enforce Electron security baseline and navigation policy

**Objective**

Apply secure BrowserWindow defaults and explicit navigation controls.

**Files**

- Modify: `desktop/main.ts`
- Create: `desktop/security.ts`
- Test: `tests/desktop/security-config.test.ts`
- Modify: `docs/ARCHITECTURE.md`

**Dependencies**

- Task 4

**Implementation Steps**

1. Configure `contextIsolation: true` and `nodeIntegration: false`.
2. Restrict navigation and window creation with explicit allow rules.
3. Keep preload API minimal and typed.
4. Document security posture and rationale in architecture docs.

**Verification**

- Run: `pnpm run test -- tests/desktop/security-config.test.ts`
- Expect: security config assertions pass.
- Run: `pnpm run test -- tests/desktop/security-config.test.ts --test-name-pattern="rejects disallowed navigation"`
- Expect: negative-path check passes by blocking unsafe navigation attempts.

**Done When**

- Renderer has no unrestricted Node access.
- Disallowed navigation and popup paths are blocked by policy.

### Task 6: Add native module rebuild pipeline for Electron targets

**Objective**

Guarantee `better-sqlite3` works in packaged app by rebuilding native modules for Electron ABI.

**Files**

- Modify: `package.json`
- Create: `scripts/desktop/rebuild-native.sh`
- Test: `tests/desktop/native-module-smoke.test.ts`
- Modify: `README.md`

**Dependencies**

- Task 4

**Implementation Steps**

1. Add `desktop:rebuild-native` script using `@electron/rebuild`.
2. Wire rebuild into packaging pre-steps.
3. Add smoke test that initializes DB through packaged runtime path.
4. Document required toolchain dependencies for local and CI builds.

**Verification**

- Run: `pnpm run desktop:rebuild-native`
- Expect: rebuild completes for configured Electron target.
- Run: `pnpm run test -- tests/desktop/native-module-smoke.test.ts`
- Expect: DB initialization succeeds under Electron runtime.

**Done When**

- Packaged runtime can open SQLite without native module load errors.
- Rebuild command is deterministic and documented.

### Task 7: Configure DMG and ZIP packaging outputs

**Objective**

Produce installable macOS artifacts with configurable DMG presentation and release metadata.

**Files**

- Create: `electron-builder.yml`
- Modify: `package.json`
- Create: `build/icons/agentstats.icns`
- Create: `build/dmg-background.png`
- Test: `tests/desktop/package-config.test.ts`

**Dependencies**

- Task 4
- Task 6

**Implementation Steps**

1. Add electron-builder config for mac targets (`dmg`, `zip`).
2. Configure app metadata, app category, and artifact naming.
3. Add DMG layout and visual assets.
4. Add package config tests to lock required build settings.

**Verification**

- Run: `pnpm run test -- tests/desktop/package-config.test.ts`
- Expect: config validation tests pass.
- Run: `pnpm run desktop:dist`
- Expect: both `.dmg` and `.zip` artifacts are generated.

**Done When**

- Local packaging produces expected artifact set.
- Packaging config is versioned and test-covered.

### Task 8: Implement signing and notarization release workflow

**Objective**

Automate signed and notarized artifact generation in CI with clear failure signals.

**Files**

- Create: `.github/workflows/release-desktop-macos.yml`
- Create: `scripts/release/notarize-verify.sh`
- Modify: `docs/OPERATIONS.md`
- Modify: `README.md`
- Test: `tests/release/notarize-script.test.ts`

**Dependencies**

- Task 7

**Implementation Steps**

1. Add release workflow stages: build, sign, notarize, staple, verify.
2. Add shell script that checks required secrets and validates artifact signatures.
3. Document required secrets and certificate setup steps.
4. Add tests for script argument and env-var validation.

**Verification**

- Run: `pnpm run test -- tests/release/notarize-script.test.ts`
- Expect: script validation tests pass.
- Run: `AGENTSTATS_FAKE_NOTARIZE=1 bash scripts/release/notarize-verify.sh`
- Expect: dry-run path succeeds through preflight checks.

**Done When**

- CI workflow can produce notarization-ready artifacts.
- Failure modes for missing credentials are explicit and actionable.

### Task 9: Add desktop onboarding for hook and endpoint setup

**Objective**

Ensure Claude Code and Codex integrations work with desktop runtime defaults without manual guesswork.

**Files**

- Create: `desktop/onboarding/install-hooks.ts`
- Modify: `hooks/claude-code/install.sh`
- Modify: `hooks/claude-code/README.md`
- Modify: `hooks/codex/README.md`
- Test: `tests/hooks.desktop-onboarding.test.ts`

**Dependencies**

- Task 4
- Task 5

**Implementation Steps**

1. Add onboarding flow to install or update hook endpoint configuration.
2. Preserve user overrides while providing desktop default endpoint values.
3. Update hook docs for desktop launch assumptions and troubleshooting.
4. Add test coverage for generated endpoint config and override behavior.

**Verification**

- Run: `pnpm run test -- tests/hooks.desktop-onboarding.test.ts`
- Expect: onboarding tests pass for default and override scenarios.
- Run: `pnpm run test -- tests/hooks.desktop-onboarding.test.ts --test-name-pattern="rejects invalid endpoint"`
- Expect: negative-path validation prevents malformed endpoint config.

**Done When**

- Hook setup path is explicit for desktop users.
- Endpoint defaults are correct and safely overridable.

### Task 10: Validate data migration and persistence behavior

**Objective**

Guarantee existing users can migrate to desktop data paths without losing historical data.

**Files**

- Create: `src/runtime/migration.ts`
- Modify: `src/runtime/service.ts`
- Test: `tests/runtime/data-migration.test.ts`
- Modify: `docs/OPERATIONS.md`

**Dependencies**

- Task 3
- Task 4

**Implementation Steps**

1. Add migration helper for first-run move/copy from legacy DB path.
2. Ensure migration is idempotent and rollback-safe.
3. Add startup logging and user-facing messages for migration outcomes.
4. Add tests for successful migration, already-migrated case, and corrupt-source handling.

**Verification**

- Run: `pnpm run test -- tests/runtime/data-migration.test.ts`
- Expect: migration tests pass across first-run and repeat-run cases.
- Run: `pnpm run test -- tests/runtime/data-migration.test.ts --test-name-pattern="handles corrupt source db"`
- Expect: negative-path behavior preserves destination and surfaces actionable error.

**Done When**

- Legacy data is preserved during migration scenarios.
- Failed migration does not destroy existing destination data.

### Task 11: Publish release readiness checklist and operator docs

**Objective**

Create a deterministic release checklist and operator documentation for desktop distribution.

**Files**

- Create: `docs/release/macos-desktop-checklist.md`
- Modify: `README.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/ARCHITECTURE.md`

**Dependencies**

- Task 8
- Task 10

**Implementation Steps**

1. Add release checklist covering build, notarization, stapling, Gatekeeper verification, and smoke checks.
2. Update README with desktop install and development commands.
3. Update operations docs with release secrets and troubleshooting guidance.
4. Add architecture notes for desktop deployment boundaries.

**Verification**

- Run: `rg -n "desktop:dev|desktop:dist|notarization|Gatekeeper|migration" README.md docs/OPERATIONS.md docs/release/macos-desktop-checklist.md docs/ARCHITECTURE.md`
- Expect: docs contain required desktop and release procedures.

**Done When**

- Release process is executable from docs without tribal knowledge.
- Migration guidance is clear for new and existing users.

## Risks And Mitigations

- Risk: Native module ABI mismatch breaks packaged runtime.
  Mitigation: enforce pre-package rebuild and add smoke test in CI.
- Risk: Service startup race causes blank window or failed API calls.
  Mitigation: gate `loadURL` behind service readiness health checks.
- Risk: Localhost model expands local attack surface.
  Mitigation: strict loopback binding, navigation restrictions, and minimal preload APIs.
- Risk: Signing/notarization failures late in release cycle.
  Mitigation: preflight credential checks and reproducible CI verification script.
- Risk: Data migration causes user data loss.
  Mitigation: idempotent migration with backup/rollback strategy and negative-path tests.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Runtime lifecycle is managed and leak-free | `pnpm run test -- tests/runtime/service-lifecycle.test.ts` | Start/stop tests pass without open handle leaks |
| Desktop path defaults are correct | `pnpm run test -- tests/config.desktop-paths.test.ts` | Desktop and env override path cases pass |
| Desktop shell boots with managed backend | `pnpm run desktop:dev` | Native window opens with functioning dashboard |
| Security baseline is enforced | `pnpm run test -- tests/desktop/security-config.test.ts` | Secure window config and navigation guard tests pass |
| Native module loads in desktop runtime | `pnpm run test -- tests/desktop/native-module-smoke.test.ts` | `better-sqlite3` initializes successfully |
| Packaging outputs are generated | `pnpm run desktop:dist` | `.dmg` and `.zip` artifacts are produced |
| Notarization pipeline is runnable | `pnpm run test -- tests/release/notarize-script.test.ts` | Script validation tests pass for expected env setup |
| Legacy data migration is safe | `pnpm run test -- tests/runtime/data-migration.test.ts` | Migration success and negative-path tests pass |
| Baseline repo quality gates still pass | `pnpm build && pnpm css:build && pnpm run test` | Build, CSS, and test suites all pass |

## Source Context

- Electron process model: https://www.electronjs.org/docs/latest/tutorial/process-model
- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Native module rebuild guidance: https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
- Electron rebuild tooling: https://github.com/electron/rebuild
- Electron ecosystem Node baseline change: https://www.electronjs.org/blog/ecosystem-node-22
- electron-builder mac docs: https://www.electron.build/mac.html
- electron-builder DMG docs: https://www.electron.build/dmg
- electron-builder auto-update docs: https://www.electron.build/auto-update.html
- Apple Developer ID + notarization guidance: https://developer.apple.com/support/developer-id/
- Apple outside-App-Store distribution: https://developer.apple.com/documentation/security/distributing-software-outside-the-mac-app-store
- Tauri distribution docs (alternative path): https://v2.tauri.app/distribute/
- Tauri sidecar docs (alternative path): https://v2.tauri.app/develop/sidecar/

## Handoff

Plan complete and saved to docs/plans/2026-02-23-macos-desktop-dmg-implementation.md.

1. Execute in this session, task by task.
2. Open a separate execution session.
3. Refine this plan before implementation.
