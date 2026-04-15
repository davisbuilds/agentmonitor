# API Docs

AgentMonitor currently exposes two API layers.

## v1 Compatibility Surface

Used by ingest clients and some current Monitor behaviors.

- Event ingest contract: [event-contract.md](event-contract.md)
- Main endpoints: `/api/events`, `/api/events/batch`, `/api/stats`, `/api/sessions`, `/api/stream`, `/api/otel/v1/*`

## v2 Canonical App Contract

Used by the canonical Svelte app at `/app/`.

- Session browsing: `/api/v2/sessions`, `/api/v2/sessions/:id`, `/api/v2/sessions/:id/messages`, `/api/v2/sessions/:id/children`
- Live ops: `/api/v2/live/settings`, `/api/v2/live/sessions`, `/api/v2/live/sessions/:id`, `/api/v2/live/sessions/:id/turns`, `/api/v2/live/sessions/:id/items`, `/api/v2/live/stream`
- Search and analytics: `/api/v2/search`, `/api/v2/analytics/summary`, `/api/v2/analytics/activity`, `/api/v2/analytics/projects`, `/api/v2/analytics/tools`
- Filter metadata: `/api/v2/projects`, `/api/v2/agents`

The current TypeScript route entrypoint for v2 is [../../src/api/v2/router.ts](../../src/api/v2/router.ts).

## Related Docs

- Product surface and feature notes: [../system/FEATURES.md](../system/FEATURES.md)
- Architecture and data flow: [../system/ARCHITECTURE.md](../system/ARCHITECTURE.md)
- Runtime and integration setup: [../system/OPERATIONS.md](../system/OPERATIONS.md)
