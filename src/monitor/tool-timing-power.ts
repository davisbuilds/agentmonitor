import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface PowerHistory {
  coveredRanges: TimeRange[];
  sleepRanges: TimeRange[];
}

export interface SleepOverlap {
  coverage: 'complete' | 'partial' | 'unknown';
  sleepOverlapMs: number | null;
  coveredMs: number;
}

interface PowerArchive {
  date: string;
  text: string;
}

type Transition = 'sleep' | 'dark-entry' | 'dark-wake' | 'wake' | 'promotion' | 'start' | 'boundary';

interface PowerRecord {
  id: number;
  timestampMs: number;
  pid: number;
  transition: Transition | null;
}

const DAY_MS = 86_400_000;
const POWER_ARCHIVE_DIR = '/var/log/powermanagement';
const ARCHIVE_NAME = /^(\d{4}\.\d{2}\.\d{2})\.asl$/;
const MAX_ARCHIVES = 32;
const ASL_FORMAT = '$(ASLMessageID)\t$(Time)\t$(TimeNanoSec)\t$(Host)\t$(PID)\t$(com.apple.iokit.domain)\t$(signature)\t$(Message)';
const execFileAsync = promisify(execFile);

function archiveDay(date: string): number {
  return Date.parse(date.replaceAll('.', '-') + 'T00:00:00Z');
}

function shortHost(host: string): string {
  return host.split('.')[0].toLowerCase();
}

function transitionOf(domain: string, signature: string, message: string): Transition | null {
  if (domain === 'Start') return 'start';
  if (domain === 'Shutdown' || domain === 'Restart') return 'boundary';
  if (domain !== 'Sleep' && domain !== 'DarkWake' && domain !== 'Wake') return null;
  if (signature !== 'success') return 'boundary';
  if (domain === 'Sleep' && message.startsWith('Entering Sleep state')) return 'sleep';
  if (domain === 'Sleep' && message.startsWith('Entering DarkWake state')) return 'dark-entry';
  if (domain === 'DarkWake' && message.startsWith('DarkWake from ')) return 'dark-wake';
  if (domain === 'Wake' && message.startsWith('Wake from ')) return 'wake';
  if (domain === 'Wake' && message.startsWith('DarkWake to FullWake')) return 'promotion';
  return 'boundary';
}

function parseRecords(text: string, host: string): PowerRecord[] {
  const records: PowerRecord[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const [rawId, rawSeconds, rawNanos, recordHost, rawPid, domain, signature, message] = line.split('\t', 8);
    if (message === undefined || shortHost(recordHost) !== host
      || ![rawId, rawSeconds, rawNanos, rawPid].every(value => /^\d+$/.test(value))) return [];
    const [id, seconds, nanos, pid] = [rawId, rawSeconds, rawNanos, rawPid].map(Number);
    if (![id, seconds, nanos, pid].every(Number.isSafeInteger) || nanos >= 1_000_000_000) return [];
    const timestampMs = seconds * 1000 + nanos / 1_000_000;
    const previous = records.at(-1);
    if (previous && previous.timestampMs > timestampMs) return [];
    records.push({ id, timestampMs, pid, transition: transitionOf(domain, signature, message) });
  }
  return records;
}

function validRange({ startMs, endMs }: TimeRange): boolean {
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs < endMs;
}

function appendRange(ranges: TimeRange[], startMs: number, endMs: number): void {
  if (startMs >= endMs) return;
  const previous = ranges.at(-1);
  if (previous && previous.endMs >= startMs) {
    previous.endMs = Math.max(previous.endMs, endMs);
  } else {
    ranges.push({ startMs, endMs });
  }
}

function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const merged: TimeRange[] = [];
  for (const { startMs, endMs } of ranges.filter(validRange).sort((a, b) => a.startMs - b.startMs)) {
    appendRange(merged, startMs, endMs);
  }
  return merged;
}

function durationMs(ranges: readonly TimeRange[]): number {
  return ranges.reduce((total, range) => total + (range.endMs - range.startMs), 0);
}

export function unionDurationMs(ranges: readonly TimeRange[]): number {
  return durationMs(mergeRanges(ranges));
}

const previousTransitions: Record<Exclude<Transition, 'start' | 'boundary'>, readonly Transition[]> = {
  sleep: ['start', 'wake', 'promotion', 'dark-wake', 'dark-entry'],
  'dark-entry': ['start', 'wake', 'promotion'],
  'dark-wake': ['sleep'],
  wake: ['sleep'],
  promotion: ['dark-wake', 'dark-entry'],
};

