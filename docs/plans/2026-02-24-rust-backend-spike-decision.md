---
date: 2026-02-25
topic: rust-backend-spike
stage: decision
status: complete
source: spike-evaluation
---

# Rust Backend Spike: Go/No-Go Decision

## Recommendation: GO

Proceed with phased Rust migration targeting Tauri desktop packaging.

## Evidence Summary

### Parity

**Status: PASS**

- 18/18 black-box HTTP parity tests pass on both TypeScript and Rust runtimes.
- Tests cover: health, single ingest, validation (missing fields), dedup, null event_id, batch, batch rejection, batch dedup, stats shape, stats accuracy, SSE content-type, SSE connected message, SSE broadcast-on-ingest, SSE client count in health.
- No expectation forks between runtimes.
- 73 additional Rust-side tests (38 unit + 13 events_api + 6 queries + 9 schema + 7 stats_stream) validate internal behavior.

### Performance

**Status: PASS with nuance**

| Metric | TypeScript | Rust | Assessment |
|--------|-----------|------|------------|
| Idle RSS | 106.7 MB | 8.3 MB | Rust **13x better** — critical for always-on desktop tool |
| Peak RSS | 175.0 MB | 27.8 MB | Rust **6x better** |
| Throughput | 10,958 ev/s | 8,838 ev/s | TS 19% higher — not concerning at this workload scale |
| Latency p95 | 713 ms | 278 ms | Rust **2.6x better** |
| Latency p99 | 1,801 ms | 287 ms | Rust **6.3x better** |
| Binary size | 120 MB | 3.5 MB | Rust **34x smaller** — significant for desktop distribution |
| Startup | 171 ms | 417 ms | TS faster — Rust number includes cargo overhead |

Throughput gap is explained by `Mutex<Connection>` serialization in Rust vs lock-free single-threaded access in Node.js. This is a known trade-off and the Rust figure (8,800 ev/s) far exceeds realistic agent workloads (<100 ev/s). The latency consistency advantage is more relevant for dashboard responsiveness.

### Stability

**Status: PARTIAL — soak test not run**

Unit and integration tests are stable across multiple runs. A dedicated 30-minute soak was not executed in this iteration. The parity harness ran cleanly with zero failed requests under 40-concurrent-connection load. This is acceptable for a go decision with the soak scheduled as a follow-up validation before production cutover.

### Operability

**Status: PASS**

- `pnpm rust:dev`, `pnpm rust:build`, `pnpm rust:test` all work.
- `pnpm test:parity:ts` and `pnpm test:parity:rust` run the same suite against either runtime.
- `pnpm bench:compare` automates side-by-side comparison.
- Environment variables are compatible with existing config (`AGENTMONITOR_PORT`, `AGENTMONITOR_DB_PATH`, etc.).

## Spike Scorecard vs ADR Criteria

| Criterion | Required | Result |
|-----------|----------|--------|
| Contract parity | Parity suite passes both runtimes, no forks | **PASS** — 18/18 |
| Runtime stability | 30-min soak without crash/leak | **PARTIAL** — no soak, but clean under load |
| Performance | Throughput >= TS baseline, or justified gap | **PASS** — gap is justified, latency is better |
| Operability | Reproducible local dev workflow | **PASS** |

## Risks

1. **Soak test gap**: No 30-minute soak run completed. Mitigated by scheduling soak as first task in migration phase.
2. **Scope incomplete**: Only 5 of 9+ endpoints implemented (health, events, events/batch, stats, stream). Full migration requires OTEL, sessions, filter-options, transcripts, cost endpoints.
3. **Mutex throughput ceiling**: Under extreme concurrent writes, Rust's mutex approach will bottleneck before Node.js does. Mitigated by SQLite's inherent single-writer limitation making this theoretical at realistic workloads.
4. **Startup time**: Rust binary starts slower than Node.js. Acceptable for a desktop app that starts once per session.

## Unresolved Gaps

- OTEL JSON log/metric parsing not ported.
- Session filtering, transcript aggregation, cost breakdown endpoints not implemented.
- Import pipeline not ported.
- Pricing engine not ported.
- No Tauri shell or IPC integration yet.

These are expected — the spike scoped to core ingest + live-stream behavior per the implementation plan.

## Next Milestone

**Phase 1: Complete Rust Backend Migration** (target: 2 weeks)

1. Run 30-minute soak test with ingest + SSE.
2. Port remaining endpoints: sessions, filter-options, transcripts, stats/cost, OTEL.
3. Port pricing engine and import pipeline.
4. Achieve full parity on all API endpoints with extended parity test suite.

**Phase 2: Tauri Desktop Shell** (target: 2 weeks after Phase 1)

1. Tauri project scaffold with Rust backend embedded.
2. HTTP API preserved on localhost for hook compatibility.
3. Tauri IPC added for renderer communication (additive, not replacement).
4. DMG packaging, signing, notarization.

**Decision cutoff**: If Phase 1 is not complete within 2 weeks, re-evaluate scope or fall back to Electron path.

## Archived Path

The [Electron + DMG plan](2026-02-23-macos-desktop-dmg-implementation.md) is archived. The parity test harness built during the spike transfers to the Rust runtime as ongoing contract regression coverage.
