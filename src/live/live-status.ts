// A session's live status says how recently it was active: live within five
// minutes, active within fifteen, ended after that. Writers store the status
// they derive at write time, but a row that stops receiving writes keeps it, so
// a session whose producer simply goes quiet (most often one known only from
// telemetry) would read as live indefinitely. Readers therefore re-derive a
// stored live or active status from the session's last activity; an explicit
// end, or any other stored status, is read as stored.

const LIVE_WINDOW_MS = 5 * 60_000;
const ACTIVE_WINDOW_MS = 15 * 60_000;

// An activity time in the forms SQLite's date functions read: a date, then
// optionally a time, then optionally an offset. SQLite reads a time without an
// offset as UTC, where `new Date` reads it as local time, and offset-free times
// are still stored, so the TypeScript reading takes SQLite's.
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
  if (stored !== 'live' && stored !== 'active') return stored;
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
  // Whole milliseconds, so the boundaries agree with the TypeScript reading.
  const idleMs = `CAST(round((julianday(${now}) - julianday(${activity})) * 86400000.0) AS INTEGER)`;
  return `(CASE WHEN ${stored} IN ('live', 'active') AND ${activity} GLOB '${ACTIVITY_TIME_GLOB}'
      AND julianday(${activity}) IS NOT NULL THEN
      CASE WHEN ${idleMs} <= ${LIVE_WINDOW_MS} THEN 'live'
        WHEN ${idleMs} <= ${ACTIVE_WINDOW_MS} THEN 'active'
        ELSE 'ended' END
    ELSE ${stored} END)`;
}

