import {
  geodesicAreaSqM,
  isSimplePolygon,
  perimeterM,
  ringToPolygon,
  type LngLat,
  type Polygon,
  type Position,
} from '@plot/shared';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl';
import { MapOverlay } from './mapOverlay.js';

/**
 * All polygon-drawing interaction lives here, deliberately outside React: the
 * map owns the DOM, React only renders the numbers this controller reports.
 *
 *   click            place a vertex
 *   double-click     close the polygon
 *   drag a vertex    move it
 *   right-click      delete a vertex
 */

export type DrawMode =
  /** Nothing drawn yet. */
  | 'idle'
  /** Placing or adjusting vertices. */
  | 'drawing'
  /** Polygon closed; waiting for the agent to drop the access point. */
  | 'awaiting-access'
  /** Polygon closed and access point placed. */
  | 'ready';

export interface DrawState {
  mode: DrawMode;
  /** Open ring - the closing repeat is added only when a polygon is built. */
  vertices: Position[];
  closed: boolean;
  access: LngLat | null;
  /** Live measurements, valid once there are three or more vertices. */
  areaSqM: number;
  perimeterM: number;
  selfIntersecting: boolean;
}

const SRC_SHAPE = 'draw-shape';
const SRC_VERTICES = 'draw-vertices';
const LAYER_FILL = 'draw-fill';
const LAYER_LINE = 'draw-line';
const LAYER_VERTEX = 'draw-vertex';

const COLOR_OK = '#4ade80';
const COLOR_BAD = '#f87171';
const VERTEX_RADIUS_PX = 6;
/**
 * A second click this close to the last vertex is a repeat, not a new corner.
 * Closing with a double-click fires two extra clicks on the same pixel, and a
 * duplicated vertex makes a zero-length edge that reads as self-intersecting.
 */
