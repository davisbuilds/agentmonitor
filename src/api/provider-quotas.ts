import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/connection.js';
import {
  getProviderQuotas,
  recordClaudeSessionAccounting,
  type ClaudeSessionAccounting,
  upsertProviderQuotaSnapshot,
  type ProviderName,
  type ProviderQuotaSnapshotInput,
} from '../db/queries.js';
import { upsertAntigravityStatuslineContext, type AntigravityStatuslineContextInput } from '../live/projector.js';
import { resolveContextWindow } from '../pricing/context-windows.js';
import { broadcaster } from '../sse/emitter.js';
import { notifyAntigravityActivity } from '../watcher/service.js';
import { liveBroadcaster } from './v2/live-stream.js';

export const providerQuotasRouter = Router();

function isProviderName(value: string): value is ProviderName {
  return value === 'claude' || value === 'codex' || value === 'antigravity';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function positiveFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isWindowsDrivePrefix(segment: string): boolean {
  if (segment.length !== 2 || segment[1] !== ':') return false;
  const code = segment.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function projectNameFromWorkspacePath(rawPath: string | null): string | null {
  if (!rawPath) return null;
  const trimmed = rawPath.trim();
  let end = trimmed.length;
  while (end > 0 && (trimmed[end - 1] === '/' || trimmed[end - 1] === '\\')) {
    end--;
  }
  if (end === 0) return null;
  const withoutTrailing = trimmed.slice(0, end);
  const lastSep = Math.max(withoutTrailing.lastIndexOf('/'), withoutTrailing.lastIndexOf('\\'));
  const last = withoutTrailing.slice(lastSep + 1);
  if (!last || last === '.' || last === '..' || isWindowsDrivePrefix(last)) return null;
  return last;
}

interface AntigravityQuotaBucket {
  remaining_fraction?: unknown;
  reset_time?: unknown;
  reset_in_seconds?: unknown;
  disabled?: unknown;
}

function usableAntigravityBucket(value: unknown): AntigravityQuotaBucket | null {
  const bucket = asRecord(value) as AntigravityQuotaBucket | null;
  if (!bucket || bucket.disabled === true) return null;
  if (typeof bucket.remaining_fraction !== 'number' || !Number.isFinite(bucket.remaining_fraction)) {
    return null;
  }
  return bucket;
}

function parseAntigravityResetTime(bucket: AntigravityQuotaBucket): string | null {
  if (typeof bucket.reset_in_seconds === 'number' && Number.isFinite(bucket.reset_in_seconds) && bucket.reset_in_seconds <= 0) {
    return null;
  }
  if (typeof bucket.reset_time === 'string') {
    const trimmed = bucket.reset_time.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return new Date(parsed).toISOString();
  }
  return null;
}

function buildAntigravityWindow(
  bucket: AntigravityQuotaBucket | null,
  windowMinutes: number,
): ProviderQuotaSnapshotInput['primary'] {
  if (!bucket) return null;
  const remaining = bucket.remaining_fraction as number;
  const usedPercent = Number(Math.max(0, Math.min(100, (1 - remaining) * 100)).toFixed(2));
  return {
    used_percent: usedPercent,
    resets_at: parseAntigravityResetTime(bucket),
    window_minutes: windowMinutes,
  };
}

function sanitizeAntigravityRawPayload(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'email' || key === 'subagents') continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function parseAntigravityStatuslinePayload(payload: unknown): ProviderQuotaSnapshotInput | null {
  const data = asRecord(payload);
  if (!data) return null;
  const quota = asRecord(data.quota);
  if (!quota) return null;

  const gemini5h = usableAntigravityBucket(quota['gemini-5h']);
  const geminiWeekly = usableAntigravityBucket(quota['gemini-weekly']);
  const hasGemini = gemini5h !== null || geminiWeekly !== null;

  const primaryBucket = hasGemini ? gemini5h : usableAntigravityBucket(quota['3p-5h']);
  const secondaryBucket = hasGemini ? geminiWeekly : usableAntigravityBucket(quota['3p-weekly']);
  if (!primaryBucket && !secondaryBucket) return null;

  return {
    provider: 'antigravity',
    agent_type: 'antigravity',
    status: 'available',
    source: 'antigravity-statusline',
    plan_type: nonEmptyString(data.plan_tier),
    primary: buildAntigravityWindow(primaryBucket, 300),
    secondary: buildAntigravityWindow(secondaryBucket, 10080),
    raw_payload: sanitizeAntigravityRawPayload(data),
  };
}

function parseAntigravityStatuslineContext(
  payload: unknown,
  now = Date.now(),
): AntigravityStatuslineContextInput | null {
  const data = asRecord(payload);
  if (!data) return null;

  const sessionId = nonEmptyString(data.conversation_id) ?? nonEmptyString(data.session_id);
  const cw = asRecord(data.context_window);
  if (!sessionId || !cw) return null;

  let usedTokens = positiveFinite(cw.total_input_tokens);
  if (usedTokens === null) {
    const currentUsage = asRecord(cw.current_usage);
    if (currentUsage) {
      const inputTokens = nonNegativeFinite(currentUsage.input_tokens);
      const cacheCreation = nonNegativeFinite(currentUsage.cache_creation_input_tokens);
      const cacheRead = nonNegativeFinite(currentUsage.cache_read_input_tokens);
      if (inputTokens !== null || cacheCreation !== null || cacheRead !== null) {
        const sum = (inputTokens ?? 0) + (cacheCreation ?? 0) + (cacheRead ?? 0);
        if (sum > 0) usedTokens = sum;
      }
    }
  }
  if (usedTokens === null) return null;

  const modelObj = asRecord(data.model);
  const model = nonEmptyString(data.model) ?? nonEmptyString(modelObj?.id) ?? nonEmptyString(modelObj?.display_name);
  const reportedWindow = positiveFinite(cw.context_window_size);
  const windowTokens = resolveContextWindow({
    agent: 'antigravity',
    model,
    reportedWindow,
    observedTokens: usedTokens,
  });

  const workspace = asRecord(data.workspace);
  const workspaceDir = nonEmptyString(workspace?.project_dir)
    ?? nonEmptyString(workspace?.current_dir)
    ?? nonEmptyString(data.cwd);
  const project = projectNameFromWorkspacePath(workspaceDir);

  const rawTitle = nonEmptyString(data.conversation_title);
  const title = rawTitle ? rawTitle.replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;

  return {
    sessionId,
    project,
    firstMessage: title,
    title,
    usedTokens: Math.round(usedTokens),
    windowTokens,
    observedAt: new Date(now).toISOString(),
  };
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
    process_duration_ms: duration,
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

providerQuotasRouter.post('/antigravity/statusline', (req: Request, res: Response) => {
  const contextUpdate = parseAntigravityStatuslineContext(req.body);
  if (contextUpdate) {
    const rowState = upsertAntigravityStatuslineContext(getDb(), contextUpdate);
    liveBroadcaster.broadcast('session_presence', {
      session_id: contextUpdate.sessionId,
      live_status: 'live',
      integration_mode: rowState.integration_mode,
      fidelity: rowState.fidelity,
      last_item_at: rowState.last_item_at,
    });
    if (broadcaster.clientCount > 0) {
      broadcaster.broadcast('session_update', {
        type: 'session_parsed',
        session_id: contextUpdate.sessionId,
      });
    }
  }

  const snapshot = parseAntigravityStatuslinePayload(req.body);
  if (snapshot) {
    upsertProviderQuotaSnapshot(snapshot);
  }

  if (!snapshot && !contextUpdate) {
    res.status(202).json({ accepted: false, reason: 'missing quota or context_window payload' });
    return;
  }

  notifyAntigravityActivity();
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
