import { useState } from 'react';
import type { Fix } from '../lib/currentLocationLayer.js';

/**
 * "Take me to where I am."
 *
 * Exists because a plot drawn on the map's default view lands wherever that
 * view happens to be - which is how a boundary ended up 97 km from the person
 * who drew it, invisible to a phone that only caches what is within 5 km.
 *
 * The reported accuracy is shown rather than hidden. Browser geolocation on a
 * laptop is Wi-Fi triangulation, routinely off by a kilometre or more, and a
 * silent recentre would look just as confident as a GPS fix.
 */

export interface LocateButtonProps {
  onLocated: (fix: Fix) => void;
}

type State =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'located'; accuracyM: number }
  | { kind: 'error'; message: string };

/** Browser geolocation errors are numeric codes; these are the three that occur. */
function describe(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'Location permission denied — allow it in the address bar, then try again';
    case error.POSITION_UNAVAILABLE:
      return 'No position available right now';
    case error.TIMEOUT:
      return 'Timed out looking for a position';
    default:
      return error.message || 'Could not get a position';
  }
}

export function LocateButton({ onLocated }: LocateButtonProps) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const locate = () => {
    if (!('geolocation' in navigator)) {
      setState({ kind: 'error', message: 'This browser has no geolocation' });
      return;
    }
    setState({ kind: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const fix: Fix = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyM: position.coords.accuracy,
        };
        setState({ kind: 'located', accuracyM: fix.accuracyM });
        onLocated(fix);
      },
      (error) => setState({ kind: 'error', message: describe(error) }),
      // A cached position would defeat the purpose; the whole point is to find
      // out where this machine is now.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  };

  return (
    <div className="locate">
      <button
        type="button"
        className="locate__button"
        onClick={locate}
        disabled={state.kind === 'locating'}
      >
        {state.kind === 'locating' ? 'Locating…' : 'Use my location'}
      </button>

      {state.kind === 'located' && (
        <p className="locate__note">
          Centred on your position, accurate to about {Math.round(state.accuracyM)} m.
          {state.accuracyM > 500 &&
            ' That is a rough fix — check the imagery before drawing.'}
        </p>
      )}

      {state.kind === 'error' && <p className="locate__error">{state.message}</p>}
    </div>
  );
}
