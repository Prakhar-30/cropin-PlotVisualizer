import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ApiError } from '@plot/shared';
import { plotsRouter } from './routes/plots.js';
import { describeStore } from './store/index.js';

export function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Says which driver is live. On a deployment that silently fell back to
  // SQLite this is the difference between "working" and "losing every plot".
  app.get('/api/health', (_req, res) => res.json({ ok: true, store: describeStore() }));
  app.use('/api/plots', plotsRouter);

  app.use((_req, res) => {
    const body: ApiError = { error: 'not found' };
    res.status(404).json(body);
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    const body: ApiError = { error: 'internal error', details: [err.message] };
    res.status(500).json(body);
  });

  return app;
}
