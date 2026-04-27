import { Router, type Request, type Response } from 'express';
import {
  listBrowsingSessions,
  getBrowsingSession,
  getSessionChildren,
  getSessionMessages,
  getSessionActivity,
  listPinnedMessages,
  pinMessage,
  unpinMessage,
  listLiveSessions,
  getLiveSession,
  getSessionTurns,
  getSessionItems,
  searchMessages,
  getAnalyticsSummary,
  getAnalyticsActivity,
  getAnalyticsCoverage,
  getAnalyticsHourOfWeek,
  getAnalyticsTopSessions,
  getAnalyticsVelocity,
  getAnalyticsAgents,
  getAnalyticsProjects,
  getAnalyticsTools,
  getMonitorToolStats,
  listMonitorSessions,
  listMonitorEvents,
  getMonitorStats,
  getMonitorFilterOptions,
  getMonitorSessionWithEvents,
  getMonitorSessionTranscript,
  getAnalyticsSkillsDaily,
  getUsageSummary,
  getUsageCoverage,
  getUsageDaily,
  getUsageProjects,
  getUsageModels,
  getUsageAgents,
  getUsageTopSessions,
  listInsights,
  getInsight,
  deleteInsight,
  getDistinctProjects,
  getDistinctAgents,
} from '../../db/v2-queries.js';
import { liveStreamRouter } from './live-stream.js';
import { config } from '../../config.js';
import { generateInsight } from '../../insights/service.js';

export const v2Router = Router();
v2Router.use('/live/stream', liveStreamRouter);

function safeInt(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = parseInt(value, 10);
  return isNaN(n) ? undefined : n;
}

function safeString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// --- Sessions ---

