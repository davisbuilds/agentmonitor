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

// --- Sessions ---

v2Router.get('/sessions', (req: Request, res: Response) => {
  const params = {
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    cursor: req.query.cursor as string | undefined,
    project: req.query.project as string | undefined,
    agent: req.query.agent as string | undefined,
    date_from: req.query.date_from as string | undefined,
    date_to: req.query.date_to as string | undefined,
    min_messages: req.query.min_messages ? parseInt(req.query.min_messages as string, 10) : undefined,
    max_messages: req.query.max_messages ? parseInt(req.query.max_messages as string, 10) : undefined,
  };
  const result = listBrowsingSessions(params);
  res.json(result);
});

v2Router.get('/sessions/:id', (req: Request, res: Response) => {
  const session = getBrowsingSession(req.params['id'] as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(session);
});

v2Router.get('/sessions/:id/messages', (req: Request, res: Response) => {
  const sessionId = req.params['id'] as string;
  const session = getBrowsingSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const params = {
    offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
  };
  const result = getSessionMessages(sessionId, params);
  res.json(result);
});

v2Router.get('/sessions/:id/children', (req: Request, res: Response) => {
  const children = getSessionChildren(req.params['id'] as string);
  res.json({ data: children });
});

// --- Search ---

v2Router.get('/search', (req: Request, res: Response) => {
  const q = req.query.q as string | undefined;
  if (!q || !q.trim()) {
    res.status(400).json({ error: 'Query parameter "q" is required' });
    return;
  }

  const params = {
    q: q.trim(),
    project: req.query.project as string | undefined,
    agent: req.query.agent as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    cursor: req.query.cursor as string | undefined,
  };
  const result = searchMessages(params);
  res.json(result);
});

// --- Analytics ---

v2Router.get('/analytics/summary', (req: Request, res: Response) => {
  const params = {
    project: req.query.project as string | undefined,
    agent: req.query.agent as string | undefined,
    date_from: req.query.date_from as string | undefined,
    date_to: req.query.date_to as string | undefined,
  };
  res.json(getAnalyticsSummary(params));
});

v2Router.get('/analytics/activity', (req: Request, res: Response) => {
  const params = {
    project: req.query.project as string | undefined,
    agent: req.query.agent as string | undefined,
    date_from: req.query.date_from as string | undefined,
    date_to: req.query.date_to as string | undefined,
  };
  res.json({ data: getAnalyticsActivity(params) });
});

v2Router.get('/analytics/projects', (req: Request, res: Response) => {
  const params = {
    date_from: req.query.date_from as string | undefined,
    date_to: req.query.date_to as string | undefined,
  };
  res.json({ data: getAnalyticsProjects(params) });
});

v2Router.get('/analytics/tools', (req: Request, res: Response) => {
  const params = {
    project: req.query.project as string | undefined,
    date_from: req.query.date_from as string | undefined,
    date_to: req.query.date_to as string | undefined,
  };
  res.json({ data: getAnalyticsTools(params) });
});

// --- Metadata ---

v2Router.get('/projects', (_req: Request, res: Response) => {
  res.json({ data: getDistinctProjects() });
});

v2Router.get('/agents', (_req: Request, res: Response) => {
  res.json({ data: getDistinctAgents() });
});
