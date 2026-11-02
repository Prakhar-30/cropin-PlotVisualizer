import { MAX_PLOT_AREA_HA, MAX_PLOT_AREA_SQ_M, MIN_DISTINCT_VERTICES } from './constants.js';
import {
  centroidLngLat,
  distinctVertexCount,
  geodesicAreaSqM,
  isRingClosed,
  selfIntersections,
  sqMToHectares,
} from './geo.js';
import type { PathExclusion, Polygon, Position } from './types.js';

/**
 * The one validator. The API runs it on every write; the web app runs it before
 * enabling Save so the agent sees the same message the server would return.
 */

export interface NormalizedPlot {
  name: string;
  polygon: Polygon;
  landmark_note: string;
  exclusions: PathExclusion[];
  /** Recomputed here, never taken from the client. */
  area_sq_m: number;
  centroid_lat: number;
  centroid_lng: number;
}

export type ValidationResult =
  | { ok: true; value: NormalizedPlot }
  | { ok: false; errors: string[] };

const MAX_NAME_LEN = 120;
const MAX_NOTE_LEN = 500;

/** Paths per plot. Generous: a vineyard block has a dozen headland and row tracks. */
export const MAX_PATHS = 60;
export const MIN_PATH_WIDTH_M = 0.5;
export const MAX_PATH_WIDTH_M = 15;
export const DEFAULT_PATH_WIDTH_M = 2;

/** Checks the paths, returning them tidied (rounded widths) or the problems. */
function validateExclusions(value: unknown): { exclusions: PathExclusion[]; errors: string[] } {
  if (value === undefined || value === null) return { exclusions: [], errors: [] };
  if (!Array.isArray(value)) return { exclusions: [], errors: ['exclusions must be an array of paths'] };
  if (value.length > MAX_PATHS) return { exclusions: [], errors: [`at most ${MAX_PATHS} paths per plot`] };
  const exclusions: PathExclusion[] = [];
  const errors: string[] = [];
  value.forEach((raw, i) => {
    const path = raw as Partial<PathExclusion> | null;
    const line = path?.line;
    if (
      !Array.isArray(line) ||
      line.length < 2 ||
      line.some((p) => !Array.isArray(p) || p.length < 2 || !isLng(p[0]) || !isLat(p[1]))
    ) {
      errors.push(`path ${i + 1} needs at least two valid [lng, lat] points`);
      return;
    }
    const width = path?.width_m;
    if (!isFiniteNumber(width) || width < MIN_PATH_WIDTH_M || width > MAX_PATH_WIDTH_M) {
      errors.push(`path ${i + 1} width must be between ${MIN_PATH_WIDTH_M} and ${MAX_PATH_WIDTH_M} m`);
      return;
    }
    exclusions.push({
      line: line.map((p) => [p[0], p[1]] as Position),
      width_m: Math.round(width * 10) / 10,
    });
  });
  return { exclusions, errors };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isLat(v: unknown): v is number {
  return isFiniteNumber(v) && v >= -90 && v <= 90;
}

function isLng(v: unknown): v is number {
  return isFiniteNumber(v) && v >= -180 && v <= 180;
}

/** Validates ring shape only, before any area is computed from it. */
function validateRing(ring: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(ring)) return ['polygon.coordinates[0] must be an array of positions'];

  for (const pos of ring) {
    if (!Array.isArray(pos) || pos.length < 2 || !isLng(pos[0]) || !isLat(pos[1])) {
      errors.push('polygon contains a position that is not a valid [lng, lat] pair');
      return errors;
    }
  }
  const positions = ring as Position[];
  if (!isRingClosed(positions)) {
    errors.push('polygon ring is not closed - the last position must repeat the first');
  }
  if (distinctVertexCount(positions) < MIN_DISTINCT_VERTICES) {
    errors.push(`polygon needs at least ${MIN_DISTINCT_VERTICES} distinct vertices`);
  }
  return errors;
}

export function validatePlotInput(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['request body must be a JSON object'] };
  }
  const body = input as Record<string, unknown>;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) errors.push('name is required');
  else if (name.length > MAX_NAME_LEN) errors.push(`name must be ${MAX_NAME_LEN} characters or fewer`);

  const note = body.landmark_note === undefined ? '' : body.landmark_note;
  let landmark_note = '';
  if (typeof note === 'string') {
    landmark_note = note.trim();
    if (landmark_note.length > MAX_NOTE_LEN) {
      errors.push(`landmark_note must be ${MAX_NOTE_LEN} characters or fewer`);
    }
  } else {
    errors.push('landmark_note must be a string');
  }

  const paths = validateExclusions(body.exclusions);
  errors.push(...paths.errors);

  const geom = body.polygon as Polygon | undefined;
  if (!geom || typeof geom !== 'object' || geom.type !== 'Polygon' || !Array.isArray(geom.coordinates)) {
    errors.push('polygon must be a GeoJSON Polygon');
    return { ok: false, errors };
  }
  if (geom.coordinates.length !== 1) {
    errors.push('polygon must have exactly one ring - holes are not supported');
    return { ok: false, errors };
  }

  const ringErrors = validateRing(geom.coordinates[0]);
  errors.push(...ringErrors);
  if (ringErrors.length > 0) return { ok: false, errors };

  const polygon: Polygon = { type: 'Polygon', coordinates: [geom.coordinates[0]] };

  if (selfIntersections(polygon).length > 0) {
    errors.push('polygon is self-intersecting');
  }

  const area_sq_m = geodesicAreaSqM(polygon);
  if (!(area_sq_m > 0)) {
    errors.push('polygon encloses no area - the vertices may be collinear');
  } else if (area_sq_m > MAX_PLOT_AREA_SQ_M) {
    errors.push(
      `polygon area ${sqMToHectares(area_sq_m).toFixed(1)} ha exceeds the ${MAX_PLOT_AREA_HA} ha limit - likely a mis-draw`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  const [centroid_lng, centroid_lat] = centroidLngLat(polygon);
  return {
    ok: true,
    value: {
      name,
      polygon,
      landmark_note,
      exclusions: paths.exclusions,
      area_sq_m,
      centroid_lat,
      centroid_lng,
    },
  };
}
