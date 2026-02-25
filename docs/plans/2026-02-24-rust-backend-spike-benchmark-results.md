---
date: 2026-02-25
topic: rust-backend-spike
stage: benchmark-results
status: complete
source: automated
---

# Rust Backend Spike Benchmark Results

## Environment

- **Hardware**: Apple Silicon (arm64), 10 CPUs, 32GB RAM
- **OS**: macOS Darwin 25.2.0
- **Node.js**: v24.13.0 (nvm)
- **Rust**: release build (optimized)
- **SQLite**: in-memory for Rust unit tests, file-backed for benchmark

## Workload Parameters

| Parameter | Value |
|-----------|-------|
| Total events | 20,000 |
| Concurrency | 40 |
| Batch size | 50 |
| Warmup events | 500 |
| Mode | batch (`POST /api/events/batch`) |
| Soak duration | not run (see notes) |

## Results

| Metric | TypeScript (Node.js) | Rust (axum + tokio) | Delta |
|--------|---------------------|--------------------|----|
| Startup time | 171ms | 417ms | +144% |
| Idle RSS | 106.7MB | 8.3MB | **-92%** |
| Peak RSS (under load) | 175.0MB | 27.8MB | **-84%** |
| Throughput | 10,958 events/s | 8,838 events/s | -19% |
| Latency p50 | 92ms | 218ms | +137% |
| Latency p95 | 713ms | 278ms | **-61%** |
| Latency p99 | 1,801ms | 287ms | **-84%** |
| Failed requests | 0 | 0 | — |
| Runtime size | 120MB (node_modules) | 3.5MB (binary) | **-97%** |
| Parity tests | 18/18 pass | 18/18 pass | — |

## Analysis

### Memory

Rust's memory footprint is dramatically lower — 13x less idle memory and 6x less under load. For a desktop tool running continuously, this is the most impactful result. A Tauri app with this backend would consume a fraction of what an Electron app with Node.js would.

### Throughput

TypeScript has ~19% higher throughput (10,958 vs 8,838 events/s). This is likely due to Rust's `Mutex<Connection>` serializing all SQLite writes, while Node.js benefits from better-sqlite3's synchronous API in a single-threaded event loop with no lock contention.

This gap is not concerning for a localhost dashboard — 8,800 events/s is far above any realistic agent workload. The bottleneck is SQLite single-writer semantics, not the HTTP layer.

### Latency

Rust's latency distribution is far more consistent:
- p50 is higher (218ms vs 92ms) — the mutex adds contention overhead at the median
- p95 is 61% lower (278ms vs 713ms) — Rust doesn't suffer Node.js GC pauses
- p99 is 84% lower (287ms vs 1,801ms) — tail latency is dramatically better

For a real-time dashboard, predictable latency matters more than median throughput.

### Startup

TypeScript starts 2.4x faster (171ms vs 417ms). The Rust figure includes cargo process launch overhead when measured via `cargo run`. The raw binary startup (direct execution) would be significantly faster. Both are well under 1 second, which is acceptable for a desktop app.

### Binary Size

Rust binary is 3.5MB vs 120MB for node_modules. This is a 34x reduction and directly impacts Tauri packaging size vs Electron.

## Caveats

- Single run, not averaged across multiple iterations
- TypeScript server was using file-backed SQLite; Rust was too (temp file)
- No SSE client load during benchmark (ingest-only workload)
- Soak test not run in this iteration — would need a dedicated 30-minute run
- Rust throughput could be improved with connection pooling or sharded writes

## Raw Data

Machine-readable results: [`benchmark-results.json`](benchmark-results.json)

## Reproduction

```sh
# Build Rust release binary first
pnpm rust:build

# Run comparison
pnpm bench:compare -- --events=20000 --concurrency=40 --batch-size=50
```
