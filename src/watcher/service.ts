import fs from 'fs';
import path from 'path';
import { COMPRESSED_ROLLOUT_SUFFIX, transcriptBaseName } from '../util/transcript-file.js';
import os from 'os';
import { watch, type FSWatcher } from 'chokidar';
import { getDb } from '../db/connection.js';
import {
  discoverCodexSessionFiles,
  discoverSessionFiles,
  findMissingSessionProjections,
  syncSessionFileDetailed,
  syncCodexSessionFileDetailed,
  syncAntigravitySessionFileDetailed,
  syncAllFiles,
  syncAllCodexFiles,
  syncAllAntigravityFiles,
} from './index.js';
import { broadcaster } from '../sse/emitter.js';
import { liveBroadcaster } from '../api/v2/live-stream.js';
import { config } from '../config.js';
import { shouldExcludePath } from '../util/path-excludes.js';
import { syncExecutionReceipts } from '../import/executions.js';

/** A Claude transcript, or a Codex rollout, plain or as Codex compresses it once finished. */
function isWatchedTranscript(filePath: string, codexSessionsDir: string): boolean {
  return filePath.endsWith('.jsonl')
    || (filePath.startsWith(codexSessionsDir) && filePath.endsWith(COMPRESSED_ROLLOUT_SUFFIX));
}

