# Rust Backend

Reimplements core ingest and live-stream behavior using axum + tokio + rusqlite. Spike complete with GO decision — phased migration in progress.

See root `AGENTS.md` for project overview, API contract, and shared conventions.
The convergence target is the canonical Svelte `/app/` experience backed by the `/api/v2/*` contract. Do not extend the legacy `/` dashboard path as a separate product.

## Working Commands

- Dev server: `pnpm rust:dev` (binds `127.0.0.1:3142`)
- Release build: `pnpm rust:build`
- Run tests: `pnpm rust:test`
- Desktop invariants only: `pnpm rust:test:desktop-invariants`
- Import historical logs: `pnpm rust:import --source all` (supports `--source`, `--from`, `--to`, `--dry-run`, `--force`, `--claude-dir`, `--codex-dir`)
- Parity tests (TS): `pnpm test:parity:ts` (isolated temp server + temp DB; does not touch normal monitor data)
- Parity tests (TS live): `pnpm test:parity:ts:live` (needs TS server running on 3141)
- Parity tests (Rust): `pnpm test:parity:rust` (needs Rust server running on 3142)
- Benchmark comparison: `pnpm bench:compare`

## Gotchas

- **`cargo` not in PATH**: Shell sessions from Claude Code don't inherit cargo. Prefix commands with `export PATH="$HOME/.cargo/bin:$PATH"` or use the `pnpm rust:*` scripts.
- **Lib + bin crate structure**: Integration tests can't import from a binary crate. The crate is split into `src/lib.rs` (all modules + `build_router()`) and a thin `src/main.rs`. Always add new modules to `lib.rs`.
- **`Path::new(":memory:")` in tests**: `db::initialize` expects `&Path`, not `&str`. Use `Path::new(":memory:")` for in-memory test databases.
- **TS validates `agent_type` as required string only, not enum**: Parity tests must match the looser TypeScript behavior. Don't assert enum rejection for `agent_type` in shared parity tests.
- **`pnpm rust:import` already includes Cargo `--` separator**: Pass flags directly (`pnpm rust:import --help`, `pnpm rust:import --source codex`). Do not add an extra `--`.
- **Multiple Rust binaries require explicit `--bin` for `cargo run`**: After adding helper CLIs (for example `import`), plain `cargo run` becomes ambiguous. Keep `pnpm rust:dev` pinned to `--bin agentmonitor-rs`.
- **Keep importer metadata as `serde_json::Value` until insert**: `truncate_metadata` accepts `&Value`; converting metadata to `String` too early causes type mismatches and extra parse/serialize churn.
- **`Option<String>` + helper signature mismatch**: If helper takes `&str`, call `.as_deref().and_then(helper)` instead of `.and_then(helper)`.
- **Import parity requires historical session finalization**: For events with `source = "import"`, mark sessions as `ended` to match TypeScript behavior and keep imported sessions out of active lists.

## Testing

- Run `pnpm rust:test` before pushing any Rust changes.
- Use red/green TDD for new features and major changes.
- 73 Rust tests + 18 shared parity tests.
