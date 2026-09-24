import { once } from 'node:events';
import type { Server } from 'node:http';
import { config } from './config.js';
import { closeDb, getDb } from './db/connection.js';
import { initSchema } from './db/schema.js';
import { getStatsForBroadcast, updateIdleSessions } from './db/queries.js';
import { startStatsBroadcast, stopStatsBroadcast } from './api/stream.js';
import { liveBroadcaster } from './api/v2/live-stream.js';
import { broadcaster } from './sse/emitter.js';
import { createApp } from './app.js';
import { runImport } from './import/index.js';
import { startProviderQuotaPolling, stopProviderQuotaPolling } from './provider-quotas/service.js';
import { acquireRuntimeOwnership } from './runtime-ownership.js';
import { startServerBuildWatch } from './build-fingerprint.js';
import { startWatcher, stopWatcher } from './watcher/service.js';
import { ensureSessionTraceSummaryBackfill } from './trace-quality/summary.js';
import { recalculateEventCosts } from './pricing/recalc.js';

export interface RuntimeOptions {
  noWatch?: boolean;
  noImport?: boolean;
}

export interface RuntimeHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startAgentMonitorRuntime(options: RuntimeOptions = {}): Promise<RuntimeHandle> {
  // Record the build this process loaded before anything can rebuild it, and
  // publish it in the lock so one-shot commands can tell they differ.
  const build = startServerBuildWatch();
  const ownership = acquireRuntimeOwnership(config.dbPath, { build });
  let server: Server | undefined;
  let sessionChecker: ReturnType<typeof setInterval> | undefined;
  let autoImportTimer: ReturnType<typeof setInterval> | undefined;
  let autoImportDelay: ReturnType<typeof setTimeout> | undefined;
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

      if (sessionChecker) clearInterval(sessionChecker);
      if (autoImportTimer) clearInterval(autoImportTimer);
      if (autoImportDelay) clearTimeout(autoImportDelay);

      // Stop accepting connections before ending SSE responses. EventSource
      // clients reconnect automatically when a stream closes; leaving the
      // listener open during the awaited service cleanup can admit a new stream
      // that keeps server.close() pending indefinitely.
      const serverClosePromise = server?.listening
        ? new Promise<void>((resolve, reject) => {
            server?.close(error => error ? reject(error) : resolve());
          })
        : undefined;
      // Attach a handler immediately in case close fails before the later await.
      void serverClosePromise?.catch(() => undefined);

      stopStatsBroadcast();
      broadcaster.closeAllClients();
      liveBroadcaster.closeAllClients();
      server?.closeIdleConnections();

      await attempt(stopProviderQuotaPolling);
      await attempt(stopWatcher);
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

    // Rates load once, from this build. Price any usage stored while its model
    // had no rate card (it billed as $0), so a pricing update takes effect on
    // the restart that ships it rather than waiting for a manual recalc.
    const costs = recalculateEventCosts(getDb(), { apply: true, missingOnly: true });
    if (costs.costs_attributed > 0) {
      console.log(`[pricing] labelled the source of ${costs.costs_attributed} existing cost(s)`);
    }
    if (costs.updated > 0) {
      console.log(`[pricing] priced ${costs.updated} usage row(s) that had no cost`);
    }

    // Build the all-time Monitor snapshot before accepting HTTP work. The
    // underlying better-sqlite3 query is synchronous; leaving its first cold
    // run to the dashboard would queue health and every other request behind
    // it. Subsequent event writes invalidate this cache, and the hot indexed
    // refresh stays bounded.
    getStatsForBroadcast();

    const app = createApp();
    server = app.listen(config.port, config.host);
    await once(server, 'listening');

    const publicUrl = process.env.PORTLESS_URL?.replace(/\/+$/, '');
    console.log(`AgentMonitor listening on http://${config.host}:${config.port}`);
    console.log(`Dashboard: ${publicUrl ? `${publicUrl}/app/` : `http://localhost:${config.port}/app/`}`);

    startStatsBroadcast();
    if (!options.noWatch) startWatcher();
    startProviderQuotaPolling();

    sessionChecker = setInterval(() => {
      const idled = updateIdleSessions(config.sessionTimeoutMinutes);
      if (idled > 0 && broadcaster.clientCount > 0) {
        broadcaster.broadcast('session_update', { type: 'idle_check', idled });
      }
    }, 60_000);

    if (!options.noImport && config.autoImportIntervalMinutes > 0) {
      const intervalMs = config.autoImportIntervalMinutes * 60_000;
      autoImportDelay = setTimeout(autoImportAll, 5_000);
      autoImportTimer = setInterval(autoImportAll, intervalMs);
      console.log(`Auto-import: every ${config.autoImportIntervalMinutes}m`);
    }

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
