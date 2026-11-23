
import { RECENT_LIVE_STATUSES } from '../contracts/session-lifecycle.js';
import { sqlStringList } from '../util/sql-literals.js';

const RECENT_LIVE_STATUS_SET = new Set<string>(RECENT_LIVE_STATUSES);
const LIVE_WINDOW_MS = 5 * 60_000;
const ACTIVE_WINDOW_MS = 15 * 60_000;

const ACTIVITY_TIME = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?(Z|[+-]\d{2}:\d{2})?$/;
const ACTIVITY_TIME_GLOB = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*';

function activityTimeMs(value: string): number {
  const match = ACTIVITY_TIME.exec(value);
  if (!match) return Number.NaN;
  const [, date, time, offset] = match;
  return Date.parse(`${date}T${time ?? '00:00'}${offset ?? 'Z'}`);
}

/** The status a session last active at `lastActivityAt` has at `now`. */
export function liveStatusFromActivity(lastActivityAt: string | null, now: number = Date.now()): string {
  if (!lastActivityAt) return 'available';
  const idleMs = now - activityTimeMs(lastActivityAt);
  if (Number.isNaN(idleMs)) return 'available';
  if (idleMs <= LIVE_WINDOW_MS) return 'live';
  if (idleMs <= ACTIVE_WINDOW_MS) return 'active';
  return 'ended';
}

/** What a stored status means at `now`. */
export function effectiveLiveStatus(
  stored: string | null,
  lastActivityAt: string | null,
  now: number = Date.now(),
): string | null {
  if (!RECENT_LIVE_STATUS_SET.has(stored ?? '')) return stored;
  if (!lastActivityAt || Number.isNaN(activityTimeMs(lastActivityAt))) return stored;
  return liveStatusFromActivity(lastActivityAt, now);
}

/**
 * SQL for `effectiveLiveStatus` over a browsing_sessions row. `nowIso` pins the
 * instant (an ISO timestamp from `Date#toISOString`); it defaults to SQLite's now.
 */
export function effectiveLiveStatusSql(alias = '', nowIso?: string): string {
  if (nowIso !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(nowIso)) {
    throw new Error(`effectiveLiveStatusSql: not an ISO instant: ${nowIso}`);
  }
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  const stored = column('live_status');
  const activity = `COALESCE(${column('last_item_at')}, ${column('ended_at')})`;
  const now = nowIso === undefined ? "'now'" : `'${nowIso}'`;
  const idleMs = `CAST(round((julianday(${now}) - julianday(${activity})) * 86400000.0) AS INTEGER)`;
  return `(CASE WHEN ${stored} IN (${sqlStringList(RECENT_LIVE_STATUSES)}) AND ${activity} GLOB '${ACTIVITY_TIME_GLOB}'
      AND julianday(${activity}) IS NOT NULL THEN
      CASE WHEN ${idleMs} <= ${LIVE_WINDOW_MS} THEN 'live'
        WHEN ${idleMs} <= ${ACTIVE_WINDOW_MS} THEN 'active'
        ELSE 'ended' END
    ELSE ${stored} END)`;
}