v2Router.get('/sessions', (req: Request, res: Response) => {
  try {
    const params = {
      limit: safeInt(req.query.limit as string),
      cursor: req.query.cursor as string | undefined,
      project: req.query.project as string | undefined,
      agent: req.query.agent as string | undefined,
      date_from: req.query.date_from as string | undefined,
      date_to: req.query.date_to as string | undefined,
      min_messages: safeInt(req.query.min_messages as string),
      max_messages: safeInt(req.query.max_messages as string),
    };
    const result = listBrowsingSessions(params);
    res.json(result);
  } catch (err) {
    console.error('[v2/sessions] Error:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

v2Router.get('/sessions/:id', (req: Request, res: Response) => {
  try {
    const session = getBrowsingSession(req.params['id'] as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    console.error('[v2/sessions/:id] Error:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

v2Router.get('/sessions/:id/messages', (req: Request, res: Response) => {
  try {
    const sessionId = req.params['id'] as string;
    const session = getBrowsingSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const params = {
      offset: safeInt(req.query.offset as string),
      limit: safeInt(req.query.limit as string),
      around_ordinal: safeInt(req.query.around_ordinal as string),
    };
    const result = getSessionMessages(sessionId, params);
    res.json(result);
  } catch (err) {
    console.error('[v2/sessions/:id/messages] Error:', err);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

v2Router.get('/sessions/:id/activity', (req: Request, res: Response) => {
  try {
    const sessionId = req.params['id'] as string;
    const session = getBrowsingSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(getSessionActivity(sessionId));
  } catch (err) {
    console.error('[v2/sessions/:id/activity] Error:', err);
    res.status(500).json({ error: 'Failed to get session activity' });
  }
});

v2Router.get('/sessions/:id/pins', (req: Request, res: Response) => {
  try {
    const sessionId = req.params['id'] as string;
    const session = getBrowsingSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ data: listPinnedMessages({ session_id: sessionId }) });
  } catch (err) {
    console.error('[v2/sessions/:id/pins] Error:', err);
    res.status(500).json({ error: 'Failed to list session pins' });
  }
});

v2Router.post('/sessions/:id/messages/:messageId/pin', (req: Request, res: Response) => {
  try {
    const sessionId = req.params['id'] as string;
    const session = getBrowsingSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const messageId = safeInt(req.params['messageId'] as string | undefined);
    if (!messageId) {
      res.status(400).json({ error: 'Invalid message id' });
      return;
    }

    const pinned = pinMessage(sessionId, messageId);
    if (!pinned) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    res.status(201).json(pinned);
  } catch (err) {
    console.error('[v2/sessions/:id/messages/:messageId/pin POST] Error:', err);
    res.status(500).json({ error: 'Failed to pin message' });
  }
});

v2Router.delete('/sessions/:id/messages/:messageId/pin', (req: Request, res: Response) => {
  try {
    const sessionId = req.params['id'] as string;
    const session = getBrowsingSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const messageId = safeInt(req.params['messageId'] as string | undefined);
    if (!messageId) {
      res.status(400).json({ error: 'Invalid message id' });
      return;
    }

    const result = unpinMessage(sessionId, messageId);
    if (!result.removed) {
      res.status(404).json({ error: 'Pin not found' });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error('[v2/sessions/:id/messages/:messageId/pin DELETE] Error:', err);
    res.status(500).json({ error: 'Failed to unpin message' });
  }
});

v2Router.get('/sessions/:id/children', (req: Request, res: Response) => {
  try {
    const children = getSessionChildren(req.params['id'] as string);
    res.json({ data: children });
  } catch (err) {
    console.error('[v2/sessions/:id/children] Error:', err);
    res.status(500).json({ error: 'Failed to get children' });
  }
});

// --- Search ---

v2Router.get('/pins', (req: Request, res: Response) => {
  try {
    res.json({ data: listPinnedMessages({ project: req.query.project as string | undefined }) });
  } catch (err) {
    console.error('[v2/pins] Error:', err);
    res.status(500).json({ error: 'Failed to list pins' });
  }
});

// --- Live ---

function splitKinds(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const kinds = value.split(',').map(part => part.trim()).filter(Boolean);
  return kinds.length > 0 ? kinds : undefined;
}

v2Router.get('/live/settings', (_req: Request, res: Response) => {
  res.json({
    enabled: config.live.enabled,
    codex_mode: config.live.codexMode,
    capture: {
      prompts: config.live.capture.prompts,
      reasoning: config.live.capture.reasoning,
      tool_arguments: config.live.capture.toolArguments,
    },
    diff_payload_max_bytes: config.live.diffPayloadMaxBytes,
  });
});

v2Router.get('/live/sessions', (req: Request, res: Response) => {
  try {
    const params = {
      limit: safeInt(req.query.limit as string),
      cursor: req.query.cursor as string | undefined,
      project: req.query.project as string | undefined,
      agent: req.query.agent as string | undefined,
      live_status: req.query.live_status as string | undefined,
      fidelity: req.query.fidelity as string | undefined,
      active_only: req.query.active_only === 'true',
    };
    res.json(listLiveSessions(params));
  } catch (err) {
    console.error('[v2/live/sessions] Error:', err);
    res.status(500).json({ error: 'Failed to list live sessions' });
  }
});

v2Router.get('/live/sessions/:id', (req: Request, res: Response) => {
  try {
    const session = getLiveSession(req.params['id'] as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    console.error('[v2/live/sessions/:id] Error:', err);
    res.status(500).json({ error: 'Failed to get live session' });
  }
});

v2Router.get('/live/sessions/:id/turns', (req: Request, res: Response) => {
  try {
    const sessionId = req.params['id'] as string;
    const session = getLiveSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ data: getSessionTurns(sessionId) });
  } catch (err) {
    console.error('[v2/live/sessions/:id/turns] Error:', err);
    res.status(500).json({ error: 'Failed to get live turns' });
  }
});

v2Router.get('/live/sessions/:id/items', (req: Request, res: Response) => {
  try {
    const sessionId = req.params['id'] as string;
    const session = getLiveSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const params = {
      cursor: req.query.cursor as string | undefined,
      limit: safeInt(req.query.limit as string),
      kinds: splitKinds(req.query.kinds as string | undefined),
    };
    res.json(getSessionItems(sessionId, params));
  } catch (err) {
    console.error('[v2/live/sessions/:id/items] Error:', err);
    res.status(500).json({ error: 'Failed to get live items' });
  }
});

v2Router.get('/search', (req: Request, res: Response) => {
  const q = req.query.q as string | undefined;
  if (!q || !q.trim()) {
    res.status(400).json({ error: 'Query parameter "q" is required' });
    return;
  }

  try {
    const sort: 'recent' | 'relevance' = req.query.sort === 'relevance' ? 'relevance' : 'recent';
    const params = {
      q: q.trim(),
      project: req.query.project as string | undefined,
      agent: req.query.agent as string | undefined,
      sort,
      limit: safeInt(req.query.limit as string),
      cursor: req.query.cursor as string | undefined,
    };
    const result = searchMessages(params);
    res.json(result);
  } catch (err) {
    const sqliteErr = err as { code?: string };
    if (sqliteErr.code === 'SQLITE_ERROR') {
      res.status(400).json({ error: 'Invalid search query syntax' });
      return;
    }
    console.error('[v2/search] Error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// --- Analytics ---

function readAnalyticsParams(req: Request): {
  project?: string;
  agent?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
} {
  return {
    project: req.query.project as string | undefined,
    agent: req.query.agent as string | undefined,
    date_from: req.query.date_from as string | undefined,
    date_to: req.query.date_to as string | undefined,
    limit: safeInt(req.query.limit as string),
  };
}

function isInsightKind(value: unknown): value is 'overview' | 'workflow' | 'usage' {
  return value === 'overview' || value === 'workflow' || value === 'usage';
}

function isInsightProvider(value: unknown): value is 'openai' | 'anthropic' | 'gemini' {
  return value === 'openai' || value === 'anthropic' || value === 'gemini';
}

v2Router.get('/analytics/summary', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json(getAnalyticsSummary(params));
  } catch (err) {
    console.error('[v2/analytics/summary] Error:', err);
    res.status(500).json({ error: 'Failed to get analytics summary' });
  }
});

v2Router.get('/analytics/activity', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json({
      data: getAnalyticsActivity(params),
      coverage: getAnalyticsCoverage(params, 'all_sessions'),
    });
  } catch (err) {
    console.error('[v2/analytics/activity] Error:', err);
    res.status(500).json({ error: 'Failed to get activity data' });
  }
});

v2Router.get('/analytics/projects', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json({
      data: getAnalyticsProjects(params),
      coverage: getAnalyticsCoverage(params, 'all_sessions'),
    });
  } catch (err) {
    console.error('[v2/analytics/projects] Error:', err);
    res.status(500).json({ error: 'Failed to get project data' });
  }
});

v2Router.get('/analytics/tools', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json({
      data: getAnalyticsTools(params),
      coverage: getAnalyticsCoverage(params, 'tool_analytics_capable'),
    });
  } catch (err) {
    console.error('[v2/analytics/tools] Error:', err);
    res.status(500).json({ error: 'Failed to get tool data' });
  }
});

v2Router.get('/monitor/tools', (req: Request, res: Response) => {
  try {
    const params = {
      project: safeString(req.query.project as string | string[] | undefined),
      agent: safeString((req.query.agent ?? req.query.agent_type) as string | string[] | undefined),
      date_from: safeString((req.query.date_from ?? req.query.since) as string | string[] | undefined),
      date_to: safeString(req.query.date_to as string | string[] | undefined),
    };
    res.json({ tools: getMonitorToolStats(params) });
  } catch (err) {
    console.error('[v2/monitor/tools] Error:', err);
    res.status(500).json({ error: 'Failed to get monitor tool data' });
  }
});

v2Router.get('/monitor/sessions', (req: Request, res: Response) => {
  try {
    const params = {
      status: safeString(req.query.status as string | string[] | undefined),
      exclude_status: safeString(req.query.exclude_status as string | string[] | undefined),
      project: safeString(req.query.project as string | string[] | undefined),
      agent: safeString((req.query.agent ?? req.query.agent_type) as string | string[] | undefined),
      date_from: safeString((req.query.date_from ?? req.query.since) as string | string[] | undefined),
      date_to: safeString(req.query.date_to as string | string[] | undefined),
      limit: safeInt(req.query.limit as string),
    };
    res.json(listMonitorSessions(params));
  } catch (err) {
    console.error('[v2/monitor/sessions] Error:', err);
    res.status(500).json({ error: 'Failed to list monitor sessions' });
  }
});

v2Router.get('/monitor/events', (req: Request, res: Response) => {
  try {
    const params = {
      limit: safeInt(req.query.limit as string),
      offset: safeInt(req.query.offset as string),
      agent: safeString((req.query.agent ?? req.query.agent_type) as string | string[] | undefined),
      event_type: safeString(req.query.event_type as string | string[] | undefined),
      tool_name: safeString(req.query.tool_name as string | string[] | undefined),
      session_id: safeString(req.query.session_id as string | string[] | undefined),
      branch: safeString(req.query.branch as string | string[] | undefined),
      model: safeString(req.query.model as string | string[] | undefined),
      source: safeString(req.query.source as string | string[] | undefined),
      since: safeString(req.query.since as string | string[] | undefined),
      until: safeString(req.query.until as string | string[] | undefined),
    };
    res.json(listMonitorEvents(params));
  } catch (err) {
    console.error('[v2/monitor/events] Error:', err);
    res.status(500).json({ error: 'Failed to list monitor events' });
  }
});

v2Router.get('/monitor/stats', (req: Request, res: Response) => {
  try {
    const params = {
      agent: safeString((req.query.agent ?? req.query.agent_type) as string | string[] | undefined),
      since: safeString((req.query.since ?? req.query.date_from) as string | string[] | undefined),
    };
    res.json(getMonitorStats(params));
  } catch (err) {
    console.error('[v2/monitor/stats] Error:', err);
    res.status(500).json({ error: 'Failed to get monitor stats' });
  }
});

v2Router.get('/monitor/filter-options', (_req: Request, res: Response) => {
  try {
    res.json(getMonitorFilterOptions());
  } catch (err) {
    console.error('[v2/monitor/filter-options] Error:', err);
    res.status(500).json({ error: 'Failed to get monitor filter options' });
  }
});

v2Router.get('/monitor/sessions/:id/transcript', (req: Request, res: Response) => {
  try {
    const transcript = getMonitorSessionTranscript(req.params['id'] as string);
    if (!transcript) {
      res.status(404).json({ error: 'No transcript data for this session' });
      return;
    }
    res.json(transcript);
  } catch (err) {
    console.error('[v2/monitor/sessions/:id/transcript] Error:', err);
    res.status(500).json({ error: 'Failed to get monitor session transcript' });
  }
});

v2Router.get('/monitor/sessions/:id', (req: Request, res: Response) => {
  try {
    const eventLimit = safeInt((req.query.event_limit ?? req.query.limit) as string) ?? 10;
    const result = getMonitorSessionWithEvents(req.params['id'] as string, eventLimit);
    if (!result.session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error('[v2/monitor/sessions/:id] Error:', err);
    res.status(500).json({ error: 'Failed to get monitor session detail' });
  }
});

v2Router.get('/analytics/skills/daily', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json({
      data: getAnalyticsSkillsDaily(params),
      coverage: getAnalyticsCoverage(params, 'all_sessions'),
    });
  } catch (err) {
    console.error('[v2/analytics/skills/daily] Error:', err);
    res.status(500).json({ error: 'Failed to get skill analytics' });
  }
});

v2Router.get('/analytics/hour-of-week', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json({
      data: getAnalyticsHourOfWeek(params),
      coverage: getAnalyticsCoverage(params, 'all_sessions'),
    });
  } catch (err) {
    console.error('[v2/analytics/hour-of-week] Error:', err);
    res.status(500).json({ error: 'Failed to get hour-of-week analytics' });
  }
});

v2Router.get('/analytics/top-sessions', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json({
      data: getAnalyticsTopSessions(params),
      coverage: getAnalyticsCoverage(params, 'all_sessions'),
    });
  } catch (err) {
    console.error('[v2/analytics/top-sessions] Error:', err);
    res.status(500).json({ error: 'Failed to get top sessions analytics' });
  }
});

v2Router.get('/analytics/velocity', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json(getAnalyticsVelocity(params));
  } catch (err) {
    console.error('[v2/analytics/velocity] Error:', err);
    res.status(500).json({ error: 'Failed to get velocity analytics' });
  }
});

