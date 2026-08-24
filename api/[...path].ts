import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '@plot/api/dist/app.js';

/**
 * The API, as a Vercel Function.
 *
 * Vercel builds a function out of every file in this directory and matches it
 * before any rewrite, so `/api/plots`, `/api/health` and the rest arrive here
 * without needing a routing rule. The catch-all name is what lets one function
 * serve every path beneath `/api`.
 *
 * The Express workspace lives in `service/`, not here, and that is the whole
 * reason it was moved: Vercel treats *every* file under `api/` as its own
 * function, so a package sitting in this directory would have had each of its
 * source files compiled as a separate endpoint.
 *
 * `buildApp()` returns a `(req, res)` function, which is exactly the shape a
 * Vercel Function takes - so production and `npm run dev:api` run the same app
 * object and there is no second copy of the routing to keep in step. It is
 * built once per instance: a warm function reuses it, a cold start pays once.
 */
const app = buildApp();

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  app(req as never, res as never);
}