/** Infer only intervals supported by a consistent transition sequence in local ASL records. */
export function parsePowerArchives(archives: readonly PowerArchive[], host: string): PowerHistory | null {
  const coveredRanges: TimeRange[] = [];
  const sleepRanges: TimeRange[] = [];
  let anchor: PowerRecord | null = null;
  let previous: PowerRecord | null = null;
  let previousDay = NaN;

  function closeSegment(): void {
    if (anchor && anchor.transition !== 'sleep' && previous) {
      appendRange(coveredRanges, anchor.timestampMs, previous.timestampMs);
    }
    anchor = null;
  }

  for (const archive of [...archives].sort((a, b) => a.date.localeCompare(b.date))) {
    const day = archiveDay(archive.date);
    if (!Number.isFinite(day)) continue;
    const records = parseRecords(archive.text, shortHost(host));
    if (records.length === 0) continue;
    if (previous && records[0].timestampMs < previous.timestampMs) return null;
    if (day !== previousDay + DAY_MS) closeSegment();
    previousDay = day;
    for (const record of records) {
      const { transition, timestampMs, id, pid } = record;
      if (previous && (id !== previous.id + 1 || pid !== previous.pid || transition === 'start')) {
        closeSegment();
      }
      if (transition === 'boundary') {
        anchor = null;
      } else if (transition) {
        if (transition !== 'start' && anchor?.transition && previousTransitions[transition].includes(anchor.transition)) {
          appendRange(coveredRanges, anchor.timestampMs, timestampMs);
          if (anchor.transition === 'sleep') appendRange(sleepRanges, anchor.timestampMs, timestampMs);
        }
        anchor = record;
      }
      previous = record;
    }
  }
  closeSegment();
  return coveredRanges.length > 0 ? { coveredRanges, sleepRanges } : null;
}

function firstIntervalAfter(intervals: readonly TimeRange[], startMs: number): number {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (intervals[middle].endMs <= startMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function overlapDuration(ranges: readonly TimeRange[], intervals: readonly TimeRange[]): number {
  let total = 0;
  for (const { startMs, endMs } of ranges) {
    for (let index = firstIntervalAfter(intervals, startMs); index < intervals.length; index++) {
      const interval = intervals[index];
      if (interval.startMs >= endMs) break;
      total += Math.min(endMs, interval.endMs) - Math.max(startMs, interval.startMs);
    }
  }
  return total;
}

/** Measures one call or a union of concurrent calls against the same host history. */
export function measureSleepOverlap(ranges: readonly TimeRange[], history: PowerHistory | null): SleepOverlap {
  const merged = mergeRanges(ranges);
  const coveredMs = history ? overlapDuration(merged, history.coveredRanges) : 0;
  if (!history || coveredMs === 0) return { coverage: 'unknown', sleepOverlapMs: null, coveredMs: 0 };
  return {
    coverage: coveredMs === durationMs(merged) ? 'complete' : 'partial',
    sleepOverlapMs: overlapDuration(merged, history.sleepRanges),
    coveredMs,
  };
}

/** Reads only relevant daily archives from this macOS host. Callers must establish source host attribution. */
export async function readLocalPowerHistory(ranges: readonly TimeRange[]): Promise<PowerHistory | null> {
  if (process.platform !== 'darwin') return null;
  const merged = mergeRanges(ranges);
  if (merged.length === 0) return null;
  const signal = AbortSignal.timeout(5_000);
  try {
    const entries = await readdir(POWER_ARCHIVE_DIR, { withFileTypes: true });
    const files = entries.filter(entry => entry.isFile() && ARCHIVE_NAME.test(entry.name))
      .map(entry => ({ name: entry.name, date: entry.name.slice(0, -4) }))
      .filter(({ date }) => {
        const day = archiveDay(date);
        // Allow for local day boundaries and neighboring transition evidence.
        return merged.some(({ startMs, endMs }) => startMs < day + 3 * DAY_MS && endMs > day - 2 * DAY_MS);
      })
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-MAX_ARCHIVES);
    const archives: PowerArchive[] = [];
    for (const { name, date } of files) {
      if (signal.aborted) break;
      try {
        const { stdout } = await execFileAsync('/usr/bin/syslog', [
          '-f', join(POWER_ARCHIVE_DIR, name), '-nodc', '-T', 'sec', '-F', ASL_FORMAT, '-k', 'Sender', 'powerd',
        ], { timeout: 1_000, maxBuffer: 2 * 1024 * 1024, signal });
        archives.push({ date, text: stdout });
      } catch {
        // An unreadable archive leaves a gap between any neighboring files.
      }
    }
    return parsePowerArchives(archives, hostname());
  } catch {
    return null;
  }
}
