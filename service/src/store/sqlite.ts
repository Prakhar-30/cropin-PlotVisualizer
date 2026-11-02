import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  generatePlotId,
  haversineMetres,
  type NormalizedPlot,
  type PathExclusion,
  type Plot,
  PLOT_COLOURS,
  type PlotWithDistance,
  type Polygon,
} from '@plot/shared';
import { config } from '../config.js';
import type { PlotStore } from './types.js';

/**
 * The local development and test driver.
 *
 * Every SQLite statement in the service lives in this file. It is the store the
 * test suite runs against, which is why the rejection rules and the `?near=`
 * arithmetic are covered here rather than against a network service.
 */

interface PlotRow {
  id: string;
  name: string;
  polygon: string;
  centroid_lat: number;
  centroid_lng: number;
  area_sq_m: number;
  landmark_note: string;
  colour_index: number;
  exclusions: string;
  created_at: string;
  updated_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plots (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  polygon       TEXT NOT NULL,
  centroid_lat  REAL NOT NULL,
  centroid_lng  REAL NOT NULL,
  area_sq_m     REAL NOT NULL,
  landmark_note TEXT NOT NULL DEFAULT '',
  colour_index  INTEGER NOT NULL DEFAULT 0,
  exclusions    TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
CREATE TABLE IF NOT EXISTS health_cache (
  plot_id    TEXT NOT NULL,
  cache_key  TEXT NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (plot_id, cache_key)
);
-- The mobile app's hot path is a bounding-box scan on the centroid.
CREATE INDEX IF NOT EXISTS idx_plots_centroid ON plots (centroid_lat, centroid_lng);
`;

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const dbPath = config.dbPath;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  dropLegacyTable(db);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Brings an existing database up to the current schema.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the columns are checked first.
 * Adding rather than recreating matters even for a prototype: the seeded plots
 * are what the phone has been tested against, and silently dropping them turns
 * a schema change into a mystery about why the app is empty.
 */
function migrate(handle: Database.Database): void {
  const columns = new Set(
    (handle.prepare('PRAGMA table_info(plots)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('colour_index')) {
    handle.exec('ALTER TABLE plots ADD COLUMN colour_index INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('exclusions')) {
    handle.exec("ALTER TABLE plots ADD COLUMN exclusions TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.has('updated_at')) {
    handle.exec('ALTER TABLE plots ADD COLUMN updated_at TEXT');
  }
}

/**
 * A database from before the access point was removed has `access_lat` and
 * `access_lng` as NOT NULL columns, which every new insert would violate. The
 * updated flow starts from a clean slate by decision, so that table is dropped
 * and recreated rather than migrated.
 */
function dropLegacyTable(handle: Database.Database): void {
  const columns = (handle.prepare('PRAGMA table_info(plots)').all() as { name: string }[]).map((c) => c.name);
  if (columns.includes('access_lat')) handle.exec('DROP TABLE plots');
}

/** Test helper: drops the handle so the next getDb() reopens from config. */
function closeDb(): void {
  db?.close();
  db = null;
}

function rowToPlot(row: PlotRow): Plot {
  const { updated_at, ...rest } = row;
  return {
    ...rest,
    polygon: JSON.parse(row.polygon) as Polygon,
    exclusions: JSON.parse(row.exclusions || '[]') as PathExclusion[],
    ...(updated_at ? { updated_at } : {}),
  };
}

const MAX_ID_ATTEMPTS = 20;

/**
 * Inserts a validated plot, retrying until it lands on a free id.
 *
 * `forcedId` exists for the seed script, which wants stable ids the mobile app
 * can hard-code during development. The HTTP route never passes it, so an id in
 * a request body is always ignored.
 */
function insertPlotSync(value: NormalizedPlot, forcedId?: string): Plot {
  const stmt = getDb().prepare(
    `INSERT INTO plots
       (id, name, polygon, centroid_lat, centroid_lng, area_sq_m, landmark_note, colour_index, exclusions,
        created_at, updated_at)
     VALUES (@id, @name, @polygon, @centroid_lat, @centroid_lng, @area_sq_m, @landmark_note, @colour_index,
        @exclusions, @created_at, @updated_at)`,
  );
  const created_at = new Date().toISOString();
  const colour_index = pickColourIndex(value.centroid_lat, value.centroid_lng);

  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = forcedId ?? generatePlotId();
    const row: PlotRow = {
      id,
      name: value.name,
      polygon: JSON.stringify(value.polygon),
      centroid_lat: value.centroid_lat,
      centroid_lng: value.centroid_lng,
      area_sq_m: value.area_sq_m,
      landmark_note: value.landmark_note,
      colour_index,
      exclusions: JSON.stringify(value.exclusions),
      created_at,
      updated_at: created_at,
    };
    try {
      stmt.run(row);
      return rowToPlot(row);
    } catch (err) {
      if (forcedId) throw err;
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') continue;
      throw err;
    }
  }
  throw new Error('could not allocate a unique plot id');
}

function getPlotSync(id: string): Plot | null {
  const row = getDb().prepare('SELECT * FROM plots WHERE id = ?').get(id) as PlotRow | undefined;
  return row ? rowToPlot(row) : null;
}

function listPlotsSync(): Plot[] {
  const rows = getDb()
    .prepare('SELECT * FROM plots ORDER BY created_at DESC, id DESC')
    .all() as PlotRow[];
  return rows.map(rowToPlot);
}

/** Degrees of latitude per metre, and of longitude per metre at a given latitude. */
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LNG_EQUATOR = 111_320;

/**
 * Plots whose centroid falls within `radiusM` of (`lat`, `lng`), nearest first.
 *
 * A bounding box narrows the scan in SQL - which is what the index is for - and
 * an exact haversine on the survivors turns that square into a circle.
 */
function listPlotsNearSync(lat: number, lng: number, radiusM: number): PlotWithDistance[] {
  const dLat = radiusM / M_PER_DEG_LAT;
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
  const dLng = radiusM / (M_PER_DEG_LNG_EQUATOR * cosLat);

  const rows = getDb()
    .prepare(
      `SELECT * FROM plots
        WHERE centroid_lat BETWEEN ? AND ?
          AND centroid_lng BETWEEN ? AND ?`,
    )
    .all(lat - dLat, lat + dLat, lng - dLng, lng + dLng) as PlotRow[];

  return rows
    .map((row) => ({
      ...rowToPlot(row),
      distance_m: haversineMetres([lng, lat], [row.centroid_lng, row.centroid_lat]),
    }))
    .filter((p) => p.distance_m <= radiusM)
    .sort((a, b) => a.distance_m - b.distance_m);
}

/**
 * Chooses the palette slot least used by plots nearby.
 *
 * Mirrors `fieldar.pick_colour_index()` in the Supabase schema. Adjacent plots
 * never share a colour, which is the whole point - two plots in different
 * districts may, because they are never on screen together.
 */
function pickColourIndex(lat: number, lng: number, neighbourhoodM = 500): number {
  const nearby = listPlotsNearSync(lat, lng, neighbourhoodM);
  const used = new Array<number>(PLOT_COLOURS.length).fill(0);
  for (const plot of nearby) {
    const slot = plot.colour_index;
    if (slot >= 0 && slot < used.length) used[slot]! += 1;
  }
  let best = 0;
  for (let i = 1; i < used.length; i++) {
    if (used[i]! < used[best]!) best = i;
  }
  return best;
}

function updatePlotSync(id: string, value: NormalizedPlot): Plot | null {
  const changed = getDb()
    .prepare(
      `UPDATE plots
          SET name = @name, polygon = @polygon, centroid_lat = @centroid_lat, centroid_lng = @centroid_lng,
              area_sq_m = @area_sq_m, landmark_note = @landmark_note, exclusions = @exclusions,
              updated_at = @updated_at
        WHERE id = @id`,
    )
    .run({
      id,
      name: value.name,
      polygon: JSON.stringify(value.polygon),
      centroid_lat: value.centroid_lat,
      centroid_lng: value.centroid_lng,
      area_sq_m: value.area_sq_m,
      landmark_note: value.landmark_note,
      exclusions: JSON.stringify(value.exclusions),
      updated_at: new Date().toISOString(),
    }).changes;
  return changed > 0 ? getPlotSync(id) : null;
}

function deletePlotSync(id: string): boolean {
  getDb().prepare('DELETE FROM health_cache WHERE plot_id = ?').run(id);
  return getDb().prepare('DELETE FROM plots WHERE id = ?').run(id).changes > 0;
}

function deleteAllPlotsSync(): void {
  getDb().exec('DELETE FROM health_cache');
  getDb().exec('DELETE FROM plots');
}

/**
 * The SQLite driver.
 *
 * The methods are async only to satisfy [PlotStore]; better-sqlite3 is
 * synchronous, so each one resolves immediately.
 */
export class SqlitePlotStore implements PlotStore {
  readonly kind = 'sqlite' as const;

  async init(): Promise<void> {
    getDb();
  }

  async insertPlot(value: NormalizedPlot, forcedId?: string): Promise<Plot> {
    return insertPlotSync(value, forcedId);
  }

  async getPlot(id: string): Promise<Plot | null> {
    return getPlotSync(id);
  }

  async listPlots(): Promise<Plot[]> {
    return listPlotsSync();
  }

  async listPlotsNear(lat: number, lng: number, radiusM: number): Promise<PlotWithDistance[]> {
    return listPlotsNearSync(lat, lng, radiusM);
  }

  async updatePlot(id: string, value: NormalizedPlot): Promise<Plot | null> {
    return updatePlotSync(id, value);
  }

  async getCachedHealth(plotId: string, key: string): Promise<unknown | null> {
    const row = getDb()
      .prepare('SELECT payload FROM health_cache WHERE plot_id = ? AND cache_key = ?')
      .get(plotId, key) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as unknown) : null;
  }

  async putCachedHealth(plotId: string, key: string, payload: unknown): Promise<void> {
    const db = getDb();
    db.prepare('DELETE FROM health_cache WHERE plot_id = ? AND cache_key <> ?').run(plotId, key);
    db.prepare('INSERT OR REPLACE INTO health_cache (plot_id, cache_key, payload) VALUES (?, ?, ?)').run(
      plotId,
      key,
      JSON.stringify(payload),
    );
  }

  async deletePlot(id: string): Promise<boolean> {
    return deletePlotSync(id);
  }

  async deleteAllPlots(): Promise<void> {
    deleteAllPlotsSync();
  }

  /** Test helper: drops the handle so the next call reopens from config. */
  close(): void {
    closeDb();
  }
}
