import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '@plot/api/dist/app.js';

/**
 * The API, as a single Vercel Function.
 *
 * A `[...path].ts` catch-all was tried first and only ever matched one segment:
 * `/api/plots` worked, `/api/plots/PLT-1780` returned Vercel's own 404. So the
 * routing is declared explicitly in vercel.json instead, which leaves nothing
 * to infer.
 *
 * The Express workspace lives in `service/` because Vercel compiles every file
 * under `api/` into its own Function - a package here would deploy one endpoint
 * per source file.
 *
 * `buildApp()` returns a `(req, res)` function, the same shape a Vercel Function
 * takes, so production and `npm run dev:api` share one app object.
 */
const app = buildApp();

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  app(req as never, res as never);
}
