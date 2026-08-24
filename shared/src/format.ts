import { sqMToAcres, sqMToHectares } from './geo.js';

/** One place to decide how numbers look, so the map and the list page agree. */

export function formatHectares(areaSqM: number, digits = 2): string {
  return `${sqMToHectares(areaSqM).toFixed(digits)} ha`;
}

export function formatAcres(areaSqM: number, digits = 2): string {
  return `${sqMToAcres(areaSqM).toFixed(digits)} ac`;
}

/** e.g. `1.24 ha / 3.06 ac` */
export function formatArea(areaSqM: number): string {
  return `${formatHectares(areaSqM)} / ${formatAcres(areaSqM)}`;
}

/** Metres under a kilometre, kilometres above it. */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return '-';
  return metres < 1000 ? `${metres.toFixed(0)} m` : `${(metres / 1000).toFixed(2)} km`;
}

export function formatLatLng(lat: number, lng: number, digits = 6): string {
  return `${lat.toFixed(digits)}, ${lng.toFixed(digits)}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}
