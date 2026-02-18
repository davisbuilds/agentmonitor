import express, { type Express } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRouter } from './api/router.js';

export interface CreateAppOptions {
  serveStatic?: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', apiRouter);

  if (options.serveStatic !== false) {
    app.use(express.static(publicDir));
  }

  return app;
}
