---
date: 2026-02-24
topic: rust-backend-spike
stage: implementation-plan
status: draft
source: conversation
---

# Rust Backend Spike Implementation Plan

## Goal

Deliver a 5-7 day, decision-ready Rust backend spike that reproduces core AgentMonitor ingest and live-stream behavior with measurable parity, performance, and operational signals before committing to a full rewrite.

## Scope

### In Scope

- Create an isolated Rust service (`rust-backend/`) that does not replace the current TypeScript runtime yet.
- Implement core endpoints for spike evaluation:
  - `POST /api/events`
  - `POST /api/events/batch`
  - `GET /api/stats`
  - `GET /api/stream`
  - `GET /api/health`
- Keep SQLite schema compatibility for `agents`, `sessions`, and `events` needed by the above routes.
- Implement contract-critical ingest behavior:
  - required fields (`session_id`, `agent_type`, `event_type`)
  - enum validation
  - optional `event_id` deduplication
  - UTF-8-safe metadata truncation and `payload_truncated`
  - session lifecycle transitions needed by stats and SSE
- Add black-box parity tests and benchmark comparisons against the TypeScript baseline.
- Produce a go/no-go decision document with explicit recommendation.

### Out of Scope

- Full migration of all endpoints (OTEL, import, transcripts, filter options, full sessions API).
- Desktop windowing/packaging/signing/notarization (Electron/Tauri/DMG tasks).
- Rewriting frontend dashboard code.
- Replacing the TypeScript service in default scripts during the spike window.

## Technical Decisions

These choices are locked for the spike to avoid decision churn during implementation.

- **SQLite crate**: `rusqlite` (synchronous). SQLite is single-writer regardless of async wrapper, and `rusqlite` is simpler to operate than `sqlx` for this workload. Compile-time query checking is a nice-to-have but not worth the complexity for a spike.
- **HTTP framework**: `axum` on `tokio` runtime. De facto standard for new Rust web services.
- **SSE fan-out**: `tokio::sync::broadcast` channel for hub-to-client delivery. Simpler than manual `Vec<Sender>` management and handles slow-consumer drops automatically.
- **HTTP API preserved**: The Rust service exposes the same HTTP endpoints on a different port (`3142`). This is required — Claude Code and Codex hooks depend on HTTP ingest. If this spike leads to Tauri, the HTTP API stays for hook compatibility; Tauri IPC would be additive, not a replacement.
- **Serialization**: `serde` + `serde_json`. No alternatives worth considering.

## Evaluation Criteria Beyond Parity

The spike should capture these metrics in addition to contract parity:

- **Memory footprint**: idle RSS and RSS under sustained ingest+SSE load, compared to Node baseline. This matters for a desktop tool that runs all day.
- **Binary size**: release build size for the Rust service vs Node `node_modules` + runtime. Relevant to eventual Tauri packaging vs Electron.
- **Startup time**: cold start to first successful `/api/health` response for both runtimes.

These are not pass/fail criteria — they are evidence for the go/no-go decision and the Tauri vs Electron packaging choice.

## Assumptions And Constraints

- Existing TypeScript service remains the source of truth during the spike.
- API surface and data contract for scoped endpoints must remain compatible with current hook behavior.
- SQLite remains the persistence layer for parity evaluation.
- The spike is time-boxed to one week maximum; unresolved major gaps trigger no-go.
- Rust code should run on loopback (`127.0.0.1`) and avoid widened network exposure.
- Current project guardrails still apply: no committed runtime artifacts (`data/`, `*.db`).
- Existing test coverage is mostly in-process TypeScript; parity harness must be black-box HTTP based.

## Task Breakdown

### Task 1: Lock Spike Acceptance Criteria And Architecture Boundaries

**Objective**

Define explicit success/failure criteria so the spike ends with a deterministic go/no-go decision.

**Files**

- Create: `docs/plans/adr/2026-02-24-rust-backend-spike-decision-record.md`
- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `docs/plans/2026-02-24-rust-backend-spike-implementation.md`

**Dependencies**

None

**Implementation Steps**

1. Record why the spike targets backend parity first (not desktop shell first).
2. Capture alternatives considered (Electron-first TypeScript continuation, Tauri sidecar now, full rewrite now).
3. Define quantitative acceptance thresholds:
   - parity: 100% pass on scoped black-box contract tests
   - reliability: no crash/leak in 30-minute soak run
   - performance: ingest throughput >= TypeScript baseline, or documented trade-off with clear win elsewhere
