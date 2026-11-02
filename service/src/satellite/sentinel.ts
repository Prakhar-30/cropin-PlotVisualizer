import type { IndexKey, IndexSampler, Polygon } from '@plot/shared';
import { Cog, httpRange, type PixelWindow, type RangeFetcher } from './geotiff.js';
import { toUtm, zoneFromEpsg, type UtmZone } from './utm.js';

/**
 * Crop condition from Sentinel-2 Level-2A surface reflectance.
 *
 * Source: the open Sentinel-2 L2A archive on AWS, catalogued by Element 84's
 * Earth Search STAC API - no account, no key. A new image of any spot on the
 * ground every five days or so, cloud permitting.
 *
 *   NDVI, crop greenness = (B08 - B04) / (B08 + B04)    10 m
 *   NDRE, crop vigour    = (B8A - B05) / (B8A + B05)    20 m
 *   LSWI, water stress   = (B8A - B11) / (B8A + B11)    20 m
 *
 * The plot's 3 m cells are finer than any of those pixels, so each cell takes
 * the bilinear blend of the four pixel centres around it: the grid keeps its
 * shape and patches still form, but detail inside one 10-20 m pixel is not in
 * the data, and every response says so.
 *
 * Clouds: each scene's own Scene Classification layer (SCL, 20 m) marks every
 * pixel as vegetation, bare soil, water, cloud, cloud shadow, and so on. The
 * newest scene with at least [MIN_CLEAR_SHARE] of the plot clear is used, and
 * a cell whose SCL pixel is not clear gets no value - it is left out rather
 * than coloured from a cloud.
 */

export const EARTH_SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search';

/** How far back to look for a clear scene. */
export const SEARCH_DAYS = 60;

/** Scenes cloudier than this over their whole tile are not even tried. */
const MAX_SCENE_CLOUD_PCT = 70;

/** A scene is used when at least this share of the plot is clear. */
export const MIN_CLEAR_SHARE = 0.8;

/** Scenes tried, newest first, before giving up. */
const MAX_SCENES_TRIED = 6;

/** SCL classes that are ground seen clearly: vegetation, not vegetated, water, unclassified. */
const CLEAR_SCL = new Set([4, 5, 6, 7]);

/** Margin read around the plot, metres, so the outer cells have pixels to blend from. */
const MARGIN_M = 45;

export interface SceneInfo {
  id: string;
  /** Acquisition date, YYYY-MM-DD. */
  date: string;
  /** Share of the plot's pixels that were clear, 0-1. */
  clearShare: number;
  /** The tile's own cloud cover, percent. */
  cloudCoverPct: number;
}

export interface SentinelResult {
  samplers: Record<IndexKey, IndexSampler>;
  scene: SceneInfo;
}

interface StacAsset {
  href: string;
  'raster:bands'?: { scale?: number; offset?: number; nodata?: number }[];
}

interface StacItem {
  id: string;
  properties: Record<string, unknown>;
  assets: Record<string, StacAsset>;
}

type JsonFetcher = (url: string, body: unknown) => Promise<unknown>;

const postJson: JsonFetcher = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/geo+json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`STAC search failed: HTTP ${res.status}`);
  return res.json();
};

/** Recent Sentinel-2 L2A scenes over [polygon], newest first. */
export async function searchScenes(
  polygon: Polygon,
  now: Date = new Date(),
  post: JsonFetcher = postJson,
): Promise<StacItem[]> {
  const from = new Date(now.getTime() - SEARCH_DAYS * 86_400_000);
  const body = {
    collections: ['sentinel-2-l2a'],
    intersects: polygon,
    datetime: `${from.toISOString()}/${now.toISOString()}`,
    query: { 'eo:cloud_cover': { lt: MAX_SCENE_CLOUD_PCT } },
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit: 20,
  };
  const result = (await post(EARTH_SEARCH_URL, body)) as { features?: StacItem[] };
  const items = result.features ?? [];
  // Sorted here too: not every STAC server honours sortby.
  return [...items].sort((a, b) => String(b.properties.datetime).localeCompare(String(a.properties.datetime)));
}

