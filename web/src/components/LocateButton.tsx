import { useCallback, useEffect, useRef, useState } from 'react';
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
  | { kind: 'locating'; bestM: number | null }
  | { kind: 'located'; accuracyM: number }
  | { kind: 'error'; message: string };

/**
 * Stop refining once the fix is at least this good.
 *
 * A GNSS receiver's first fix is its worst. It reports as soon as it has a
 * solution at all, then tightens over the next several seconds as more
 * satellites lock and the ephemeris fills in - 60 m improving to 8 m is a
 * completely ordinary sequence on a phone. `getCurrentPosition` returns that
 * first, worst answer and stops, so watching and keeping the best is worth
 * roughly an order of magnitude on hardware that actually has GNSS.
 */
const GOOD_ENOUGH_M = 10;

/** Give up refining after this long and keep whatever was best. */
const REFINE_TIMEOUT_MS = 20_000;

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
  const watchId = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bestM = useRef<number>(Number.POSITIVE_INFINITY);

  const stop = useCallback(() => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // A watch left running after the page moves on keeps the receiver awake and
  // drains the battery of the very phone this is meant to help.
  useEffect(() => stop, [stop]);

  /** Accept the current best rather than waiting out the refine window. */
  const settleNow = () => {
    stop();
    setState((current) =>
      current.kind === 'locating' && current.bestM !== null
        ? { kind: 'located', accuracyM: current.bestM }
        : current,
    );
  };

  const locate = () => {
    if (!('geolocation' in navigator)) {
      setState({ kind: 'error', message: 'This browser has no geolocation' });
      return;
    }
    stop();
    bestM.current = Number.POSITIVE_INFINITY;
    setState({ kind: 'locating', bestM: null });

    const settle = () => {
      stop();
      setState((current) =>
        current.kind === 'locating' && current.bestM !== null
          ? { kind: 'located', accuracyM: current.bestM }
          : current,
      );
    };

    timer.current = setTimeout(settle, REFINE_TIMEOUT_MS);

    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        const accuracyM = position.coords.accuracy;
        // Only accept a fix that beats the best so far. Readings wander both
        // ways, and letting the overlay jump to a worse one looks like drift.
        if (accuracyM >= bestM.current) return;
        bestM.current = accuracyM;

        onLocated({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyM,
        });

        if (accuracyM <= GOOD_ENOUGH_M) {
          stop();
          setState({ kind: 'located', accuracyM });
        } else {
          setState({ kind: 'locating', bestM: accuracyM });
        }
      },
      (error) => {
        stop();
        setState({ kind: 'error', message: describe(error) });
      },
      // A cached position would defeat the purpose; the whole point is to find
      // out where this machine is now.
      { enableHighAccuracy: true, timeout: REFINE_TIMEOUT_MS, maximumAge: 0 },
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
        {state.kind === 'locating' ? 'Refining…' : 'Use my location'}
      </button>

      {state.kind === 'locating' && state.bestM !== null && (
        <p className="locate__note">
          Best so far ±{Math.round(state.bestM)} m — still improving.{' '}
          <button type="button" className="locate__inline" onClick={settleNow}>
            Use this
          </button>
        </p>
      )}

      {state.kind === 'located' && (
        <p className="locate__note">
          Centred on your position, accurate to about {Math.round(state.accuracyM)} m.
          {state.accuracyM > 50 && (
            <>
              {' '}
              This device has no GPS — that figure is Wi-Fi triangulation. Open
              this page <strong>on your phone</strong> for a fix of 5–15 m.
            </>
          )}
        </p>
      )}

      {state.kind === 'error' && <p className="locate__error">{state.message}</p>}
    </div>
  );
}
