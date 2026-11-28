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
import { antigravitySnapshotToParsedSession } from '../parser/antigravity-sessions.js';
import { syncClaudeLiveSession, type ClaudeLiveSyncResult } from '../live/claude-adapter.js';
import { syncCodexLiveSession } from '../live/codex-adapter.js';
import { preserveAntigravitySessionMetadata, syncAntigravityLiveSession } from '../live/antigravity-adapter.js';
import type { ProjectionFidelity } from '../live/projector.js';
import { discoverAntigravityLogs, ingestAntigravitySnapshot } from '../import/antigravity.js';
import { hashAntigravityConversation, readAntigravityConversationSnapshot } from '../import/antigravity/snapshot.js';
import { discoverCodexRolloutFilesRecursive, discoverJsonlFilesRecursive } from '../util/file-discovery.js';
import { COMPRESSED_ROLLOUT_SUFFIX, readTranscriptFile, transcriptBaseName } from '../util/transcript-file.js';
import { safelyMaintainTraceSummaryForSession } from '../trace-quality/service.js';
import { setSessionMode, type EventRow } from '../db/queries.js';
import { reparseRequested } from '../db/reparse-marker.js';
import { hasCurrentCodexContextEvidence } from '../skills/codex-evidence-version.js';
import { createCodexRolloutInventory, currentCodexRollout, resolveCodexRolloutHistory, type CodexRolloutInventory } from '../util/codex-rollout-history.js';

