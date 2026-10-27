import { SEVERITY_COLOURS, SEVERITY_LABELS, type IndexKey } from '@plot/shared';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { PlotHealth } from '../api.js';
import { MapOverlay } from './mapOverlay.js';

/**
 * Crop condition for every saved plot at once, on one index: the moderate and
 * critical cells, and a drop point on each patch.
 *
 * Normal cells are not painted. Across many plots a green wash hides the
 * imagery and the boundaries, and the question the map answers is the same one
 * the camera answers: where does somebody need to go. The panel still reports
 * the normal share.
 *
 * Cells are drawn as real polygons rather than as a raster image so that they
 * stay geographically registered at every zoom. Drop points are a circle layer,
 * not DOM markers, so a few hundred of them cost nothing; clicking one opens
 * its plot, zone and coordinate.
 */

const SRC_CELLS = 'plot-health-cells';
const SRC_DROPS = 'plot-health-drops';
const LAYER_CELLS = 'plot-health-cells-fill';
const LAYER_CELL_EDGES = 'plot-health-cells-line';
const LAYER_DROPS = 'plot-health-drops-circle';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Formats a position the way a field agent will read it aloud or type it in. */
export function formatCoordinate(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

export class PlotHealthLayer extends MapOverlay {
  private popup: maplibregl.Popup | null = null;

  constructor(map: MapLibreMap, beforeLayerId?: string) {
    super(map);

    map.addSource(SRC_CELLS, { type: 'geojson', data: EMPTY });
    map.addSource(SRC_DROPS, { type: 'geojson', data: EMPTY });

    map.addLayer(
      {
        id: LAYER_CELLS,
        type: 'fill',
        source: SRC_CELLS,
        paint: {
          // The colour is baked into each feature by `setSnapshots`, so the
          // zone edges live in @plot/shared and not in a style expression that
          // only this file would know about.
          'fill-color': ['get', 'colour'],
          // Translucent enough to read the imagery underneath: the crop and the
          // grading together are what make the grading believable.
          'fill-opacity': 0.6,
        },
      },
      beforeLayerId,
    );

    map.addLayer(
      {
        id: LAYER_CELL_EDGES,
        type: 'line',
        source: SRC_CELLS,
        paint: { 'line-color': '#0b0f14', 'line-width': 0.4, 'line-opacity': 0.35 },
      },
      beforeLayerId,
    );

    // On top of everything, plot outlines included: a drop point is the thing
    // to find on the map.
    map.addLayer({
      id: LAYER_DROPS,
      type: 'circle',
      source: SRC_DROPS,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 6, 19, 9],
        'circle-color': ['get', 'colour'],
        'circle-stroke-color': '#0b0f14',
        'circle-stroke-width': 2,
      },
    });

    this.onLayer('click', LAYER_DROPS, (e) => {
      const feature = e.features?.[0];
      if (!feature || feature.geometry.type !== 'Point') return;
      const [lng, lat] = feature.geometry.coordinates as [number, number];
      const p = feature.properties as { plot: string; label: string; area: number };
      this.popup?.remove();
      this.popup = new maplibregl.Popup({ closeButton: true, offset: 10, className: 'drop-popup' })
        .setLngLat([lng, lat])
        .setHTML(
          `<strong>${escapeHtml(p.plot)}</strong><br>${escapeHtml(p.label)} · ${Math.round(p.area)} m²` +
            `<br><span class="mono">${formatCoordinate(lat, lng)}</span>`,
        )
        .addTo(this.map);
    });
    this.onLayer('mouseenter', LAYER_DROPS, () => (this.map.getCanvas().style.cursor = 'pointer'));
    this.onLayer('mouseleave', LAYER_DROPS, () => (this.map.getCanvas().style.cursor = ''));
  }

  protected layerIds(): string[] {
    return [LAYER_DROPS, LAYER_CELL_EDGES, LAYER_CELLS];
  }

  protected sourceIds(): string[] {
    return [SRC_DROPS, SRC_CELLS];
  }

  protected override releaseExtras(): void {
    this.popup?.remove();
    this.popup = null;
  }

  /**
   * Draws one index across every snapshot given: moderate and critical cells in
   * their zone colour, and a drop point on each patch. `plotNames` labels the
   * popups.
   */
  setSnapshots(snapshots: PlotHealth[], index: IndexKey, plotNames: ReadonlyMap<string, string>): void {
    const cells: GeoJSON.Feature[] = [];
    const drops: GeoJSON.Feature[] = [];
    for (const snapshot of snapshots) {
      const plot = plotNames.get(snapshot.plot_id) ?? snapshot.plot_id;
      for (const cell of snapshot.cells) {
        const zone = cell.zones[index];
        if (zone < 1) continue;
        cells.push({
          type: 'Feature',
          geometry: cell.cell,
          properties: { zone, colour: SEVERITY_COLOURS[zone] },
        });
      }
      for (const patch of snapshot.patches) {
        if (patch.index !== index) continue;
        drops.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [patch.centroid_lng, patch.centroid_lat] },
          properties: {
            zone: patch.zone,
            colour: SEVERITY_COLOURS[patch.zone],
            label: SEVERITY_LABELS[patch.zone],
            area: patch.area_sq_m,
            plot: `${plot} · ${snapshot.plot_id}`,
          },
        });
      }
    }
    // Critical drawn last, so a red point is never hidden under a yellow one.
    drops.sort((a, b) => (a.properties!.zone as number) - (b.properties!.zone as number));
    (this.map.getSource(SRC_CELLS) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: cells });
    (this.map.getSource(SRC_DROPS) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: drops });
  }

  clear(): void {
    (this.map.getSource(SRC_CELLS) as GeoJSONSource | undefined)?.setData(EMPTY);
    (this.map.getSource(SRC_DROPS) as GeoJSONSource | undefined)?.setData(EMPTY);
    this.releaseExtras();
  }

  setVisible(visible: boolean): void {
    const value = visible ? 'visible' : 'none';
    for (const id of this.layerIds()) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', value);
    }
    if (!visible) this.releaseExtras();
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
