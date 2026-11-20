import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { getToolTimingSession } from '../db/v2-queries.js';
import { discoverCodexRolloutFilesRecursive, discoverJsonlFilesRecursive } from '../util/file-discovery.js';
import { shouldExcludePath } from '../util/path-excludes.js';
import { transcriptBaseName } from '../util/transcript-file.js';
import { readToolTiming } from './tool-timing.js';
import { measureSleepOverlap, readLocalPowerHistory, unionDurationMs, type SleepOverlap } from './tool-timing-power.js';

function existingRollout(file: string): string | undefined {
  if (!/\.jsonl(?:\.zst)?$/.test(file)) return;
  const plain = file.replace(/\.jsonl\.zst$/, '.jsonl');
  return [plain, `${plain}.zst`].find(candidate => fs.existsSync(candidate));
}

/** Codex may replace a physical rollout while keeping its native session UUID. */
function currentNativeRollout(codexHome: string, id: string): string | undefined {
  const stateDir = process.env.CODEX_SQLITE_HOME || codexHome;
  let db: Database.Database | undefined;
  try {
    const indexes = fs.readdirSync(stateDir).filter(name => /^state_\d+\.sqlite$/.test(name));
    const current = indexes.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0];
    if (!current) return;
    db = new Database(path.join(stateDir, current), { readonly: true, fileMustExist: true, timeout: 250 });
    const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(id) as { rollout_path: string } | undefined;
    if (!row?.rollout_path || !path.isAbsolute(row.rollout_path) || !/\.jsonl(?:\.zst)?$/.test(row.rollout_path)) return;
    const file = existingRollout(row.rollout_path);
    if (!file) return;
    const real = fs.realpathSync(file);
    for (const dir of ['sessions', 'archived_sessions']) {
      const root = path.join(codexHome, dir);
      if (!fs.existsSync(root)) continue;
      const resolvedRoot = fs.realpathSync(root);
      if (real.startsWith(resolvedRoot + path.sep) && !shouldExcludePath(resolvedRoot, real, config.sync.excludePatterns)) return real;
    }
  } catch {
    // Older or unavailable native indexes still permit a bounded filename lookup.
  } finally {
    db?.close();
  }
}

function sessionFiles(session: NonNullable<ReturnType<typeof getToolTimingSession>>) {
  if (session.agent === 'codex') {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    // A live thread can resume in a new rollout before the watcher catches up.
    const native = currentNativeRollout(home, session.session_id);
    if (native) return { selection: 'native_index' as const, files: [native] };
    const indexed = session.file_path && existingRollout(session.file_path);
    if (indexed) return { selection: 'monitor_index' as const, files: [indexed] };
    const files = ['sessions', 'archived_sessions'].flatMap(dir => {
      try {
        return discoverCodexRolloutFilesRecursive(path.join(home, dir), { excludePatterns: config.sync.excludePatterns });
      } catch {
        return [];
      }
    }).filter(file => {
      const name = transcriptBaseName(file).toLowerCase();
      const id = session.session_id.toLowerCase();
      // Replacements can carry the native UUID followed by the physical rollout UUID.
      return name.endsWith(`-${id}`) || name.includes(`-${id}_`);
    });
    // A matching original filename alone cannot establish that a later leaf was retained.
    return { selection: 'filename' as const, files };
  }
  if (session.agent === 'claude') {
    if (session.file_path && fs.existsSync(session.file_path)) return { selection: 'monitor_index' as const, files: [session.file_path] };
    try {
      const files = discoverJsonlFilesRecursive(path.join(config.claudeDir, 'projects'), { excludePatterns: config.sync.excludePatterns })
        .filter(file => transcriptBaseName(file) === session.session_id);
      return { selection: 'filename' as const, files };
    } catch {
      return { selection: 'filename' as const, files: [] };
    }
  }
  return { selection: 'unsupported' as const, files: [] };
}

function sleepFields(overlap: SleepOverlap) {
  return { coverage: overlap.coverage, sleep_overlap_ms: overlap.sleepOverlapMs, covered_ms: overlap.coveredMs };
}

export async function getSessionToolTiming(id: string, options: { limit: number; offset: number; powerHost?: string }) {
  const session = getToolTimingSession(id);
  if (!session) return;
  const { files, selection } = sessionFiles(session);
  const source = session.agent === 'codex' ? 'codex' : 'claude-code';
  const { coverage, intervals } = readToolTiming({ sessionId: session.session_id, source, filePaths: files });
  if (selection === 'filename' && coverage.status === 'available') coverage.status = 'partial';
  const ranges = intervals.map(call => ({ startMs: call.startedAt, endMs: call.returnedAt }));
  const history = options.powerHost && ranges.length ? await readLocalPowerHistory(ranges) : null;
  const sleep = measureSleepOverlap(ranges, history);
  const sorted = [...intervals].sort((a, b) => (b.returnedAt - b.startedAt) - (a.returnedAt - a.startedAt)
    || a.startedAt - b.startedAt || a.callId.localeCompare(b.callId));
  const page = sorted.slice(options.offset, options.offset + options.limit);
  return {
    session_id: session.session_id,
    agent: session.agent,
    source_selection: selection,
    coverage: {
      status: coverage.status,
      files_read: coverage.filesRead,
      malformed_records: coverage.malformedRecords,
      open_calls: coverage.openCalls,
      unmatched_returns: coverage.unmatchedReturns,
      invalid_intervals: coverage.invalidIntervals,
      duplicate_calls: coverage.duplicateCalls,
      copied_records: coverage.copiedRecords,
      unresolved_files: coverage.unresolvedFiles,
    },
    total_calls: intervals.length,
    reported_calls: intervals.filter(call => call.reportedMs !== null).length,
    elapsed_union_ms: coverage.status === 'available' || intervals.length > 0 ? unionDurationMs(ranges) : null,
    power_host: options.powerHost ?? null,
    sleep: sleepFields(sleep),
    calls: page.map(call => ({
      call_id: call.callId, tool: call.toolName,
      started_at: new Date(call.startedAt).toISOString(), returned_at: new Date(call.returnedAt).toISOString(),
      elapsed_ms: call.returnedAt - call.startedAt, reported_ms: call.reportedMs, reported_source: call.reportedSource ?? null,
      sleep: sleepFields(measureSleepOverlap([{ startMs: call.startedAt, endMs: call.returnedAt }], history)),
    })),
    next_offset: options.offset + page.length < intervals.length ? options.offset + page.length : null,
  };
}

export type SessionToolTiming = NonNullable<Awaited<ReturnType<typeof getSessionToolTiming>>>;
