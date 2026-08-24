/** Single source of truth for every magic number shared by the API and the web app. */

/** Square metres in one hectare. */
export const SQ_M_PER_HECTARE = 10_000;
/** Square metres in one international acre. */
export const SQ_M_PER_ACRE = 4046.8564224;

/** A draw larger than this is almost certainly a mistake, so the API rejects it. */
export const MAX_PLOT_AREA_HA = 500;
export const MAX_PLOT_AREA_SQ_M = MAX_PLOT_AREA_HA * SQ_M_PER_HECTARE;

/** A ring needs at least this many distinct vertices to bound an area. */
export const MIN_DISTINCT_VERTICES = 3;

/** Two vertices closer than this (in degrees) count as the same point. */
export const VERTEX_EPSILON_DEG = 1e-9;

/** Human-readable plot ids look like PLT-4471. */
export const PLOT_ID_PREFIX = 'PLT';
export const PLOT_ID_PATTERN = /^PLT-\d{4}$/;

/** Default `radius_m` for `GET /api/plots?near=` when the caller omits it. */
export const DEFAULT_NEAR_RADIUS_M = 2000;

/** Esri World Imagery raster tiles - the basemap for the map screen. */
export const ESRI_WORLD_IMAGERY_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const ESRI_WORLD_IMAGERY_ATTRIBUTION =
  'Esri, Maxar, Earthstar Geographics, and the GIS User Community';
/**
 * Deepest zoom Esri serves imagery for over rural India. Past this it returns a
 * "Map data not yet available" placeholder tile, so the map overzooms the last
 * real level instead of asking for tiles that do not exist.
 */
export const MAX_IMAGERY_ZOOM = 18;

/** Where the map opens: farmland in Mandya district, Karnataka. */
export const DEFAULT_MAP_CENTER: [number, number] = [76.7245, 12.7875];
export const DEFAULT_MAP_ZOOM = 16;

/**
 * Metres per degree, for laying out a metric grid over a small area.
 *
 * The same two numbers the Android client uses (`core/geo/Enu.kt`). They exist
 * here only for gridding: every distance and area in this project is geodesic,
 * computed by Turf, and never derived from these.
 */
export const METRES_PER_DEG_LAT = 110_540;
export const METRES_PER_DEG_LNG_AT_EQUATOR = 111_320;
