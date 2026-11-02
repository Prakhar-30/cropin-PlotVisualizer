/**
 * WGS84 latitude/longitude to UTM easting/northing, for one known zone.
 *
 * Sentinel-2 images are delivered in the UTM zone of their tile (EPSG:326xx
 * north, 327xx south), and a pixel is found by its easting and northing. This
 * is the standard transverse Mercator series (Snyder, *Map Projections - A
 * Working Manual*, USGS PP 1395, pp. 61-64): accurate to well under a
 * millimetre within a zone, far finer than the 10 m pixels it is used to find.
 * Written out rather than pulled in as a dependency, because it is thirty
 * lines and this is the only projection the service needs.
 */

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;

export interface UtmZone {
  zone: number;
  south: boolean;
}

/** The zone of an EPSG code such as 32643 (43 N) or 32737 (37 S), or null. */
export function zoneFromEpsg(epsg: number): UtmZone | null {
  if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, south: false };
  if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, south: true };
  return null;
}

/** Distance along the meridian from the equator to latitude [phi], metres. */
export function meridianArc(phi: number): number {
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  return (
    A *
    ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi))
  );
}

/** [easting, northing] in metres of (lat, lng) in [zone]. */
export function toUtm(lat: number, lng: number, { zone, south }: UtmZone): [number, number] {
  const phi = (lat * Math.PI) / 180;
  const lambda0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const lambda = (lng * Math.PI) / 180;

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const n = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  const t = tanPhi * tanPhi;
  const c = EP2 * cosPhi * cosPhi;
  const a = cosPhi * (lambda - lambda0);

  const easting =
    K0 *
      n *
      (a + ((1 - t + c) * a ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5) / 120) +
    500000;
  const northing =
    K0 *
      (meridianArc(phi) +
        n *
          tanPhi *
          ((a * a) / 2 +
            ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 +
            ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6) / 720)) +
    (south ? 10000000 : 0);
  return [easting, northing];
}
