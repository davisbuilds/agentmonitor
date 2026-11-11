import { Router, type Request, type Response } from 'express';
import { broadcaster } from '../sse/emitter.js';
import { getStatsForBroadcast, getProviderQuotas, onSessionSweep } from '../db/queries.js';
import { config } from '../config.js';
import { serverBuildStatus } from '../build-fingerprint.js';
import { getRecentUnpricedModels } from '../db/v2-queries.js';

export const streamRouter = Router();

// Periodic stats broadcaster
let statsInterval: ReturnType<typeof setInterval> | null = null;

export function startStatsBroadcast(): void {
  if (statsInterval) return;
  let staleBuildLogged = false;
  let unpricedLogged = '';
  statsInterval = setInterval(() => {
    const build = serverBuildStatus();
    if (build.stale && !staleBuildLogged) {
      staleBuildLogged = true;
      console.warn(`[build] the build on disk changed since this server started (${build.started} -> ${build.current}). Restart to load it; until then this server keeps running the old code.`);
    }
    const unpriced = getRecentUnpricedModels().map(entry => entry.model).join(', ');
    if (unpriced && unpriced !== unpricedLogged) {
      console.warn(`[pricing] recent usage from models with no rate card bills as $0: ${unpriced}. Add their rates under src/pricing/data/, rebuild and restart; startup then prices the stored rows.`);
    }
    unpricedLogged = unpriced;
    if (broadcaster.clientCount === 0) return;
    broadcaster.broadcast('stats', statsBroadcastPayload());
  }, config.statsIntervalMs);
}

/** The periodic `stats` SSE snapshot, with the server-state flags that ride it. */
export function statsBroadcastPayload(): Record<string, unknown> {
  const build = serverBuildStatus();
  const stats = getStatsForBroadcast();
  const quota_monitor = getProviderQuotas();
  const server_build = { tracked: build.tracked, stale: build.stale };
  const unpriced_models = getRecentUnpricedModels();
  return { ...stats, quota_monitor, usage_monitor: quota_monitor, server_build, unpriced_models } as unknown as Record<string, unknown>;
}

export function stopStatsBroadcast(): void {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

let stopSweepListener: (() => void) | null = null;

/**
 * Send each session-sweep result as a `session_update` of type `idle_check`.
 * Reads run the sweep too, so this listens to the sweep itself: whichever
 * caller in this process moved a session, the Monitor hears the status it now
 * has. A sweep in another process (an `amon` command) is not heard; the
 * timeout rides along so the Monitor can still idle what that sweep moved.
 */
export function startSessionSweepBroadcast(): void {
  if (stopSweepListener) return;
  stopSweepListener = onSessionSweep((sweep) => {
    if (broadcaster.clientCount === 0) return;
    broadcaster.broadcast('session_update', {
      type: 'idle_check',
      idled: sweep.idled,
      ended: sweep.ended,
      transitions: sweep.transitions,
      timeout_minutes: config.sessionTimeoutMinutes,
    });
  });
}

export function stopSessionSweepBroadcast(): void {
  stopSweepListener?.();
  stopSweepListener = null;
}

// GET /api/stream - SSE endpoint
streamRouter.get('/', (req: Request, res: Response) => {
  const accepted = broadcaster.addClient(res, {
    agentType: req.query.agent_type as string | undefined,
    eventType: req.query.event_type as string | undefined,
  });

  if (!accepted) {
    res.status(503).json({
      error: 'SSE client limit reached',
      max_clients: config.maxSseClients,
    });
  }
});
