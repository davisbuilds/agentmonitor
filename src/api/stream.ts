import { Router, type Request, type Response } from 'express';
import { broadcaster } from '../sse/emitter.js';
import { getStatsForBroadcast, getProviderQuotas } from '../db/queries.js';
import { config } from '../config.js';
import { serverBuildStatus } from '../build-fingerprint.js';

export const streamRouter = Router();

// Periodic stats broadcaster
let statsInterval: ReturnType<typeof setInterval> | null = null;

export function startStatsBroadcast(): void {
  if (statsInterval) return;
  let staleBuildLogged = false;
  statsInterval = setInterval(() => {
    const build = serverBuildStatus();
    if (build.stale && !staleBuildLogged) {
      staleBuildLogged = true;
      console.warn(`[build] the build on disk changed since this server started (${build.started} -> ${build.current}). Restart to load it; until then this server keeps running the old code.`);
    }
    if (broadcaster.clientCount === 0) return;
    const stats = getStatsForBroadcast();
    const quota_monitor = getProviderQuotas();
    const server_build = { tracked: build.tracked, stale: build.stale };
    broadcaster.broadcast('stats', { ...stats, quota_monitor, usage_monitor: quota_monitor, server_build } as unknown as Record<string, unknown>);
  }, config.statsIntervalMs);
}

export function stopStatsBroadcast(): void {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
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
