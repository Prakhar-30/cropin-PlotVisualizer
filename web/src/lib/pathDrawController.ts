import { DEFAULT_PATH_WIDTH_M, lineLengthM, type PathExclusion, type Plot, type Position } from '@plot/shared';
import {
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapMouseEvent,
} from 'maplibre-gl';
import { MapOverlay } from './mapOverlay.js';

/**
 * Walking paths inside plots: drawn, edited, and shown.
 *
 * A path is a line along its middle with a width on the ground. Its cells are
 * left out of crop condition, so a bare track through a vineyard is not graded
 * as a line of failing crop.
 *
 *   Add path         start a path; click along it
 *   double-click     finish it (or "Finish path")
 *   × in the panel   remove one
 *
 * Paths are drawn at their true width: MapLibre's line width is in pixels, so
 * each feature carries its width in pixels at zoom 0 and the style doubles it
 * per zoom level, the way the map's own scale does.
 */

export interface PathDrawState {
  /** Paths of the plot being drawn or edited. */
  paths: PathExclusion[];
  /** Points of the path being drawn now, or null when not drawing one. */
  current: Position[] | null;
  /** Width the next path is drawn at, metres. */
  widthM: number;
}

const SRC_EDIT = 'path-edit';
const SRC_SAVED = 'path-saved';
const LAYER_SAVED = 'path-saved-line';
const LAYER_EDIT = 'path-edit-line';
const LAYER_EDIT_CENTRE = 'path-edit-centre';
const LAYER_EDIT_POINTS = 'path-edit-points';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Metres per pixel at zoom 0 at the equator, for 512 px tiles. */
const METRES_PER_PX_Z0 = 78271.517;

const MERGE_SLOP_PX = 8;

/** Line width in pixels as a function of zoom, for a [width] in metres at [lat]. */
function widthExpression(): ExpressionSpecification {
  return [
    'interpolate',
    ['exponential', 2],
    ['zoom'],
    0,
    ['get', 'px0'],
    24,
    ['*', ['get', 'px0'], 16777216],
  ];
}

function pathFeature(path: { line: Position[]; width_m: number }, extra: Record<string, unknown> = {}): GeoJSON.Feature {
  const lat = path.line[0]?.[1] ?? 0;
  const px0 = path.width_m / (METRES_PER_PX_Z0 * Math.cos((lat * Math.PI) / 180));
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: path.line },
    properties: { px0, width_m: path.width_m, ...extra },
  };
}

export class PathDrawController extends MapOverlay {
  private paths: PathExclusion[] = [];
  private current: Position[] | null = null;
  private widthM = DEFAULT_PATH_WIDTH_M;

  constructor(
    map: MapLibreMap,
    private readonly emit: (state: PathDrawState) => void,
    beforeLayerId?: string,
  ) {
    super(map);
    map.addSource(SRC_SAVED, { type: 'geojson', data: EMPTY });
    map.addSource(SRC_EDIT, { type: 'geojson', data: EMPTY });
    map.addLayer(
      {
        id: LAYER_SAVED,
        type: 'line',
        source: SRC_SAVED,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#c8b89a', 'line-opacity': 0.55, 'line-width': widthExpression() },
      },
      beforeLayerId,
    );
    map.addLayer({
      id: LAYER_EDIT,
      type: 'line',
      source: SRC_EDIT,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#e9d8b4', 'line-opacity': 0.7, 'line-width': widthExpression() },
    });
    map.addLayer({
      id: LAYER_EDIT_CENTRE,
      type: 'line',
      source: SRC_EDIT,
      paint: { 'line-color': '#3a2c14', 'line-width': 1.5, 'line-dasharray': [2, 2] },
    });
    map.addLayer({
      id: LAYER_EDIT_POINTS,
      type: 'circle',
      source: SRC_EDIT,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': '#3a2c14', 'circle-stroke-width': 1.5 },
    });

    this.onMap('click', (e) => this.onClick(e));
    this.onMap('dblclick', () => this.finishPath());
  }

  protected layerIds(): string[] {
    return [LAYER_EDIT_POINTS, LAYER_EDIT_CENTRE, LAYER_EDIT, LAYER_SAVED];
  }

  protected sourceIds(): string[] {
    return [SRC_EDIT, SRC_SAVED];
  }

  /** Shows the saved paths of every plot except the one being edited. */
  setSaved(plots: Plot[], exceptId: string | null): void {
    (this.map.getSource(SRC_SAVED) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: plots.filter((p) => p.id !== exceptId).flatMap((p) => p.exclusions.map((path) => pathFeature(path))),
    });
  }

  /** Starts editing [paths] - a plot's own, or none for a new plot. */
  load(paths: PathExclusion[]): void {
    this.paths = paths.map((p) => ({ line: p.line.map((q) => [...q] as Position), width_m: p.width_m }));
    this.current = null;
    this.render();
  }

  clear(): void {
    this.load([]);
  }

  setWidth(widthM: number): void {
    this.widthM = widthM;
    this.render();
  }

  startPath(): void {
    this.current = [];
    this.render();
  }

  /** Keeps the path being drawn, if it has two points or more. */
  finishPath(): void {
    if (!this.current) return;
    if (this.current.length >= 2) this.paths.push({ line: this.current, width_m: this.widthM });
    this.current = null;
    this.render();
  }

  cancelPath(): void {
    this.current = null;
    this.render();
  }

  removePath(index: number): void {
    this.paths.splice(index, 1);
    this.render();
  }

  toExclusions(): PathExclusion[] {
    return this.paths.map((p) => ({ line: p.line, width_m: p.width_m }));
  }

  private onClick(e: MapMouseEvent): void {
    if (!this.current) return;
    const last = this.current[this.current.length - 1];
    if (last) {
      const p = this.map.project(last as [number, number]);
      // The two clicks of a double-click land on one spot; one point, not two.
      if (Math.hypot(p.x - e.point.x, p.y - e.point.y) < MERGE_SLOP_PX) return;
    }
    this.current.push([e.lngLat.lng, e.lngLat.lat]);
    this.render();
  }

  private render(): void {
    const features: GeoJSON.Feature[] = this.paths.map((path, index) => pathFeature(path, { index }));
    if (this.current) {
      if (this.current.length >= 2) features.push(pathFeature({ line: this.current, width_m: this.widthM }));
      for (const point of this.current) {
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} });
      }
    }
    (this.map.getSource(SRC_EDIT) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
    this.emit({ paths: this.toExclusions(), current: this.current ? [...this.current] : null, widthM: this.widthM });
  }
}

/** A path's length on the ground, for the panel. */
export function pathLengthM(path: PathExclusion): number {
  return lineLengthM(path.line);
}

export const emptyPathState: PathDrawState = { paths: [], current: null, widthM: DEFAULT_PATH_WIDTH_M };
