import { Router, type Request, type Response } from 'express';
import { getFilterOptions } from '../db/queries.js';

export const filterOptionsRouter = Router();

filterOptionsRouter.get('/', (_req: Request, res: Response) => {
  const options = getFilterOptions();
  res.json(options);
});
