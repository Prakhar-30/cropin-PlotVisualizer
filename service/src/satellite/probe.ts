/**
 * Reads real Sentinel-2 for a small square and prints what it found: the scene,
 * how clear it was, and the spread of each index. For checking the pipeline end
 * to end where the network allows it - CI runs it on every push.
 *
 *   npm run probe -w @plot/api -- 12.7862 76.7201
 */
import { buildHealthSnapshot, pointInPolygon, type Polygon } from '@plot/shared';
import { sentinelSamplers } from './sentinel.js';

const lat = Number(process.argv[2] ?? 12.7862);
const lng = Number(process.argv[3] ?? 76.7201);
const half = 0.0003; // about 65 m across
const polygon: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [lng - half, lat - half],
      [lng + half, lat - half],
      [lng + half, lat + half],
      [lng - half, lat + half],
      [lng - half, lat - half],
    ],
  ],
};

const started = Date.now();
const { samplers, scene } = await sentinelSamplers(polygon, (a, b) => pointInPolygon(a, b, polygon));
const snapshot = buildHealthSnapshot({ plotId: 'PROBE', polygon, samplers, capturedOn: scene.date, source: 'sentinel-2-l2a' });
console.log(`scene ${scene.id} (${scene.date}), ${Math.round(scene.clearShare * 100)}% of the square clear`);
console.log(`${snapshot.cells.length} cells in ${Date.now() - started} ms`);
for (const index of snapshot.indices) {
  console.log(
    `${index.key.padEnd(5)} min ${index.min.toFixed(3)}  mean ${index.mean.toFixed(3)}  max ${index.max.toFixed(3)}  ` +
      `zones normal/moderate/critical ${index.zone_counts.join('/')}`,
  );
}
if (snapshot.cells.length === 0) process.exit(1);
