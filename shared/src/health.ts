import * as turf from '@turf/turf';
import { METRES_PER_DEG_LAT, METRES_PER_DEG_LNG_AT_EQUATOR } from './constants.js';
import { geodesicAreaSqM, polygonBbox, ringToPolygon } from './geo.js';
import type { Polygon } from './types.js';

/**
 * Crop condition as a grid of 3 m cells graded on three indices, plus the
 * patches worth walking to.
 *
 * This lives in `shared` rather than in the API because three callers need the
 * exact same answer: the web tool draws the cells, the API serves them, and the
 * Supabase ingest writes them into `fieldar.health_cells`. A cell that is amber
 * on the map and stressed in the database is worse than no colour at all.
 *
 * Severity banding happens here, once. Clients receive a band, not a raw index
 * value to threshold themselves - otherwise every client owns a copy of the
 * agronomy, and they drift.
 */

/**
 * Ground size of one cell, metres. Fixed for every plot.
 *
 * Three metres is fine enough to show the shape of a problem patch on the
 * small plots this is used on, and coarse enough that a field of a few
 * hectares is still a few thousand cells rather than tens of thousands.
 */
export const CELL_SIZE_M = 3;

/** The three crop-condition indices, in the order the UI offers them. */
export type IndexKey = 'ndvi' | 'ndre' | 'lswi';

export interface IndexSpec {
  key: IndexKey;
  /** What the agent sees. The index name is for the curious. */
  label: string;
  /** What the index measures, one line. */
  description: string;
  /**
   * Zone edges, from the bottom up: below `edges[0]` is critical, below
   * `edges[1]` moderate, anything else normal. Lower is worse for all three.
   */
  edges: readonly [number, number];
}

/**
 * The indices and their zone edges.
 *
 * - **NDVI, crop greenness** - (NIR - Red) / (NIR + Red). Dense healthy canopy
 *   sits around 0.6-0.85; thin or stressed canopy 0.35-0.55; below about 0.35 is
 *   sparse crop or bare soil.
 * - **NDRE, crop vigour** - (NIR - RedEdge) / (NIR + RedEdge). Tracks chlorophyll
 *   and nitrogen, and saturates later than NDVI in a dense crop. Vigorous crop
 *   around 0.35-0.55; moderate 0.2-0.35; below 0.2 is low vigour.
 * - **LSWI, water stress** - (NIR - SWIR) / (NIR + SWIR). Leaf and soil water.
 *   Well-watered crop around 0.2-0.4; 0.05-0.2 is drying; below 0.05 is water
 *   stress.
 *
 * Edges are conservative on purpose: calling a healthy cell critical sends an
 * agent on a pointless walk, which is how a tool like this loses its audience.
 */
export const HEALTH_INDICES: readonly IndexSpec[] = [
  { key: 'ndvi', label: 'Crop greenness', description: 'NDVI - canopy greenness and density', edges: [0.35, 0.55] },
  { key: 'ndre', label: 'Crop vigour', description: 'NDRE - chlorophyll and nitrogen status', edges: [0.2, 0.35] },
  { key: 'lswi', label: 'Water stress', description: 'LSWI - leaf and soil water content', edges: [0.05, 0.2] },
];

export const INDEX_KEYS: readonly IndexKey[] = HEALTH_INDICES.map((i) => i.key);

export function indexSpec(key: IndexKey): IndexSpec {
  return HEALTH_INDICES.find((i) => i.key === key)!;
}

/**
 * The zone type, its labels and its colours come from the generated palette,
 * so the AR overlay grades a cell exactly the way the map does.
 */
export {
  SEVERITY_COLOURS,
  SEVERITY_FILL_ALPHA,
  SEVERITY_LABELS,
  type Severity,
} from './palette.js';
import type { Severity } from './palette.js';

/** 0 normal, 1 moderate, 2 critical. Named for readability at call sites. */
export const ZONE_NORMAL: Severity = 0;
export const ZONE_MODERATE: Severity = 1;
export const ZONE_CRITICAL: Severity = 2;