const VERTEX_MERGE_SLOP_PX = 8;

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export class PlotDrawController extends MapOverlay {
  private readonly emit: (state: DrawState) => void;

  private vertices: Position[] = [];
  private closed = false;
  private mode: DrawMode = 'idle';
  private accessMarker: maplibregl.Marker | null = null;
  private dragIndex: number | null = null;

  constructor(map: MapLibreMap, onChange: (state: DrawState) => void) {
    super(map);
    this.emit = onChange;
    this.installLayers();
    this.installHandlers();
  }

  protected layerIds(): string[] {
    return [LAYER_VERTEX, LAYER_LINE, LAYER_FILL];
  }

  protected sourceIds(): string[] {
    return [SRC_VERTICES, SRC_SHAPE];
  }

  protected override releaseExtras(): void {
    this.accessMarker?.remove();
    this.accessMarker = null;
  }

  /* ------------------------------------------------------------- lifecycle */

  private installLayers(): void {
    const map = this.map;
    map.addSource(SRC_SHAPE, { type: 'geojson', data: EMPTY });
    map.addSource(SRC_VERTICES, { type: 'geojson', data: EMPTY });

    map.addLayer({
      id: LAYER_FILL,
      type: 'fill',
      source: SRC_SHAPE,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 },
    });
    map.addLayer({
      id: LAYER_LINE,
      type: 'line',
      source: SRC_SHAPE,
      paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
    });
    map.addLayer({
      id: LAYER_VERTEX,
      type: 'circle',
      source: SRC_VERTICES,
      paint: {
        'circle-radius': VERTEX_RADIUS_PX,
        'circle-color': '#ffffff',
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 2,
      },
    });
  }

  private installHandlers(): void {
    const canvas = this.map.getCanvas();
    this.map.doubleClickZoom.disable();
    // Right-drag rotation is wrong for a 2D drawing tool, and while it is
    // enabled MapLibre swallows the right-click so vertices cannot be deleted.
    this.map.dragRotate.disable();

    // Bound on the DOM rather than through `map.on('contextmenu')`: MapLibre
    // routes that event through a handler that suppresses it after any
    // right-button gesture, which makes deletion silently unreliable.
    this.onDom(this.map.getCanvasContainer(), 'contextmenu', (ev) => this.onContextMenu(ev));

    this.onMap('click', (e) => this.onClick(e));
    this.onMap('dblclick', () => this.onDoubleClick());
    this.onMap('mousemove', (e) => this.onMouseMove(e));
    this.onMap('mouseup', () => this.endDrag());
    this.onLayer('mousedown', LAYER_VERTEX, (e) => this.onVertexMouseDown(e));
    this.onLayer('mouseenter', LAYER_VERTEX, () => (canvas.style.cursor = 'move'));
    this.onLayer('mouseleave', LAYER_VERTEX, () => (canvas.style.cursor = ''));
  }

  /* ---------------------------------------------------------------- public */

  /** Clears everything and puts the map back into vertex-placing mode. */
  startNew(): void {
    this.vertices = [];
    this.closed = false;
    this.mode = 'drawing';
    this.accessMarker?.remove();
    this.accessMarker = null;
    this.render();
  }

  reset(): void {
    this.startNew();
    this.mode = 'idle';
    this.render();
  }

  /** The polygon exactly as it will be sent to the API, or null if incomplete. */
  toPolygon(): Polygon | null {
    if (this.vertices.length < 3) return null;
    return ringToPolygon(this.vertices);
  }

  getAccessPoint(): LngLat | null {
    if (!this.accessMarker) return null;
    const { lng, lat } = this.accessMarker.getLngLat();
    return [lng, lat];
  }

  /* -------------------------------------------------------------- handlers */

  private onClick(e: MapMouseEvent): void {
    if (this.mode === 'awaiting-access') {
      this.placeAccessMarker([e.lngLat.lng, e.lngLat.lat]);
      return;
    }
    if (this.mode !== 'drawing' || this.closed) return;
    if (this.isOnLastVertex(e)) return;
    this.vertices.push([e.lngLat.lng, e.lngLat.lat]);
    this.render();
  }

  /** True when the event lands on the vertex that was placed most recently. */
  private isOnLastVertex(e: MapMouseEvent): boolean {
    const last = this.vertices[this.vertices.length - 1];
    if (!last) return false;
    const p = this.map.project(last as [number, number]);
    return Math.hypot(p.x - e.point.x, p.y - e.point.y) < VERTEX_MERGE_SLOP_PX;
  }

  /**
   * Closes the ring. Nothing is popped here: `onClick` already collapses the
   * repeat clicks a double-click generates, so whatever is in `vertices` is
   * exactly what the agent placed.
   */
  private onDoubleClick(): void {
    if (this.mode !== 'drawing' || this.closed || this.vertices.length < 3) return;
    this.closed = true;
    this.mode = 'awaiting-access';
    this.render();
  }

  private onContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    const rect = this.map.getCanvas().getBoundingClientRect();
    const index = this.vertexIndexAt([ev.clientX - rect.left, ev.clientY - rect.top]);
    if (index === null) return;
    // Below three vertices there is no polygon left, so re-open for editing.
    this.vertices.splice(index, 1);
    if (this.vertices.length < 3) {
      this.closed = false;
      this.mode = 'drawing';
    }
    this.render();
  }

  private onVertexMouseDown(e: MapMouseEvent): void {
    const index = this.vertexIndexAt([e.point.x, e.point.y]);
    if (index === null) return;
    e.preventDefault();
    this.dragIndex = index;
    this.map.dragPan.disable();
  }

  private onMouseMove(e: MapMouseEvent): void {
    if (this.dragIndex === null) return;
    this.vertices[this.dragIndex] = [e.lngLat.lng, e.lngLat.lat];
    this.render();
  }

  private endDrag(): void {
    if (this.dragIndex === null) return;
    this.dragIndex = null;
    this.map.dragPan.enable();
  }

  /** Index of the drawn vertex under a canvas-relative pixel, if any. */
  private vertexIndexAt(point: [number, number]): number | null {
    const hits = this.map.queryRenderedFeatures(point, { layers: [LAYER_VERTEX] });
    const index = hits[0]?.properties?.index;
    return typeof index === 'number' ? index : null;
  }

  private placeAccessMarker(at: LngLat): void {
    if (this.accessMarker) {
      this.accessMarker.setLngLat(at);
    } else {
      this.accessMarker = new maplibregl.Marker({ draggable: true, color: '#f59e0b' })
        .setLngLat(at)
        .addTo(this.map);
      this.accessMarker.on('dragend', () => this.render());
    }
    this.mode = 'ready';
    this.render();
  }

  /* ---------------------------------------------------------------- render */

  private render(): void {
    const { vertices, closed } = this;
    const measurable = vertices.length >= 3;
    const polygon = measurable ? ringToPolygon(vertices) : null;

    const selfIntersecting = polygon ? !isSimplePolygon(polygon) : false;
    const color = selfIntersecting ? COLOR_BAD : COLOR_OK;

    const shapes: GeoJSON.Feature[] = [];
    if (closed && polygon) {
      shapes.push({ type: 'Feature', geometry: polygon, properties: { color } });
    } else if (vertices.length >= 2) {
      shapes.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: vertices },
        properties: { color },
      });
    }

    (this.map.getSource(SRC_SHAPE) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: shapes,
    });
    (this.map.getSource(SRC_VERTICES) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: vertices.map((position, index) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: position },
        properties: { index, color },
      })),
    });

    this.emit({
      mode: this.mode,
      vertices: [...vertices],
      closed,
      access: this.getAccessPoint(),
      areaSqM: polygon ? geodesicAreaSqM(polygon) : 0,
      perimeterM: polygon ? perimeterM(polygon) : 0,
      selfIntersecting,
    });
  }
}

export const emptyDrawState: DrawState = {
  mode: 'idle',
  vertices: [],
  closed: false,
  access: null,
  areaSqM: 0,
  perimeterM: 0,
  selfIntersecting: false,
};
