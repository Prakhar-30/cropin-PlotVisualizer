import {
  ESRI_WORLD_IMAGERY_ATTRIBUTION,
  ESRI_WORLD_IMAGERY_TILE_URL,
  MAX_IMAGERY_ZOOM,
} from '@plot/shared';
import type { StyleSpecification } from 'maplibre-gl';

/** A bare raster style: Esri World Imagery and nothing else. */
export const satelliteStyle: StyleSpecification = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: [ESRI_WORLD_IMAGERY_TILE_URL],
      tileSize: 256,
      maxzoom: MAX_IMAGERY_ZOOM,
      attribution: ESRI_WORLD_IMAGERY_ATTRIBUTION,
    },
  },
  layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
};
