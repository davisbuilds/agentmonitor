import path from 'path';
import os from 'os';
import { watch, type FSWatcher } from 'chokidar';
import { getDb } from '../db/connection.js';
import { syncSessionFileDetailed, syncCodexSessionFileDetailed, syncAllFiles, syncAllCodexFiles } from './index.js';
import { broadcaster } from '../sse/emitter.js';
import { liveBroadcaster } from '../api/v2/live-stream.js';
import { config } from '../config.js';
import { shouldExcludePath } from '../util/path-excludes.js';

let watcher: FSWatcher | undefined;
let resyncTimer: ReturnType<typeof setInterval> | undefined;

// Debounce map: file path → timeout handle
const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;
type WatchedSource = 'claude' | 'codex';

function getClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

function getCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

function shouldIgnoreWatchedPath(
  filePath: string,
  source: WatchedSource,
  claudeProjectsDir: string,
  codexSessionsDir: string,
): boolean {
  const rootDir = source === 'codex' ? codexSessionsDir : claudeProjectsDir;
  return shouldExcludePath(rootDir, filePath, config.sync.excludePatterns);
}

function handleFileChange(
  filePath: string,
  source: WatchedSource,
  claudeProjectsDir: string,
  codexSessionsDir: string,
): void {
  if (shouldIgnoreWatchedPath(filePath, source, claudeProjectsDir, codexSessionsDir)) {
    return;
  }

  // Debounce: wait 500ms after last change before processing
  const debounceKey = `${source}:${filePath}`;
  const existing = debounceMap.get(debounceKey);
  if (existing) clearTimeout(existing);

  debounceMap.set(debounceKey, setTimeout(() => {
    debounceMap.delete(debounceKey);

    const db = getDb();
    const outcome = source === 'codex'
      ? syncCodexSessionFileDetailed(db, filePath)
      : syncSessionFileDetailed(db, filePath);

    if (outcome.result === 'parsed') {
      const sessionId = path.basename(filePath, '.jsonl');
      const integrationMode = source === 'codex' ? 'codex-jsonl' : 'claude-jsonl';
      const fidelity = source === 'codex' ? 'summary' : 'full';
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

export function startWatcher(): void {
  const claudeDir = getClaudeDir();
  const projectsDir = path.join(claudeDir, 'projects');
  const codexSessionsDir = path.join(getCodexHome(), 'sessions');

  // Initial sync on startup
  const db = getDb();
  console.log('[watcher] Starting initial sync...');
  const stats = syncAllFiles(db, claudeDir, { excludePatterns: config.sync.excludePatterns });
  console.log(`[watcher] Initial sync complete: ${stats.parsed} parsed, ${stats.skipped} skipped, ${stats.errors} errors (${stats.total} total files)`);

  // Sync Codex session files
  const codexStats = syncAllCodexFiles(db, undefined, { excludePatterns: config.sync.excludePatterns });
  if (codexStats.total > 0) {
    console.log(`[watcher] Codex sync: ${codexStats.parsed} parsed, ${codexStats.skipped} skipped, ${codexStats.errors} errors (${codexStats.total} total files)`);
  }

  // Start chokidar watcher
  watcher = watch([
    path.join(projectsDir, '**/*.jsonl'),
    path.join(codexSessionsDir, '**/*.jsonl'),
  ], {
    persistent: true,
    ignoreInitial: true, // We already did initial sync
    ignored: (filePath) => (
      shouldExcludePath(projectsDir, filePath, config.sync.excludePatterns)
      || shouldExcludePath(codexSessionsDir, filePath, config.sync.excludePatterns)
    ),
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('add', (filePath) => {
    const source = filePath.startsWith(codexSessionsDir) ? 'codex' : 'claude';
    handleFileChange(filePath, source, projectsDir, codexSessionsDir);
  });
  watcher.on('change', (filePath) => {
    const source = filePath.startsWith(codexSessionsDir) ? 'codex' : 'claude';
    handleFileChange(filePath, source, projectsDir, codexSessionsDir);
  });

  watcher.on('error', (err) => {
    console.error('[watcher] Error:', err);
  });

  console.log(`[watcher] Watching ${projectsDir} and ${codexSessionsDir} for changes`);

  // Periodic re-sync every 15 minutes to catch anything missed
  const RESYNC_INTERVAL_MS = 15 * 60_000;
  resyncTimer = setInterval(() => {
    const claudeStats = syncAllFiles(db, claudeDir, { excludePatterns: config.sync.excludePatterns });
    const codexStats = syncAllCodexFiles(db, undefined, { excludePatterns: config.sync.excludePatterns });
    const parsed = claudeStats.parsed + codexStats.parsed;

    if (parsed > 0) {
      console.log(
        `[watcher] Periodic resync: ${parsed} new/updated sessions `
        + `(claude=${claudeStats.parsed}, codex=${codexStats.parsed})`,
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

export function stopWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = undefined;
  }
  if (resyncTimer) {
    clearInterval(resyncTimer);
    resyncTimer = undefined;
  }
  // Clear any pending debounce timers
  for (const timeout of debounceMap.values()) {
    clearTimeout(timeout);
  }
  debounceMap.clear();
}
