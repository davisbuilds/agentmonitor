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

- Content-free activity reads and their coverage limits: [activity-contract.md](activity-contract.md)
- Route source and response wiring: [../../src/api/v2/router.ts](../../src/api/v2/router.ts)
- Query contracts: [../../src/db/v2-queries.ts](../../src/db/v2-queries.ts)

Response-shape compatibility is enforced by the API and CLI test suites. Add
durable semantics here or in a focused contract document when an external client
needs more than the TypeScript route and query definitions.

For `GET /api/v2/search` and `amon sessions search`, pass the response’s `cursor` to
continue the same query and sort. Omit it to start over. A malformed cursor or one
from the other sort produces HTTP 400 or CLI exit 2. A full page can return a cursor
even when the following page is empty.

`GET /api/v2/analytics/git-activity` accepts `commit_scope=mine` for commits
matching the server's Git author emails or proved by a monitored session.
The scope applies to commit counts and their coverage. With `mine`,
`author_identity_configured` tells the client whether author-email matching
was available. The endpoint returns all contributors when `commit_scope=all`
or the parameter is omitted. See [Git activity setup](../system/OPERATIONS.md)
for author aliases.

## Related Docs

- Product surface and feature notes: [../system/FEATURES.md](../system/FEATURES.md)
- Architecture and data flow: [../system/ARCHITECTURE.md](../system/ARCHITECTURE.md)
- Runtime and integration setup: [../system/OPERATIONS.md](../system/OPERATIONS.md)
