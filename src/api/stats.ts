import { Router, type Request, type Response } from 'express';
import { getStats, getToolAnalytics, getCostOverTime, getCostBySession, getCostByModel } from '../db/queries.js';

export const statsRouter = Router();

// GET /api/stats - Aggregated statistics
statsRouter.get('/', (req: Request, res: Response) => {
  const stats = getStats({
    agentType: req.query.agent_type as string | undefined,
    since: req.query.since as string | undefined,
  });

  res.json(stats);
});

// GET /api/stats/tools - Tool analytics
statsRouter.get('/tools', (req: Request, res: Response) => {
  const tools = getToolAnalytics({
    agentType: req.query.agent_type as string | undefined,
    since: req.query.since as string | undefined,
  });
  res.json({ tools });
});

// GET /api/stats/cost - Cost breakdowns
statsRouter.get('/cost', (req: Request, res: Response) => {
  const [timeline, bySession, byModel] = [
    getCostOverTime({
      agentType: req.query.agent_type as string | undefined,
      since: req.query.since as string | undefined,
    }),
    getCostBySession(Number(req.query.limit) || 10),
    getCostByModel(),
  ];
  res.json({ timeline, by_session: bySession, by_model: byModel });
});
