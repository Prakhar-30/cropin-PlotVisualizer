import * as turf from '@turf/turf';
import { SQ_M_PER_ACRE, SQ_M_PER_HECTARE, VERTEX_EPSILON_DEG } from './constants.js';
import type { Feature, Plot, Polygon, Position } from './types.js';

/** WGS84 `[lng, lat]`, the order GeoJSON uses everywhere in this project. */
export type LngLat = [number, number];

/* ------------------------------------------------------------------ rings */

export function isRingClosed(ring: Position[]): boolean {
  if (ring.length < 2) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return samePoint(first, last);
}

function samePoint(a: Position, b: Position): boolean {
  return (
    Math.abs(a[0] - b[0]) <= VERTEX_EPSILON_DEG &&
    Math.abs(a[1] - b[1]) <= VERTEX_EPSILON_DEG
  );
}

/** Appends the first vertex to the end if the ring is not already closed. */
function closeRing(ring: Position[]): Position[] {
  if (ring.length === 0 || isRingClosed(ring)) return ring;
  return [...ring, ring[0]];
}

/** Counts vertices ignoring the closing repeat and any consecutive duplicates. */
export function distinctVertexCount(ring: Position[]): number {
  const open = isRingClosed(ring) ? ring.slice(0, -1) : ring;
  let count = 0;
  for (let i = 0; i < open.length; i++) {
    if (i === 0 || !samePoint(open[i], open[i - 1])) count++;
  }
  return count;
}

/** Builds a closed single-ring GeoJSON Polygon from a list of vertices. */
export function ringToPolygon(ring: Position[]): Polygon {
  return { type: 'Polygon', coordinates: [closeRing(ring)] };
}

/* -------------------------------------------------------------- geodesics */

/**
 * Geodesic area in square metres. Never compute this from raw degrees - the
 * whole point of routing through turf is that it works on the ellipsoid.
 */
export function geodesicAreaSqM(polygon: Polygon): number {
  return turf.area(polygon);
}

/** Length of the outer ring in metres. */
export function perimeterM(polygon: Polygon): number {
  const outer = polygon.coordinates[0];
  if (!outer || outer.length < 2) return 0;
  return turf.length(turf.lineString(closeRing(outer)), { units: 'meters' });
}

/** Area-weighted representative point, `[lng, lat]`. */
export function centroidLngLat(polygon: Polygon): LngLat {
  const c = turf.centerOfMass(polygon).geometry.coordinates;
  return [c[0], c[1]];
}

/** Self-intersection points. Empty means the ring is simple. */
export function selfIntersections(polygon: Polygon): LngLat[] {
  return turf
    .kinks(turf.polygon(polygon.coordinates))
    .features.map((f) => [f.geometry.coordinates[0], f.geometry.coordinates[1]] as LngLat);
}

export function isSimplePolygon(polygon: Polygon): boolean {
  return selfIntersections(polygon).length === 0;
}

/** Great-circle distance in metres. Used by the `?near=` filter. */
export function haversineMetres(a: LngLat, b: LngLat): number {
  return turf.distance(turf.point(a), turf.point(b), { units: 'meters' });
}

/* ------------------------------------------------------------ conversions */

export const sqMToHectares = (sqM: number): number => sqM / SQ_M_PER_HECTARE;
export const sqMToAcres = (sqM: number): number => sqM / SQ_M_PER_ACRE;

/* -------------------------------------------------------------- rendering */

/** The bare GeoJSON Feature form of a plot, used by the map and `/geojson`. */
export function plotToFeature(plot: Plot): Feature<Polygon> {
  return {
    type: 'Feature',
    id: plot.id,
    geometry: plot.polygon,
    properties: {
      id: plot.id,
      name: plot.name,
      area_sq_m: plot.area_sq_m,
      area_ha: sqMToHectares(plot.area_sq_m),
      centroid_lat: plot.centroid_lat,
      centroid_lng: plot.centroid_lng,
      access_lat: plot.access_lat,
      access_lng: plot.access_lng,
      landmark_note: plot.landmark_note,
      created_at: plot.created_at,
    },
  };
}

/** Bounding box `[west, south, east, north]` of a polygon, for map fitting. */
export function polygonBbox(polygon: Polygon): [number, number, number, number] {
  const [w, s, e, n] = turf.bbox(polygon);
  return [w, s, e, n];
}
