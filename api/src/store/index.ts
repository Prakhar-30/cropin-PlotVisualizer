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

async function createStore(): Promise<PlotStore> {
  const supabase = supabaseStoreFromEnv();
  if (supabase) return supabase;

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
