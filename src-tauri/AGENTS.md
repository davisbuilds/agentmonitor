# Tauri Desktop Shell

Wraps the agentmonitor Rust backend into a native macOS desktop app via Tauri v2.

See root `AGENTS.md` for project overview, API contract, and shared conventions.
See `rust-backend/AGENTS.md` for Rust-specific gotchas and commands.

## Working Commands

- Dev shell: `pnpm tauri:dev`
- Build: `pnpm tauri:build`
- macOS release (unsigned): `pnpm tauri:release:mac:unsigned`
- macOS release (signed): `pnpm tauri:release:mac:signed`
- macOS release (signed + notarized): `pnpm tauri:release:mac:notarized`
- Desktop invariant tests: `pnpm rust:test:desktop-invariants`

## Runtime Model (Phase 2, Internal-First)

- Tauri starts an embedded Rust runtime through `rust-backend`'s `runtime_contract` API (not `runtime_host` internals), then navigates the main window to the contract-provided base URL.
- Rust serves both API routes and dashboard static assets from the same origin (`/api/*`, `/`, `/js/*`, `/css/*`) in desktop mode.
- HTTP ingest/SSE remains the adapter boundary for hooks and parity safety; Tauri IPC is additive and not required for core ingest flow.
- Desktop bind precedence is deterministic: `AGENTMONITOR_DESKTOP_HOST` / `AGENTMONITOR_DESKTOP_PORT` override backend env bind values; otherwise runtime falls back to `AGENTMONITOR_HOST` / `AGENTMONITOR_RUST_PORT` defaults.
- Startup orchestration lives in `src-tauri/src/runtime_coordinator.rs`; keep `src-tauri/src/lib.rs` as composition glue only.
- IPC command surface in `src-tauri/src/ipc/mod.rs` is additive (`desktop_runtime_status`, `desktop_health`); ingest/data flow remains HTTP-first.

## Code Map

- `src/lib.rs`: composition glue (keep thin).
- `src/runtime_coordinator.rs`: startup orchestration.
- `src/ipc/mod.rs`: IPC command surface.
- `tests/runtime_boundary.rs`: desktop startup contract assertions.

## Gotchas

- **Do not block inside async backend readiness checks**: Calling `std::thread::sleep` or sync `std::net::TcpStream` I/O inside async startup checks can starve the runtime and make health waits hang. Use `tokio::time::sleep` + `tokio::net::TcpStream` for readiness probes.
- **Tauri setup failures can explode into macOS panic backtraces**: Returning setup-hook errors from deep startup paths can trigger noisy `panic in a function that cannot unwind` output in `tauri dev`. For bind-collision startup failures, emit a clear message and `std::process::exit(1)` in setup instead of relying on panic surfaces.
- **Embedded-backend tests need unique SQLite paths**: Reusing the same temp DB file across tests causes intermittent `database is locked`. Generate a unique temp DB path per test case.
- **Bind-collision tests should reserve a free port first**: Hardcoded test ports are flaky if already in use. Bind `127.0.0.1:0`, capture the assigned port, release listener, then run collision checks against that port.
- **`pnpm rust:dev` and `pnpm tauri:dev` both target Rust port 3142 by default**: Running both at once is an expected startup collision. Shut down one or set a different `AGENTMONITOR_RUST_PORT` for one process.
- **Use `AGENTMONITOR_DESKTOP_PORT` for Tauri-only overrides**: If you need `pnpm rust:dev` and `pnpm tauri:dev` simultaneously, prefer `AGENTMONITOR_DESKTOP_PORT` so standalone Rust defaults stay unchanged.
- **Keep runtime boundary tests in `src-tauri/tests/runtime_boundary.rs`**: Add new desktop startup contract assertions there, not in ad-hoc manual checks, so boundary regressions fail fast.
- **Do not call `shutdown_blocking()` inside async tokio tests**: It uses `tauri::async_runtime::block_on`, which panics with nested runtime errors. Use `EmbeddedBackendState::shutdown_async().await` in async tests.
- **Keep Tauri command wrappers thin and test helper functions directly**: `#[tauri::command]` functions that take `tauri::State<'_, T>` are awkward to test in isolation. Put logic in plain helpers (for example `runtime_status_from_state`, `desktop_health_from_state`) and keep command functions as thin adapters.
- **Use `pnpm tauri:release:mac -- --dry-run` before release builds**: The release script validates signing/notarization env upfront and fails fast before expensive bundle builds.
- **Notarized mode requires a real API key file path**: `APPLE_API_KEY_PATH` must point to an existing `.p8`; preflight intentionally fails on missing files.
- **DMG bundling runs AppleScript (`create-dmg`) and can stall in headless or restricted GUI sessions**: Use release script `--dry-run` for preflight checks and `pnpm tauri:build --no-bundle` for non-GUI verification.
- **Finder launch differs from terminal cwd**: Relative backend paths (like `./data/agentmonitor-rs.db`) can fail when launched from Finder because cwd is not the repo root. In desktop startup, resolve relative DB paths against Tauri `app_data_dir`.
