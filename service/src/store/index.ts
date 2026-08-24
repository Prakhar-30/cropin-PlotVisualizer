import { config } from '../config.js';
import { supabaseStoreFromEnv } from './supabase.js';
import type { PlotStore } from './types.js';

export type { PlotStore } from './types.js';

/**
 * Picks the storage driver.
 *
 * Supabase when it is configured, SQLite otherwise. The choice is made from the
 * environment rather than from a flag so that no deployment can end up on the
 * file-backed driver by accident - on Vercel that would appear to work and then
 * quietly lose every plot when the function instance is recycled.
 *
 * The SQLite driver is loaded with a dynamic import, and that is deliberate:
 * `better-sqlite3` is a native addon, and a statically imported one would be
 * pulled into the serverless bundle and loaded on every cold start even though
 * a deployment never uses it. A prebuilt binary for the wrong platform only
 * fails when something loads it, so the fix is not to load it.
 */
let ready: Promise<PlotStore> | null = null;

/**
 * True on a platform whose filesystem does not survive between invocations.
 *
 * Both Vercel and AWS Lambda set these themselves; nothing has to be configured
 * for the check to work.
 */
function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

async function createStore(): Promise<PlotStore> {
  const supabase = supabaseStoreFromEnv();
  if (supabase) return supabase;

  // Refuse to fall back to a file on a serverless platform. Doing so looks
  // healthy - plots save, the list populates - right up to the moment the
  // instance is recycled and every boundary someone drew is gone. A deployment
  // that is missing its credentials should fail on the first request, loudly.
  if (isServerless()) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SECRET_KEY are not set. A serverless deployment ' +
        'has no durable filesystem, so the SQLite fallback would lose every plot ' +
        'when the instance recycles. Set both in the project environment.',
    );
  }

  const { SqlitePlotStore } = await import('./sqlite.js');
  return new SqlitePlotStore();
}

/**
 * The store, initialised.
 *
 * Memoised on the promise, not on the result, so that concurrent requests
 * arriving at a cold serverless instance share one initialisation instead of
 * racing several.
 */
export function getReadyStore(): Promise<PlotStore> {
  if (!ready) {
    ready = createStore().then(async (store) => {
      await store.init();
      return store;
    });
    // A failed init must not stay cached, or one bad cold start poisons the
    // instance for the whole of its life.
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}

/** Test helper: forces the next call to rebuild from the current environment. */
export function resetStore(): void {
  ready = null;
}

/** Where plots are being kept, for the `/api/health` readout. */
export function describeStore(): string {
  return config.supabaseUrl && config.supabaseSecretKey
    ? 'supabase'
    : `sqlite (${config.dbPath})`;
}
