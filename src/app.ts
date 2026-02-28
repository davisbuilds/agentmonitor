import express, { type Express, type NextFunction, type Request, type Response } from 'express';
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
  const jsonLikeContentTypes = ['application/json', 'application/*+json', 'text/plain'];

  // Parse ingest routes as raw text first so handlers can recover from
  // double-encoded payloads sent by flaky clients.
  app.use('/api/events', express.text({ limit: '1mb', type: jsonLikeContentTypes }));
  app.use('/api/otel', express.text({ limit: '5mb', type: jsonLikeContentTypes }));
  app.use(express.json({ limit: '1mb', strict: false }));
  app.use('/api', apiRouter);

  // Surface invalid JSON payloads as concise 400s without noisy stack traces.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (
      err instanceof SyntaxError
      && 'status' in err
      && (err as { status?: number }).status === 400
      && 'body' in err
    ) {
      res.status(400).json({ error: 'Invalid JSON payload' });
      return;
    }
    next(err);
  });

  if (options.serveStatic !== false) {
    app.use(express.static(publicDir));
  }

  return app;
}