v2Router.get('/analytics/agents', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json({
      data: getAnalyticsAgents(params),
      coverage: getAnalyticsCoverage(params, 'all_sessions'),
    });
  } catch (err) {
    console.error('[v2/analytics/agents] Error:', err);
    res.status(500).json({ error: 'Failed to get agent analytics' });
  }
});

// --- Usage ---

v2Router.get('/usage/summary', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json(getUsageSummary(params));
  } catch (err) {
    console.error('[v2/usage/summary] Error:', err);
    res.status(500).json({ error: 'Failed to get usage summary' });
  }
});

v2Router.get('/usage/daily', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json({
      data: getUsageDaily(params),
      coverage: getUsageCoverage(params),
    });
  } catch (err) {
    console.error('[v2/usage/daily] Error:', err);
    res.status(500).json({ error: 'Failed to get daily usage' });
  }
});

v2Router.get('/usage/projects', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json({
      data: getUsageProjects(params),
      coverage: getUsageCoverage(params),
    });
  } catch (err) {
    console.error('[v2/usage/projects] Error:', err);
    res.status(500).json({ error: 'Failed to get usage by project' });
  }
});

v2Router.get('/usage/models', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json({
      data: getUsageModels(params),
      coverage: getUsageCoverage(params),
    });
  } catch (err) {
    console.error('[v2/usage/models] Error:', err);
    res.status(500).json({ error: 'Failed to get usage by model' });
  }
});

