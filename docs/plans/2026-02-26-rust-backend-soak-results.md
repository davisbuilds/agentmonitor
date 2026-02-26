---
date: 2026-02-26
topic: rust-backend-soak
stage: validation
status: complete
source: phase-1-followup
---

# Rust Backend 30-Minute Soak Results

## Result: PASS

Run target:
- Runtime: Rust backend (`pnpm rust:dev`) on `127.0.0.1:3142`
- Duration: 30 minutes (`1802.8s`)
- Load: continuous batch ingest (`2` workers, batch size `10`)
- Live stream check: persistent SSE client connected for full run

Key outcomes:
- `sentEvents`: `315,850`
- `receivedEvents`: `315,850`
- `failedRequests`: `0` (`requestFailureRate = 0`)
- `healthFailures`: `0` across `180` health checks
- `sseConnectedAtLeastOnce`: `true`
- `sseFrames`: `315,851`
- `rssGrowthRatio`: `0.933` (stable; threshold `< 1.5`)
- Final verdict: `pass: true`

Raw artifact:
- [`2026-02-26-rust-backend-soak-summary.json`](./2026-02-26-rust-backend-soak-summary.json)
