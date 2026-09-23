/**
 * The one home for "which day is this?". Every user-facing date filter and
 * daily bucket resolves days in the reporting zone — the operator's zone —
 * because the frontend sends and displays local calendar dates.
 */

import { config } from '../config.js';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// A stored timestamp with a time but no zone: SQLite's `YYYY-MM-DD HH:MM:SS`,
// or ISO without a suffix. Both are UTC by this app's storage convention.
const ZONELESS_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: string }

function wallClock(instantMs: number, zone: string): WallClock {
  const fields: Record<string, string> = {};
  for (const part of partsFormatter(zone).formatToParts(new Date(instantMs))) fields[part.type] = part.value;
  return {
    year: Number(fields.year), month: Number(fields.month), day: Number(fields.day),
    hour: Number(fields.hour), minute: Number(fields.minute), second: Number(fields.second),
    weekday: fields.weekday,
  };
}

/** How far the zone's wall clock is ahead of UTC at an instant. */
function zoneOffsetMs(instantMs: number, zone: string): number {
  const w = wallClock(instantMs, zone);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function reportingTimeZone(): string {
  return config.reportingTimeZone;
}

export function isBareDay(value: string): boolean {
  return DAY_PATTERN.test(value);
}

/** Parse a stored timestamp. Zone-less values are UTC. */
export function parseStoredTimestamp(value: string): Date | null {
  const normalized = ZONELESS_PATTERN.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The local calendar day (`YYYY-MM-DD`) a timestamp falls on. */
export function localDayOf(timestamp: string, zone = reportingTimeZone()): string | null {
  const parsed = parseStoredTimestamp(timestamp);
  if (!parsed) return null;
  const w = wallClock(parsed.getTime(), zone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Local weekday (Monday = 0) and hour a timestamp falls on. */
export function localWeekdayHour(
  timestamp: string,
  zone = reportingTimeZone(),
): { weekday: number; hour: number } | null {
  const parsed = parseStoredTimestamp(timestamp);
  if (!parsed) return null;
  const w = wallClock(parsed.getTime(), zone);
  return { weekday: WEEKDAYS.indexOf(w.weekday), hour: w.hour };
}

/**
 * The UTC instant at which a local day begins. Solved from the zone's offset at
 * that midnight, re-checked once so a DST change near midnight still lands.
 */
export function localDayStart(day: string, zone = reportingTimeZone()): string {
  const [year, month, date] = day.split('-').map(Number);
  const midnightAsUtc = Date.UTC(year, month - 1, date);
  let instant = midnightAsUtc - zoneOffsetMs(midnightAsUtc, zone);
  const corrected = midnightAsUtc - zoneOffsetMs(instant, zone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant).toISOString();
}

/** The UTC instant at which the local day after `day` begins (23 or 25 hours on DST days). */
export function localDayEndExclusive(day: string, zone = reportingTimeZone()): string {
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return localDayStart(next.toISOString().slice(0, 10), zone);
}

/** Lower bound for a `date_from` param: a bare day is its local midnight; a timestamp is itself. */
export function dateParamLowerBound(param: string, zone = reportingTimeZone()): string {
  if (isBareDay(param)) return localDayStart(param, zone);
  return parseStoredTimestamp(param)?.toISOString() ?? param;
}

/**
 * Exclusive upper bound for a `date_to` param: a bare day ends at the next local
 * midnight; a timestamp is included up to the end of its second, matching
 * SQLite `datetime()`'s whole-second precision.
 */
export function dateParamUpperExclusive(param: string, zone = reportingTimeZone()): string {
  if (isBareDay(param)) return localDayEndExclusive(param, zone);
  const parsed = parseStoredTimestamp(param);
  if (!parsed) return param;
  return new Date(Math.floor(parsed.getTime() / 1000) * 1000 + 1000).toISOString();
}