v2Router.get('/usage/agents', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json({
      data: getUsageAgents(params),
      coverage: getUsageCoverage(params),
    });
  } catch (err) {
    console.error('[v2/usage/agents] Error:', err);
    res.status(500).json({ error: 'Failed to get usage by agent' });
  }
});

v2Router.get('/usage/top-sessions', (req: Request, res: Response) => {
  try {
    const params = readAnalyticsParams(req);
    res.json({
      data: getUsageTopSessions(params),
      coverage: getUsageCoverage(params),
    });
  } catch (err) {
    console.error('[v2/usage/top-sessions] Error:', err);
    res.status(500).json({ error: 'Failed to get top usage sessions' });
  }
});

// --- Insights ---

v2Router.get('/insights', (req: Request, res: Response) => {
  try {
    const kindQuery = safeString(req.query.kind as string | string[] | undefined);
    let kind: 'overview' | 'workflow' | 'usage' | undefined;
    if (kindQuery) {
      if (!isInsightKind(kindQuery)) {
        res.status(400).json({ error: 'Invalid insight kind' });
        return;
      }
      kind = kindQuery;
    }

    res.json({
      data: listInsights({
        date_from: req.query.date_from as string | undefined,
        date_to: req.query.date_to as string | undefined,
        project: req.query.project as string | undefined,
        agent: req.query.agent as string | undefined,
        kind,
        limit: safeInt(req.query.limit as string),
      }),
      generation: {
        default_provider: config.insights.provider,
        providers: {
          openai: {
            configured: config.insights.providers.openai.apiKey != null,
            default_model: config.insights.providers.openai.model,
          },
          anthropic: {
            configured: config.insights.providers.anthropic.apiKey != null,
            default_model: config.insights.providers.anthropic.model,
          },
          gemini: {
            configured: config.insights.providers.gemini.apiKey != null,
            default_model: config.insights.providers.gemini.model,
          },
        },
      },
    });
  } catch (err) {
    console.error('[v2/insights] Error:', err);
    res.status(500).json({ error: 'Failed to list insights' });
  }
});

