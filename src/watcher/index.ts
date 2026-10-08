import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import {
  insertParsedSession,
  parseSessionChunk,
  type ClaudeParseState,
  type ParsedChunk,
} from '../parser/claude-code.js';
import { parseCodexSessionChunk, type CodexParseState } from '../parser/codex-sessions.js';
import { parseAntigravitySessions } from '../parser/antigravity-sessions.js';
import { syncClaudeLiveSession, type ClaudeLiveSyncResult } from '../live/claude-adapter.js';
import { syncCodexLiveSession } from '../live/codex-adapter.js';
import { syncAntigravityLiveSession } from '../live/antigravity-adapter.js';
import { discoverAntigravityLogs } from '../import/antigravity.js';
import { discoverJsonlFilesRecursive } from '../util/file-discovery.js';
import { safelyMaintainTraceSummaryForSession } from '../trace-quality/service.js';
import { setSessionMode } from '../db/queries.js';

// --- File hashing ---

function hashBytes(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// --- Resuming a parse ---

/**
 * Where the last parse of a transcript stopped. Transcripts grow by appending,
 * and parsing the whole file again on every append grew with the session; a
 * checkpoint lets the next sync parse only the bytes after it. Kept in memory:
 * after a restart each file's first sync parses it whole.
 */
interface ParseCheckpoint<State> {
  /** Bytes parsed, ending at a newline. */
  bytes: number;
  /** sha256 of those bytes: the file_hash the parse stored. */
  fileHash: string;
  messageCount: number;
  state: State;
}

const MAX_CHECKPOINTS = 64;
const checkpoints = new Map<string, ParseCheckpoint<unknown>>();

function rememberCheckpoint(filePath: string, checkpoint: ParseCheckpoint<unknown>): void {
  checkpoints.delete(filePath);
  checkpoints.set(filePath, checkpoint);
  // Map order is insertion order, so the first key is the least recently synced.
  if (checkpoints.size > MAX_CHECKPOINTS) checkpoints.delete(checkpoints.keys().next().value!);
}

/** Forget every checkpoint, so the next sync of each file parses it whole. */
export function clearParseCheckpoints(): void {
  checkpoints.clear();
}

/**
 * Hash the file, and return the checkpoint only if the file still starts with
 * exactly the bytes it covers and the store still holds what that parse wrote.
 * Anything else (a rewritten or truncated file, rows changed by another sync or
 * a repair) parses the file whole.
 */
function readCheckpoint<State>(
  db: Database.Database,
  filePath: string,
  sessionId: string,
  bytes: Buffer,
): { fileHash: string; checkpoint?: ParseCheckpoint<State> } {
  const checkpoint = checkpoints.get(filePath) as ParseCheckpoint<State> | undefined;
  if (!checkpoint || bytes.length < checkpoint.bytes) return { fileHash: hashBytes(bytes) };
  const hash = crypto.createHash('sha256').update(bytes.subarray(0, checkpoint.bytes));
  const prefixHash = hash.copy().digest('hex');
  const fileHash = hash.update(bytes.subarray(checkpoint.bytes)).digest('hex');
  if (prefixHash !== checkpoint.fileHash) return { fileHash };

  const stored = db.prepare(`
    SELECT bs.message_count, bs.file_hash, wf.file_hash AS watched_hash, wf.status,
      (SELECT COUNT(*) FROM messages WHERE session_id = bs.id) AS messages,
      (SELECT COUNT(*) FROM session_turns WHERE session_id = bs.id) AS turns
    FROM browsing_sessions bs
    JOIN watched_files wf ON wf.file_path = bs.file_path
    WHERE bs.id = ? AND bs.file_path = ?
  `).get(sessionId, filePath) as {
    message_count: number; file_hash: string; watched_hash: string; status: string; messages: number; turns: number;
  } | undefined;
  const intact = stored
    && stored.status === 'parsed'
    && stored.file_hash === checkpoint.fileHash
    && stored.watched_hash === checkpoint.fileHash
    && stored.message_count === checkpoint.messageCount
    && stored.messages === checkpoint.messageCount
    && stored.turns === checkpoint.messageCount;
  return intact ? { fileHash, checkpoint } : { fileHash };
}

type ChunkParser<State> = (
  content: string,
  sessionId: string,
  filePath: string,
  state?: State,
) => ParsedChunk<State>;

/** Parse the whole file, or only the bytes after a checkpoint that still applies. */
function parseTranscript<State>(
  bytes: Buffer,
  sessionId: string,
  filePath: string,
  parse: ChunkParser<State>,
  checkpoint: ParseCheckpoint<State> | undefined,
): ParsedChunk<State> {
  return checkpoint
    ? parse(bytes.subarray(checkpoint.bytes).toString('utf-8'), sessionId, filePath, checkpoint.state)
    : parse(bytes.toString('utf-8'), sessionId, filePath);
}

/** Call once the parse is stored: a partial last line is parsed again next time. */
function settleCheckpoint<State>(filePath: string, bytes: Buffer, fileHash: string, chunk: ParsedChunk<State>): void {
  if (chunk.resumable && bytes.length > 0 && bytes[bytes.length - 1] === 0x0a) {
    rememberCheckpoint(filePath, {
      bytes: bytes.length,
      fileHash,
      messageCount: chunk.parsed.metadata.message_count,
      state: chunk.state,
    });
  } else {
    checkpoints.delete(filePath);
  }
}

// --- Discover session files ---

export function discoverSessionFiles(claudeDir: string, options: SyncOptions = {}): string[] {
  const projectsDir = path.join(claudeDir, 'projects');
  return discoverJsonlFilesRecursive(projectsDir, { excludePatterns: options.excludePatterns });
}

// --- Sync a single session file ---

export type SyncResult = 'parsed' | 'skipped' | 'error';

interface SyncOptions {
  force?: boolean;
  excludePatterns?: string[];
}

export interface SyncSessionOutcome {
  result: SyncResult;
  live?: ClaudeLiveSyncResult;
  session_id?: string;
  /** Whether the parse read the whole file or continued from a checkpoint. */
  parse?: 'full' | 'resumed';
}

interface WatchedFileState {
  file_hash: string;
  status: SyncResult;
}

interface MissingProjectionRow {
  file_path: string;
}

function getWatchedFileState(db: Database.Database, filePath: string): WatchedFileState | undefined {
  return db.prepare(
    'SELECT file_hash, status FROM watched_files WHERE file_path = ?'
  ).get(filePath) as WatchedFileState | undefined;
}

function upsertWatchedFile(
  db: Database.Database,
  filePath: string,
  fileHash: string,
  fileMtime: string,
  status: SyncResult,
): void {
  db.prepare(`
    INSERT INTO watched_files (file_path, file_hash, file_mtime, status, last_parsed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      file_hash = excluded.file_hash,
      file_mtime = excluded.file_mtime,
      status = excluded.status,
      last_parsed_at = datetime('now')
  `).run(filePath, fileHash, fileMtime, status);
}

/**
 * Return currently discoverable transcript files whose cache says parsing
 * succeeded but whose browser projection is absent. Stale cache rows for files
 * no longer on disk and intentionally skipped files are excluded by design.
 */
export function findMissingSessionProjections(
  db: Database.Database,
  currentFilePaths: Iterable<string>,
): string[] {
  const currentFiles = new Set(currentFilePaths);
  if (currentFiles.size === 0) return [];

  const missingRows = db.prepare(`
    SELECT wf.file_path
    FROM watched_files wf
    WHERE wf.status = 'parsed'
      AND NOT EXISTS (
        SELECT 1 FROM browsing_sessions bs WHERE bs.file_path = wf.file_path
      )
  `).all() as MissingProjectionRow[];

  return missingRows
    .map(row => row.file_path)
    .filter(filePath => currentFiles.has(filePath))
    .sort();
}

export function syncSessionFileDetailed(
  db: Database.Database,
  filePath: string,
  options: SyncOptions = {},
): SyncSessionOutcome {
  let fileHash = 'error';
  let fileMtime = '';
  try {
    const stat = fs.statSync(filePath);
    // One read serves the change check, the checkpoint check and the parse.
    const bytes = fs.readFileSync(filePath);
    const sessionId = path.basename(filePath, '.jsonl');
    const read = options.force
      ? { fileHash: hashBytes(bytes), checkpoint: undefined }
      : readCheckpoint<ClaudeParseState>(db, filePath, sessionId, bytes);
    fileHash = read.fileHash;
    fileMtime = stat.mtime.toISOString();

    // Check watched_files for existing record
    const existing = getWatchedFileState(db, filePath);
    if (!options.force && existing?.file_hash === fileHash && existing.status !== 'error') {
      return { result: 'skipped' };
    }

    const chunk = parseTranscript(bytes, sessionId, filePath, parseSessionChunk, read.checkpoint);
    const appendFrom = read.checkpoint?.messageCount;
    const parsed = chunk.parsed;

    // Skip files with no messages (non-interactive sessions)
    if (parsed.metadata.message_count === 0) {
      checkpoints.delete(filePath);
      upsertWatchedFile(db, filePath, fileHash, fileMtime, 'skipped');
      return { result: 'skipped', session_id: sessionId };
    }

    // Insert parsed data
    const { messagesKept } = insertParsedSession(db, parsed, filePath, stat.size, fileHash, { appendFrom });
    const live = syncClaudeLiveSession(db, parsed, { keptMessages: messagesKept });
    // Stamp the Monitor session's invocation mode from the JSONL the watcher
    // already parsed, so a live session gets its headless/interactive pill
    // without waiting for the next auto-import tick. No-op if the Monitor
    // session row does not exist yet (created by hooks/import, not the watcher).
    if (parsed.metadata.mode) setSessionMode(parsed.metadata.session_id, parsed.metadata.mode);
    safelyMaintainTraceSummaryForSession(sessionId, 'claude session sync');

    // Update watched_files
    upsertWatchedFile(db, filePath, fileHash, fileMtime, 'parsed');
    settleCheckpoint(filePath, bytes, fileHash, chunk);

    return { result: 'parsed', live, session_id: sessionId, parse: appendFrom === undefined ? 'full' : 'resumed' };
  } catch (err) {
    checkpoints.delete(filePath);
    console.error(`[watcher] Failed to sync ${filePath}:`, err);
    try {
      upsertWatchedFile(db, filePath, fileHash, fileMtime, 'error');
    } catch (dbErr) {
      console.error(`[watcher] Failed to record error state for ${filePath}:`, dbErr);
    }
    return { result: 'error' };
  }
}

export function syncSessionFile(db: Database.Database, filePath: string, options: SyncOptions = {}): SyncResult {
  return syncSessionFileDetailed(db, filePath, options).result;
}

// --- Sync all discovered files ---

export interface SyncStats {
  parsed: number;
  skipped: number;
  errors: number;
  total: number;
}

export function syncAllFiles(db: Database.Database, claudeDir: string, options: SyncOptions = {}): SyncStats {
  const files = discoverSessionFiles(claudeDir, options);
  const stats: SyncStats = { parsed: 0, skipped: 0, errors: 0, total: files.length };

  for (const filePath of files) {
    const result = syncSessionFile(db, filePath, options);
    stats[result === 'parsed' ? 'parsed' : result === 'skipped' ? 'skipped' : 'errors']++;
  }

  return stats;
}

// --- Codex session file support ---

export function discoverCodexSessionFiles(codexHome?: string, options: SyncOptions = {}): string[] {
  const base = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const sessionsDir = path.join(base, 'sessions');
  return discoverJsonlFilesRecursive(sessionsDir, { excludePatterns: options.excludePatterns });
}

export function syncCodexSessionFileDetailed(
  db: Database.Database,
  filePath: string,
  options: SyncOptions = {},
): SyncSessionOutcome {
  let fileHash = 'error';
  let fileMtime = '';
  try {
    const stat = fs.statSync(filePath);
    // One read serves the change check, the checkpoint check and the parse.
    const bytes = fs.readFileSync(filePath);
    const sessionId = path.basename(filePath, '.jsonl');
    const read = options.force
      ? { fileHash: hashBytes(bytes), checkpoint: undefined }
      : readCheckpoint<CodexParseState>(db, filePath, sessionId, bytes);
    fileHash = read.fileHash;
    fileMtime = stat.mtime.toISOString();

    const existing = getWatchedFileState(db, filePath);
    if (!options.force && existing?.file_hash === fileHash && existing.status !== 'error') {
      return { result: 'skipped' };
    }

    const chunk = parseTranscript(bytes, sessionId, filePath, parseCodexSessionChunk, read.checkpoint);
    const appendFrom = read.checkpoint?.messageCount;
    const parsed = chunk.parsed;

    if (parsed.metadata.message_count === 0) {
      checkpoints.delete(filePath);
      upsertWatchedFile(db, filePath, fileHash, fileMtime, 'skipped');
      return { result: 'skipped', session_id: sessionId };
    }

    const { messagesKept } = insertParsedSession(db, parsed, filePath, stat.size, fileHash, { appendFrom });
    const live = syncCodexLiveSession(db, parsed, { keptMessages: messagesKept });
    // The Monitor session row is keyed by the Codex session UUID (session_meta.id),
    // not the rollout filename the watcher uses for browsing_sessions — match the
    // import's id resolution so mode lands on the right row. No-op if absent.
    if (parsed.metadata.mode) {
      const uuid = sessionId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      setSessionMode(uuid?.[1] ?? sessionId, parsed.metadata.mode);
    }
    safelyMaintainTraceSummaryForSession(sessionId, 'codex session sync');

    upsertWatchedFile(db, filePath, fileHash, fileMtime, 'parsed');
    settleCheckpoint(filePath, bytes, fileHash, chunk);

    return { result: 'parsed', live, session_id: sessionId, parse: appendFrom === undefined ? 'full' : 'resumed' };
  } catch (err) {
    checkpoints.delete(filePath);
    console.error(`[watcher] Failed to sync Codex ${filePath}:`, err);
    try {
      upsertWatchedFile(db, filePath, fileHash, fileMtime, 'error');
    } catch (dbErr) {
      console.error(`[watcher] Failed to record error state for ${filePath}:`, dbErr);
    }
    return { result: 'error' };
  }
}

export function syncCodexSessionFile(db: Database.Database, filePath: string, options: SyncOptions = {}): SyncResult {
  return syncCodexSessionFileDetailed(db, filePath, options).result;
}

export function syncAllCodexFiles(db: Database.Database, codexHome?: string, options: SyncOptions = {}): SyncStats {
  const files = discoverCodexSessionFiles(codexHome, options);
  const stats: SyncStats = { parsed: 0, skipped: 0, errors: 0, total: files.length };

  for (const filePath of files) {
    const result = syncCodexSessionFileDetailed(db, filePath, options).result;
    stats[result === 'parsed' ? 'parsed' : result === 'skipped' ? 'skipped' : 'errors']++;
  }

  return stats;
}

// --- Antigravity conversation DB support ---

/**
 * Change token for an Antigravity conversation DB. Folds the SQLite sidecars
 * (`-wal`, `-shm`) into the hash: when a conversation DB is still open in WAL
 * mode, newly committed steps can live only in `<uuid>.db-wal` while the main
 * `.db` is byte-unchanged. Hashing the main file alone would make the periodic
 * resync see the same hash and skip, leaving the browser/search/trace-quality
 * projection stale until SQLite checkpoints. Folding in the sidecars means any
 * committed WAL frame flips the token (over-parsing on a spurious change is
 * harmless — `insertParsedSession` rewrites only rows that differ). (Codex review, PR #57.)
 */
export function hashAntigravityDb(filePath: string): string {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  for (const suffix of ['-wal', '-shm']) {
    try {
      h.update(suffix);
      h.update(fs.readFileSync(filePath + suffix));
    } catch {
      // sidecar absent (checkpointed / not in WAL mode) — nothing to fold in
    }
  }
  return h.digest('hex');
}

function syncAntigravitySessionFileDetailed(
  db: Database.Database,
  filePath: string,
  options: SyncOptions = {},
): SyncSessionOutcome {
  let fileHash = 'error';
  let fileMtime = '';
  try {
    const stat = fs.statSync(filePath);
    fileHash = hashAntigravityDb(filePath);
    fileMtime = stat.mtime.toISOString();

    const existing = getWatchedFileState(db, filePath);
    if (!options.force && existing?.file_hash === fileHash && existing.status !== 'error') {
      return { result: 'skipped' };
    }

    const sessionId = path.basename(filePath, '.db');
    const parsed = parseAntigravitySessions(filePath);

    if (parsed.messages.length === 0) {
      upsertWatchedFile(db, filePath, fileHash, fileMtime, 'skipped');
      return { result: 'skipped', session_id: sessionId };
    }

    const { messagesKept } = insertParsedSession(db, parsed, filePath, stat.size, fileHash);
    const live = syncAntigravityLiveSession(db, parsed, { keptMessages: messagesKept });
    safelyMaintainTraceSummaryForSession(sessionId, 'antigravity session sync');

    upsertWatchedFile(db, filePath, fileHash, fileMtime, 'parsed');

    return { result: 'parsed', live, session_id: sessionId };
  } catch (err) {
    console.error(`[watcher] Failed to sync Antigravity ${filePath}:`, err);
    try {
      upsertWatchedFile(db, filePath, fileHash, fileMtime, 'error');
    } catch (dbErr) {
      console.error(`[watcher] Failed to record error state for ${filePath}:`, dbErr);
    }
    return { result: 'error' };
  }
}

export function syncAllAntigravityFiles(db: Database.Database, dir?: string, options: SyncOptions = {}): SyncStats {
  const files = discoverAntigravityLogs(dir, { excludePatterns: options.excludePatterns });
  const stats: SyncStats = { parsed: 0, skipped: 0, errors: 0, total: files.length };

  for (const filePath of files) {
    const result = syncAntigravitySessionFileDetailed(db, filePath, options).result;
    stats[result === 'parsed' ? 'parsed' : result === 'skipped' ? 'skipped' : 'errors']++;
  }

  return stats;
}