4. Define decision outputs: go, no-go, or constrained continuation.

**Verification**

- Run: `rg -n "parity|soak|throughput|go/no-go|alternatives" docs/plans/adr/2026-02-24-rust-backend-spike-decision-record.md docs/system/ARCHITECTURE.md`
- Expect: all criteria and alternatives are explicitly documented.

**Done When**

- Acceptance criteria are measurable and non-ambiguous.
- Team can evaluate spike outcome without redefining success afterward.

### Task 2: Scaffold Isolated Rust Service And Developer Workflow

**Objective**

Create a runnable Rust service skeleton with reproducible local commands and health endpoint.

**Files**

- Create: `rust-backend/Cargo.toml`
- Create: `rust-backend/src/main.rs`
- Create: `rust-backend/src/config.rs`
- Create: `rust-backend/src/state.rs`
- Create: `rust-backend/src/api/health.rs`
- Modify: `package.json`
- Modify: `README.md`

**Dependencies**

- Task 1

**Implementation Steps**

1. Scaffold Rust project using `axum`, `tokio`, `serde`, `tracing`, and SQLite crate selection.
2. Add config parsing for host, port, DB path, payload cap, and SSE limits matching existing env names where possible.
3. Implement `/api/health` with minimal runtime state checks.
4. Add scripts such as `rust:dev`, `rust:build`, `rust:test` in `package.json` for unified repo ergonomics.
5. Document startup commands and port strategy (`3142` default for spike).

**Verification**

- Run: `cargo check --manifest-path rust-backend/Cargo.toml`
- Expect: clean build graph and zero compile errors.
- Run: `pnpm run rust:dev`
- Expect: Rust server starts and `GET /api/health` returns `200`.

**Done When**

- Rust service boots independently from TypeScript service.
- Local dev commands are documented and reproducible.

### Task 3: Implement SQLite Schema Compatibility Layer

**Objective**

Ensure Rust runtime can read/write event and session data in a schema compatible with current TypeScript expectations for scoped endpoints.

**Files**

- Create: `rust-backend/src/db/connection.rs`
- Create: `rust-backend/src/db/schema.rs`
- Create: `rust-backend/src/db/queries.rs`
- Create: `rust-backend/src/db/mod.rs`
- Create: `rust-backend/tests/schema_compatibility.rs`

**Dependencies**

- Task 2

**Implementation Steps**

1. Initialize SQLite in WAL mode and apply schema bootstrapping for required tables/indexes.
2. Mirror key column types and defaults used by TypeScript paths for events/sessions/agents.
3. Implement prepared statements for insert, dedupe checks, and aggregate reads.
4. Add schema compatibility assertions to detect drift against expected table/index definitions.

**Verification**

- Run: `cargo test --manifest-path rust-backend/Cargo.toml schema_compatibility -- --nocapture`
- Expect: compatibility tests pass for table and index presence.

**Done When**

- Rust writes are queryable through current schema assumptions.
- Schema compatibility test fails fast on accidental drift.

### Task 4: Build Event Contract Validation And Normalization

**Objective**

Reproduce ingest validation behavior for required fields, enum checks, truncation, and timestamps.

**Files**

- Create: `rust-backend/src/contracts/event.rs`
- Create: `rust-backend/src/contracts/validation.rs`
- Create: `rust-backend/src/util/truncate.rs`
- Create: `rust-backend/tests/event_contract.rs`

**Dependencies**

- Task 3

**Implementation Steps**

1. Define serde models for incoming payloads with strict required-field validation.
2. Implement enum/value validation for `agent_type`, `event_type`, and known status fields.
3. Implement UTF-8-safe byte truncation for metadata and set `payload_truncated`.
4. Preserve `client_timestamp` while generating server `created_at`.
5. Add negative-path tests for invalid enums, missing required values, and oversized metadata.

**Verification**

- Run: `cargo test --manifest-path rust-backend/Cargo.toml event_contract -- --nocapture`
- Expect: positive and negative validation cases pass.

**Done When**

- Validation responses are structurally compatible with current API behavior.
- Truncation and timestamp semantics match scoped contract expectations.

### Task 5: Implement Ingest Endpoints With Dedup And Batch Reporting

**Objective**

Deliver `POST /api/events` and `POST /api/events/batch` with deterministic dedupe and rejection reporting.

**Files**

