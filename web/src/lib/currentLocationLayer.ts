import * as turf from '@turf/turf';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import { MapOverlay } from './mapOverlay.js';

/**
 * Where the browser thinks you are, drawn with its own stated accuracy.
 *
 * The circle is the point of this layer, not decoration. A laptop indoors is
 * commonly located by Wi-Fi triangulation to within a kilometre or two, and a
 * bare dot at that accuracy invites someone to draw a boundary around the wrong
 * field entirely. Drawing the uncertainty at true ground scale makes a bad fix
 * obvious at a glance: if the circle swallows the whole screen, do not trust it.
 */

const SRC_ACCURACY = 'current-location-accuracy';
const LAYER_ACCURACY_FILL = 'current-location-accuracy-fill';
const LAYER_ACCURACY_LINE = 'current-location-accuracy-line';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number;
}

export class CurrentLocationLayer extends MapOverlay {
  private marker: maplibregl.Marker | null = null;

  constructor(map: MapLibreMap, beforeLayerId?: string) {
    super(map);

    map.addSource(SRC_ACCURACY, { type: 'geojson', data: EMPTY });

    map.addLayer(
      {
        id: LAYER_ACCURACY_FILL,
        type: 'fill',
        source: SRC_ACCURACY,
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.12 },
      },
      beforeLayerId,
    );
    map.addLayer(
      {
        id: LAYER_ACCURACY_LINE,
        type: 'line',
        source: SRC_ACCURACY,
        paint: { 'line-color': '#38bdf8', 'line-width': 1, 'line-opacity': 0.6 },
      },
      beforeLayerId,
    );
  }

  protected layerIds(): string[] {
    return [LAYER_ACCURACY_LINE, LAYER_ACCURACY_FILL];
  }

  protected sourceIds(): string[] {
    return [SRC_ACCURACY];
  }

  protected override releaseExtras(): void {
    this.marker?.remove();
    this.marker = null;
  }

  setFix(fix: Fix | null): void {
    if (!fix) {
      (this.map.getSource(SRC_ACCURACY) as GeoJSONSource | undefined)?.setData(EMPTY);
      this.releaseExtras();
      return;
    }

    // Built in kilometres by turf on the real ellipsoid, so the circle stays the
    // right size on the ground at any zoom rather than being a fixed pixel blob.
    const circle = turf.circle([fix.lng, fix.lat], Math.max(fix.accuracyM, 1) / 1000, {
      steps: 64,
      units: 'kilometers',
    });
    (this.map.getSource(SRC_ACCURACY) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: [circle],
    });

    if (!this.marker) {
      const el = document.createElement('div');
      el.className = 'here-dot';
      this.marker = new maplibregl.Marker({ element: el });
    }
    this.marker.setLngLat([fix.lng, fix.lat]).addTo(this.map);
  }
}