function hashBytes(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

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

export function discoverSessionFiles(claudeDir: string, options: SyncOptions = {}): string[] {
  const projectsDir = path.join(claudeDir, 'projects');
  return discoverJsonlFilesRecursive(projectsDir, { excludePatterns: options.excludePatterns });
}

export type SyncResult = 'parsed' | 'skipped' | 'error';

interface SyncOptions {
  force?: boolean;
  excludePatterns?: string[];
  /** Reuse one stat-cached header inventory during a Codex sweep. */
  codexInventory?: CodexRolloutInventory;
}

export interface SyncSessionOutcome {
  result: SyncResult;
  live?: ClaudeLiveSyncResult;
  session_id?: string;
  /** Whether the parse read the whole file or continued from a checkpoint. */
  parse?: 'full' | 'resumed';
  integration_mode?: string;
  fidelity?: ProjectionFidelity;
  ingestedEvents?: EventRow[];
  sessionStatus?: 'active' | 'idle' | 'ended';
}

interface WatchedFileState {
  file_hash: string;
  file_mtime: string | null;
  status: SyncResult;
}

interface MissingProjectionRow {
  file_path: string;
}

function getWatchedFileState(db: Database.Database, filePath: string): WatchedFileState | undefined {
  return db.prepare(
    'SELECT file_hash, file_mtime, status FROM watched_files WHERE file_path = ?'
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

/**
 * A Claude subagent's task description: Claude Code writes it, with the
 * spawning tool call, to `<agent>.meta.json` beside the subagent's transcript.
 */
function readSubagentDescription(filePath: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(filePath.replace(/\.jsonl$/, '.meta.json'), 'utf-8')) as {
      description?: unknown;
    };
    if (typeof meta.description !== 'string') return null;
    return meta.description.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  } catch {
    return null;
  }
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
    const bytes = fs.readFileSync(filePath);
    const sessionId = path.basename(filePath, '.jsonl');
    const read = options.force
      ? { fileHash: hashBytes(bytes), checkpoint: undefined }
      : readCheckpoint<ClaudeParseState>(db, filePath, sessionId, bytes);
    fileHash = read.fileHash;
    fileMtime = stat.mtime.toISOString();

    const existing = getWatchedFileState(db, filePath);
    if (!options.force && existing?.file_hash === fileHash && existing.status !== 'error') {
      return { result: 'skipped' };
    }

    const chunk = parseTranscript(bytes, sessionId, filePath, parseSessionChunk, read.checkpoint);
    const appendFrom = read.checkpoint?.messageCount;
    const parsed = chunk.parsed;
    if (parsed.metadata.relationship_type === 'subagent' && !parsed.metadata.title) {
      parsed.metadata.title = readSubagentDescription(filePath);
    }

    if (parsed.metadata.message_count === 0) {
      checkpoints.delete(filePath);
      upsertWatchedFile(db, filePath, fileHash, fileMtime, 'skipped');
      return { result: 'skipped', session_id: sessionId };
    }

    const { messagesKept } = insertParsedSession(db, parsed, filePath, stat.size, fileHash, { appendFrom });
    const live = syncClaudeLiveSession(db, parsed, { keptMessages: messagesKept });
    if (parsed.metadata.mode) setSessionMode(parsed.metadata.session_id, parsed.metadata.mode);
    safelyMaintainTraceSummaryForSession(sessionId, 'claude session sync');

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

export function discoverCodexSessionFiles(codexHome?: string, options: SyncOptions = {}): string[] {
  const base = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const sessionsDir = path.join(base, 'sessions');
  return discoverCodexRolloutFilesRecursive(sessionsDir, { excludePatterns: options.excludePatterns });
}

/** Single-file live notifications still need the current leaf, including notifications
 * for an ancestor after a new segment was created. Header reads are stat-cached by
 * the shared inventory; a sweep supplies one inventory for all of its files. */
function codexInventoryForFile(filePath: string, options: SyncOptions): CodexRolloutInventory {
  if (options.codexInventory) return options.codexInventory;
  let root = path.dirname(filePath);
  for (let directory = root; path.dirname(directory) !== directory; directory = path.dirname(directory)) {
    if (path.basename(directory) === 'sessions') { root = directory; break; }
  }
  return createCodexRolloutInventory(discoverCodexRolloutFilesRecursive(root, { excludePatterns: options.excludePatterns }));
}

export function syncCodexSessionFileDetailed(
  db: Database.Database,
  filePath: string,
  options: SyncOptions = {},
): SyncSessionOutcome {
  let fileHash = 'error';
  let fileMtime = '';
  try {
    filePath = path.resolve(filePath);
    const inventory = codexInventoryForFile(filePath, options);
    const entry = inventory.entries.find(candidate => candidate.filePath === filePath)
      ?? (filePath.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
        ? inventory.entries.find(candidate => candidate.filePath === filePath.slice(0, -4))
        : undefined);
    const active = entry ? currentCodexRollout(entry, inventory) : undefined;
    if (active) filePath = active.filePath;
    const members = active ? inventory.bySessionId.get(active.sessionId) ?? [active] : [];
    const nativeMembers = members.filter(candidate => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(candidate.rolloutId));
    // WHY: Complete compressed roots have immutable bytes; a history-mode label alone does not imply
    // external dependencies.
    const paginated = active && (members.some(candidate => candidate.historyBase || candidate.historyError)
      || nativeMembers.length > 1
      || (nativeMembers.includes(active) && active.rolloutId !== active.sessionId));
    // WHY: Missing ancestry cannot justify replacing a complete stored transcript with a partial
    // parse.
    const history = paginated ? resolveCodexRolloutHistory(filePath, { inventory }) : undefined;
    const stat = fs.statSync(filePath);
    fileMtime = stat.mtime.toISOString();
    const original = active && inventory.byRolloutId.get(active.sessionId)?.find(candidate => candidate.sessionId === active.sessionId);
    const sessionId = transcriptBaseName(history ? original?.filePath ?? history.segments.find(segment => segment.sessionId === history.sessionId)?.filePath ?? filePath : filePath);
    const existing = getWatchedFileState(db, filePath);
    const storedCapabilities = existing?.status === 'parsed' ? db.prepare(`
      SELECT skill_context_capabilities_json FROM browsing_sessions WHERE id = ?
    `).pluck().get(sessionId) : undefined;
    const refreshContext = existing?.status === 'parsed' && !hasCurrentCodexContextEvidence(storedCapabilities);
    const replay = options.force || refreshContext;
    // WHY: Codex does not append to a compressed rollout, so a matching mtime can avoid needless
    // decompression.
    if (!replay && !paginated && filePath.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
      && existing && existing.status !== 'error' && !reparseRequested(existing) && existing.file_mtime === fileMtime) {
      return { result: 'skipped' };
    }
    const bytes = history?.bytes ?? readTranscriptFile(filePath);
    const read = replay
      ? { fileHash: hashBytes(bytes), checkpoint: undefined }
      : readCheckpoint<CodexParseState>(db, filePath, sessionId, bytes);
    fileHash = read.fileHash;

    if (!replay && existing?.file_hash === fileHash && existing.status !== 'error') {
      return { result: 'skipped' };
    }

    const parse: ChunkParser<CodexParseState> = history?.prefixLineCount
      ? (content, id, source, state) => parseCodexSessionChunk(content, id, source, state, {
          inheritedThroughOrdinal: history.ownFromLine - 1,
        })
      : parseCodexSessionChunk;
    const chunk = parseTranscript(bytes, sessionId, filePath, parse, read.checkpoint);
    const appendFrom = read.checkpoint?.messageCount;
    const parsed = chunk.parsed;

    if (parsed.metadata.message_count === 0) {
      checkpoints.delete(filePath);
      upsertWatchedFile(db, filePath, fileHash, fileMtime, 'skipped');
      return { result: 'skipped', session_id: sessionId };
    }

    const siblings = history ? members.filter(member => member.filePath !== filePath) : [];
    const live = db.transaction(() => {
      const { messagesKept } = insertParsedSession(db, parsed, filePath, stat.size, fileHash, { appendFrom });
      const projection = syncCodexLiveSession(db, parsed, { keptMessages: messagesKept });
      // WHY: Monitor uses native session UUIDs while the watcher indexes physical filenames.
      if (parsed.metadata.mode) {
        const uuid = sessionId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        setSessionMode(uuid?.[1] ?? sessionId, parsed.metadata.mode);
      }
      upsertWatchedFile(db, filePath, fileHash, fileMtime, 'parsed');
      for (const sibling of siblings) {
        upsertWatchedFile(db, sibling.filePath, fileHash, new Date(sibling.mtimeMs).toISOString(), 'skipped');
      }
      return projection;
    })();
    for (const sibling of siblings) checkpoints.delete(sibling.filePath);
    safelyMaintainTraceSummaryForSession(sessionId, 'codex session sync');
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
  const codexInventory = createCodexRolloutInventory(files);
  const entriesByPath = new Map(codexInventory.entries.map(entry => [entry.filePath, entry]));
  const syncedLeaves = new Set<string>();
  const stats: SyncStats = { parsed: 0, skipped: 0, errors: 0, total: files.length };

  for (const filePath of files) {
    const entry = entriesByPath.get(path.resolve(filePath));
    let target = filePath;
    try {
      if (entry) target = currentCodexRollout(entry, codexInventory).filePath;
    } catch {
      // WHY: Detailed sync records this lookup failure for both batch scans and single-file
      // notifications.
    }
    if (syncedLeaves.has(target)) { stats.skipped++; continue; }
    syncedLeaves.add(target);
    const result = syncCodexSessionFileDetailed(db, filePath, { ...options, codexInventory }).result;
    stats[result === 'parsed' ? 'parsed' : result === 'skipped' ? 'skipped' : 'errors']++;
  }

  return stats;
}

export function hashAntigravityDb(filePath: string): string {
  return hashAntigravityConversation(filePath);
}

export function syncAntigravitySessionFileDetailed(
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
    const snapshot = readAntigravityConversationSnapshot(filePath, {
      includeTranscript: true,
      includeSummary: true,
      throwOnError: true,
    });
    const rawParsed = antigravitySnapshotToParsedSession(snapshot);
    const ingested = ingestAntigravitySnapshot(db, snapshot, { importStateHash: fileHash });

    if (rawParsed.messages.length === 0 && ingested.eventsFound === 0) {
      upsertWatchedFile(db, filePath, fileHash, fileMtime, 'skipped');
      return { result: 'skipped', session_id: sessionId };
    }

    let live: ClaudeLiveSyncResult | undefined;
    let integration_mode = 'antigravity-sqlite';
    let fidelity: ProjectionFidelity = 'summary';
    if (rawParsed.messages.length > 0) {
      const parsed = preserveAntigravitySessionMetadata(db, rawParsed);
      const { messagesKept } = insertParsedSession(db, parsed, filePath, stat.size, fileHash);
      live = syncAntigravityLiveSession(db, parsed, { keptMessages: messagesKept });
      fidelity = parsed.metadata.fidelity === 'full' ? 'full' : 'summary';
      integration_mode = parsed.metadata.integration_mode
        ?? (fidelity === 'full' ? 'antigravity-transcript' : 'antigravity-sqlite');
    }
    safelyMaintainTraceSummaryForSession(sessionId, 'antigravity session sync');

    upsertWatchedFile(db, filePath, fileHash, fileMtime, 'parsed');

    return {
      result: 'parsed',
      live,
      session_id: sessionId,
      integration_mode,
      fidelity,
      ingestedEvents: ingested.ingestedEvents,
      sessionStatus: ingested.sessionStatus,
    };
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
