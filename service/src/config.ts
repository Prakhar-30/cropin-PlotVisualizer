import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Runtime configuration.
 *
 * `SUPABASE_SECRET_KEY` acts as `service_role` and bypasses every row-level
 * security policy, so it is read here and nowhere else - it must never reach the
 * browser bundle or the Android app, both of which use the publishable key.
 */
export const config = {
  port: Number(process.env.PORT ?? 4000),
  /** `:memory:` is honoured, which is how the test suite runs without a file. */
  dbPath: process.env.DB_PATH ?? path.resolve(here, '..', 'data', 'plots.db'),

  /** Both must be present for the Supabase driver to be selected. */
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY ?? '',
};
