import type { Feature, Polygon, Position } from 'geojson';

export type { Feature, Polygon, Position };

/**
 * A strip inside a plot that carries no crop - a walking path, a cart track -
 * and so is left out of crop condition: no cells, no colour, no patches.
 * Drawn as a line along its middle, with its width on the ground.
 */
export interface PathExclusion {
  /** The path's centre line, WGS84 [lng, lat], two points or more. */
  line: Position[];
  /** Width on the ground, metres. */
  width_m: number;
}

/** A plot exactly as the API stores and returns it. */
export interface Plot {
  id: string;
  name: string;
  /** GeoJSON Polygon, WGS84, lng/lat order, first ring closed. */
  polygon: Polygon;
  centroid_lat: number;
  centroid_lng: number;
  /** Geodesic, recomputed server-side on save. */
  area_sq_m: number;
  landmark_note: string;
  /**
   * Palette slot 0-7, assigned by the server so that no two plots within 500 m
   * share one. See `palette.ts` and `plotColour()`.
   */
  colour_index: number;
  /** Paths inside the plot that are left out of crop condition. */
  exclusions: PathExclusion[];
  created_at: string;
  /** Last change to the boundary, name, note or paths. Absent on old rows. */
  updated_at?: string;
}

/** The body of `POST /api/plots`. A client-supplied area is deliberately absent. */
export interface PlotInput {
  name: string;
  polygon: Polygon;
  landmark_note?: string;
  exclusions?: PathExclusion[];
}

/** `GET /api/plots?near=` adds the centroid distance it filtered on. */
export interface PlotWithDistance extends Plot {
  distance_m: number;
}

export interface ApiError {
  error: string;
  details?: string[];
}
