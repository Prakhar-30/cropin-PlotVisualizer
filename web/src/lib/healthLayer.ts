import { SEVERITY_COLOURS, SEVERITY_LABELS, type Severity } from '@plot/shared';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { PlotHealth } from '../api.js';
import { MapOverlay } from './mapOverlay.js';

/**
 * The pixelated plot-health overlay and its hotspot pins.
 *
 * Cells are drawn as real polygons rather than as a raster image so that they
 * stay geographically registered at every zoom - the point of the feature is
 * that a coloured square is a place you can walk to, and a stretched bitmap
 * stops being that as soon as the map is tilted or the projection matters.
 *
 * Hotspot pins carry their own coordinates in the label. That is the whole
 * request from the field: the agent reads the number off the screen, or copies
 * it, and walks there.
 */

const SRC_CELLS = 'plot-health-cells';
const SRC_HOTSPOTS = 'plot-health-hotspots';
const LAYER_CELLS = 'plot-health-cells-fill';
const LAYER_CELL_EDGES = 'plot-health-cells-line';
const LAYER_HOTSPOT_RING = 'plot-health-hotspot-ring';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Formats a position the way a field agent will read it aloud or type it in. */
export function formatCoordinate(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

export class PlotHealthLayer extends MapOverlay {
  private pins: maplibregl.Marker[] = [];

  constructor(map: MapLibreMap, beforeLayerId?: string) {
    super(map);

    map.addSource(SRC_CELLS, { type: 'geojson', data: EMPTY });
    map.addSource(SRC_HOTSPOTS, { type: 'geojson', data: EMPTY });

    map.addLayer(
      {
        id: LAYER_CELLS,
        type: 'fill',
        source: SRC_CELLS,
        paint: {
          // The colour is baked into each feature by `setSnapshot`, so the
          // banding thresholds live in @plot/shared and not in a style
          // expression that only this file would know about.
          'fill-color': ['get', 'colour'],
          // Translucent enough to read the imagery underneath: an agronomist
          // wants to see the crop and the grading at once, and an opaque grid
          // hides exactly the evidence that makes the grading believable.
          'fill-opacity': 0.55,
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

    map.addLayer({
      id: LAYER_HOTSPOT_RING,
      type: 'circle',
      source: SRC_HOTSPOTS,
      paint: {
        'circle-radius': 14,
        'circle-color': 'transparent',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-stroke-opacity': 0.9,
      },
    });
  }

  protected layerIds(): string[] {
    return [LAYER_HOTSPOT_RING, LAYER_CELL_EDGES, LAYER_CELLS];
  }

  protected sourceIds(): string[] {
    return [SRC_HOTSPOTS, SRC_CELLS];
  }

  protected override releaseExtras(): void {
    for (const pin of this.pins) pin.remove();
    this.pins = [];
  }

  /** Draws a snapshot, or clears the overlay when passed `null`. */
  setSnapshot(snapshot: PlotHealth | null): void {
    if (!snapshot) {
      this.clear();
      return;
    }

    (this.map.getSource(SRC_CELLS) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: snapshot.cells.map((cell) => ({
        type: 'Feature' as const,
        geometry: cell.cell,
        properties: {
          value: cell.value,
          severity: cell.severity,
          colour: SEVERITY_COLOURS[cell.severity],
          label: SEVERITY_LABELS[cell.severity],
          coordinate: formatCoordinate(cell.centroid_lat, cell.centroid_lng),
        },
      })),
    });

    (this.map.getSource(SRC_HOTSPOTS) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: snapshot.hotspots.map((hotspot) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [hotspot.centroid_lng, hotspot.centroid_lat],
        },
        properties: { rank: hotspot.rank },
      })),
    });

    this.releaseExtras();
    this.pins = snapshot.hotspots.map((hotspot) => {
      const el = document.createElement('div');
      el.className = 'hotspot-pin';
      el.style.setProperty('--hotspot-colour', SEVERITY_COLOURS[hotspot.severity as Severity]);

      const rank = document.createElement('span');
      rank.className = 'hotspot-pin__rank';
      rank.textContent = String(hotspot.rank);

      const readout = document.createElement('span');
      readout.className = 'hotspot-pin__coord';
      readout.textContent = formatCoordinate(hotspot.centroid_lat, hotspot.centroid_lng);
      // One click puts the coordinate on the clipboard, which is how it gets
      // into a phone: the agent is going to type it into a maps app, and
      // transcribing six decimal places by eye is where mistakes come from.
      readout.title = 'Click to copy';
      readout.addEventListener('click', () => {
        void navigator.clipboard
          ?.writeText(formatCoordinate(hotspot.centroid_lat, hotspot.centroid_lng))
          .then(() => {
            readout.classList.add('is-copied');
            setTimeout(() => readout.classList.remove('is-copied'), 1200);
          })
          .catch(() => {
            /* clipboard blocked; the number is still on screen to read */
          });
      });

      el.append(rank, readout);
      return new maplibregl.Marker({ element: el, anchor: 'top' })
        .setLngLat([hotspot.centroid_lng, hotspot.centroid_lat])
        .addTo(this.map);
    });
  }

  clear(): void {
    (this.map.getSource(SRC_CELLS) as GeoJSONSource | undefined)?.setData(EMPTY);
    (this.map.getSource(SRC_HOTSPOTS) as GeoJSONSource | undefined)?.setData(EMPTY);
    this.releaseExtras();
  }

  setVisible(visible: boolean): void {
    const value = visible ? 'visible' : 'none';
    for (const id of this.layerIds()) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', value);
    }
    for (const pin of this.pins) {
      pin.getElement().style.display = visible ? '' : 'none';
    }
  }
}