- Create: `rust-backend/src/api/events.rs`
- Modify: `rust-backend/src/main.rs`
- Create: `rust-backend/tests/events_api.rs`

**Dependencies**

- Task 4

**Implementation Steps**

1. Implement single-event ingest with `event_id` dedupe semantics and 201/200 status behavior.
2. Implement batch ingest response contract: `received`, `ids`, `duplicates`, `rejected`.
3. Ensure session state updates required for downstream stats/SSE behavior.
4. Broadcast `event` and `session_update` messages into SSE hub on successful writes.
5. Add integration tests for dedupe, partial rejection, and session transition behavior.

**Verification**

- Run: `cargo test --manifest-path rust-backend/Cargo.toml events_api -- --nocapture`
- Expect: ingest and dedupe semantics pass all integration tests.

**Done When**

- Ingest endpoints match scoped TypeScript behavior for normal and mixed-validity payloads.
- Event write path emits downstream notifications required by dashboard flow.

### Task 6: Implement Stats Aggregation And SSE Delivery

**Objective**

Provide live stats and streaming behavior compatible with existing dashboard assumptions for scoped events.

**Files**

- Create: `rust-backend/src/api/stats.rs`
- Create: `rust-backend/src/api/stream.rs`
- Create: `rust-backend/src/sse/hub.rs`
- Create: `rust-backend/src/sse/mod.rs`
- Create: `rust-backend/tests/stream_api.rs`

**Dependencies**

- Task 5

**Implementation Steps**

1. Implement `GET /api/stats` counters required by existing dashboard top-line widgets.
2. Implement `GET /api/stream` SSE endpoint with `event`, `stats`, and `session_update` event names.
3. Add heartbeat and max-client enforcement matching configured limits.
4. Emit periodic stats updates and immediate event/session updates on ingest.
5. Add tests for SSE connect, max-client `503` behavior, and disconnect cleanup.

**Verification**

- Run: `cargo test --manifest-path rust-backend/Cargo.toml stream_api -- --nocapture`
- Expect: SSE behavior, backpressure guard, and stats broadcasts pass.

**Done When**

- Dashboard can consume scoped SSE messages from Rust service without protocol changes.
- Max-client and cleanup behavior are test-covered.

### Task 7: Add Black-Box Parity Harness Across TypeScript And Rust

**Objective**

Create a shared HTTP parity test suite that can execute unchanged against both runtimes.

**Files**

- Create: `tests/parity/events-parity.test.ts`
- Create: `tests/parity/stats-stream-parity.test.ts`
- Create: `tests/parity/helpers/runtime.ts`
- Modify: `package.json`
- Modify: `README.md`

**Dependencies**

- Task 6

**Implementation Steps**

1. Build parity tests that target `AGENTMONITOR_BASE_URL` instead of importing server internals.
2. Cover contract-critical scenarios from scoped endpoints (validation, dedupe, batch rejection, SSE limits).
3. Add scripts `test:parity:ts` and `test:parity:rust` that launch each runtime and run the same suite.
4. Record parity summary output in machine-readable format (`json` artifact).

**Verification**

- Run: `pnpm run test:parity:ts`
- Expect: TypeScript baseline parity suite passes.
- Run: `pnpm run test:parity:rust`
- Expect: Rust parity suite passes with identical test expectations.

**Done When**

- One test suite validates both implementations.
- Parity regressions are visible as deterministic test failures.

### Task 8: Benchmark Throughput, Latency, And Runtime Stability

**Objective**

Generate comparable runtime evidence to evaluate whether Rust improves key backend characteristics.

**Files**

- Create: `scripts/bench/compare-ts-vs-rust.ts`
- Create: `docs/plans/2026-02-24-rust-backend-spike-benchmark-results.md`
- Modify: `README.md`

**Dependencies**

- Task 7

**Implementation Steps**

1. Run ingest benchmark for both runtimes using identical workload parameters.
2. Capture throughput and latency distributions (including p95).
3. Capture memory footprint (idle RSS, peak RSS under load) and startup time for both runtimes.
4. Measure release binary size for Rust vs `node_modules` + runtime size for TypeScript.
5. Run 30-minute soak with continuous ingest + SSE client to surface leak/crash behavior, sampling RSS periodically to detect unbounded growth.
6. Document measured deltas and caveats (hardware, warmup, build profile).

**Verification**