/**
 * A patch needs at least this many touching moderate-or-critical cells.
 *
 * At 3 m cells that is 18 m². A single off cell is as likely to be one noisy
 * pixel as a real problem; two touching ones are a patch worth a drop point.
 */
export const MIN_PATCH_CELLS = 2;

export type IndexValues = Record<IndexKey, number>;
export type IndexZones = Record<IndexKey, Severity>;

export interface HealthCell {
  col: number;
  row: number;
  centroid_lat: number;
  centroid_lng: number;
  /** The cell square, trimmed to the boundary, for drawing. */
  cell: Polygon;
  /** Each index's value at this cell. */
  values: IndexValues;
  /** Each index's zone at this cell. */
  zones: IndexZones;
}

/**
 * A connected patch of moderate or critical cells for one index: what the
 * field app turns into one drop point.
 */
export interface HealthPatch {
  index: IndexKey;
  /** 1 is the worst patch for this index. */
  rank: number;
  /** The patch's worst cell: a patch with a red centre is a red patch. */
  zone: Severity;
  centroid_lat: number;
  centroid_lng: number;
  cell_count: number;
  area_sq_m: number;
  mean_value: number;
}

export interface IndexSummary {
  key: IndexKey;
  label: string;
  edges: readonly [number, number];
  min: number;
  max: number;
  mean: number;
  /** Cells per zone: [normal, moderate, critical]. */
  zone_counts: [number, number, number];
}

export interface HealthSnapshot {
  plot_id: string;
  captured_on: string;
  source: string;
  cell_size_m: number;
  grid_cols: number;
  grid_rows: number;
  indices: IndexSummary[];
  cells: HealthCell[];
  patches: HealthPatch[];
}

/** Samples one index at a position. Real ingest passes a raster reader here. */
export type IndexSampler = (lat: number, lng: number) => number;

export function classifyZone(value: number, edges: readonly [number, number]): Severity {
  if (value < edges[0]) return ZONE_CRITICAL;
  if (value < edges[1]) return ZONE_MODERATE;
  return ZONE_NORMAL;
}

/**
 * Rasterises a plot into 3 m cells, grades each cell on every index, and
 * groups the moderate and critical cells into patches.
 *
 * Cells are laid out on a metric grid anchored at the polygon's south-west
 * corner, so they are square on the ground rather than square in degrees.
 * Only cells whose centre falls inside the boundary are kept, which is what
 * keeps every patch centroid a point inside the plot.
 */
export function buildHealthSnapshot(options: {
  plotId: string;
  polygon: Polygon;
  samplers: Record<IndexKey, IndexSampler>;
  capturedOn: string;
  cellSizeM?: number;
  source?: string;
}): HealthSnapshot {
  const { plotId, polygon, samplers, capturedOn, cellSizeM = CELL_SIZE_M, source = 'synthetic' } = options;

  const [minLng, minLat, maxLng, maxLat] = polygonBbox(polygon);
  const midLat = (minLat + maxLat) / 2;
  const degLat = cellSizeM / METRES_PER_DEG_LAT;
  const degLng = cellSizeM / (Math.cos((midLat * Math.PI) / 180) * METRES_PER_DEG_LNG_AT_EQUATOR);

  const cols = Math.max(1, Math.ceil((maxLng - minLng) / degLng));
  const rows = Math.max(1, Math.ceil((maxLat - minLat) / degLat));

  const cells: HealthCell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const west = minLng + col * degLng;
      const south = minLat + row * degLat;
      const east = west + degLng;
      const north = south + degLat;
      const centroidLng = west + degLng / 2;
      const centroidLat = south + degLat / 2;

      if (!turf.booleanPointInPolygon(turf.point([centroidLng, centroidLat]), polygon)) continue;

      const square = ringToPolygon([
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ]);
      // Trimmed to the boundary, so no cell's colour bleeds into the
      // neighbour's field.
      const clipped = clipToBoundary(square, polygon);
      if (!clipped) continue;

      const values = {} as IndexValues;
      const zones = {} as IndexZones;
      for (const spec of HEALTH_INDICES) {
        const value = round3(samplers[spec.key](centroidLat, centroidLng));
        values[spec.key] = value;
        zones[spec.key] = classifyZone(value, spec.edges);
      }
      cells.push({ col, row, centroid_lat: centroidLat, centroid_lng: centroidLng, cell: clipped, values, zones });
    }
  }

  return {
    plot_id: plotId,
    captured_on: capturedOn,
    source,
    cell_size_m: cellSizeM,
    grid_cols: cols,
    grid_rows: rows,
    indices: HEALTH_INDICES.map((spec) => summarise(spec, cells)),
    cells,
    patches: HEALTH_INDICES.flatMap((spec) => findPatches(cells, spec.key, cellSizeM)),
  };
}

