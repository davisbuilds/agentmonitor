import { once } from 'node:events';
import type { Server } from 'node:http';
import { config } from './config.js';
import { closeDb, getDb } from './db/connection.js';
import { initSchema } from './db/schema.js';
import { getStatsForBroadcast, updateIdleSessions } from './db/queries.js';
import { SERVICE_WATCHDOG, startEventLoopWatchdog } from './event-loop-watchdog.js';
import { startHookSpoolDrain, stopHookSpoolDrain } from './import/hook-spool.js';
import { runningAsLaunchdService } from './util/service-context.js';
import {
  startSessionSweepBroadcast,
  startStatsBroadcast,
  stopSessionSweepBroadcast,
  stopStatsBroadcast,
} from './api/stream.js';
import { liveBroadcaster } from './api/v2/live-stream.js';
import { broadcaster } from './sse/emitter.js';
import { createApp } from './app.js';
import { runImport } from './import/index.js';
import { startProviderQuotaPolling, stopProviderQuotaPolling } from './provider-quotas/service.js';
import { startGitActivityPolling, stopGitActivityPolling } from './git/service.js';
import { acquireRuntimeOwnership } from './runtime-ownership.js';
import { startServerBuildWatch } from './build-fingerprint.js';
import { startWatcher, stopWatcher } from './watcher/service.js';
import { ensureSessionTraceSummaryBackfill } from './trace-quality/summary.js';
import { recalculateEventCosts } from './pricing/recalc.js';
import { startSearchIndexMaintenance, type SearchIndexMaintenance } from './db/storage.js';

export interface RuntimeOptions {
  noWatch?: boolean;
  noImport?: boolean;
  noQuotaPolling?: boolean;
}

export interface RuntimeHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startAgentMonitorRuntime(options: RuntimeOptions = {}): Promise<RuntimeHandle> {
  const build = startServerBuildWatch();
  const ownership = acquireRuntimeOwnership(config.dbPath, { build });
  // WHY: launchd restarts a process that exits, but a frozen process still looks alive.
  const stopWatchdog = runningAsLaunchdService() ? startEventLoopWatchdog(SERVICE_WATCHDOG) : undefined;
  let server: Server | undefined;
  let sessionChecker: ReturnType<typeof setInterval> | undefined;
  let autoImportTimer: ReturnType<typeof setInterval> | undefined;
  let autoImportDelay: ReturnType<typeof setTimeout> | undefined;
  let searchIndexMaintenance: SearchIndexMaintenance | undefined;
  let closePromise: Promise<void> | undefined;

  function autoImportAll() {
    try {
      const result = runImport({ source: 'all' });
      if (result.totalEventsImported > 0 || result.totalEventsRefreshed > 0 || result.totalEventsRemoved > 0) {
        console.log(`Auto-import: imported ${result.totalEventsImported}, refreshed ${result.totalEventsRefreshed} and removed ${result.totalEventsRemoved} events from ${result.totalFiles - result.skippedFiles} file(s)`);
        if (broadcaster.clientCount > 0) {
          broadcaster.broadcast('session_update', {
            type: 'auto_import',
            imported: result.totalEventsImported,
            refreshed: result.totalEventsRefreshed,
            removed: result.totalEventsRemoved,
          });
        }
      }
    } catch (err) {
      console.error('Auto-import error:', err);
    }
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const errors: unknown[] = [];
      const attempt = async (operation: () => void | Promise<void>) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };

      stopWatchdog?.();
      stopHookSpoolDrain();
      if (sessionChecker) clearInterval(sessionChecker);
      stopSessionSweepBroadcast();
      if (autoImportTimer) clearInterval(autoImportTimer);
      if (autoImportDelay) clearTimeout(autoImportDelay);

      // WHY: EventSource reconnects automatically. Close the listener first so a client cannot
      // reconnect during shutdown.
      const serverClosePromise = server?.listening
        ? new Promise<void>((resolve, reject) => {
            server?.close(error => error ? reject(error) : resolve());
          })
        : undefined;
      // WHY: A close promise can reject before shutdown reaches its later await.
      void serverClosePromise?.catch(() => undefined);

      stopStatsBroadcast();
      broadcaster.closeAllClients();
      liveBroadcaster.closeAllClients();
      server?.closeIdleConnections();

      if (!options.noQuotaPolling) await attempt(stopProviderQuotaPolling);
      await attempt(stopGitActivityPolling);
      await attempt(stopWatcher);
      await attempt(() => searchIndexMaintenance?.stop());
      if (serverClosePromise) await attempt(() => serverClosePromise);
      await attempt(() => closeDb());
      await attempt(() => ownership.release());

      if (errors.length > 0) {
        throw new AggregateError(errors, 'AgentMonitor runtime cleanup failed');
      }
    })();
    return closePromise;
  }

  try {
    initSchema();
    const rebuiltTraceSummaries = ensureSessionTraceSummaryBackfill();
    if (rebuiltTraceSummaries > 0) {
      console.log(`[trace-quality] (re)built ${rebuiltTraceSummaries} session trace summaries`);
    }

    const costs = recalculateEventCosts(getDb(), { apply: true, missingOnly: true });
    if (costs.costs_attributed > 0) {
      console.log(`[pricing] labelled the source of ${costs.costs_attributed} existing cost(s)`);
    }
    if (costs.updated > 0) {
      console.log(`[pricing] priced ${costs.updated} usage row(s) that had no cost`);
    }

    // WHY: A cold synchronous totals query in the request path would stall the first dashboard load.
    getStatsForBroadcast();

    const app = createApp();
    server = app.listen(config.port, config.host);
    await once(server, 'listening');

    const publicUrl = process.env.PORTLESS_URL?.replace(/\/+$/, '');
    console.log(`AgentMonitor listening on http://${config.host}:${config.port}`);
    console.log(`Dashboard: ${publicUrl ? `${publicUrl}/app/` : `http://localhost:${config.port}/app/`}`);

    startStatsBroadcast();
    startHookSpoolDrain();
    if (!options.noWatch) startWatcher();
    if (!options.noQuotaPolling) startProviderQuotaPolling();
    startGitActivityPolling();

    startSessionSweepBroadcast();
    sessionChecker = setInterval(() => {
      updateIdleSessions(config.sessionTimeoutMinutes);
    }, 60_000);

    if (!options.noImport && config.autoImportIntervalMinutes > 0) {
      const intervalMs = config.autoImportIntervalMinutes * 60_000;
      autoImportDelay = setTimeout(autoImportAll, 5_000);
      autoImportTimer = setInterval(autoImportAll, intervalMs);
      console.log(`Auto-import: every ${config.autoImportIntervalMinutes}m`);
    }

    // WHY: Search-index merges reclaim dead entries left by deleted transcripts. Deferring them once
    // grew the index far beyond live size.
    searchIndexMaintenance = startSearchIndexMaintenance({
      db: getDb,
      initialDelayMs: 10 * 60_000,
      intervalMs: 6 * 60 * 60_000,
    });

    return {
      url: `http://${config.host}:${config.port}`,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'AgentMonitor startup and cleanup failed',
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export function installRuntimeSignalHandlers(runtime: RuntimeHandle | Promise<RuntimeHandle>): void {
  const runtimeReady = Promise.resolve(runtime);
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    console.log('\nShutting down AgentMonitor...');
    try {
      const handle = await runtimeReady;
      await handle.close();
      process.exit(0);
    } catch (error) {
      console.error('AgentMonitor shutdown failed:', error);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}