/** The EPSG code of a scene's grid, from either STAC projection field. */
export function sceneEpsg(item: StacItem): number | null {
  const epsg = item.properties['proj:epsg'];
  if (typeof epsg === 'number') return epsg;
  const code = item.properties['proj:code'];
  if (typeof code === 'string' && code.startsWith('EPSG:')) return Number(code.slice(5));
  return null;
}

/**
 * Turns a band's stored integers into reflectance.
 *
 * Since processing baseline 04.00 (January 2022) L2A products carry a -1000
 * offset, so reflectance is DN / 10000 - 0.1. Earth Search records whether it
 * already applied that offset; where it did not, the asset's raster:bands
 * metadata, or failing that the baseline, says whether to.
 */
export function reflectanceOf(item: StacItem, asset: StacAsset): (dn: number) => number {
  const band = asset['raster:bands']?.[0];
  const scale = band?.scale ?? 0.0001;
  let offset: number;
  if (item.properties['earthsearch:boa_offset_applied'] === true) offset = 0;
  else if (band?.offset !== undefined) offset = band.offset;
  else offset = String(item.properties['s2:processing_baseline'] ?? '00.00') >= '04.00' ? -0.1 : 0;
  return (dn) => dn * scale + offset;
}

/** A band read over the plot, sampled by map coordinate. */
class BandWindow {
  constructor(
    private readonly cog: Cog,
    private readonly window: PixelWindow,
  ) {}

  /** Bilinear blend of the four pixel centres around (x, y), or NaN. */
  bilinear(x: number, y: number): number {
    const [c, r] = this.cog.pixelOf(x, y);
    const fc = c - 0.5 - this.window.col0;
    const fr = r - 0.5 - this.window.row0;
    const c0 = Math.floor(fc);
    const r0 = Math.floor(fr);
    const tc = fc - c0;
    const tr = fr - r0;
    const v00 = this.at(c0, r0);
    const v10 = this.at(c0 + 1, r0);
    const v01 = this.at(c0, r0 + 1);
    const v11 = this.at(c0 + 1, r0 + 1);
    return (v00 * (1 - tc) + v10 * tc) * (1 - tr) + (v01 * (1 - tc) + v11 * tc) * tr;
  }

  /** The value of the pixel containing (x, y), or NaN. */
  nearest(x: number, y: number): number {
    const [c, r] = this.cog.pixelOf(x, y);
    return this.at(Math.floor(c) - this.window.col0, Math.floor(r) - this.window.row0);
  }

  private at(col: number, row: number): number {
    if (col < 0 || row < 0 || col >= this.window.width || row >= this.window.height) return Number.NaN;
    return this.window.data[row * this.window.width + col]!;
  }
}

async function readBand(
  href: string,
  bounds: [number, number, number, number],
  fetcher: RangeFetcher,
): Promise<BandWindow> {
  const cog = await Cog.open(href, fetcher);
  const [minX, minY, maxX, maxY] = bounds;
  const [c0, r0] = cog.pixelOf(minX, maxY);
  const [c1, r1] = cog.pixelOf(maxX, minY);
  return new BandWindow(cog, await cog.readWindow(c0, r0, c1 + 1, r1 + 1));
}

/** The plot's bounding box in the scene's UTM zone, widened by [MARGIN_M]. */
function utmBounds(polygon: Polygon, zone: UtmZone): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lng, lat] of polygon.coordinates[0]!) {
    const [x, y] = toUtm(lat!, lng!, zone);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX - MARGIN_M, minY - MARGIN_M, maxX + MARGIN_M, maxY + MARGIN_M];
}

