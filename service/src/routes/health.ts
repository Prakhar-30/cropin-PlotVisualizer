import { Router } from 'express';
import {
  DEFAULT_CELL_SIZE_M,
  buildHealthSnapshot,
  syntheticNdviSampler,
  type ApiError,
  type HealthSnapshot,
} from '@plot/shared';
import { getReadyStore } from '../store/index.js';

/**
 * Plot health rasters.
 *
 * The grid, the severity banding and the hotspot clustering all come from
 * `@plot/shared`, which is also what a Supabase ingest would call - so the map
 * and the database can never disagree about which cell is stressed.
 *
 * What is *not* real yet is the imagery. The index values come from
 * `syntheticNdviSampler`, a deterministic stand-in, and every response says so
 * in `source` and `synthetic`. Wiring real Sentinel-2 means replacing the
 * sampler passed in below and nothing else.
 */
// mergeParams so `:id` from the parent `/api/plots/:id/health` mount is visible.
export const healthRouter = Router({ mergeParams: true });

/** Snapshots are pure functions of (plot, date, cell size), so caching is free. */
const cache = new Map<string, HealthSnapshot>();

export interface HealthResponse extends HealthSnapshot {
  /** Loud on purpose: never let a made-up NDVI be mistaken for a measured one. */
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

  const cellSizeM = Number(req.query.cell_size_m ?? DEFAULT_CELL_SIZE_M);
  if (!Number.isFinite(cellSizeM) || cellSizeM < 2 || cellSizeM > 100) {
    const body: ApiError = {
      error: 'invalid cell size',
      // The floor is not arbitrary: below the imagery's own ground resolution a
      // finer grid is interpolation dressed up as detail.
      details: ['cell_size_m must be between 2 and 100'],
    };
    res.status(400).json(body);
    return;
  }

  // Fixed capture date: the sampler is deterministic, so a moving "today" would
  // change the cache key every midnight without changing a single value.
  const capturedOn = plot.created_at.slice(0, 10);
  const key = `${plot.id}:${capturedOn}:${cellSizeM}`;

  let snapshot = cache.get(key);
  if (!snapshot) {
    snapshot = buildHealthSnapshot({
      plotId: plot.id,
      polygon: plot.polygon,
      sample: syntheticNdviSampler(plot.id, plot.polygon),
      capturedOn,
      cellSizeM,
      source: 'synthetic',
      indexName: 'ndvi',
    });
    cache.set(key, snapshot);
  }

  const body: HealthResponse = {
    ...snapshot,
    synthetic: true,
    note: 'Synthetic NDVI for demonstration. Not derived from satellite imagery.',
  };
  res.json(body);
  } catch (err) {
    next(err);
  }
});
