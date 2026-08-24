import * as turf from '@turf/turf';
import { METRES_PER_DEG_LAT, METRES_PER_DEG_LNG_AT_EQUATOR } from './constants.js';
import { geodesicAreaSqM, polygonBbox, ringToPolygon } from './geo.js';
import type { Polygon } from './types.js';

/**
 * Plot health as a grid of cells, plus the clusters worth walking to.
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

/** Ground resolution of one cell. Sentinel-2 red/NIR is 10 m native. */
export const DEFAULT_CELL_SIZE_M = 10;

/**
 * NDVI band edges, from the bottom up.
 *
 * NDVI runs -1..1; healthy vegetated cropland sits around 0.6-0.9, stressed or
 * patchy canopy around 0.3-0.5, and bare soil below about 0.2. These are the
 * conventional break points, and they are deliberately conservative: calling a
 * healthy cell stressed sends an agent on a pointless walk, which is how a tool
 * like this loses its audience.
 */
export const NDVI_SEVERITY_EDGES = [0.25, 0.4, 0.55] as const;

export type Severity = 0 | 1 | 2 | 3;

export const SEVERITY_LABELS: Record<Severity, string> = {
  0: 'Healthy',
  1: 'Mild',
  2: 'Stressed',
  3: 'Critical',
};

/**
 * Cell colours: green through yellow and amber to brown.
 *
 * Independent of the plot palette on purpose - that palette identifies *which*
 * plot, this one grades *condition*, and reusing one for the other would make a
 * red plot look like a dying plot.
 *
 * The bad end is brown rather than red because brown is what the ground
 * actually looks like where a crop has failed, so the grading reads as a
 * description rather than as an alarm. Red also collides with the boundary
 * palette, which is the one colour that must stay unambiguous.
 */
export const SEVERITY_COLOURS: Record<Severity, string> = {
  0: '#4d9221',
  1: '#d9d61c',
  2: '#d98b21',
  3: '#8c5109',
};

/** A cell is only reported as a hotspot at or above this band. */
export const HOTSPOT_MIN_SEVERITY: Severity = 2;

/**
 * Ignore clusters smaller than this many cells.
 *
 * At 10 m cells that is 300 m². Below it, a "hotspot" is as likely to be one
 * noisy pixel as a real problem, and sending someone to stand on it wastes the
 * trip that this whole feature exists to make worthwhile.
 */
export const MIN_HOTSPOT_CELLS = 3;

export interface HealthCell {
  col: number;
  row: number;
  /** The index value, e.g. NDVI in -1..1. */
  value: number;
  severity: Severity;
  centroid_lat: number;
  centroid_lng: number;
  /** The cell square itself, for drawing. */
  cell: Polygon;
}

export interface HealthHotspot {
  /** 1 is the worst. What the agent is sent to first. */
  rank: number;
  centroid_lat: number;
  centroid_lng: number;
  cell_count: number;
  area_sq_m: number;
  mean_value: number;
  severity: Severity;
}

export interface HealthSnapshot {
  plot_id: string;
  captured_on: string;
  source: string;
  index_name: string;
  cell_size_m: number;
  grid_cols: number;
  grid_rows: number;
  value_min: number;
  value_max: number;
  value_mean: number;
  cells: HealthCell[];
  hotspots: HealthHotspot[];
}

/** Samples the index at a position. Real ingest passes a raster reader here. */
export type IndexSampler = (lat: number, lng: number) => number;

export function classifySeverity(
  value: number,
  edges: readonly number[] = NDVI_SEVERITY_EDGES,
): Severity {
  // Lower NDVI is worse, so the bands run downward: below the first edge is
  // critical, above the last is healthy.
  if (value < edges[0]!) return 3;
  if (value < edges[1]!) return 2;
  if (value < edges[2]!) return 1;
  return 0;
}

/**
 * Rasterises a plot into cells and finds the hotspots.
 *
 * Cells are laid out on a metric grid anchored at the polygon's south-west
 * corner, so they are square on the ground rather than square in degrees - at
 * 12°N a degree of longitude is 108.5 km against 110.5 km for latitude, and a
 * grid built in raw degrees would be visibly rectangular and would report the
 * wrong area per cell.
 *
 * Only cells whose centre falls inside the boundary are kept. That is what makes
 * every hotspot centroid a legal walk-to target: it is the mean of points that
 * are each already inside the plot, and for the convex-ish shapes farm plots
 * actually are, that mean is inside too.
 */
export function buildHealthSnapshot(options: {
  plotId: string;
  polygon: Polygon;
  sample: IndexSampler;
  capturedOn: string;
  cellSizeM?: number;
  source?: string;
  indexName?: string;
}): HealthSnapshot {
  const {
    plotId,
    polygon,
    sample,
    capturedOn,
    cellSizeM = DEFAULT_CELL_SIZE_M,
    source = 'synthetic',
    indexName = 'ndvi',
  } = options;

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

      // Trim the square to the boundary. Keeping a cell because its centre is
      // inside still leaves up to half of it hanging over the fence, so the
      // grading bleeds into the neighbour's field - and this overlay's whole
      // claim is that it describes *this* plot. The intersection is used when
      // there is one; a cell fully inside comes back unchanged.
      const clipped = clipToBoundary(square, polygon);
      if (!clipped) continue;

      const value = sample(centroidLat, centroidLng);
      cells.push({
        col,
        row,
        value,
        severity: classifySeverity(value),
        centroid_lat: centroidLat,
        centroid_lng: centroidLng,
        cell: clipped,
      });
    }
  }

  const values = cells.map((c) => c.value);
  return {
    plot_id: plotId,
    captured_on: capturedOn,
    source,
    index_name: indexName,
    cell_size_m: cellSizeM,
    grid_cols: cols,
    grid_rows: rows,
    value_min: values.length ? Math.min(...values) : 0,
    value_max: values.length ? Math.max(...values) : 0,
    value_mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    cells,
    hotspots: findHotspots(cells, cellSizeM),
  };
}