function summarise(spec: IndexSpec, cells: HealthCell[]): IndexSummary {
  const values = cells.map((c) => c.values[spec.key]);
  const counts: [number, number, number] = [0, 0, 0];
  for (const c of cells) counts[c.zones[spec.key]]++;
  return {
    key: spec.key,
    label: spec.label,
    edges: spec.edges,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    mean: values.length ? round3(values.reduce((a, b) => a + b, 0) / values.length) : 0,
    zone_counts: counts,
  };
}

/**
 * Groups touching moderate-or-critical cells for one index into patches,
 * worst first.
 *
 * Four-way connectivity, not eight. Diagonal-only neighbours share a single
 * corner on the ground; chaining through them merges two separate problems and
 * puts the drop point in the healthy gap between them.
 */
export function findPatches(cells: HealthCell[], index: IndexKey, cellSizeM: number = CELL_SIZE_M): HealthPatch[] {
  const flagged = new Map<string, HealthCell>();
  for (const cell of cells) {
    if (cell.zones[index] >= ZONE_MODERATE) flagged.set(`${cell.col},${cell.row}`, cell);
  }

  const seen = new Set<string>();
  const clusters: HealthCell[][] = [];
  for (const key of flagged.keys()) {
    if (seen.has(key)) continue;
    const cluster: HealthCell[] = [];
    const queue = [key];
    seen.add(key);
    while (queue.length > 0) {
      const cell = flagged.get(queue.pop()!);
      if (!cell) continue;
      cluster.push(cell);
      for (const [dCol, dRow] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const neighbour = `${cell.col + dCol},${cell.row + dRow}`;
        if (flagged.has(neighbour) && !seen.has(neighbour)) {
          seen.add(neighbour);
          queue.push(neighbour);
        }
      }
    }
    if (cluster.length >= MIN_PATCH_CELLS) clusters.push(cluster);
  }

  return clusters
    .map((cluster) => {
      // The drop point stands on the patch's worst cells, not on its average:
      // a ring-shaped patch would otherwise put the marker in its healthy
      // middle.
      const zone = Math.max(...cluster.map((c) => c.zones[index])) as Severity;
      const core = cluster.filter((c) => c.zones[index] === zone);
      return {
        index,
        zone,
        centroid_lat: core.reduce((sum, c) => sum + c.centroid_lat, 0) / core.length,
        centroid_lng: core.reduce((sum, c) => sum + c.centroid_lng, 0) / core.length,
        cell_count: cluster.length,
        area_sq_m: cluster.length * cellSizeM * cellSizeM,
        mean_value: round3(cluster.reduce((sum, c) => sum + c.values[index], 0) / cluster.length),
      };
    })
    // Worst zone first, then largest, then lowest value: deterministic, so the
    // same plot numbers its drop points the same way every time.
    .sort((a, b) => b.zone - a.zone || b.cell_count - a.cell_count || a.mean_value - b.mean_value)
    .map((patch, i) => ({ rank: i + 1, ...patch }));
}

