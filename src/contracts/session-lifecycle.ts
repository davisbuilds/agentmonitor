// WHY: The Monitor follows ingested events while the session browser follows transcripts. Both call
// a session active, but their lifecycle boundaries differ.

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