/** Share of the plot's SCL pixels that are clear, by sampling the plot's own vertices' box. */
function clearShare(scl: BandWindow, polygon: Polygon, zone: UtmZone, inside: (lat: number, lng: number) => boolean): number {
  const ring = polygon.coordinates[0]!;
  const lats = ring.map((p) => p[1]!);
  const lngs = ring.map((p) => p[0]!);
  const [south, north, west, east] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  let total = 0;
  let clear = 0;
  // A 12 x 12 sample of the plot: plenty against 20 m SCL pixels.
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) {
      const lat = south + ((i + 0.5) / 12) * (north - south);
      const lng = west + ((j + 0.5) / 12) * (east - west);
      if (!inside(lat, lng)) continue;
      const [x, y] = toUtm(lat, lng, zone);
      const cls = scl.nearest(x, y);
      if (!Number.isFinite(cls)) continue;
      total++;
      if (CLEAR_SCL.has(cls)) clear++;
    }
  }
  return total === 0 ? 0 : clear / total;
}

const ratio = (a: number, b: number) => (a + b === 0 ? Number.NaN : (a - b) / (a + b));

/**
 * Samplers for the three indices over [polygon] from the newest clear
 * Sentinel-2 scene, or an error saying why there are none.
 *
 * [inside] tells whether a point is in the plot; it is passed in so this
 * module needs no geometry library of its own.
 */
export async function sentinelSamplers(
  polygon: Polygon,
  inside: (lat: number, lng: number) => boolean,
  options: { now?: Date; post?: JsonFetcher; fetcher?: RangeFetcher } = {},
): Promise<SentinelResult> {
  const fetcher = options.fetcher ?? httpRange;
  const items = await searchScenes(polygon, options.now, options.post);
  if (items.length === 0) throw new Error(`no Sentinel-2 scene in the last ${SEARCH_DAYS} days`);

  let tried = 0;
  for (const item of items) {
    if (tried >= MAX_SCENES_TRIED) break;
    const epsg = sceneEpsg(item);
    const zone = epsg === null ? null : zoneFromEpsg(epsg);
    const assets = item.assets;
    const needed = ['scl', 'red', 'nir', 'rededge1', 'nir08', 'swir16'] as const;
    if (!zone || needed.some((k) => !assets[k]?.href)) continue;
    tried++;

    const bounds = utmBounds(polygon, zone);
    const scl = await readBand(assets.scl!.href, bounds, fetcher);
    const share = clearShare(scl, polygon, zone, inside);
    if (share < MIN_CLEAR_SHARE) continue;

    const [red, nir, rededge, nir08, swir] = await Promise.all(
      (['red', 'nir', 'rededge1', 'nir08', 'swir16'] as const).map((k) => readBand(assets[k]!.href, bounds, fetcher)),
    );
    const rho = Object.fromEntries(
      (['red', 'nir', 'rededge1', 'nir08', 'swir16'] as const).map((k) => [k, reflectanceOf(item, assets[k]!)]),
    ) as Record<'red' | 'nir' | 'rededge1' | 'nir08' | 'swir16', (dn: number) => number>;

    /** Wraps a two-band index with the cloud mask. */
    const index =
      (compute: (x: number, y: number) => number): IndexSampler =>
      (lat, lng) => {
        const [x, y] = toUtm(lat, lng, zone);
        if (!CLEAR_SCL.has(scl.nearest(x, y))) return Number.NaN;
        return compute(x, y);
      };

    const date = String(item.properties.datetime ?? '').slice(0, 10);
    return {
      scene: {
        id: item.id,
        date,
        clearShare: Math.round(share * 100) / 100,
        cloudCoverPct: Number(item.properties['eo:cloud_cover'] ?? Number.NaN),
      },
      samplers: {
        ndvi: index((x, y) => ratio(rho.nir(nir!.bilinear(x, y)), rho.red(red!.bilinear(x, y)))),
        ndre: index((x, y) => ratio(rho.nir08(nir08!.bilinear(x, y)), rho.rededge1(rededge!.bilinear(x, y)))),
        lswi: index((x, y) => ratio(rho.nir08(nir08!.bilinear(x, y)), rho.swir16(swir!.bilinear(x, y)))),
      },
    };
  }
  throw new Error(
    `no Sentinel-2 scene in the last ${SEARCH_DAYS} days with ${Math.round(MIN_CLEAR_SHARE * 100)}% of the plot clear of cloud`,
  );
}
