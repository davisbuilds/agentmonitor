/**
 * Events a hook could not deliver. A hook that cannot reach the server (it is
 * down, restarting, or frozen) writes the event it would have posted into this
 * spool instead of dropping it, and the server stores them when it next drains.
 *
 * The spool follows the execution-receipt rules (src/import/executions.ts): an
 * owned, non-link directory and files with no group or other permissions, read
 * without following links, bounded in size and count, and errors counted rather
 * than logged with their contents. Unlike receipts, these files are the
 * server's to consume: each is removed once stored, or set aside in `rejected/`
 * when it is not a valid event.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { normalizeIngestEvent } from '../contracts/event-contract.js';
import { insertEvent } from '../db/queries.js';
import { broadcaster } from '../sse/emitter.js';
import { safelyMaintainTraceSummaryForEvent } from '../trace-quality/service.js';

export interface HookSpoolDrain {
  /** Events stored for the first time. */
  ingested: number;
  /** Events already stored: the server got them although the hook gave up waiting. */
  duplicates: number;
  /** Files that are not a valid event, moved to `rejected/` for inspection. */
  rejected: number;
  /** Files left in place: unsafe, unreadable, or a failed write; the next drain retries. */
  errors: number;
}

/**
 * `<order>-<event id>.json`, which the hooks write by renaming a dot-prefixed
 * temporary file. The order is the hook's clock when the event happened, in
 * microseconds since the epoch where it can tell (`0` where it cannot), so
 * events of the same second replay in the order they happened.
 */
const SPOOL_FILE = /^\d{1,20}-[A-Za-z0-9._-]{1,128}\.json$/;
/** Hooks stop spooling at this many files; a drain reads no more than this. */
const HOOK_SPOOL_MAX_FILES = 10_000;
const DRAIN_INTERVAL_MS = 60_000;
const MAX_FILE_BYTES = 1024 * 1024;

function privateTo(info: fs.Stats, uid: number | undefined): boolean {
  return (info.mode & 0o077) === 0 && (uid === undefined || info.uid === uid);
}

/** Read one spooled file without following a link, or null when it is not a safe, owned file. */
function readSpooled(file: string, uid: number | undefined): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > MAX_FILE_BYTES || !privateTo(info, uid)) return null;
    return fs.readFileSync(fd, 'utf8');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function setAside(directory: string, name: string): void {
  const rejected = path.join(directory, 'rejected');
  fs.mkdirSync(rejected, { recursive: true, mode: 0o700 });
  fs.renameSync(path.join(directory, name), path.join(rejected, name));
}

/**
 * Store the events hooks spooled while the server could not take them, oldest
 * first, then remove each file. Event ids make this safe to repeat: an event
 * the server already stored is dropped as a duplicate.
 */
export function drainHookSpool(directory: string): HookSpoolDrain {
  const drain: HookSpoolDrain = { ingested: 0, duplicates: 0, rejected: 0, errors: 0 };
  const uid = process.getuid?.();
  let names: string[];
  try {
    const root = fs.lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || !privateTo(root, uid)) {
      drain.errors += 1;
      return drain;
    }
    names = fs.readdirSync(directory).filter(name => SPOOL_FILE.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') drain.errors += 1;
    return drain;
  }
  // Oldest first. BigInt: a microsecond key outgrows exact Number comparison.
  const order = (name: string) => BigInt(name.slice(0, name.indexOf('-')));
  names.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : a.localeCompare(b)));

  for (const name of names.slice(0, HOOK_SPOOL_MAX_FILES)) {
    const file = path.join(directory, name);
    try {
      const body = readSpooled(file, uid);
      if (body === null) {
        drain.errors += 1;
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        value = undefined;
      }
      const parsed = value === undefined ? null : normalizeIngestEvent(value);
      if (!parsed?.ok) {
        setAside(directory, name);
        drain.rejected += 1;
        continue;
      }
      const stored = insertEvent(parsed.event, { replayed: true });
      if (stored) {
        drain.ingested += 1;
        safelyMaintainTraceSummaryForEvent(stored.id, 'hook spool drain');
      } else {
        drain.duplicates += 1;
      }
      fs.rmSync(file, { force: true });
    } catch {
      drain.errors += 1;
    }
  }
  return drain;
}

/** What the server's drains have done since it started, for /api/health. */
const totals: HookSpoolDrain = { ingested: 0, duplicates: 0, rejected: 0, errors: 0 };
let timer: ReturnType<typeof setInterval> | null = null;

function drainConfiguredSpool(): void {
  const drain = drainHookSpool(config.hookSpoolDir);
  const errorsBefore = totals.errors;
  for (const key of Object.keys(totals) as Array<keyof HookSpoolDrain>) totals[key] += drain[key];
  if (drain.ingested > 0 || drain.duplicates > 0 || drain.rejected > 0) {
    console.log(`[hook-spool] stored ${drain.ingested} event(s) hooks could not deliver`
      + `, dropped ${drain.duplicates} already stored, set aside ${drain.rejected} invalid`);
  }
  if (drain.errors > 0 && errorsBefore === 0) {
    console.error(`[hook-spool] could not read ${drain.errors} spooled file(s) in ${config.hookSpoolDir}; it must be a directory you own with no group or other access`);
  }
  if (drain.ingested > 0 && broadcaster.clientCount > 0) {
    broadcaster.broadcast('session_update', { type: 'hook_spool', ingested: drain.ingested });
  }
}

/** Drain now, then every minute. */
export function startHookSpoolDrain(): void {
  if (timer) return;
  drainConfiguredSpool();
  timer = setInterval(drainConfiguredSpool, DRAIN_INTERVAL_MS);
  timer.unref();
}

export function stopHookSpoolDrain(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** The spool's state for /api/health: files waiting now, and what drains have done. */
export function hookSpoolStatus(): HookSpoolDrain & { directory: string; pending: number } {
  let pending = 0;
  try {
    pending = fs.readdirSync(config.hookSpoolDir).filter(name => SPOOL_FILE.test(name)).length;
  } catch {
    // No spool yet: nothing was ever spooled.
  }
  return { directory: config.hookSpoolDir, pending, ...totals };
}
