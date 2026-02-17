import { Router, type Request, type Response } from 'express';
import { getStats } from '../db/queries.js';

export const statsRouter = Router();

// GET /api/stats - Aggregated statistics
statsRouter.get('/', (req: Request, res: Response) => {
  const stats = getStats({
    agentType: req.query.agent_type as string | undefined,
    since: req.query.since as string | undefined,
  });

  res.json(stats);
});
