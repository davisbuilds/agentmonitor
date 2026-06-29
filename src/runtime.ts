import { config } from './config.js';
import { initSchema } from './db/schema.js';
import { updateIdleSessions } from './db/queries.js';
import { startStatsBroadcast, stopStatsBroadcast } from './api/stream.js';
import { broadcaster } from './sse/emitter.js';
import { createApp } from './app.js';
import { runImport } from './import/index.js';
import { startProviderQuotaPolling, stopProviderQuotaPolling } from './provider-quotas/service.js';
import { startWatcher, stopWatcher } from './watcher/service.js';
import { ensureSessionTraceSummaryBackfill } from './trace-quality/summary.js';

export interface RuntimeOptions {
  noWatch?: boolean;
  noImport?: boolean;
}

export interface RuntimeHandle {
  url: string;
  close: () => Promise<void>;
}

export function startAgentMonitorRuntime(options: RuntimeOptions = {}): RuntimeHandle {
  initSchema();
  ensureSessionTraceSummaryBackfill();

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`AgentMonitor listening on http://${config.host}:${config.port}`);
    console.log(`Dashboard: http://localhost:${config.port}/app/`);
  });

  startStatsBroadcast();

  if (!options.noWatch) {
    startWatcher();
  }

  startProviderQuotaPolling();

  const sessionChecker = setInterval(() => {
    const idled = updateIdleSessions(config.sessionTimeoutMinutes);
    if (idled > 0 && broadcaster.clientCount > 0) {
      broadcaster.broadcast('session_update', { type: 'idle_check', idled });
    }
  }, 60_000);

  let autoImportTimer: ReturnType<typeof setInterval> | undefined;
  let autoImportDelay: ReturnType<typeof setTimeout> | undefined;

  function autoImportAll() {
    try {
      const result = runImport({ source: 'all' });
      if (result.totalEventsImported > 0) {
        console.log(`Auto-import: imported ${result.totalEventsImported} events from ${result.totalFiles - result.skippedFiles} file(s)`);
        if (broadcaster.clientCount > 0) {
          broadcaster.broadcast('session_update', { type: 'auto_import', imported: result.totalEventsImported });
        }
      }
    } catch (err) {
      console.error('Auto-import error:', err);
    }
  }

  if (!options.noImport && config.autoImportIntervalMinutes > 0) {
    const intervalMs = config.autoImportIntervalMinutes * 60_000;
    autoImportDelay = setTimeout(autoImportAll, 5_000);
    autoImportTimer = setInterval(autoImportAll, intervalMs);
    console.log(`Auto-import: every ${config.autoImportIntervalMinutes}m`);
  }

  async function close(): Promise<void> {
    stopWatcher();
    stopProviderQuotaPolling();
    stopStatsBroadcast();
    clearInterval(sessionChecker);
    if (autoImportTimer) clearInterval(autoImportTimer);
    if (autoImportDelay) clearTimeout(autoImportDelay);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  return {
    url: `http://${config.host}:${config.port}`,
    close,
  };
}

export function installRuntimeSignalHandlers(runtime: RuntimeHandle): void {
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    console.log('\nShutting down AgentMonitor...');
    await runtime.close();
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}
