import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRouter } from './api/router.js';
import { apiErrorHandler, localOriginGuard } from './api/local-origin.js';
import { config } from './config.js';
import { gitAuthorEmails } from './git/author-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ bindHost = config.host }: { bindHost?: string } = {}): Express {
  const app = express();
  // WHY: Looking up the build identity on each HTTP request would launch Git processes in the
  // request path.
  app.locals.commitAuthorEmails = gitAuthorEmails();
  app.use('/api', localOriginGuard({ bindHost }));
  const jsonLikeContentTypes = ['application/json', 'application/*+json', 'text/plain'];

  // WHY: Some producers double-encode the JSON body. The handler needs its original text to recover
  // it.
  app.use('/api/events', express.text({ limit: '1mb', type: jsonLikeContentTypes }));
  app.use('/api/otel', express.text({ limit: '5mb', type: jsonLikeContentTypes }));
  app.use(express.json({ limit: '1mb', strict: false }));
  app.use('/api', apiRouter);

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

  app.get('/', (_req: Request, res: Response) => {
    res.redirect(302, '/app/');
  });

  const svelteDir = path.join(__dirname, '..', 'frontend', 'dist');
  app.use('/app', express.static(svelteDir));
  app.get('/app/{*path}', (_req: Request, res: Response) => {
    res.sendFile(path.join(svelteDir, 'index.html'));
  });

  app.use(apiErrorHandler);

  return app;
}
