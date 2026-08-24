import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  generatePlotId,
  type NormalizedPlot,
  type Plot,
  type PlotWithDistance,
  type Polygon,
} from '@plot/shared';
import { config } from '../config.js';
import type { PlotStore } from './types.js';

/**
 * The deployed driver: Supabase Postgres over PostgREST.
 *
 * Reached through the wrappers in `public` that migration 002 creates, not
 * through the `fieldar` schema directly. PostgREST only serves schemas listed
 * in the project's "Exposed schemas" setting, and depending on someone having
 * changed that in a dashboard is a deployment that fails as a 404 on every
 * request with nothing to point at.
 *
 * Geometry never crosses this boundary as anything but GeoJSON. PostGIS does
 * the conversion inside `fieldar.create_plot`, so the lng/lat ordering is
 * decided once, in SQL, rather than in every client that wants to write a plot.
 */

/** A row of `public.fieldar_plots`, which mirrors `fieldar.plots_api`. */
interface PlotApiRow {
  id: string;
  name: string;
  polygon: Polygon;
  centroid_lat: number;
  centroid_lng: number;
  access_lat: number;
  access_lng: number;
  area_sq_m: number;
  landmark_note: string;
  colour_index: number;
  created_at: string;
}

const MAX_ID_ATTEMPTS = 20;

/** Postgres unique-violation. The only insert failure worth retrying. */
const UNIQUE_VIOLATION = '23505';

function rowToPlot(row: PlotApiRow): Plot {
  return {
    id: row.id,
    name: row.name,
    polygon: row.polygon,
    centroid_lat: row.centroid_lat,
    centroid_lng: row.centroid_lng,
    access_lat: row.access_lat,
    access_lng: row.access_lng,
    area_sq_m: row.area_sq_m,
    landmark_note: row.landmark_note,
    colour_index: row.colour_index,
    created_at: row.created_at,
  };
}

export class SupabasePlotStore implements PlotStore {
  readonly kind = 'supabase' as const;

  private readonly client: SupabaseClient;

  constructor(url: string, secretKey: string) {
    this.client = createClient(url, secretKey, {
      // No browser here: nothing to persist, nothing to refresh, and a
      // serverless function is gone before a refresh timer would ever fire.
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async init(): Promise<void> {
    // The schema is applied by running api/sql/*.sql against the project; a
    // serverless function must not try to migrate on every cold start. This
    // only checks that the doorway exists, so a missing migration is reported
    // once, clearly, instead of as a confusing 404 per request.
    const { error } = await this.client.from('fieldar_plots').select('id').limit(1);
    if (error) {
      throw new Error(
        `Supabase is reachable but public.fieldar_plots is missing (${error.message}). ` +
          'Run api/sql/001_fieldar_schema.sql then api/sql/002_api_surface.sql.',
      );
    }
  }

  async insertPlot(value: NormalizedPlot, forcedId?: string): Promise<Plot> {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const id = forcedId ?? generatePlotId();
      const { data, error } = await this.client
        .rpc('fieldar_create_plot', {
          p_id: id,
          p_name: value.name,
          p_polygon: value.polygon,
          p_access_lat: value.access_lat,
          p_access_lng: value.access_lng,
          p_area_sq_m: value.area_sq_m,
          p_landmark_note: value.landmark_note,
        })
        .select();

      if (!error) {
        const row = (data as PlotApiRow[] | null)?.[0];
        if (!row) throw new Error('insert returned no row');
        return rowToPlot(row);
      }
      // A forced id is the seed script asking for one specific id; colliding
      // there is a real error, not something to paper over with a retry.
      if (forcedId || error.code !== UNIQUE_VIOLATION) {
        throw new Error(`insert failed: ${error.message}`);
      }
    }
    throw new Error('could not allocate a unique plot id');
  }

  async getPlot(id: string): Promise<Plot | null> {
    const { data, error } = await this.client
      .from('fieldar_plots')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`lookup failed: ${error.message}`);
    return data ? rowToPlot(data as PlotApiRow) : null;
  }

  async listPlots(): Promise<Plot[]> {
    const { data, error } = await this.client
      .from('fieldar_plots')
      .select('*')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (error) throw new Error(`list failed: ${error.message}`);
    return (data as PlotApiRow[]).map(rowToPlot);
  }

  async listPlotsNear(lat: number, lng: number, radiusM: number): Promise<PlotWithDistance[]> {
    // ST_DWithin on an indexed geography, computed in the database. The SQLite
    // driver approximates this with a bounding box plus a haversine pass; here
    // it is exact and stays an index scan as the table grows.
    const { data, error } = await this.client.rpc('fieldar_plots_near', {
      at_lat: lat,
      at_lng: lng,
      radius_m: radiusM,
    });
    if (error) throw new Error(`near query failed: ${error.message}`);
    return (data as (PlotApiRow & { distance_m: number })[]).map((row) => ({
      ...rowToPlot(row),
      distance_m: row.distance_m,
    }));
  }

  async deleteAllPlots(): Promise<void> {
    const { error } = await this.client.rpc('fieldar_delete_all_plots');
    if (error) throw new Error(`delete failed: ${error.message}`);
  }
}

/** Builds the driver from the environment, or `null` when it is not configured. */
export function supabaseStoreFromEnv(): SupabasePlotStore | null {
  const { supabaseUrl, supabaseSecretKey } = config;
  if (!supabaseUrl || !supabaseSecretKey) return null;
  return new SupabasePlotStore(supabaseUrl, supabaseSecretKey);
}
