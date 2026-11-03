/**
 * Marking a boundary by walking it: the phone's GPS gives each corner.
 *
 * A plot traced on satellite imagery is only as good as the imagery's
 * registration and the eye of whoever clicked; walking the fence line with a
 * phone puts the corners where the ground actually is. Two ways to mark:
 *
 *  - **Mark point here**, standing still at a corner: the last few seconds of
 *    fixes are averaged, weighted by their own accuracy, which takes the
 *    second-to-second wander out of a single reading.
 *  - **Auto-mark** while walking: a point each time the agent has moved a set
 *    spacing from the last one, so a curved edge gets enough points to follow
 *    it. The spacing is never less than the fix's own accuracy - points closer
 *    than the error between them are noise, not shape.
 *
 * Fixes worse than [WALK_MAX_ACCURACY_M] are never used: a boundary off by
 * tens of metres is worse than no boundary.
 */

export interface GpsSample {
  lng: number;
  lat: number;
  accuracyM: number;
  atMs: number;
}

export interface WalkFix {
  lng: number;
  lat: number;
  /** Accuracy of the fix, or the mean accuracy of the fixes averaged. */
  accuracyM: number;
  /** How many fixes went into it. */
  count: number;
}

/** No fix claiming worse than this marks a point. */
export const WALK_MAX_ACCURACY_M = 15;

/** Mark point here averages the fixes from this long before the press. */
export const WALK_AVERAGE_WINDOW_MS = 4000;

/** Default and limits of the auto-mark spacing, metres. */
export const WALK_DEFAULT_SPACING_M = 5;
export const WALK_MIN_SPACING_M = 2;
export const WALK_MAX_SPACING_M = 50;

/** Samples older than this are dropped from the buffer. */
export const WALK_BUFFER_MS = 10_000;

const METRES_PER_DEG_LAT = 111_320;

function metresPerDegLng(lat: number): number {
  return METRES_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Flat-earth distance in metres: exact enough across a plot. */
export function walkDistanceM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const east = (b.lng - a.lng) * metresPerDegLng((a.lat + b.lat) / 2);
  const north = (b.lat - a.lat) * METRES_PER_DEG_LAT;
  return Math.hypot(east, north);
}

/**
 * The accuracy-weighted mean of the good fixes taken in the [windowMs] before
 * [nowMs], or null when there is none good enough.
 */
export function averagedFix(
  samples: readonly GpsSample[],
  nowMs: number,
  windowMs = WALK_AVERAGE_WINDOW_MS,
  maxAccuracyM = WALK_MAX_ACCURACY_M,
): WalkFix | null {
  const used = samples.filter(
    (s) => nowMs - s.atMs <= windowMs && s.atMs <= nowMs && Number.isFinite(s.accuracyM) && s.accuracyM <= maxAccuracyM,
  );
  if (used.length === 0) return null;
  let wSum = 0;
  let lng = 0;
  let lat = 0;
  let acc = 0;
  for (const s of used) {
    // A fix's accuracy is never taken as sharper than 1 m: a receiver that
    // claims 0.1 m must not outvote every other reading.
    const sigma = Math.max(s.accuracyM, 1);
    const w = 1 / (sigma * sigma);
    wSum += w;
    lng += w * s.lng;
    lat += w * s.lat;
    acc += s.accuracyM;
  }
  return { lng: lng / wSum, lat: lat / wSum, accuracyM: acc / used.length, count: used.length };
}

/**
 * Whether auto-mark should put a point at [fix], [last] being the boundary's
 * most recent point. The gap must reach the spacing and the fix's accuracy,
 * whichever is larger, so standing still never sprinkles points.
 */
export function shouldAutoMark(last: { lng: number; lat: number } | null, fix: WalkFix, spacingM: number): boolean {
  if (fix.accuracyM > WALK_MAX_ACCURACY_M) return false;
  if (!last) return true;
  return walkDistanceM(last, fix) >= Math.max(spacingM, fix.accuracyM);
}

/** [samples] with [sample] added and everything older than the buffer dropped. */
export function pushSample(samples: readonly GpsSample[], sample: GpsSample): GpsSample[] {
  return [...samples.filter((s) => sample.atMs - s.atMs <= WALK_BUFFER_MS), sample];
}
