import { Router } from 'express';
import {
  DEFAULT_NEAR_RADIUS_M,
  plotToFeature,
  validatePlotInput,
  type ApiError,
} from '@plot/shared';
import { getReadyStore } from '../store/index.js';
import { healthRouter } from './health.js';

export const plotsRouter = Router();

function fail(status: number, error: string, details?: string[]) {
  const body: ApiError = details ? { error, details } : { error };
  return { status, body };
}

interface NearQuery {
  lat: number;
  lng: number;
  radiusM: number;
}

/** Parses `?near=lat,lng&radius_m=` into numbers, or lists what is wrong with it. */
function parseNear(near: unknown, radius: unknown): NearQuery | string[] {
  const errors: string[] = [];
  if (typeof near !== 'string') return ['near must be a "lat,lng" string'];

  const parts = near.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    errors.push('near must be formatted as "lat,lng"');
  } else {
    if (parts[0] < -90 || parts[0] > 90) errors.push('near latitude out of range');
    if (parts[1] < -180 || parts[1] > 180) errors.push('near longitude out of range');
  }

  let radiusM = DEFAULT_NEAR_RADIUS_M;
  if (radius !== undefined) {
    radiusM = Number(radius);
    if (!Number.isFinite(radiusM) || radiusM <= 0) errors.push('radius_m must be a positive number');
  }

  return errors.length > 0 ? errors : { lat: parts[0], lng: parts[1], radiusM };
}

/** POST /api/plots - create. Area and centroid are recomputed, never trusted. */
plotsRouter.post('/', async (req, res, next) => {
  const result = validatePlotInput(req.body);
  if (!result.ok) {
    const { status, body } = fail(400, 'invalid plot', result.errors);
    res.status(status).json(body);
    return;
  }
  try {
    const store = await getReadyStore();
    res.status(201).json(await store.insertPlot(result.value));
  } catch (err) {
    next(err);
  }
});

/** GET /api/plots - list, optionally filtered to a radius around a point. */
plotsRouter.get('/', async (req, res, next) => {
  try {
    const store = await getReadyStore();
    if (req.query.near === undefined) {
      res.json(await store.listPlots());
      return;
    }
    const parsed = parseNear(req.query.near, req.query.radius_m);
    if (Array.isArray(parsed)) {
      const { status, body } = fail(400, 'invalid near query', parsed);
      res.status(status).json(body);
      return;
    }
    res.json(await store.listPlotsNear(parsed.lat, parsed.lng, parsed.radiusM));
  } catch (err) {
    next(err);
  }
});

plotsRouter.get('/:id', async (req, res, next) => {
  try {
    const plot = await (await getReadyStore()).getPlot(req.params.id);
    if (!plot) {
      const { status, body } = fail(404, 'plot not found');
      res.status(status).json(body);
      return;
    }
    res.json(plot);
  } catch (err) {
    next(err);
  }
});

// GET /api/plots/:id/health - the pixelated health raster and its hotspots.
plotsRouter.use('/:id/health', healthRouter);

/** GET /api/plots/:id/geojson - a bare Feature, for eyeballing in geojson.io. */
plotsRouter.get('/:id/geojson', async (req, res, next) => {
  try {
    const plot = await (await getReadyStore()).getPlot(req.params.id);
    if (!plot) {
      const { status, body } = fail(404, 'plot not found');
      res.status(status).json(body);
      return;
    }
    res.type('application/geo+json').json(plotToFeature(plot));
  } catch (err) {
    next(err);
  }
});
