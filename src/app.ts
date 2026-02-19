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

  // OTLP payloads can be large — allow up to 5MB on those routes
  app.use('/api/otel', express.json({ limit: '5mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', apiRouter);

  if (options.serveStatic !== false) {
    app.use(express.static(publicDir));
  }

  return app;
}
