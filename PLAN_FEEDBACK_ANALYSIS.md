# PLAN Feedback Analysis and P0 Implementation Recommendations

This document evaluates external feedback against the current codebase and defines what to adopt now.

## Executive Decision

- Proceed with the current architecture.
- Do not migrate from Express to Fastify in P0.
- Adopt P0 hardening immediately around contract validation, normalization, timestamps, and payload truncation semantics.

## Feedback Triage

### 1) Express vs Fastify

Decision: **Defer migration**.

Reason:
- Current bottleneck risk is schema drift and ingest correctness, not framework overhead.
- Migration cost is non-trivial and would delay contract hardening.

Action:
- Keep Express.
- Add explicit ingest validation + normalization middleware logic now.

### 2) Event schema consistency

Decision: **Adopt now**.

Risks observed:
- Validation currently checks only field presence.
- No canonical enum enforcement for `event_type`/`status`.
- Client-side timestamp is not explicitly stored.

Action:
- Add canonical event contract module (types + runtime normalization/validation).
- Enforce enums for `event_type` and `status`.
- Add `client_timestamp` field (while preserving server receive timestamp in `created_at`).

### 3) SSE scalability details

Decision: **Partially adopt now, defer replay mechanics**.

Action now:
- Keep heartbeat and disconnect cleanup (already present).
- Keep current simple fan-out for MVP.

Defer:
- `Last-Event-ID` replay / cursor gap recovery.
- Higher-scale client fan-out architecture.

### 4) Session lifecycle determinism

Decision: **Adopt via tests and docs**.

Current behavior:
- `session_end` transitions session to `ended`.
- Idle checker only marks `active` sessions idle.
- Upsert logic does not resurrect ended sessions.

Action:
- Keep logic.
- Add tests documenting and locking behavior.

### 5) Payload truncation policy

Decision: **Adopt now**.

Risks observed:
- Existing truncation is character-count based, not UTF-8 byte-safe.
- No explicit marker that payload was truncated.

Action:
- Implement UTF-8 byte-safe truncation.
- Add `payload_truncated` persisted field.
- Preserve key metadata fields in object payloads when truncation occurs.

## P0 Scope (Approved)

1. Canonical event contract + normalization module.
2. Strict validation at ingest (`POST /api/events`, `POST /api/events/batch`).
3. Add `client_timestamp` support.
4. UTF-8 byte-safe metadata truncation.
5. Persist `payload_truncated` flag.
6. Improve batch ingest response semantics with rejected/duplicate accounting.
7. Add test suite coverage for all above.
8. Add a small event contract doc with Claude/Codex examples.

## Deferred (Post-P0)

1. Fastify migration.
2. SSE replay/cursor support.
3. Retention pruning daemon and policy enforcement.
4. Throughput benchmark harness beyond basic ingest tests.

## Implementation Order

1. Introduce contract and normalizer.
2. Update schema and migration-safe column initialization.
3. Update query insertion path and truncation logic.
4. Update API route handlers to use normalization + richer ingest responses.
5. Add and run tests.
6. Update docs.
