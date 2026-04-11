import path from 'path';
import os from 'os';
import { watch, type FSWatcher } from 'chokidar';
import { getDb } from '../db/connection.js';
import { syncSessionFileDetailed, syncAllFiles, syncAllCodexFiles } from './index.js';
import { broadcaster } from '../sse/emitter.js';
import { liveBroadcaster } from '../api/v2/live-stream.js';

let watcher: FSWatcher | undefined;
let resyncTimer: ReturnType<typeof setInterval> | undefined;

// Debounce map: file path → timeout handle
const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;

function getClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

function handleFileChange(filePath: string): void {
  // Debounce: wait 500ms after last change before processing
  const existing = debounceMap.get(filePath);
  if (existing) clearTimeout(existing);

  debounceMap.set(filePath, setTimeout(() => {
    debounceMap.delete(filePath);

    const db = getDb();
    const outcome = syncSessionFileDetailed(db, filePath);

    if (outcome.result === 'parsed') {
      const sessionId = path.basename(filePath, '.jsonl');
      console.log(`[watcher] Parsed session: ${sessionId}`);
      if (outcome.live) {
        liveBroadcaster.broadcast('session_presence', {
          session_id: sessionId,
          live_status: outcome.live.live_status,
          integration_mode: 'claude-jsonl',
          fidelity: 'full',
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
            integration_mode: 'claude-jsonl',
            fidelity: 'full',
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

  // Initial sync on startup
  const db = getDb();
  console.log('[watcher] Starting initial sync...');
  const stats = syncAllFiles(db, claudeDir);
  console.log(`[watcher] Initial sync complete: ${stats.parsed} parsed, ${stats.skipped} skipped, ${stats.errors} errors (${stats.total} total files)`);

  // Sync Codex session files
  const codexStats = syncAllCodexFiles(db);
  if (codexStats.total > 0) {
    console.log(`[watcher] Codex sync: ${codexStats.parsed} parsed, ${codexStats.skipped} skipped, ${codexStats.errors} errors (${codexStats.total} total files)`);
  }

  // Start chokidar watcher
  watcher = watch(path.join(projectsDir, '**/*.jsonl'), {
    persistent: true,
    ignoreInitial: true, // We already did initial sync
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('add', handleFileChange);
  watcher.on('change', handleFileChange);

  watcher.on('error', (err) => {
    console.error('[watcher] Error:', err);
  });

  console.log(`[watcher] Watching ${projectsDir} for changes`);

  // Periodic re-sync every 15 minutes to catch anything missed
  const RESYNC_INTERVAL_MS = 15 * 60_000;
  resyncTimer = setInterval(() => {
    const resyncStats = syncAllFiles(db, claudeDir);
    if (resyncStats.parsed > 0) {
      console.log(`[watcher] Periodic resync: ${resyncStats.parsed} new/updated sessions`);
      if (broadcaster.clientCount > 0) {
        broadcaster.broadcast('session_update', {
          type: 'resync',
          parsed: resyncStats.parsed,
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