/**
 * Demonstration values for all three indices, deterministic per plot.
 *
 * **Not remote sensing.** Smooth noise seeded from the plot id, shaped to look
 * like a real field: a healthy body with gentle variation, one or two patches
 * where the canopy thins (NDVI and NDRE fall together, NDRE a little further,
 * as it does), and a separate dry patch for LSWI that only partly overlaps them -
 * water stress is not always where the canopy is thin. Swapping in Sentinel-2
 * means replacing these samplers and nothing else.
 */
export function syntheticSamplers(plotId: string, polygon: Polygon): Record<IndexKey, IndexSampler> {
  const seed = hashString(plotId);
  const [minLng, minLat, maxLng, maxLat] = polygonBbox(polygon);
  const spanLng = maxLng - minLng || 1e-6;
  const spanLat = maxLat - minLat || 1e-6;
  const uv = (lat: number, lng: number) => [(lng - minLng) / spanLng, (lat - minLat) / spanLat] as const;

  const blob = (salt: number, minRadius: number, maxRadius: number) => ({
    u: 0.15 + 0.7 * pseudoRandom(seed + salt * 97),
    v: 0.15 + 0.7 * pseudoRandom(seed + salt * 131 + 7),
    radius: minRadius + (maxRadius - minRadius) * pseudoRandom(seed + salt * 191 + 13),
    depth: 0.65 + 0.35 * pseudoRandom(seed + salt * 233 + 19),
  });
  // Canopy patches drive NDVI and NDRE; the dry patch drives LSWI.
  const canopy = [blob(1, 0.18, 0.32), blob(2, 0.12, 0.24)];
  const dry = blob(3, 0.2, 0.34);
  const dip = (u: number, v: number, b: ReturnType<typeof blob>) => {
    const d = Math.hypot(u - b.u, v - b.v);
    if (d >= b.radius) return 0;
    // Cosine falloff: zones form rings the way a real patch does.
    return b.depth * (0.5 - 0.5 * Math.cos(Math.PI * (1 - d / b.radius)));
  };
  const texture = (u: number, v: number, k: number) =>
    0.035 * Math.sin(u * 7.3 + seed * 0.011 * k) + 0.03 * Math.cos(v * 6.1 + seed * 0.017 * k);

  const thin = (u: number, v: number) => Math.min(1, canopy.reduce((sum, b) => sum + dip(u, v, b), 0));

  return {
    ndvi: (lat, lng) => {
      const [u, v] = uv(lat, lng);
      return clamp(0.72 + texture(u, v, 1) - 0.5 * thin(u, v), 0.08, 0.88);
    },
    ndre: (lat, lng) => {
      const [u, v] = uv(lat, lng);
      return clamp(0.44 + 0.8 * texture(u, v, 2) - 0.36 * thin(u, v), 0.03, 0.58);
    },
    lswi: (lat, lng) => {
      const [u, v] = uv(lat, lng);
      return clamp(0.29 + texture(u, v, 3) - 0.32 * dip(u, v, dry) - 0.06 * thin(u, v), -0.15, 0.42);
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Intersects one cell with the plot boundary.
 *
 * Turf returns a MultiPolygon for a concave plot that cuts a cell into separate
 * pieces. Only the largest piece is kept: the alternative is widening the cell
 * type to hold multipolygons everywhere for a case that is a sliver of a sliver.
 */
function clipToBoundary(square: Polygon, polygon: Polygon): Polygon | null {
  let intersection;
  try {
    intersection = turf.intersect(turf.featureCollection([turf.feature(square), turf.feature(polygon)]));
  } catch {
    // A self-touching boundary can make the intersection throw. Falling back to
    // the untrimmed square keeps the grid complete; it is at worst a cell that
    // overhangs, which is what the old behaviour did for every cell.
    return square;
  }
  if (!intersection) return null;

  const geometry = intersection.geometry;
  if (geometry.type === 'Polygon') return geometry;
  if (geometry.type === 'MultiPolygon') {
    const largest = geometry.coordinates
      .map((rings) => ringToPolygon(rings[0] as [number, number][]))
      .sort((a, b) => geodesicAreaSqM(b) - geodesicAreaSqM(a))[0];
    return largest ?? null;
  }
  return null;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash % 100000);
}

function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
