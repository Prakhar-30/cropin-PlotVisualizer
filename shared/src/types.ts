import type { Feature, Polygon, Position } from 'geojson';

export type { Feature, Polygon, Position };

/** A plot exactly as the API stores and returns it. */
export interface Plot {
  id: string;
  name: string;
  /** GeoJSON Polygon, WGS84, lng/lat order, first ring closed. */
  polygon: Polygon;
  centroid_lat: number;
  centroid_lng: number;
  /** Where someone walks or drives in from the road. */
  access_lat: number;
  access_lng: number;
  /** Geodesic, recomputed server-side on save. */
  area_sq_m: number;
  landmark_note: string;
  /**
   * Palette slot 0-7, assigned by the server so that no two plots within 500 m
   * share one. See `palette.ts` and `plotColour()`.
   */
  colour_index: number;
  created_at: string;
}

/** The body of `POST /api/plots`. A client-supplied area is deliberately absent. */
export interface PlotInput {
  name: string;
  polygon: Polygon;
  access_lat: number;
  access_lng: number;
  landmark_note?: string;
}

/** `GET /api/plots?near=` adds the centroid distance it filtered on. */
export interface PlotWithDistance extends Plot {
  distance_m: number;
}

export interface ApiError {
  error: string;
  details?: string[];
}
