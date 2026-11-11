// A session has two lifecycles, owned by different tables and driven by
// different producers. They share the word "active" but not its meaning, so
// name the set you mean instead of repeating literals.
//
// Monitor status (`sessions.status`): the event stream's view, which drives the
// Monitor's agent cards and its session counts. Ingested events move a session
// to `active`. A `session_end` moves it to `idle` (Claude Code, so the card
// lingers for one timeout) or to `ended`. The periodic sweep
// (`updateIdleSessions` in `src/db/queries.ts`) moves `active` to `idle` after
// one session timeout without events, and `idle` to `ended` after two. The
// server owns every transition and broadcasts the sweep's results, so the
// browser applies them rather than re-deriving them.
//
// Live status (`browsing_sessions.live_status`): the session browser's view,
// projected from session files and live telemetry. `live` means activity in
// the last five minutes, `active` in the last fifteen, and `ended` after that.
// `available` means the session is known but has no activity time.
// Readers re-derive a stored `live` or `active` from the last activity
// (`src/live/live-status.ts`), because a quiet producer never writes again.

const _MONITOR_SESSION_STATUSES = ['active', 'idle', 'ended'] as const;
export type MonitorSessionStatus = (typeof _MONITOR_SESSION_STATUSES)[number];

const _LIVE_STATUSES = ['live', 'active', 'available', 'ended'] as const;
export type LiveStatus = (typeof _LIVE_STATUSES)[number];

/** Live statuses that mean activity in the last fifteen minutes. */
export const RECENT_LIVE_STATUSES = ['live', 'active'] as const satisfies readonly LiveStatus[];

/** Live statuses of a session that has not ended, and so may still be producing activity. */
export const OPEN_LIVE_STATUSES = ['live', 'active', 'available'] as const satisfies readonly LiveStatus[];

const OPEN_LIVE_STATUS_SET = new Set<string>(OPEN_LIVE_STATUSES);

export function isOpenLiveStatus(status: string | null | undefined): boolean {
  return status != null && OPEN_LIVE_STATUS_SET.has(status);
}

/** One session the Monitor sweep moved, and the status it now has. */
export interface MonitorSessionTransition {
  session_id: string;
  status: Exclude<MonitorSessionStatus, 'active'>;
}
