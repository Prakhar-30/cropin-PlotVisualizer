/** Place-name search, so the surveyor can jump to a village instead of panning. */

export interface PlaceHit {
  label: string;
  lat: number;
  lng: number;
  /** `[west, south, east, north]`, when the provider supplies one. */
  bbox?: [number, number, number, number];
}

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string];
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceHit[]> {
  const q = query.trim();
  if (!q) return [];

  const url = `${NOMINATIM}?format=json&limit=6&countrycodes=in&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`place search failed (${res.status})`);

  const results = (await res.json()) as NominatimResult[];
  return results.map((r) => {
    const hit: PlaceHit = { label: r.display_name, lat: Number(r.lat), lng: Number(r.lon) };
    if (r.boundingbox) {
      const [south, north, west, east] = r.boundingbox.map(Number);
      hit.bbox = [west, south, east, north];
    }
    return hit;
  });
}
