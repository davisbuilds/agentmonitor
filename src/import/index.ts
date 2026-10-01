import fs from 'fs';
import path from 'path';
import { getDb } from '../db/connection.js';
import { eventIdExists, insertEvent, refreshImportedUsage, setSessionMode } from '../db/queries.js';
import { discoverClaudeCodeLogs, parseClaudeCodeFile, hashFile as hashClaudeFile } from './claude-code.js';
import type { ParsedImportEvent } from './claude-code.js';
import { discoverCodexLogs, parseCodexFile, hashContent as hashCodexContent } from './codex.js';
import { reconcileCodexImport, type CodexReconcileCounts } from './codex-reconcile.js';
import { discoverAntigravityLogs, parseAntigravityFile, hashFile as hashAntigravityFile } from './antigravity.js';
import { createConfig } from '../config.js';
import { safelyMaintainTraceSummaryForEvent, safelyMaintainTraceSummaryForSession } from '../trace-quality/service.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type ImportSource = 'claude-code' | 'codex' | 'antigravity' | 'all';

export interface ImportOptions {
  source: ImportSource;
  from?: Date;
  to?: Date;
  dryRun?: boolean;
  force?: boolean;
  claudeDir?: string;
  codexDir?: string;
  antigravityDir?: string;
  excludePatterns?: string[];
}

export interface ImportFileResult {
  path: string;
  source: string;
  eventsFound: number;
  eventsImported: number;
  eventsRefreshed: number;
  /** Stored Codex rows removed because the rollout no longer produces them. */
  eventsRemoved: number;
  skippedDuplicate: number;
  skippedUnchanged: boolean;
}

export interface ImportResult {
  files: ImportFileResult[];
  totalFiles: number;
  totalEventsFound: number;
  totalEventsImported: number;
  totalEventsRefreshed: number;
  totalEventsRemoved: number;
  totalDuplicates: number;
  skippedFiles: number;
}

// ─── Import state DB helpers ────────────────────────────────────────────

interface ImportStateRow {
  file_path: string;
  file_hash: string;
  file_size: number;
  source: string;
  events_imported: number;
  imported_at: string;
  file_mtime: string | null;
}

function getImportState(filePath: string): ImportStateRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM import_state WHERE file_path = ?').get(filePath) as ImportStateRow | undefined;
}