- Run: `pnpm run bench:ingest -- --events=20000 --concurrency=40 --batch-size=50`
- Expect: baseline TypeScript benchmark result captured.
- Run: `pnpm run rust:bench -- --events=20000 --concurrency=40 --batch-size=50`
- Expect: Rust benchmark result captured with comparable metrics.

**Done When**

- Benchmark document contains side-by-side metrics (throughput, p95 latency, memory, binary size, startup time) and methodology.
- Stability soak result is clearly marked pass/fail with RSS samples over time.

### Task 9: Produce Go/No-Go Decision Packet

**Objective**

Close the spike with an explicit architecture recommendation and next implementation track.

**Files**

- Create: `docs/plans/2026-02-24-rust-backend-spike-decision.md`
- Modify: `docs/project/ROADMAP.md`
- Modify: `docs/system/ARCHITECTURE.md`

**Dependencies**

- Task 8

**Implementation Steps**

1. Summarize parity results, benchmark outcomes, and unresolved gaps.
2. Grade spike against criteria from Task 1.
3. Recommend one path:
   - proceed with phased Rust migration
   - continue Electron-first TypeScript path
   - run a second focused spike (if evidence is inconclusive)
4. Define immediate next milestone and cutoff date to avoid decision drift.

**Verification**

- Run: `rg -n "Recommendation|Go|No-Go|Parity|Performance|Risks|Next milestone" docs/plans/2026-02-24-rust-backend-spike-decision.md`
- Expect: decision packet includes required sections and explicit recommendation.

**Done When**

- Decision outcome is explicit and time-bounded.
- Roadmap and architecture docs reflect the selected path.

## Risks And Mitigations

- Risk: Schema/contract drift between TypeScript and Rust causes false confidence.
  Mitigation: shared black-box parity suite and schema compatibility tests before benchmarking.
- Risk: Spike scope expands into full rewrite and misses time-box.
  Mitigation: strict endpoint scope and hard stop at Task 9 decision gate.
- Risk: Misleading benchmark due to non-equivalent runtime settings.
  Mitigation: fixed workload profile, warmup phase, and documented environment in results.
- Risk: SSE behavior differs subtly under load.
  Mitigation: explicit max-client, disconnect cleanup, and soak verification in dedicated tests.
- Risk: Team context splits across two runtimes prematurely.
  Mitigation: keep TypeScript as default runtime until go decision is approved.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Spike success criteria are explicit | `rg -n "parity|soak|throughput|go/no-go" docs/plans/adr/2026-02-24-rust-backend-spike-decision-record.md` | Criteria are documented before coding begins |
| Rust service boots with health endpoint | `pnpm run rust:dev` | Service starts and `/api/health` returns `200` |
| SQLite compatibility for scoped tables | `cargo test --manifest-path rust-backend/Cargo.toml schema_compatibility -- --nocapture` | Schema compatibility tests pass |
| Contract validation parity on edge cases | `cargo test --manifest-path rust-backend/Cargo.toml event_contract -- --nocapture` | Invalid payloads are rejected with expected structure |
| Ingest dedupe and batch reporting parity | `cargo test --manifest-path rust-backend/Cargo.toml events_api -- --nocapture` | Dedupe/rejection behavior matches scoped expectations |
| SSE behavior parity under limits | `cargo test --manifest-path rust-backend/Cargo.toml stream_api -- --nocapture` | Stream events, max-client `503`, and cleanup checks pass |
| Same parity suite passes on both runtimes | `pnpm run test:parity:ts && pnpm run test:parity:rust` | No expectation changes between runtime targets |
| Performance and stability evidence captured | `pnpm run bench:ingest -- --events=20000 --concurrency=40 --batch-size=50 && pnpm run rust:bench -- --events=20000 --concurrency=40 --batch-size=50` | Comparable benchmark and soak artifacts produced |
| Runtime footprint comparison documented | Check `docs/plans/2026-02-24-rust-backend-spike-benchmark-results.md` | Memory (idle + peak RSS), binary size, and startup time for both runtimes |
| Final architecture decision is explicit | `rg -n "Recommendation|Go|No-Go|Next milestone" docs/plans/2026-02-24-rust-backend-spike-decision.md` | Decision packet states path and immediate next milestone |

## Handoff

Plan complete and saved to docs/plans/2026-02-24-rust-backend-spike-implementation.md.

1. Execute in this session, task by task.
2. Open a separate execution session.
3. Refine this plan before implementation.