v2Router.get('/insights/:id', (req: Request, res: Response) => {
  try {
    const id = safeInt(safeString(req.params['id']));
    if (id == null) {
      res.status(400).json({ error: 'Invalid insight id' });
      return;
    }

    const insight = getInsight(id);
    if (!insight) {
      res.status(404).json({ error: 'Insight not found' });
      return;
    }

    res.json(insight);
  } catch (err) {
    console.error('[v2/insights/:id] Error:', err);
    res.status(500).json({ error: 'Failed to get insight' });
  }
});

v2Router.post('/insights/generate', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown> | null;
    const kind = body?.['kind'];
    const dateFrom = body?.['date_from'];
    const dateTo = body?.['date_to'];
    const project = body?.['project'];
    const agent = body?.['agent'];
    const prompt = body?.['prompt'];
    const provider = body?.['provider'];
    const model = body?.['model'];

    if (!isInsightKind(kind)) {
      res.status(400).json({ error: 'kind must be one of overview, workflow, or usage' });
      return;
    }
    if (typeof dateFrom !== 'string' || typeof dateTo !== 'string') {
      res.status(400).json({ error: 'date_from and date_to are required' });
      return;
    }
    if (project != null && typeof project !== 'string') {
      res.status(400).json({ error: 'project must be a string' });
      return;
    }
    if (agent != null && typeof agent !== 'string') {
      res.status(400).json({ error: 'agent must be a string' });
      return;
    }
    if (prompt != null && typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt must be a string' });
      return;
    }
    if (provider != null && !isInsightProvider(provider)) {
      res.status(400).json({ error: 'provider must be one of openai, anthropic, or gemini' });
      return;
    }
    if (model != null && typeof model !== 'string') {
      res.status(400).json({ error: 'model must be a string' });
      return;
    }

    const insight = await generateInsight({
      kind,
      date_from: dateFrom,
      date_to: dateTo,
      project: project?.trim() || undefined,
      agent: agent?.trim() || undefined,
      prompt: prompt?.trim() || undefined,
      provider: provider ?? undefined,
      model: model?.trim() || undefined,
    });
    res.status(201).json(insight);
  } catch (err) {
    console.error('[v2/insights/generate] Error:', err);
    const message = err instanceof Error ? err.message : 'Failed to generate insight';
    res.status(message.includes('required') || message.includes('must be') ? 400 : 500).json({ error: message });
  }
});

v2Router.delete('/insights/:id', (req: Request, res: Response) => {
  try {
    const id = safeInt(safeString(req.params['id']));
    if (id == null) {
      res.status(400).json({ error: 'Invalid insight id' });
      return;
    }

    const removed = deleteInsight(id);
    if (!removed) {
      res.status(404).json({ error: 'Insight not found' });
      return;
    }

    res.json({ removed: true });
  } catch (err) {
    console.error('[v2/insights/:id DELETE] Error:', err);
    res.status(500).json({ error: 'Failed to delete insight' });
  }
});

// --- Metadata ---

v2Router.get('/projects', (_req: Request, res: Response) => {
  try {
    res.json({ data: getDistinctProjects() });
  } catch (err) {
    console.error('[v2/projects] Error:', err);
    res.status(500).json({ error: 'Failed to get projects' });
  }
});

v2Router.get('/agents', (_req: Request, res: Response) => {
  try {
    res.json({ data: getDistinctAgents() });
  } catch (err) {
    console.error('[v2/agents] Error:', err);
    res.status(500).json({ error: 'Failed to get agents' });
  }
});