/**
 * Groups touching stressed cells into clusters, worst first.
 *
 * Four-way connectivity, not eight. Diagonal-only neighbours are a single shared
 * corner on the ground; chaining through them merges two separate problems into
 * one hotspot and puts its centroid in the healthy gap between them - a walk-to
 * point that is not a problem at all.
 */
export function findHotspots(cells: HealthCell[], cellSizeM: number): HealthHotspot[] {
  const stressed = new Map<string, HealthCell>();
  for (const cell of cells) {
    if (cell.severity >= HOTSPOT_MIN_SEVERITY) stressed.set(`${cell.col},${cell.row}`, cell);
  }

  const seen = new Set<string>();
  const clusters: HealthCell[][] = [];

  for (const key of stressed.keys()) {
    if (seen.has(key)) continue;
    const cluster: HealthCell[] = [];
    const queue = [key];
    seen.add(key);

    while (queue.length > 0) {
      const current = queue.pop()!;
      const cell = stressed.get(current);
      if (!cell) continue;
      cluster.push(cell);

      for (const [dCol, dRow] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const neighbour = `${cell.col + dCol},${cell.row + dRow}`;
        if (stressed.has(neighbour) && !seen.has(neighbour)) {
          seen.add(neighbour);
          queue.push(neighbour);
        }
      }
    }
    if (cluster.length >= MIN_HOTSPOT_CELLS) clusters.push(cluster);
  }

  return clusters
    .map((cluster) => {
      const meanValue = cluster.reduce((sum, c) => sum + c.value, 0) / cluster.length;
      return {
        centroid_lat: cluster.reduce((sum, c) => sum + c.centroid_lat, 0) / cluster.length,
        centroid_lng: cluster.reduce((sum, c) => sum + c.centroid_lng, 0) / cluster.length,
        cell_count: cluster.length,
        area_sq_m: cluster.length * cellSizeM * cellSizeM,
        mean_value: meanValue,
        // The cluster's band is its worst cell, not its average: a patch with a
        // dead centre matters more than its edges suggest.
        severity: Math.max(...cluster.map((c) => c.severity)) as Severity,
      };
    })
    // Worst band first, then largest, then lowest index. Rank is what the field
    // agent's route is built from, so ties must break deterministically.
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        b.cell_count - a.cell_count ||
        a.mean_value - b.mean_value,
    )
    .map((hotspot, i) => ({ rank: i + 1, ...hotspot }));
}

/**
 * A deterministic stand-in for real satellite imagery.
 *
 * **This is not remote sensing.** It is smooth value noise seeded from the plot
 * id, shaped so a plot has a healthy body with one or two stressed patches -
 * enough to build and demonstrate the whole path from raster to hotspot to a
 * coordinate an agent can walk to. Swapping it for a Sentinel-2 reader means
 * replacing this one function, because everything downstream takes an
 * [IndexSampler] and knows nothing about where the numbers came from.
 *
 * The UI must always label a snapshot built from this as synthetic. Showing a
 * made-up NDVI without saying so is how a demo turns into a wrong agronomic
 * recommendation.
 */
export function syntheticNdviSampler(plotId: string, polygon: Polygon): IndexSampler {
  const seed = hashString(plotId);
  const [minLng, minLat, maxLng, maxLat] = polygonBbox(polygon);
  const spanLng = maxLng - minLng || 1e-6;
  const spanLat = maxLat - minLat || 1e-6;

  // Two stress centres per plot, placed from the seed so the same plot always
  // has the same problem in the same corner.
  const blobs = [0, 1].map((i) => ({
    u: pseudoRandom(seed + i * 97),
    v: pseudoRandom(seed + i * 131 + 7),
    radius: 0.16 + 0.14 * pseudoRandom(seed + i * 191 + 13),
    depth: 0.3 + 0.3 * pseudoRandom(seed + i * 233 + 19),
  }));

  return (lat, lng) => {
    const u = (lng - minLng) / spanLng;
    const v = (lat - minLat) / spanLat;

    // Healthy baseline with gentle large-scale variation.
    let ndvi =
      0.74 +
      0.06 * Math.sin(u * 5.1 + seed * 0.013) +
      0.05 * Math.cos(v * 4.3 + seed * 0.021);

    for (const blob of blobs) {
      const d = Math.hypot(u - blob.u, v - blob.v);
      if (d < blob.radius) {
        // Cosine falloff: a smooth basin rather than a hard disc, so the
        // severity bands form rings the way a real stress patch does.
        const t = 1 - d / blob.radius;
        ndvi -= blob.depth * (0.5 - 0.5 * Math.cos(Math.PI * t)) * 2;
      }
    }

    return Math.max(-0.2, Math.min(0.95, ndvi));
  };
}

/** Total area covered by the reported hotspots, as a share of the plot. */
export function hotspotAreaFraction(snapshot: HealthSnapshot, polygon: Polygon): number {
  const plotArea = geodesicAreaSqM(polygon);
  if (plotArea <= 0) return 0;
  return snapshot.hotspots.reduce((sum, h) => sum + h.area_sq_m, 0) / plotArea;
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
