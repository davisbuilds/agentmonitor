import { config } from '../config.js';
import { upsertProviderQuotaSnapshot } from '../db/queries.js';
import { fetchCodexQuotaSnapshot } from './codex.js';

let codexQuotaTimer: ReturnType<typeof setInterval> | null = null;
let codexQuotaRefreshInFlight = false;

async function refreshCodexQuotaSnapshot(): Promise<void> {
  if (codexQuotaRefreshInFlight) return;
  codexQuotaRefreshInFlight = true;
  try {
    const snapshot = await fetchCodexQuotaSnapshot();
    upsertProviderQuotaSnapshot(snapshot);
  } finally {
    codexQuotaRefreshInFlight = false;
  }
}

export function startProviderQuotaPolling(): void {
  if (codexQuotaTimer) return;
  void refreshCodexQuotaSnapshot();
  codexQuotaTimer = setInterval(() => {
    void refreshCodexQuotaSnapshot();
  }, config.quotas.codexPollIntervalMs);
}

export function stopProviderQuotaPolling(): void {
  if (!codexQuotaTimer) return;
  clearInterval(codexQuotaTimer);
  codexQuotaTimer = null;
}
