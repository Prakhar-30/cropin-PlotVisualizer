import {
  averagedFix,
  pushSample,
  shouldAutoMark,
  WALK_DEFAULT_SPACING_M,
  WALK_MAX_ACCURACY_M,
  type GpsSample,
  type Position,
} from '@plot/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Fix } from './currentLocationLayer.js';

/**
 * Walk the boundary with the phone: watches GPS, marks a corner on request
 * (averaged over the last few seconds) or automatically every so many metres.
 * The pure parts - averaging, spacing - are in `@plot/shared`'s gpsWalk.
 */

export interface GpsWalkState {
  active: boolean;
  /** The newest fix, shown with its accuracy. */
  latest: GpsSample | null;
  auto: boolean;
  spacingM: number;
  /** Points this walk has marked. */
  marked: number;
  error: string | null;
}

export const idleWalk: GpsWalkState = {
  active: false,
  latest: null,
  auto: false,
  spacingM: WALK_DEFAULT_SPACING_M,
  marked: 0,
  error: null,
};

export interface GpsWalkHandlers {
  /** Adds a corner; false when the shape would not take it. */
  mark: (position: Position) => boolean;
  /** The shape's last corner, for the auto-mark spacing. */
  lastVertex: () => Position | null;
  /** Each fix, to show where the agent is. */
  onFix: (fix: Fix, first: boolean) => void;
}

function describe(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'Location permission denied - allow it in the browser, then try again';
    case error.POSITION_UNAVAILABLE:
      return 'No GPS position right now - step into the open sky';
    case error.TIMEOUT:
      return 'Still waiting for GPS…';
    default:
      return error.message || 'Could not get a position';
  }
}

export function useGpsWalk(handlers: GpsWalkHandlers) {
  const [state, setState] = useState<GpsWalkState>(idleWalk);
  const samples = useRef<GpsSample[]>([]);
  const watchId = useRef<number | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const stateRef = useRef(state);
  stateRef.current = state;

  const stop = useCallback(() => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    setState((s) => ({ ...s, active: false }));
  }, []);

  // A watch left running keeps the receiver awake and drains the battery.
  useEffect(
    () => () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    },
    [],
  );

  const start = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setState((s) => ({ ...s, error: 'This browser has no geolocation' }));
      return;
    }
    if (watchId.current !== null) return;
    samples.current = [];
    setState((s) => ({ ...s, active: true, latest: null, marked: 0, error: null }));
    let first = true;
    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        const sample: GpsSample = {
          lng: position.coords.longitude,
          lat: position.coords.latitude,
          accuracyM: position.coords.accuracy,
          atMs: Date.now(),
        };
        samples.current = pushSample(samples.current, sample);
        handlersRef.current.onFix({ lng: sample.lng, lat: sample.lat, accuracyM: sample.accuracyM }, first);
        first = false;

        let marked = 0;
        const current = stateRef.current;
        if (current.auto) {
          // While walking, the newest fix alone: an average would lag behind
          // the agent by a couple of metres.
          const fix = { lng: sample.lng, lat: sample.lat, accuracyM: sample.accuracyM, count: 1 };
          const last = handlersRef.current.lastVertex();
          const lastPoint = last ? { lng: last[0]!, lat: last[1]! } : null;
          if (shouldAutoMark(lastPoint, fix, current.spacingM) && handlersRef.current.mark([fix.lng, fix.lat])) {
            marked = 1;
          }
        }
        setState((s) => ({ ...s, latest: sample, marked: s.marked + marked, error: null }));
      },
      (error) => setState((s) => ({ ...s, error: describe(error) })),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  }, []);

  /** Marks a corner where the agent stands: the last few seconds, averaged. */
  const markHere = useCallback(() => {
    const fix = averagedFix(samples.current, Date.now());
    if (!fix) {
      const latest = stateRef.current.latest;
      setState((s) => ({
        ...s,
        error: latest
          ? `GPS is ±${Math.round(latest.accuracyM)} m - a corner needs ${WALK_MAX_ACCURACY_M} m or better. Wait in the open.`
          : 'No GPS fix yet',
      }));
      return;
    }
    if (handlersRef.current.mark([fix.lng, fix.lat])) {
      setState((s) => ({ ...s, marked: s.marked + 1, error: null }));
    } else {
      setState((s) => ({ ...s, error: 'Same spot as the last corner, or the shape is closed' }));
    }
  }, []);

  const setAuto = useCallback((auto: boolean) => setState((s) => ({ ...s, auto })), []);
  const setSpacing = useCallback((spacingM: number) => setState((s) => ({ ...s, spacingM })), []);

  return { walk: state, start, stop, markHere, setAuto, setSpacing };
}
