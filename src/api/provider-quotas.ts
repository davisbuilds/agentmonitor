import { Router, type Request, type Response } from 'express';
import {
  getProviderQuotas,
  recordClaudeSessionAccounting,
  type ClaudeSessionAccounting,
  upsertProviderQuotaSnapshot,
  type ProviderName,
  type ProviderQuotaSnapshotInput,
} from '../db/queries.js';

export const providerQuotasRouter = Router();

function isProviderName(value: string): value is ProviderName {
  return value === 'claude' || value === 'codex';
}

function parseClaudeStatuslinePayload(payload: unknown): ProviderQuotaSnapshotInput | null {
  if (!payload || typeof payload !== 'object') return null;

  const data = payload as {
    rate_limits?: {
      five_hour?: { used_percentage?: number | null; resets_at?: number | null } | null;
      seven_day?: { used_percentage?: number | null; resets_at?: number | null } | null;
    } | null;
  };

  const rateLimits = data.rate_limits;
  const fiveHour = rateLimits?.five_hour;
  const sevenDay = rateLimits?.seven_day;

  if (!fiveHour && !sevenDay) return null;

  return {
    provider: 'claude',
    agent_type: 'claude_code',
    status: 'available',
    source: 'claude-statusline',
    primary: fiveHour ? {
      used_percent: fiveHour.used_percentage ?? null,
      resets_at: fiveHour.resets_at ?? null,
      window_minutes: 300,
    } : null,
    secondary: sevenDay ? {
      used_percent: sevenDay.used_percentage ?? null,
      resets_at: sevenDay.resets_at ?? null,
      window_minutes: 10080,
    } : null,
    raw_payload: payload,
  };
}

/**
 * The session's running cost, which Claude Code keeps in memory for the life of
 * the process and adds to once per API response.
 */
function parseClaudeSessionAccounting(payload: unknown, now = Date.now()): ClaudeSessionAccounting | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as {
    session_id?: unknown;
    version?: unknown;
    cost?: { total_cost_usd?: unknown; total_duration_ms?: unknown } | null;
  };
  const cost = data.cost?.total_cost_usd;
  const duration = data.cost?.total_duration_ms;
  if (typeof data.session_id !== 'string' || data.session_id === '') return null;
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return null;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null;
  return {
    session_id: data.session_id,
    observed_at: new Date(now).toISOString(),
    process_started_at: new Date(now - duration).toISOString(),
    cost_usd: cost,
    claude_version: typeof data.version === 'string' ? data.version : null,
  };
}

providerQuotasRouter.get('/', (_req: Request, res: Response) => {
  res.json(getProviderQuotas());
});

providerQuotasRouter.post('/claude/statusline', (req: Request, res: Response) => {
  const accounting = parseClaudeSessionAccounting(req.body);
  if (accounting) recordClaudeSessionAccounting(accounting);

  const snapshot = parseClaudeStatuslinePayload(req.body);
  if (!snapshot) {
    res.status(202).json({ accepted: false, reason: 'missing rate_limits payload' });
    return;
  }

  upsertProviderQuotaSnapshot(snapshot);
  res.status(202).json({ accepted: true });
});

providerQuotasRouter.post('/:provider', (req: Request, res: Response) => {
  const providerParam = req.params['provider'];
  const provider = Array.isArray(providerParam) ? providerParam[0] : providerParam;
  if (!provider || !isProviderName(provider)) {
    res.status(404).json({ error: 'Unknown provider' });
    return;
  }
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'Expected JSON object body' });
    return;
  }

  upsertProviderQuotaSnapshot({
    ...(req.body as Omit<ProviderQuotaSnapshotInput, 'provider'>),
    provider,
  });
  res.status(202).json({ accepted: true });
});
