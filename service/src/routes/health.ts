import { createHash } from 'node:crypto';
import { Router } from 'express';
import {
  CELL_SIZE_M,
  buildHealthSnapshot,
  pointInPolygon,
  syntheticSamplers,
  type ApiError,
  type HealthSnapshot,
  type Plot,
} from '@plot/shared';
import { config } from '../config.js';
import { sentinelSamplers, type SceneInfo } from '../satellite/sentinel.js';
import { getReadyStore } from '../store/index.js';

/**
 * Crop condition for one plot: 3 m cells graded on crop greenness (NDVI), crop
 * vigour (NDRE) and water stress (LSWI), each into normal / moderate /
 * critical, plus the moderate-and-critical patches the field app turns into
 * drop points. Cells on the plot's paths are left out.
 *
 * The values come from the newest clear Sentinel-2 scene (see
 * satellite/sentinel.ts). Reading one costs a few seconds of downloads, so the
 * result is stored and keyed by the plot's geometry and the week: an edited
 * boundary or path, or a new week - and so possibly a newer scene - computes
 * afresh; anything else is served from the store. When no clear scene can be
 * had, demonstration values are served instead, flagged `synthetic: true`
 * with the reason, and retried after a few minutes.
 *
 * The grid, the zoning and the patching all come from `@plot/shared`, so the map
 * and the field app can never disagree about which cell is red.
 */
// mergeParams so `:id` from the parent `/api/plots/:id/health` mount is visible.
export const healthRouter = Router({ mergeParams: true });

export interface HealthResponse extends HealthSnapshot {
  /** True while the values are demonstration values, not measured imagery. */
  synthetic: boolean;
  note: string;
  /** The satellite scene the values come from, when they do. */
  scene?: SceneInfo;
}

/** Per-instance memory in front of the store, and how long a fallback is kept. */
const memory = new Map<string, { body: HealthResponse; until: number }>();
const FALLBACK_RETRY_MS = 10 * 60_000;

/** Changes whenever the boundary or the paths do. */
function geometryKey(plot: Plot): string {
  return createHash('sha1')
    .update(JSON.stringify([plot.polygon, plot.exclusions]))
    .digest('hex')
    .slice(0, 16);
}

/** Monday of the current week, UTC: Sentinel-2 revisits every ~5 days. */
function weekOf(now: Date): string {
  const day = (now.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day)).toISOString().slice(0, 10);
}

function synthetic(plot: Plot, note: string): HealthResponse {
  return {
    ...buildHealthSnapshot({
      plotId: plot.id,
      polygon: plot.polygon,
      samplers: syntheticSamplers(plot.id, plot.polygon),
      // Fixed date: the samplers are deterministic, so the values never change.
      capturedOn: plot.created_at.slice(0, 10),
      cellSizeM: CELL_SIZE_M,
      source: 'synthetic',
      exclusions: plot.exclusions,
    }),
    synthetic: true,
    note,
  };
}

async function fromSatellite(plot: Plot): Promise<HealthResponse> {
  const inside = (lat: number, lng: number) => pointInPolygon(lat, lng, plot.polygon);
  const { samplers, scene } = await sentinelSamplers(plot.polygon, inside);
  return {
    ...buildHealthSnapshot({
      plotId: plot.id,
      polygon: plot.polygon,
      samplers,
      capturedOn: scene.date,
      cellSizeM: CELL_SIZE_M,
      source: 'sentinel-2-l2a',
      exclusions: plot.exclusions,
    }),
    synthetic: false,
    note:
      `Sentinel-2 L2A, ${scene.date}, ${Math.round(scene.clearShare * 100)}% of the plot clear of cloud. ` +
      'NDVI from 10 m pixels, NDRE and LSWI from 20 m, blended into 3 m cells.',
    scene,
  };
}

healthRouter.get<{ id: string }>('/', async (req, res, next) => {
  try {
    const store = await getReadyStore();
    const plot = await store.getPlot(req.params.id);
    if (!plot) {
      const body: ApiError = { error: 'plot not found' };
      res.status(404).json(body);
      return;
    }

    if (config.healthSource === 'synthetic') {
      res.json(synthetic(plot, 'Demonstration values for NDVI, NDRE and LSWI. Not derived from satellite imagery.'));
      return;
    }

    const key = `s2:${geometryKey(plot)}:${weekOf(new Date())}`;
    const remembered = memory.get(`${plot.id}:${key}`);
    if (remembered && remembered.until > Date.now()) {
      res.json(remembered.body);
      return;
    }
    const stored = (await store.getCachedHealth(plot.id, key)) as HealthResponse | null;
    if (stored) {
      memory.set(`${plot.id}:${key}`, { body: stored, until: Infinity });
      res.json(stored);
      return;
    }

    let body: HealthResponse;
    try {
      body = await fromSatellite(plot);
      memory.set(`${plot.id}:${key}`, { body, until: Infinity });
      await store.putCachedHealth(plot.id, key, body);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      body = synthetic(plot, `Satellite imagery unavailable (${reason}). Showing demonstration values.`);
      memory.set(`${plot.id}:${key}`, { body, until: Date.now() + FALLBACK_RETRY_MS });
    }
    res.json(body);
  } catch (err) {
    next(err);
  }
});
