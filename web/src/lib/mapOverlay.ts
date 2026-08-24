import type { Map as MapLibreMap, MapLayerMouseEvent, MapMouseEvent } from 'maplibre-gl';

/**
 * Shared plumbing for anything that adds sources, layers and listeners to the
 * map. Both the draw tool and the saved-plots layer need the same three things
 * and got them wrong in the same two ways, so they live here once:
 *
 *  - every listener is registered with a matching unsubscribe
 *  - layers and sources are named once and torn down in the right order
 *  - teardown is skipped after `map.remove()`, because React unmounts the map
 *    before these objects are disposed and every style getter throws by then
 */
export abstract class MapOverlay {
  protected readonly map: MapLibreMap;
  private readonly unsubscribes: Array<() => void> = [];
  private mapRemoved = false;

  constructor(map: MapLibreMap) {
    this.map = map;
    this.onMap('remove', () => (this.mapRemoved = true));
  }

  /** Layers this overlay owns, listed top-most first. */
  protected abstract layerIds(): string[];
  /** Sources this overlay owns. Removed after the layers that use them. */
  protected abstract sourceIds(): string[];
  /** Anything else to release - markers, DOM nodes. Runs before layer removal. */
  protected releaseExtras(): void {}

  destroy(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    this.releaseExtras();

    if (this.mapRemoved) return;
    for (const id of this.layerIds()) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    for (const id of this.sourceIds()) {
      if (this.map.getSource(id)) this.map.removeSource(id);
    }
  }

  /*
   * MapLibre's `on` overloads separate map-wide from layer-scoped listeners and
   * the two signatures do not unify, hence the narrow structural casts.
   */

  protected onMap(event: string, handler: (e: MapMouseEvent) => void): void {
    const map = this.map as unknown as {
      on(t: string, h: (e: MapMouseEvent) => void): void;
      off(t: string, h: (e: MapMouseEvent) => void): void;
    };
    map.on(event, handler);
    this.unsubscribes.push(() => map.off(event, handler));
  }

  /** Layer-scoped events also carry the `features` that were hit. */
  protected onLayer(event: string, layer: string, handler: (e: MapLayerMouseEvent) => void): void {
    const map = this.map as unknown as {
      on(t: string, l: string, h: (e: MapLayerMouseEvent) => void): void;
      off(t: string, l: string, h: (e: MapLayerMouseEvent) => void): void;
    };
    map.on(event, layer, handler);
    this.unsubscribes.push(() => map.off(event, layer, handler));
  }

  /** For DOM events MapLibre either does not expose or filters on the way out. */
  protected onDom<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ): void {
    target.addEventListener(type, handler);
    this.unsubscribes.push(() => target.removeEventListener(type, handler));
  }
}
