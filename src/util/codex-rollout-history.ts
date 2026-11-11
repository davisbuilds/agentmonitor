import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { discoverCodexRolloutFilesRecursive } from './file-discovery.js';
import { readTranscriptFile, transcriptBaseName } from './transcript-file.js';

export interface CodexHistoryPosition {
  /** A physical rollout ID, not necessarily session_meta.payload.id after revert. */
  thread_id: string;
  end_ordinal_exclusive: number;
  end_byte_offset: number;
}

export interface CodexRolloutEntry {
  filePath: string;
  rolloutId: string;
  /** Stable native thread ID (payload.id), not the root conversation payload.session_id. */
  sessionId: string;
  meta: Record<string, unknown>;
  historyBase?: CodexHistoryPosition;
  /** Keep malformed newest leaves visible to selection; resolution still throws. */
  historyError?: Error;
  /** Physical creation time from the header envelope (payload.timestamp can survive revert). */
  timestamp?: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface CodexRolloutInventory {
  entries: CodexRolloutEntry[];
  byRolloutId: Map<string, CodexRolloutEntry[]>;
  bySessionId: Map<string, CodexRolloutEntry[]>;
  errors: Map<string, Error>;
}

export interface CodexHistoryRecord {
  value: Record<string, unknown>;
  raw: string;
  filePath: string;
  rolloutId: string;
  sessionId: string;
  inherited: boolean;
  /** Offsets address the original decoded physical file, including line terminators. */
  startByteOffset: number;
  endByteOffset: number;
}

export interface CodexHistorySegment extends CodexRolloutEntry {
  bytes: Buffer;
  records: CodexHistoryRecord[];
  endByteOffset: number;
}

export interface CodexRolloutHistory {
  sessionId: string;
  rolloutId: string;
  content: string;
  bytes: Buffer;
  lines: string[];
  /** Same order as lines: current metadata, inherited non-metadata, current own records. */
  records: CodexHistoryRecord[];
  /** Physical included slices ordered oldest ancestor to current file. */
  segments: CodexHistorySegment[];
  ownContent: string;
  prefixLineCount: number;
  /** First own non-metadata record; metadata remains at line zero. */
  ownFromLine: number;
}

export interface CodexHistoryOptions {
  inventory?: CodexRolloutInventory;
  filePaths?: readonly string[];
  maxDepth?: number;
  maxBytes?: number;
  /** Supply frozen decoded bytes when hashes and projections must share one read. */
  readFile?: (filePath: string) => Buffer;
}

const HEADER_LIMIT = 1024 * 1024;
const headerCache = new Map<string, { key: string; entry: CodexRolloutEntry }>();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function invalid(detail: string): Error {
  return new Error(`Invalid Codex rollout history: ${detail}`);
}

/** Header-only for plain files; unchanged headers are cached by nanosecond stat identity. */
export function createCodexRolloutInventory(filePaths: readonly string[]): CodexRolloutInventory {
  const inventory: CodexRolloutInventory = { entries: [], byRolloutId: new Map(), bySessionId: new Map(), errors: new Map() };
  const unique = new Set(filePaths.map(file => path.resolve(file)));
  for (const filePath of unique) {
    // Codex briefly retains both formats during compression. The live plain path wins.
    if (filePath.endsWith('.jsonl.zst') && unique.has(filePath.slice(0, -4))) continue;
    try {
      const entry = readEntry(filePath);
      inventory.entries.push(entry);
      if (entry.historyError) inventory.errors.set(filePath, entry.historyError);
      inventory.byRolloutId.set(entry.rolloutId, [...(inventory.byRolloutId.get(entry.rolloutId) ?? []), entry]);
      inventory.bySessionId.set(entry.sessionId, [...(inventory.bySessionId.get(entry.sessionId) ?? []), entry]);
    } catch (error) {
      inventory.errors.set(filePath, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return inventory;
}

/**
 * Follows HistoryPosition using physical filename IDs and decoded-byte bookmarks.
 * Mirrors Codex protocol HistoryPosition / thread-store rollout_lineage semantics;
 * payload.id remains the thread identity when revert replaces its physical rollout.
 * No partial lineage is returned: consumers must resolve before deleting projections.
 */
export function resolveCodexRolloutHistory(filePath: string, options: CodexHistoryOptions = {}): CodexRolloutHistory {
  filePath = path.resolve(filePath);
  const maxDepth = options.maxDepth ?? 128;
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  if (!integer(maxDepth) || maxDepth < 1 || !integer(maxBytes) || maxBytes < 1) throw invalid('invalid depth or byte budget');
  const readFile = options.readFile ?? readTranscriptFile;
  const inventory = options.inventory ?? createCodexRolloutInventory(options.filePaths ?? defaultFiles(filePath));
  const seen = new Set<string>();
  const segments: CodexHistorySegment[] = [];
  let nextPath = filePath;
  let cutoff: CodexHistoryPosition | undefined;
  let child: CodexRolloutEntry | undefined;
  let totalBytes = 0;
  let ownContent = '';
  while (true) {
    if (segments.length >= maxDepth) throw invalid('maximum lineage depth exceeded');
    const fullBytes = readFile(nextPath);
    totalBytes += fullBytes.length;
    if (totalBytes > maxBytes) throw invalid('decoded byte budget exceeded');
    // Re-read metadata from the exact bytes being projected, even if the inventory is older.
    const entry = entryFromBytes(nextPath, fullBytes, fs.statSync(nextPath));
    if ((inventory.byRolloutId.get(entry.rolloutId)?.length ?? 0) > 1) throw invalid(`ambiguous source rollout ${entry.rolloutId}`);
    if (seen.has(entry.rolloutId)) throw invalid('cycle detected');
    seen.add(entry.rolloutId);
    if (child && child.sessionId !== entry.sessionId && child.meta.forked_from_id !== entry.sessionId
      && child.meta.parent_thread_id !== entry.sessionId) throw invalid('source rollout belongs to another thread owner');
    const end = cutoff?.end_byte_offset ?? fullBytes.length;
    if (end > fullBytes.length || (cutoff && (end < 1 || fullBytes[end - 1] !== 10))) throw invalid('byte boundary is outside a complete source record');
    const bytes = fullBytes.subarray(0, end);
    const records = parseRecords(entry, bytes, segments.length > 0);
    validateOrdinals(entry, records, cutoff);
    if (!segments.length) ownContent = fullBytes.toString('utf8');
    segments.push({ ...entry, bytes, records, endByteOffset: end });
    const base = entry.historyBase;
    if (!base) break;
    if (seen.has(base.thread_id)) throw invalid('cycle detected');
    const candidates = inventory.byRolloutId.get(base.thread_id) ?? [];
    if (!candidates.length) throw invalid(`missing source rollout ${base.thread_id}`);
    if (candidates.length !== 1) throw invalid(`ambiguous source rollout ${base.thread_id}`);
    nextPath = candidates[0].filePath;
    cutoff = base;
    child = entry;
  }
  segments.reverse();
  const own = segments[segments.length - 1];
  const inherited = segments.slice(0, -1).flatMap(segment => segment.records.filter(record => record.value.type !== 'session_meta'));
  const records = [own.records[0], ...inherited, ...own.records.slice(1)];
  const lines = records.map(record => record.raw);
  const content = lines.join('\n') + '\n';
  return { sessionId: own.sessionId, rolloutId: own.rolloutId, bytes: Buffer.from(content), content,
    ownContent, lines, records, segments, prefixLineCount: inherited.length, ownFromLine: inherited.length + 1 };
}

function defaultFiles(filePath: string): string[] {
  let dir = path.dirname(filePath);
  while (path.dirname(dir) !== dir) {
    if (['sessions', 'archived_sessions'].includes(path.basename(dir))) {
      const home = path.dirname(dir);
      return ['sessions', 'archived_sessions'].flatMap(name => discoverCodexRolloutFilesRecursive(path.join(home, name)));
    }
    dir = path.dirname(dir);
  }
  // Standalone callers need only their own directory, never a scan of the filesystem root.
  return discoverCodexRolloutFilesRecursive(path.dirname(filePath));
}

function readEntry(filePath: string): CodexRolloutEntry {
  const stats = fs.statSync(filePath, { bigint: true });
  const key = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`;
  const cached = headerCache.get(filePath);
  if (cached?.key === key) return cached.entry;
  let bytes: Buffer;
  if (filePath.endsWith('.jsonl.zst')) {
    bytes = readTranscriptFile(filePath);
  } else {
    const fd = fs.openSync(filePath, 'r');
    try {
      const chunks: Buffer[] = [];
      let count = 0;
      while (count < HEADER_LIMIT) {
        const buffer = Buffer.alloc(Math.min(4096, HEADER_LIMIT - count));
        const length = fs.readSync(fd, buffer, 0, buffer.length, count);
        if (!length) break;
        const chunk = buffer.subarray(0, length);
        chunks.push(chunk);
        count += length;
        if (chunk.includes(10)) break;
      }
      bytes = Buffer.concat(chunks);
    } finally { fs.closeSync(fd); }
  }
  const entry = entryFromBytes(filePath, bytes, { size: Number(stats.size), mtimeMs: Number(stats.mtimeNs) / 1e6, ctimeMs: Number(stats.ctimeNs) / 1e6 }, true);
  // Bound the process cache; a full clear only costs another bounded header read.
  if (headerCache.size >= 100_000) headerCache.clear();
  headerCache.set(filePath, { key, entry });
  return entry;
}

function entryFromBytes(filePath: string, bytes: Buffer, stats: { size: number; mtimeMs: number; ctimeMs: number }, allowInvalidHistoryBase = false): CodexRolloutEntry {
  const newline = bytes.indexOf(10);
  const headerEnd = newline < 0 ? bytes.length : newline;
  if (headerEnd > HEADER_LIMIT || (newline < 0 && bytes.length >= HEADER_LIMIT)) throw invalid('session metadata exceeds header limit');
  let header: unknown;
  try { header = JSON.parse(bytes.subarray(0, headerEnd).toString('utf8')); }
  catch { throw invalid('invalid session metadata JSON'); }
  if (!object(header) || header.type !== 'session_meta' || !object(header.payload)
    || typeof header.payload.id !== 'string' || !header.payload.id) throw invalid('missing session metadata thread identity');
  const meta = header.payload;
  let historyBase: CodexHistoryPosition | undefined;
  let historyError: Error | undefined;
  try {
    if (meta.history_base !== undefined && meta.history_base !== null) {
      const base = meta.history_base;
      if (!object(base) || typeof base.thread_id !== 'string' || !base.thread_id || !integer(base.end_ordinal_exclusive)
        || !integer(base.end_byte_offset)) throw invalid('malformed history_base');
      if (meta.history_mode !== 'paginated') throw invalid('history_base requires paginated history mode');
      historyBase = { thread_id: base.thread_id, end_ordinal_exclusive: base.end_ordinal_exclusive, end_byte_offset: base.end_byte_offset };
    }
  } catch (error) {
    if (!allowInvalidHistoryBase) throw error;
    historyError = error instanceof Error ? error : invalid(String(error));
  }
  const name = transcriptBaseName(filePath);
  return { filePath, rolloutId: name.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i)?.[0] ?? name,
    sessionId: meta.id as string, meta, historyBase, historyError, timestamp: typeof header.timestamp === 'string' ? header.timestamp : undefined,
    size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function parseRecords(entry: CodexRolloutEntry, bytes: Buffer, inherited: boolean): CodexHistoryRecord[] {
  const records: CodexHistoryRecord[] = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline + 1;
    const raw = bytes.subarray(start, newline < 0 ? end : newline).toString('utf8').replace(/\r$/, '');
    if (raw.trim()) {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw invalid('malformed or incomplete source record'); }
      if (!object(value)) throw invalid('source record must be an object');
      if (records.length && value.type === 'session_meta') throw invalid('duplicate session metadata');
      records.push({ value, raw, filePath: entry.filePath, rolloutId: entry.rolloutId, sessionId: entry.sessionId,
        inherited, startByteOffset: start, endByteOffset: end });
    }
    start = end;
  }
  if (!records.length || records[0].value.type !== 'session_meta') throw invalid('missing source metadata');
  return records;
}

function validateOrdinals(entry: CodexRolloutEntry, records: CodexHistoryRecord[], cutoff?: CodexHistoryPosition): void {
  if (entry.meta.history_mode !== 'paginated') {
    if (cutoff) throw invalid('source rollout is not paginated');
    return;
  }
  const startOrdinal = entry.historyBase?.end_ordinal_exclusive ?? 0;
  let previous = -1;
  for (const [index, record] of records.entries()) {
    const ordinal = record.value.ordinal;
    if (!integer(ordinal) || ordinal <= previous || (index === 0 && ordinal !== startOrdinal)) throw invalid('invalid source record ordinal');
    previous = ordinal;
  }
  // Ordinal gaps can survive writer recovery; the exact record at the byte boundary
  // must still end immediately before the bookmark's exclusive ordinal.
  if (cutoff && (records[records.length - 1].endByteOffset !== cutoff.end_byte_offset
    || previous + 1 !== cutoff.end_ordinal_exclusive)) throw invalid('byte boundary and exclusive ordinal disagree');
}

/**
 * Cache identity of the complete physical dependency closure, including ancestors
 * owned by another native thread. Supplied snapshots must cover the closure so a
 * commit cannot accidentally combine pre-read rows with newer filesystem stamps.
 */
export function codexRolloutDependencyStamp(
  entries: readonly CodexRolloutEntry[],
  inventory: CodexRolloutInventory,
  snapshots?: ReadonlyMap<string, { mtime: string; size: number }>,
): string {
  const included = new Map<string, CodexRolloutEntry>();
  const visiting = new Set<string>();
  const visit = (entry: CodexRolloutEntry, depth: number): void => {
    if (depth > 128) throw invalid('maximum dependency lineage depth exceeded');
    if (visiting.has(entry.rolloutId)) throw invalid('dependency cycle detected');
    if ((inventory.byRolloutId.get(entry.rolloutId)?.length ?? 0) > 1) throw invalid(`ambiguous source rollout ${entry.rolloutId}`);
    if (included.has(entry.filePath)) return;
    if (entry.historyError) throw entry.historyError;
    visiting.add(entry.rolloutId);
    if (entry.historyBase) {
      const candidates = inventory.byRolloutId.get(entry.historyBase.thread_id) ?? [];
      if (!candidates.length) throw invalid(`missing source rollout ${entry.historyBase.thread_id}`);
      if (candidates.length !== 1) throw invalid(`ambiguous source rollout ${entry.historyBase.thread_id}`);
      const parent = candidates[0];
      if (parent.sessionId !== entry.sessionId && entry.meta.forked_from_id !== parent.sessionId
        && entry.meta.parent_thread_id !== parent.sessionId) throw invalid('source rollout belongs to another thread owner');
      visit(parent, depth + 1);
    }
    visiting.delete(entry.rolloutId);
    included.set(entry.filePath, entry);
  };
  for (const entry of entries) visit(entry, 1);
  const stamps = [...included.values()].sort((a, b) => a.filePath.localeCompare(b.filePath)).map(entry => {
    let snapshot = snapshots?.get(entry.filePath);
    if (snapshots && !snapshot) throw invalid(`missing frozen dependency snapshot ${entry.filePath}`);
    if (!snapshot) {
      let stat: fs.BigIntStats;
      try { stat = fs.statSync(entry.filePath, { bigint: true }); }
      catch { throw invalid(`unreadable dependency rollout ${entry.filePath}`); }
      snapshot = { mtime: stat.mtimeNs.toString(), size: Number(stat.size) };
    }
    return [entry.filePath, snapshot.mtime, snapshot.size];
  });
  return createHash('sha256').update(JSON.stringify(stamps)).digest('hex');
}