function setImportState(
  filePath: string,
  hash: string,
  size: number,
  mtime: string | null,
  source: string,
  eventsImported: number,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO import_state (file_path, file_hash, file_size, file_mtime, source, events_imported, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      file_hash = excluded.file_hash,
      file_size = excluded.file_size,
      file_mtime = excluded.file_mtime,
      events_imported = excluded.events_imported,
      imported_at = datetime('now')
  `).run(filePath, hash, size, mtime, source, eventsImported);
}

interface DiskStamp {
  size: number;
  mtime: string;
}

/**
 * Size and nanosecond mtime, taken before the file is read: if the file changes
 * during the read, the recorded stamp is older than the file and the next run
 * reads it again.
 */
function diskStamp(filePath: string): DiskStamp {
  const stat = fs.statSync(filePath, { bigint: true });
  return { size: Number(stat.size), mtime: stat.mtimeNs.toString() };
}

/**
 * Auto-import runs every few minutes over every transcript, and reading and
 * hashing them all is most of its cost. A file whose size and mtime match the
 * state recorded with its hash is skipped without a read. A cleared hash (how
 * migrations force a re-import) or a missing stamp falls through to the hash.
 */
function isUnchangedOnDisk(filePath: string, stamp: DiskStamp, options: ImportOptions): boolean {
  if (options.force) return false;
  const state = getImportState(filePath);
  return state !== undefined
    && state.file_hash !== ''
    && state.file_mtime === stamp.mtime
    && state.file_size === stamp.size;
}

// ─── Core import logic ──────────────────────────────────────────────────

function importEvents(
  events: ParsedImportEvent[],
  dryRun: boolean,
  bridgeLegacyIds = false,
  refreshUsage = false,
): { imported: number; duplicates: number; refreshed: number } {
  let imported = 0;
  let duplicates = 0;
  let refreshed = 0;
  const refreshedSessions = new Set<string>();

  if (dryRun) {
    return { imported: events.length, duplicates: 0, refreshed: 0 };
  }

  for (const event of events) {
    // This file owns the identity the positional scheme gave its events, so a
    // row already stored under that id is this same event under the old scheme.
    if (bridgeLegacyIds && event.legacy_event_id && eventIdExists(event.legacy_event_id)) {
      duplicates++;
      continue;
    }
    const row = insertEvent(event);
    if (row) {
      imported++;
      safelyMaintainTraceSummaryForEvent(row.id, 'historical import');
      continue;
    }
    // A turn stored while it was still being written gains its final usage.
    const refreshedId = refreshUsage && event.event_id ? refreshImportedUsage({ ...event, event_id: event.event_id }) : null;
    if (refreshedId !== null) {
      refreshed++;
      refreshedSessions.add(event.session_id);
    } else {
      duplicates++;
    }
  }

  // The summary already counts a refreshed row, so adding it again would
  // double it; re-derive the session instead.
  for (const sessionId of refreshedSessions) safelyMaintainTraceSummaryForSession(sessionId, 'import refresh');

  applySessionModes(events);
  return { imported, duplicates, refreshed };
}

// Invocation mode is a session-level constant carried on events. Apply it once
// per session so it backfills even when every event is a duplicate
// (upsertSession inside insertEvent is skipped on the duplicate path).
function applySessionModes(events: ParsedImportEvent[]): void {
  const sessionModes = new Map<string, 'interactive' | 'headless'>();
  for (const event of events) {
    if (event.mode) sessionModes.set(event.session_id, event.mode);
  }
  for (const [sessionId, mode] of sessionModes) {
    setSessionMode(sessionId, mode);
  }
}

function processFile(
  filePath: string,
  source: 'claude-code' | 'codex' | 'antigravity',
  options: ImportOptions,
): ImportFileResult {
  if (source === 'codex') return processCodexFile(filePath, options);

  // An Antigravity conversation can change in its WAL sidecar alone, so only
  // its hash can tell; it never takes the stat shortcut.
  const stamp = source === 'claude-code' ? diskStamp(filePath) : null;
  if (stamp && isUnchangedOnDisk(filePath, stamp, options)) return unchangedResult(filePath, source);
  const stat = fs.statSync(filePath);
  const hashFn = source === 'claude-code' ? hashClaudeFile : hashAntigravityFile;
  const currentHash = hashFn(filePath);
  if (isUnchanged(filePath, currentHash, stamp, options)) return unchangedResult(filePath, source);

  // Parse the file (each source has its own option needs)
  const events = source === 'claude-code'
    ? parseClaudeCodeFile(filePath, { from: options.from, to: options.to })
    : parseAntigravityFile(filePath, { from: options.from, to: options.to });

  // Import events. A transcript is named after its session, so it owns the ids
  // the positional scheme minted for its lines and can recognize its own rows
  // from before the id change. A child-agent transcript reports its parent's
  // session under a different filename, so those ids are not its to claim —
  // without this distinction its events collide with the parent's and are
  // dropped, which is what kept child-agent usage out of the store.
  const ownsLegacyIdentity = source === 'claude-code'
    && events.length > 0
    && path.basename(filePath, '.jsonl') === events[0].session_id;
  const { imported, duplicates, refreshed } = importEvents(
    events, options.dryRun ?? false, ownsLegacyIdentity, source === 'claude-code');
  recordImportState(filePath, currentHash, stamp?.size ?? stat.size, stamp?.mtime ?? null, source, imported, options);

  return {
    path: filePath,
    source,
    eventsFound: events.length,
    eventsImported: imported,
    eventsRefreshed: refreshed,
    eventsRemoved: 0,
    skippedDuplicate: duplicates,
    skippedUnchanged: false,
  };
}

/**
 * A Codex rollout owns its session's import rows, so a changed rollout is
 * reconciled rather than appended to: its ids are positions in the file, and a
 * rewrite re-keys them. The file is read once and the recorded hash is of those
 * exact bytes, so content that changes mid-run is seen as changed next time.
 */
function processCodexFile(filePath: string, options: ImportOptions): ImportFileResult {
  if (isUnchangedOnDisk(filePath, diskStamp(filePath), options)) return unchangedResult(filePath, 'codex');
  const read = readCodexRollout(filePath);
  if (isUnchanged(filePath, read.hash, read, options)) return unchangedResult(filePath, 'codex');
  const result: ImportFileResult = {
    path: filePath,
    source: 'codex',
    eventsFound: 0,
    eventsImported: 0,
    eventsRefreshed: 0,
    eventsRemoved: 0,
    skippedDuplicate: 0,
    skippedUnchanged: false,
  };

  // A date-scoped parse is partial, so it can add rows but never prove one stale.
  const isDateScoped = options.from !== undefined || options.to !== undefined;
  if (!options.dryRun && !isDateScoped) {
    const { events, counts } = reconcileCodexRollout(filePath, { apply: true, codexDir: options.codexDir }, read);
    result.eventsFound = events.length;
    if (counts.reconciled) {
      result.eventsImported = counts.inserted;
      result.eventsRefreshed = counts.updated;
      result.eventsRemoved = counts.deleted;
      result.skippedDuplicate = counts.unchanged;
      return result;
    }
    return appendCodexEvents(filePath, events, read, options, result);
  }

  const events = parseCodexFile(filePath, {
    from: options.from,
    to: options.to,
    codexDir: options.codexDir,
    content: read.bytes.toString('utf-8'),
  });
  result.eventsFound = events.length;
  return appendCodexEvents(filePath, events, read, options, result);
}

/** The insert-only path, for partial parses and sessions a rollout cannot own. */
function appendCodexEvents(
  filePath: string,
  events: ParsedImportEvent[],
  read: CodexRolloutRead,
  options: ImportOptions,
  result: ImportFileResult,
): ImportFileResult {
  const { imported, duplicates } = importEvents(events, options.dryRun ?? false);
  result.eventsImported = imported;
  result.skippedDuplicate = duplicates;
  recordImportState(filePath, read.hash, read.bytes.length, read.mtime, 'codex', imported, options);
  return result;
}

export interface CodexRolloutRead {
  bytes: Buffer;
  hash: string;
  /** The file's mtime from just before the read. */
  mtime: string;
}

export function readCodexRollout(filePath: string): CodexRolloutRead {
  const { mtime } = diskStamp(filePath);
  const bytes = fs.readFileSync(filePath);
  return { bytes, hash: hashCodexContent(bytes), mtime };
}

/**
 * Reconcile the session a rollout owns with one read of the file. When
 * applying, the file's import hash commits in the same transaction as the rows,
 * so it always describes the rows that are stored. Shared by the importer and
 * the usage repair, so the two cannot disagree about what a rollout means.
 */
export function reconcileCodexRollout(
  filePath: string,
  options: { apply: boolean; codexDir?: string },
  read: CodexRolloutRead = readCodexRollout(filePath),
): { events: ParsedImportEvent[]; counts: CodexReconcileCounts } {
  const diagnostics = { malformedLines: 0 };
  const events = parseCodexFile(filePath, { codexDir: options.codexDir, content: read.bytes.toString('utf-8'), diagnostics });
  // A line that does not parse, such as one read mid-write, would make every
  // row after it look stale. Such a parse cannot prove any row stale, so it
  // takes the insert-only path.
  if (diagnostics.malformedLines > 0) {
    const sessionId = events.find(event => event.event_type === 'session_start')?.session_id ?? null;
    return { events, counts: { reconciled: false, session_id: sessionId, inserted: 0, updated: 0, deleted: 0, unchanged: 0 } };
  }
  // The mode backfill and the hash commit with the rows: a hash recorded ahead
  // of a failed backfill would make every later import skip the file.
  const counts = reconcileCodexImport(events, {
    apply: options.apply,
    onCommit: committed => {
      applySessionModes(events);
      setImportState(filePath, read.hash, read.bytes.length, read.mtime, 'codex', committed.inserted);
    },
  });
  return { events, counts };
}

function isUnchanged(
  filePath: string,
  currentHash: string,
  stamp: { mtime: string } | null,
  options: ImportOptions,
): boolean {
  if (options.force) return false;
  const state = getImportState(filePath);
  const unchanged = state !== undefined && state.file_hash === currentHash;
  // A touched but unchanged file would otherwise be read on every run.
  if (unchanged && stamp && state.file_mtime !== stamp.mtime && !options.dryRun) {
    getDb().prepare('UPDATE import_state SET file_mtime = ? WHERE file_path = ?').run(stamp.mtime, filePath);
  }
  return unchanged;
}

function unchangedResult(filePath: string, source: string): ImportFileResult {
  return {
    path: filePath,
    source,
    eventsFound: 0,
    eventsImported: 0,
    eventsRefreshed: 0,
    eventsRemoved: 0,
    skippedDuplicate: 0,
    skippedUnchanged: true,
  };
}

// Record import state (unless dry run or date-scoped import). Date-scoped
// imports are partial — caching the hash would cause a later full import to
// skip the file, permanently losing the excluded events.
function recordImportState(
  filePath: string,
  hash: string,
  size: number,
  mtime: string | null,
  source: string,
  imported: number,
  options: ImportOptions,
): void {
  const isDateScoped = options.from !== undefined || options.to !== undefined;
  if (!options.dryRun && !isDateScoped) setImportState(filePath, hash, size, mtime, source, imported);
}

// ─── Public API ─────────────────────────────────────────────────────────

export function runImport(options: ImportOptions): ImportResult {
  const files: ImportFileResult[] = [];
  const runtimeConfig = createConfig();
  const excludePatterns = options.excludePatterns ?? runtimeConfig.sync.excludePatterns;

  // Discover files
  const claudeFiles = (options.source === 'claude-code' || options.source === 'all')
    ? discoverClaudeCodeLogs(options.claudeDir ?? runtimeConfig.claudeDir, { excludePatterns })
    : [];
  const codexFiles = (options.source === 'codex' || options.source === 'all')
    ? discoverCodexLogs(options.codexDir, { excludePatterns })
    : [];
  const antigravityFiles = (options.source === 'antigravity' || options.source === 'all')
    ? discoverAntigravityLogs(options.antigravityDir, { excludePatterns })
    : [];

  // Process Claude Code files
  for (const filePath of claudeFiles) {
    files.push(processFile(filePath, 'claude-code', options));
  }

  // Process Codex files
  for (const filePath of codexFiles) {
    files.push(processFile(filePath, 'codex', options));
  }

  // Process Antigravity files
  for (const filePath of antigravityFiles) {
    files.push(processFile(filePath, 'antigravity', options));
  }

  // Aggregate results
  let totalEventsFound = 0;
  let totalEventsImported = 0;
  let totalEventsRefreshed = 0;
  let totalEventsRemoved = 0;
  let totalDuplicates = 0;
  let skippedFiles = 0;

  for (const f of files) {
    totalEventsFound += f.eventsFound;
    totalEventsImported += f.eventsImported;
    totalEventsRefreshed += f.eventsRefreshed;
    totalEventsRemoved += f.eventsRemoved;
    totalDuplicates += f.skippedDuplicate;
    if (f.skippedUnchanged) skippedFiles++;
  }

  return {
    files,
    totalFiles: files.length,
    totalEventsFound,
    totalEventsImported,
    totalEventsRefreshed,
    totalEventsRemoved,
    totalDuplicates,
    skippedFiles,
  };
}
