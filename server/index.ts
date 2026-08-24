import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '@plot/api/dist/app.js';

/**
 * Vercel serverless entry.
 *
 * Express is a `(req, res)` function, which is exactly the shape Vercel expects,
 * so the same app object serves both `npm run dev:api` and production - there is
 * no second copy of the routing to keep in step.
 *
 * The app is built once per instance rather than per request. A warm function
 * reuses it; a cold start pays for it once.
 *
 * This entry lives in `server/` rather than `api/`. Vercel treats `<root>/api`
 * as its functions directory, and this repo already has an `api` workspace, so
 * putting it there would make Vercel try to compile every file in the API
 * package as its own separate function.
 */
const app = buildApp();

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  app(req as never, res as never);
}
