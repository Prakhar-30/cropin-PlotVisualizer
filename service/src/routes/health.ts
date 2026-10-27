import { Router } from 'express';
import {
  CELL_SIZE_M,
  buildHealthSnapshot,
  syntheticSamplers,
  type ApiError,
  type HealthSnapshot,
} from '@plot/shared';
import { getReadyStore } from '../store/index.js';

/**
 * Crop condition for one plot: 3 m cells graded on crop greenness (NDVI), crop
 * vigour (NDRE) and water stress (LSWI), each into normal / moderate /
 * critical, plus the moderate-and-critical patches the field app turns into
 * drop points.
 *
 * The grid, the zoning and the patching all come from `@plot/shared`, so the map
 * and the field app can never disagree about which cell is red.
 *
 * The values are demonstration values from `syntheticSamplers`, deterministic
 * per plot, and every response says so. Wiring real Sentinel-2 means replacing
 * the samplers passed in below and nothing else.
 */
// mergeParams so `:id` from the parent `/api/plots/:id/health` mount is visible.
export const healthRouter = Router({ mergeParams: true });

/** Snapshots are pure functions of (plot, date), so caching is free. */
const cache = new Map<string, HealthSnapshot>();

export interface HealthResponse extends HealthSnapshot {
  /** True while the values are demonstration values, not measured imagery. */
  synthetic: boolean;
  note: string;
}

healthRouter.get<{ id: string }>('/', async (req, res, next) => {
  try {
    const plot = await (await getReadyStore()).getPlot(req.params.id);
    if (!plot) {
      const body: ApiError = { error: 'plot not found' };
      res.status(404).json(body);
      return;
    }

    // Fixed capture date: the samplers are deterministic, so a moving "today"
    // would change the cache key every midnight without changing a value.
    const capturedOn = plot.created_at.slice(0, 10);
    const key = `${plot.id}:${capturedOn}:${CELL_SIZE_M}`;

    let snapshot = cache.get(key);
    if (!snapshot) {
      snapshot = buildHealthSnapshot({
        plotId: plot.id,
        polygon: plot.polygon,
        samplers: syntheticSamplers(plot.id, plot.polygon),
        capturedOn,
        cellSizeM: CELL_SIZE_M,
        source: 'synthetic',
      });
      cache.set(key, snapshot);
    }

    const body: HealthResponse = {
      ...snapshot,
      synthetic: true,
      note: 'Demonstration values for NDVI, NDRE and LSWI. Not yet derived from satellite imagery.',
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