function isWithinDirectory(rootDir: string, candidatePath: string): boolean {
  const rel = path.relative(rootDir, candidatePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveAntigravityDbPath(filePath: string, antigravityConversationsDir: string): string | null {
  if (!isWithinDirectory(antigravityConversationsDir, filePath)) return null;
  if (filePath.endsWith('.db')) return filePath;
  if (filePath.endsWith('.db-wal')) return filePath.slice(0, -'-wal'.length);
  if (filePath.endsWith('.db-shm')) return filePath.slice(0, -'-shm'.length);
  return null;
}

let watcher: FSWatcher | undefined;
let antigravityWatcher: FSWatcher | undefined;
let resyncTimer: ReturnType<typeof setInterval> | undefined;
let activeAntigravityDir: string | undefined;
let activeAntigravityConversationsDir: string | undefined;
let activeProjectsDir: string | undefined;
let activeCodexSessionsDir: string | undefined;

const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;
type WatchedSource = 'claude' | 'codex' | 'antigravity';

function getClaudeDir(): string {
  return config.claudeDir;
}

function getCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

function getAntigravityDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

function shouldIgnoreWatchedPath(
  filePath: string,
  source: WatchedSource,
  claudeProjectsDir: string,
  codexSessionsDir: string,
  antigravityConversationsDir: string,
): boolean {
  const rootDir = source === 'codex'
    ? codexSessionsDir
    : source === 'antigravity'
      ? antigravityConversationsDir
      : claudeProjectsDir;
  return shouldExcludePath(rootDir, filePath, config.sync.excludePatterns);
}

function handleFileChange(
  filePath: string,
  source: WatchedSource,
  claudeProjectsDir: string,
  codexSessionsDir: string,
  antigravityConversationsDir: string,
): void {
  if (shouldIgnoreWatchedPath(filePath, source, claudeProjectsDir, codexSessionsDir, antigravityConversationsDir)) {
    return;
  }

  const debounceKey = `${source}:${filePath}`;
  const existing = debounceMap.get(debounceKey);
  if (existing) clearTimeout(existing);

  debounceMap.set(debounceKey, setTimeout(() => {
    debounceMap.delete(debounceKey);

    if (source === 'antigravity' && !fs.existsSync(filePath)) return;

    const db = getDb();
    const outcome = source === 'codex'
      ? syncCodexSessionFileDetailed(db, filePath)
      : source === 'antigravity'
        ? syncAntigravitySessionFileDetailed(db, filePath)
        : syncSessionFileDetailed(db, filePath);

    if (outcome.result === 'parsed') {
      const sessionId = source === 'antigravity'
        ? path.basename(filePath, '.db')
        : transcriptBaseName(filePath);
      const integrationMode = outcome.integration_mode ?? (
        source === 'codex'
          ? 'codex-jsonl'
          : source === 'antigravity'
            ? 'antigravity-sqlite'
            : 'claude-jsonl'
      );
      const fidelity = outcome.fidelity ?? (source === 'claude' ? 'full' : 'summary');
      console.log(`[watcher] Parsed ${source} session: ${sessionId}`);
      if (outcome.live) {
        liveBroadcaster.broadcast('session_presence', {
          session_id: sessionId,
          live_status: outcome.live.live_status,
          integration_mode: integrationMode,
          fidelity,
          last_item_at: outcome.live.last_item_at,
        });
        liveBroadcaster.broadcast('turn_update', {
          session_id: sessionId,
          inserted_turns: outcome.live.inserted_turns,
          reset: outcome.live.reset,
        });
        liveBroadcaster.broadcast('item_delta', {
          session_id: sessionId,
          inserted_items: outcome.live.inserted_items,
          last_item_at: outcome.live.last_item_at,
        });
      }

      if (broadcaster.clientCount > 0) {
        broadcaster.broadcast('session_update', {
          type: 'session_parsed',
          session_id: sessionId,
        });
        if (outcome.live) {
          broadcaster.broadcast('session_update', {
            type: 'session_presence',
            session_id: sessionId,
            live_status: outcome.live.live_status,
            integration_mode: integrationMode,
            fidelity,
          });
          broadcaster.broadcast('session_update', {
            type: 'turn_update',
            session_id: sessionId,
            inserted_turns: outcome.live.inserted_turns,
            reset: outcome.live.reset,
          });
          broadcaster.broadcast('session_update', {
            type: 'item_delta',
            session_id: sessionId,
            inserted_items: outcome.live.inserted_items,
            last_item_at: outcome.live.last_item_at,
          });
        }
      }
    }
  }, DEBOUNCE_MS));
}

function ensureAntigravityWatcher(options: { syncExisting?: boolean } = {}): boolean {
  if (
    !watcher
    || antigravityWatcher
    || !activeAntigravityConversationsDir
    || !activeProjectsDir
    || !activeCodexSessionsDir
  ) {
    return false;
  }
  const antigravityConversationsDir = activeAntigravityConversationsDir;
  if (!fs.existsSync(antigravityConversationsDir)) {
    return false;
  }
  const projectsDir = activeProjectsDir;
  const codexSessionsDir = activeCodexSessionsDir;
  const antigravityDirOverride = activeAntigravityDir;

  // WHY: SQLite writes WAL frames to already-open .db-wal descriptors without closing them,
  // which macOS directory watchers miss; stat polling catches live Antigravity WAL writes.
  const nextWatcher = watch(antigravityConversationsDir, {
    persistent: true,
    ignoreInitial: true,
    backend: 'polling',
    pollingInterval: 500,
    pollingBinaryInterval: 500,
    ignored: (filePath, stats) => {
      if (!stats?.isFile()) return false;
      const agrDb = resolveAntigravityDbPath(filePath, antigravityConversationsDir);
      return !agrDb || shouldExcludePath(antigravityConversationsDir, filePath, config.sync.excludePatterns);
    },
  });
  const onAntigravityFsEvent = (filePath: string) => {
    const agrDb = resolveAntigravityDbPath(filePath, antigravityConversationsDir);
    if (agrDb) {
      handleFileChange(agrDb, 'antigravity', projectsDir, codexSessionsDir, antigravityConversationsDir);
    }
  };
  nextWatcher.on('add', onAntigravityFsEvent);
  nextWatcher.on('change', onAntigravityFsEvent);
  nextWatcher.on('error', (err) => {
    console.error('[watcher] Antigravity error:', err);
  });
  if (options.syncExisting) {
    nextWatcher.once('ready', () => {
      // WHY: Files created while polling initializes can be treated as initial under
      // ignoreInitial: true; sweep once on ready to close that startup window.
      if (antigravityWatcher !== nextWatcher) return;
      const synced = syncAllAntigravityFiles(getDb(), antigravityDirOverride, { excludePatterns: config.sync.excludePatterns });
      if (synced.parsed > 0 && broadcaster.clientCount > 0) {
        broadcaster.broadcast('session_update', { type: 'resync', parsed: synced.parsed });
      }
    });
  }
  antigravityWatcher = nextWatcher;
  return true;
}

export function notifyAntigravityActivity(): boolean {
  const attached = ensureAntigravityWatcher({ syncExisting: true });
  if (attached && activeAntigravityConversationsDir) {
    console.log(`[watcher] Watching ${activeAntigravityConversationsDir} for changes`);
  }
  return attached;
}

export function startWatcher(overrides?: { claudeDir?: string; codexHome?: string; antigravityDir?: string }): void {
  const claudeDir = overrides?.claudeDir ?? getClaudeDir();
  const projectsDir = path.join(claudeDir, 'projects');
  const codexHome = overrides?.codexHome ?? getCodexHome();
  const codexSessionsDir = path.join(codexHome, 'sessions');
  const antigravityDir = overrides?.antigravityDir ?? getAntigravityDir();
  const antigravityConversationsDir = path.join(antigravityDir, 'conversations');
  activeAntigravityDir = overrides?.antigravityDir;
  activeAntigravityConversationsDir = antigravityConversationsDir;
  activeProjectsDir = projectsDir;
  activeCodexSessionsDir = codexSessionsDir;
  const currentSessionFiles = [
    ...discoverSessionFiles(claudeDir, { excludePatterns: config.sync.excludePatterns }),
    ...discoverCodexSessionFiles(codexHome, { excludePatterns: config.sync.excludePatterns }),
  ];

  const db = getDb();
  const syncExecutions = () => {
    const result = syncExecutionReceipts(db, config.executionSpoolDir);
    if (result.imported || result.errors) {
      console.log(`[watcher] Execution receipts: ${result.imported} imported, ${result.errors} errors`);
    }
  };
  syncExecutions();
  console.log('[watcher] Starting initial sync...');
  const stats = syncAllFiles(db, claudeDir, { excludePatterns: config.sync.excludePatterns });
  console.log(`[watcher] Initial sync complete: ${stats.parsed} parsed, ${stats.skipped} skipped, ${stats.errors} errors (${stats.total} total files)`);

  const codexStats = syncAllCodexFiles(db, codexHome, { excludePatterns: config.sync.excludePatterns });
  if (codexStats.total > 0) {
    console.log(`[watcher] Codex sync: ${codexStats.parsed} parsed, ${codexStats.skipped} skipped, ${codexStats.errors} errors (${codexStats.total} total files)`);
  }

  const missingProjections = findMissingSessionProjections(db, currentSessionFiles);
  if (missingProjections.length > 0) {
    console.warn(
      `[watcher] WARNING: ${missingProjections.length} cached Claude/Codex session file(s) `
      + 'have no browsing projection. Preserve the database, then run '
      + '`amon sync sessions --source all --force` to rebuild session analytics.',
    );
  }

  const antigravityStats = syncAllAntigravityFiles(db, overrides?.antigravityDir, { excludePatterns: config.sync.excludePatterns });
  if (antigravityStats.total > 0) {
    console.log(`[watcher] Antigravity sync: ${antigravityStats.parsed} parsed, ${antigravityStats.skipped} skipped, ${antigravityStats.errors} errors (${antigravityStats.total} total files)`);
  }

  const watchTargets = [projectsDir, codexSessionsDir];

  // WHY: Chokidar removed glob support in v4, so watching glob expressions can silently miss every
  // event.
  watcher = watch(watchTargets, {
    persistent: true,
    ignoreInitial: true,
    ignored: (filePath, stats) => {
      // WHY: Rejecting directories by file extension would prevent chokidar from reaching their
      // descendants.
      if (!stats?.isFile()) return false;
      return (
        !isWatchedTranscript(filePath, codexSessionsDir)
        || shouldExcludePath(projectsDir, filePath, config.sync.excludePatterns)
        || shouldExcludePath(codexSessionsDir, filePath, config.sync.excludePatterns)
      );
    },
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  const onFsEvent = (filePath: string) => {
    if (!isWatchedTranscript(filePath, codexSessionsDir)) return;
    const source = filePath.startsWith(codexSessionsDir) ? 'codex' : 'claude';
    handleFileChange(filePath, source, projectsDir, codexSessionsDir, antigravityConversationsDir);
  };
  watcher.on('add', onFsEvent);
  watcher.on('change', onFsEvent);

  watcher.on('error', (err) => {
    console.error('[watcher] Error:', err);
  });

  const watchAntigravity = ensureAntigravityWatcher({ syncExisting: false });
  const loggedTargets = watchAntigravity ? [...watchTargets, antigravityConversationsDir] : watchTargets;
  console.log(`[watcher] Watching ${loggedTargets.join(' and ')} for changes`);

  const RESYNC_INTERVAL_MS = 15 * 60_000;
  resyncTimer = setInterval(() => {
    syncExecutions();
    if (ensureAntigravityWatcher({ syncExisting: false })) {
      console.log(`[watcher] Watching ${antigravityConversationsDir} for changes`);
    }
    const claudeStats = syncAllFiles(db, claudeDir, { excludePatterns: config.sync.excludePatterns });
    const codexStats = syncAllCodexFiles(db, codexHome, { excludePatterns: config.sync.excludePatterns });
    const antigravityStats = syncAllAntigravityFiles(db, overrides?.antigravityDir, { excludePatterns: config.sync.excludePatterns });
    const parsed = claudeStats.parsed + codexStats.parsed + antigravityStats.parsed;

    if (parsed > 0) {
      console.log(
        `[watcher] Periodic resync: ${parsed} new/updated sessions `
        + `(claude=${claudeStats.parsed}, codex=${codexStats.parsed}, antigravity=${antigravityStats.parsed})`,
      );
      if (broadcaster.clientCount > 0) {
        broadcaster.broadcast('session_update', {
          type: 'resync',
          parsed,
        });
      }
    }
  }, RESYNC_INTERVAL_MS);
}

export async function stopWatcher(): Promise<void> {
  const activeWatcher = watcher;
  const activeAntigravityWatcher = antigravityWatcher;
  watcher = undefined;
  antigravityWatcher = undefined;
  activeAntigravityDir = undefined;
  activeAntigravityConversationsDir = undefined;
  activeProjectsDir = undefined;
  activeCodexSessionsDir = undefined;
  if (resyncTimer) {
    clearInterval(resyncTimer);
    resyncTimer = undefined;
  }
  for (const timeout of debounceMap.values()) {
    clearTimeout(timeout);
  }
  debounceMap.clear();
  await Promise.all([
    activeWatcher?.close(),
    activeAntigravityWatcher?.close(),
  ]);
}
