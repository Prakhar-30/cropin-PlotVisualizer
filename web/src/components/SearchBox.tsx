import { useEffect, useRef, useState } from 'react';
import { searchPlaces, type PlaceHit } from '../lib/geocode.js';

interface Props {
  onPick: (hit: PlaceHit) => void;
}

/** Debounced place-name search over the map. */
export function SearchBox({ onPick }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (query.trim().length < 3) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true);
      setError(null);
      searchPlaces(query, controller.signal)
        .then(setHits)
        .catch((err: Error) => {
          if (err.name !== 'AbortError') setError(err.message);
        })
        .finally(() => setBusy(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="search-box">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Jump to a place — village, town, district"
        aria-label="Search for a place"
      />
      {busy && <span className="search-status">…</span>}
      {error && <div className="search-results error">{error}</div>}
      {hits.length > 0 && (
        <ul className="search-results">
          {hits.map((hit) => (
            <li key={`${hit.lat},${hit.lng}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(hit);
                  setHits([]);
                  setQuery('');
                }}
              >
                {hit.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
