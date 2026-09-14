# API Docs

AgentMonitor exposes a v1 compatibility layer and a canonical v2 application
contract. Exact routes are executable source facts; this page records ownership
and directs readers to the relevant contract.

## v1 Compatibility Surface

V1 owns event and OTLP ingestion, provider quota bridges, the shared SSE stream,
and legacy reads retained by parity and ingestion-readback tests. The removed
legacy dashboard has no v1 read consumer in the product.

- Ingest semantics: [event-contract.md](event-contract.md)
- Route source: [../../src/api/router.ts](../../src/api/router.ts)

## v2 Canonical App Contract

The Svelte app and agent-first CLI consume v2. Its route families cover Monitor,
Live, sessions, search, analytics, usage, insights, benchmarks, trace quality,
operational metrics, pins, skill context, and filter metadata.

- Route source and response wiring: [../../src/api/v2/router.ts](../../src/api/v2/router.ts)
- Query contracts: [../../src/db/v2-queries.ts](../../src/db/v2-queries.ts)

Response-shape compatibility is enforced by the API and CLI test suites. Add
durable semantics here or in a focused contract document when an external client
needs more than the TypeScript route and query definitions.

## Related Docs

- Product surface and feature notes: [../system/FEATURES.md](../system/FEATURES.md)
- Architecture and data flow: [../system/ARCHITECTURE.md](../system/ARCHITECTURE.md)
- Runtime and integration setup: [../system/OPERATIONS.md](../system/OPERATIONS.md)
