/**
 * Walking a boundary with GPS: averaging a corner, and auto-mark spacing.
 *
 *   npm run test -w @plot/api
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  averagedFix,
  pushSample,
  shouldAutoMark,
  walkDistanceM,
  WALK_BUFFER_MS,
  type GpsSample,
} from '@plot/shared';

const origin = { lng: 76.7201, lat: 12.7862 };
const metresPerDegLng = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
const at = (eastM: number, northM: number) => ({
  lng: origin.lng + eastM / metresPerDegLng,
  lat: origin.lat + northM / 111_320,
});

test('walk: distance across a plot is metric', () => {
  assert.ok(Math.abs(walkDistanceM(origin, at(30, 40)) - 50) < 0.01);
});

test('walk: a corner averages the recent good fixes, weighted by accuracy', () => {
  const samples: GpsSample[] = [
    { ...at(2, 0), accuracyM: 4, atMs: 1000 },
    { ...at(-2, 0), accuracyM: 4, atMs: 2000 },
    { ...at(0, 2), accuracyM: 4, atMs: 3000 },
    { ...at(0, -2), accuracyM: 4, atMs: 4000 },
    // Too rough to count, however close it is.
    { ...at(40, 0), accuracyM: 40, atMs: 4500 },
  ];
  const fix = averagedFix(samples, 5000)!;
  assert.equal(fix.count, 4);
  assert.ok(walkDistanceM(fix, origin) < 0.01);

  // A sharper fix carries more weight.
  const weighted = averagedFix(
    [
      { ...at(0, 0), accuracyM: 2, atMs: 1000 },
      { ...at(10, 0), accuracyM: 10, atMs: 2000 },
    ],
    3000,
  )!;
  assert.ok(walkDistanceM(weighted, origin) < 1);
});

test('walk: no corner from stale or rough fixes', () => {
  assert.equal(averagedFix([{ ...origin, accuracyM: 4, atMs: 0 }], 10_000), null);
  assert.equal(averagedFix([{ ...origin, accuracyM: 59, atMs: 9000 }], 10_000), null);
  assert.equal(averagedFix([], 0), null);
});

test('walk: auto-mark waits for the spacing, and for the accuracy', () => {
  const fix = (east: number, accuracyM: number) => ({ ...at(east, 0), accuracyM, count: 1 });
  assert.equal(shouldAutoMark(null, fix(0, 4), 5), true);
  assert.equal(shouldAutoMark(origin, fix(3, 4), 5), false);
  assert.equal(shouldAutoMark(origin, fix(5.5, 4), 5), true);
  // Standing still with ±8 m fixes must not sprinkle points 6 m apart.
  assert.equal(shouldAutoMark(origin, fix(6, 8), 5), false);
  assert.equal(shouldAutoMark(origin, fix(9, 8), 5), true);
  // Too rough to mark at all.
  assert.equal(shouldAutoMark(null, fix(0, 30), 5), false);
});

test('walk: the buffer keeps only the last few seconds', () => {
  let samples: GpsSample[] = [];
  for (let t = 0; t <= 30_000; t += 1000) samples = pushSample(samples, { ...origin, accuracyM: 4, atMs: t });
  assert.ok(samples.every((s) => 30_000 - s.atMs <= WALK_BUFFER_MS));
  assert.equal(samples[samples.length - 1]!.atMs, 30_000);
});
