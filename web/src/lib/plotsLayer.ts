import {
  formatHectares,
  MAX_IMAGERY_ZOOM,
  plotColour,
  plotToFeature,
  polygonBbox,
  type Plot,
} from '@plot/shared';
import maplibregl, { type GeoJSONSource, type LngLatBoundsLike, type Map as MapLibreMap } from 'maplibre-gl';
import { MapOverlay } from './mapOverlay.js';

/**
 * Renders already-saved plots underneath the draw tool, so a new boundary can be
 * traced against its neighbours. Labels are HTML markers rather than symbol
 * layers, which keeps the raster style free of a glyph endpoint.
 */

const SRC_SHAPE = 'saved-plots';
const SRC_ACCESS = 'saved-plots-access-src';
const LAYER_FILL = 'saved-plots-fill';
const LAYER_LINE = 'saved-plots-line';
const LAYER_ACCESS = 'saved-plots-access';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export class SavedPlotsLayer extends MapOverlay {
  private labels: maplibregl.Marker[] = [];

  constructor(map: MapLibreMap, onSelect: (id: string) => void) {
    super(map);

    map.addSource(SRC_SHAPE, { type: 'geojson', data: EMPTY });
    map.addSource(SRC_ACCESS, { type: 'geojson', data: EMPTY });

    map.addLayer({
      id: LAYER_FILL,
      type: 'fill',
      source: SRC_SHAPE,
      // Colour comes from each feature rather than the style, so the palette
      // lives in @plot/shared alongside the Kotlin copy the AR view uses. A plot
      // is the same colour on the map as it is through the camera.
      paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': 0.14 },
    });
    map.addLayer({
      id: LAYER_LINE,
      type: 'line',
      source: SRC_SHAPE,
      paint: { 'line-color': ['get', 'colour'], 'line-width': 2, 'line-dasharray': [3, 2] },
    });
    map.addLayer({
      id: LAYER_ACCESS,
      type: 'circle',
      source: SRC_ACCESS,
      paint: {
        'circle-radius': 4,
        'circle-color': '#f59e0b',
        'circle-stroke-color': '#111827',
        'circle-stroke-width': 1,
      },
    });

    this.onLayer('click', LAYER_FILL, (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === 'string') onSelect(id);
    });
  }

  protected layerIds(): string[] {
    return [LAYER_ACCESS, LAYER_LINE, LAYER_FILL];
  }

  /**
   * The lowest layer this overlay owns. Anything inserted before it - the health
   * grid, for one - is drawn underneath every saved boundary.
   */
  bottomLayerId(): string {
    return LAYER_FILL;
  }

  protected sourceIds(): string[] {
    return [SRC_ACCESS, SRC_SHAPE];
  }

  protected override releaseExtras(): void {
    for (const marker of this.labels) marker.remove();
    this.labels = [];
  }

  setPlots(plots: Plot[]): void {
    (this.map.getSource(SRC_SHAPE) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: plots.map((plot) => {
        const feature = plotToFeature(plot);
        return {
          ...feature,
          properties: { ...feature.properties, colour: plotColour(plot.colour_index).hex },
        };
      }),
    });
    (this.map.getSource(SRC_ACCESS) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: plots.map((p) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.access_lng, p.access_lat] },
        properties: { id: p.id },
      })),
    });

    this.releaseExtras();
    this.labels = plots.map((p) => {
      const el = document.createElement('div');
      el.className = 'plot-label';
      el.style.setProperty('--plot-colour', plotColour(p.colour_index).hex);
      el.textContent = `${p.id} · ${formatHectares(p.area_sq_m)}`;
      return new maplibregl.Marker({ element: el })
        .setLngLat([p.centroid_lng, p.centroid_lat])
        .addTo(this.map);
    });
  }

  /** Frames a plot on screen. Used by the list page's click-to-zoom action. */
  zoomTo(plot: Plot): void {
    const [w, s, e, n] = polygonBbox(plot.polygon);
    this.map.fitBounds([[w, s], [e, n]] as LngLatBoundsLike, {
      padding: 120,
      duration: 800,
      maxZoom: MAX_IMAGERY_ZOOM - 1,
    });
  }
}
