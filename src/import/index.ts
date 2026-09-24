import fs from 'fs';
import path from 'path';
import { getDb } from '../db/connection.js';
import { eventIdExists, insertEvent, setSessionMode } from '../db/queries.js';
import { discoverClaudeCodeLogs, parseClaudeCodeFile, hashFile as hashClaudeFile } from './claude-code.js';
import type { ParsedImportEvent } from './claude-code.js';
import { discoverCodexLogs, parseCodexFile, hashContent as hashCodexContent } from './codex.js';
import { reconcileCodexImport } from './codex-reconcile.js';
import { discoverAntigravityLogs, parseAntigravityFile, hashFile as hashAntigravityFile } from './antigravity.js';
import { createConfig } from '../config.js';
import { safelyMaintainTraceSummaryForEvent } from '../trace-quality/service.js';

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
}

function getImportState(filePath: string): ImportStateRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM import_state WHERE file_path = ?').get(filePath) as ImportStateRow | undefined;
}

function setImportState(filePath: string, hash: string, size: number, source: string, eventsImported: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO import_state (file_path, file_hash, file_size, source, events_imported, imported_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      file_hash = excluded.file_hash,
      file_size = excluded.file_size,
      events_imported = excluded.events_imported,
      imported_at = datetime('now')
  `).run(filePath, hash, size, source, eventsImported);
}

// ─── Core import logic ──────────────────────────────────────────────────

function importEvents(
  events: ParsedImportEvent[],
  dryRun: boolean,
  bridgeLegacyIds = false,
): { imported: number; duplicates: number } {
  let imported = 0;
  let duplicates = 0;

  if (dryRun) {
    return { imported: events.length, duplicates: 0 };
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
    } else {
      duplicates++;
    }
  }

  applySessionModes(events);
  return { imported, duplicates };
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

  const stat = fs.statSync(filePath);
  const hashFn = source === 'claude-code' ? hashClaudeFile : hashAntigravityFile;
  const currentHash = hashFn(filePath);
  if (isUnchanged(filePath, currentHash, options)) return unchangedResult(filePath, source);

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
  const { imported, duplicates } = importEvents(events, options.dryRun ?? false, ownsLegacyIdentity);
  recordImportState(filePath, currentHash, stat.size, source, imported, options);

  return {
    path: filePath,
    source,
    eventsFound: events.length,
    eventsImported: imported,
    eventsRefreshed: 0,
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
  const bytes = fs.readFileSync(filePath);
  const currentHash = hashCodexContent(bytes);
  if (isUnchanged(filePath, currentHash, options)) return unchangedResult(filePath, 'codex');

  const events = parseCodexFile(filePath, {
    from: options.from,
    to: options.to,
    codexDir: options.codexDir,
    content: bytes.toString('utf-8'),
  });
  const result: ImportFileResult = {
    path: filePath,
    source: 'codex',
    eventsFound: events.length,
    eventsImported: 0,
    eventsRefreshed: 0,
    eventsRemoved: 0,
    skippedDuplicate: 0,
    skippedUnchanged: false,
  };

  // A date-scoped parse is partial, so it can add rows but never prove one stale.
  const isDateScoped = options.from !== undefined || options.to !== undefined;
  const reconciled = options.dryRun || isDateScoped
    ? null
    : reconcileCodexImport(events, {
        apply: true,
        onCommit: counts => setImportState(filePath, currentHash, bytes.length, 'codex', counts.inserted),
      });
  if (reconciled?.reconciled) {
    applySessionModes(events);
    result.eventsImported = reconciled.inserted;
    result.eventsRefreshed = reconciled.updated;
    result.eventsRemoved = reconciled.deleted;
    result.skippedDuplicate = reconciled.unchanged;
    return result;
  }

  const { imported, duplicates } = importEvents(events, options.dryRun ?? false);
  result.eventsImported = imported;
  result.skippedDuplicate = duplicates;
  recordImportState(filePath, currentHash, bytes.length, 'codex', result.eventsImported, options);
  return result;
}

function isUnchanged(filePath: string, currentHash: string, options: ImportOptions): boolean {
  if (options.force) return false;
  const state = getImportState(filePath);
  return state !== undefined && state.file_hash === currentHash;
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
  source: string,
  imported: number,
  options: ImportOptions,
): void {
  const isDateScoped = options.from !== undefined || options.to !== undefined;
  if (!options.dryRun && !isDateScoped) setImportState(filePath, hash, size, source, imported);
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
