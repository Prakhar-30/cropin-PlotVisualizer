import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM } from '@plot/shared';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useState, type RefObject } from 'react';
import { satelliteStyle } from './mapStyle.js';

/**
 * Creates one MapLibre instance for a container and hands it back once the
 * style has loaded - callers may add sources immediately, without guarding.
 */
export function useMapLibre(container: RefObject<HTMLDivElement | null>): MapLibreMap | null {
  const [map, setMap] = useState<MapLibreMap | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const instance = new maplibregl.Map({
      container: container.current,
      style: satelliteStyle,
      center: DEFAULT_MAP_CENTER,
      zoom: DEFAULT_MAP_ZOOM,
      attributionControl: { compact: true },
    });
    instance.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
    instance.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    // `style.load` fires as soon as the style is parsed. `load` additionally
    // waits for the first tiles, so a slow or failing basemap would leave the
    // draw tool permanently uninstalled - the one thing that must never depend
    // on Esri being reachable.
    instance.on('style.load', () => setMap(instance));

    // Dev-only handle: lets you drive the map from the console while picking
    // coordinates or reproducing a draw bug. Never present in a production build.
    if (import.meta.env.DEV) {
      (window as unknown as { __map?: MapLibreMap }).__map = instance;
    }

    return () => {
      setMap(null);
      instance.remove();
    };
  }, [container]);

  return map;
}
