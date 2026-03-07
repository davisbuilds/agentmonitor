import { Router, type Request, type Response } from 'express';
import {
  listBrowsingSessions,
  getBrowsingSession,
  getSessionChildren,
  getSessionMessages,
  searchMessages,
  getAnalyticsSummary,
  getAnalyticsActivity,
  getAnalyticsProjects,
  getAnalyticsTools,
  getDistinctProjects,
  getDistinctAgents,
} from '../../db/v2-queries.js';

export const v2Router = Router();

function safeInt(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = parseInt(value, 10);
  return isNaN(n) ? undefined : n;
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
    };
    const result = getSessionMessages(sessionId, params);
    res.json(result);
  } catch (err) {
    console.error('[v2/sessions/:id/messages] Error:', err);
    res.status(500).json({ error: 'Failed to get messages' });
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

v2Router.get('/search', (req: Request, res: Response) => {
  const q = req.query.q as string | undefined;
  if (!q || !q.trim()) {
    res.status(400).json({ error: 'Query parameter "q" is required' });
    return;
  }

  try {
    const params = {
      q: q.trim(),
      project: req.query.project as string | undefined,
      agent: req.query.agent as string | undefined,
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

v2Router.get('/analytics/summary', (req: Request, res: Response) => {
  try {
    const params = {
      project: req.query.project as string | undefined,
      agent: req.query.agent as string | undefined,
      date_from: req.query.date_from as string | undefined,
      date_to: req.query.date_to as string | undefined,
    };
    res.json(getAnalyticsSummary(params));
  } catch (err) {
    console.error('[v2/analytics/summary] Error:', err);
    res.status(500).json({ error: 'Failed to get analytics summary' });
  }
});

v2Router.get('/analytics/activity', (req: Request, res: Response) => {
  try {
    const params = {
      project: req.query.project as string | undefined,
      agent: req.query.agent as string | undefined,
      date_from: req.query.date_from as string | undefined,
      date_to: req.query.date_to as string | undefined,
    };
    res.json({ data: getAnalyticsActivity(params) });
  } catch (err) {
    console.error('[v2/analytics/activity] Error:', err);
    res.status(500).json({ error: 'Failed to get activity data' });
  }
});

v2Router.get('/analytics/projects', (req: Request, res: Response) => {
  try {
    const params = {
      date_from: req.query.date_from as string | undefined,
      date_to: req.query.date_to as string | undefined,
    };
    res.json({ data: getAnalyticsProjects(params) });
  } catch (err) {
    console.error('[v2/analytics/projects] Error:', err);
    res.status(500).json({ error: 'Failed to get project data' });
  }
});

v2Router.get('/analytics/tools', (req: Request, res: Response) => {
  try {
    const params = {
      project: req.query.project as string | undefined,
      date_from: req.query.date_from as string | undefined,
      date_to: req.query.date_to as string | undefined,
    };
    res.json({ data: getAnalyticsTools(params) });
  } catch (err) {
    console.error('[v2/analytics/tools] Error:', err);
    res.status(500).json({ error: 'Failed to get tool data' });
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
