/**
 * End-to-end API tests. Runs the real Express app against an in-memory SQLite
 * database, so it exercises the same validation and SQL the service ships with.
 *
 *   npm run test -w @plot/api
 */
process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import {
  MAX_PLOT_AREA_HA,
  PLOT_COLOURS,
  PLOT_ID_PATTERN,
  sqMToHectares,
  type HealthCell,
  type HealthHotspot,
  type Plot,
  type PlotWithDistance,
  type Position,
} from '@plot/shared';

const { buildApp } = await import('../app.js');

const server = buildApp().listen(0);
let base = '';

before(() => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** Axis-aligned closed square of `sizeDeg` centred on (lng, lat). */
function square(lng: number, lat: number, sizeDeg: number): Position[] {
  const h = sizeDeg / 2;
  return [
    [lng - h, lat - h],
    [lng + h, lat - h],
    [lng + h, lat + h],
    [lng - h, lat + h],
    [lng - h, lat - h],
  ];
}

function body(ring: Position[], extra: Record<string, unknown> = {}) {
  return {
    name: 'Test plot',
    polygon: { type: 'Polygon', coordinates: [ring] },
    access_lat: 12.818,
    access_lng: 76.755,
    landmark_note: 'gate by the culvert',
    ...extra,
  };
}

async function post(payload: unknown) {
  const res = await fetch(`${base}/api/plots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json() };
}

test('health reports which store is live', async () => {
  const { status, json } = await get('/api/health');
  assert.equal(status, 200);
  const body = json as { ok: boolean; store: string };
  assert.equal(body.ok, true);
  // Naming the driver is the point: a deployment that quietly fell back to the
  // file-backed store would otherwise look healthy right up until it lost data.
  assert.match(body.store, /^sqlite \(/, `tests must run on sqlite, got ${body.store}`);
});

test('creates a plot and recomputes area server-side', async () => {
  // A 0.002 deg square at 12.818N is roughly 217 x 221 m, about 4.8 ha.
  const { status, json } = await post(
    body(square(76.755, 12.818, 0.002), { area_sq_m: 999999, id: 'PLT-0001', centroid_lat: 0 }),
  );
  assert.equal(status, 201);
  const plot = json as unknown as Plot;

  assert.match(plot.id, PLOT_ID_PATTERN, 'id is short and human-readable');
  assert.notEqual(plot.id, 'PLT-0001', 'client-supplied id is ignored');
  assert.ok(Math.abs(sqMToHectares(plot.area_sq_m) - 4.8) < 0.2, `area was ${plot.area_sq_m}`);
  assert.ok(Math.abs(plot.centroid_lat - 12.818) < 1e-6, 'centroid recomputed, not taken from body');
  assert.ok(Math.abs(plot.centroid_lng - 76.755) < 1e-6);
  assert.equal(plot.access_lat, 12.818);
  assert.equal(plot.landmark_note, 'gate by the culvert');
  assert.ok(Date.parse(plot.created_at) > 0);
  assert.equal(plot.polygon.coordinates[0].length, 5, 'ring stored closed');
});

test('rejects an unclosed ring', async () => {
  const open = square(76.755, 12.818, 0.002).slice(0, -1);
  const { status, json } = await post(body(open));
  assert.equal(status, 400);
  assert.ok(
    (json.details as string[]).some((d) => d.includes('not closed')),
    JSON.stringify(json),
  );
});

test('rejects fewer than three distinct vertices', async () => {
  const { status, json } = await post(
    body([
      [76.755, 12.818],
      [76.756, 12.818],
      [76.755, 12.818],
    ]),
  );
  assert.equal(status, 400);
  assert.ok(
    (json.details as string[]).some((d) => d.includes('distinct vertices')),
    JSON.stringify(json),
  );
});

test('rejects a self-intersecting bowtie', async () => {
  const { status, json } = await post(
    body([
      [76.755, 12.818],
      [76.757, 12.82],
      [76.757, 12.818],
      [76.755, 12.82],
      [76.755, 12.818],
    ]),
  );
  assert.equal(status, 400);
  assert.ok(
    (json.details as string[]).some((d) => d.includes('self-intersecting')),
    JSON.stringify(json),
  );
});

test(`rejects anything larger than ${MAX_PLOT_AREA_HA} ha`, async () => {
  const { status, json } = await post(body(square(76.755, 12.818, 0.05))); // ~3000 ha
  assert.equal(status, 400);
  assert.ok(
    (json.details as string[]).some((d) => d.includes('mis-draw')),
    JSON.stringify(json),
  );
});

test('rejects collinear vertices that enclose no area', async () => {
  const { status, json } = await post(
    body([
      [76.755, 12.818],
      [76.756, 12.818],
      [76.757, 12.818],
      [76.755, 12.818],
    ]),
  );
  assert.equal(status, 400);
  assert.ok(
    (json.details as string[]).some((d) => d.includes('no area')),
    JSON.stringify(json),
  );
});

test('requires the access point', async () => {
  const payload = body(square(76.755, 12.818, 0.002)) as Record<string, unknown>;
  delete payload.access_lat;
  delete payload.access_lng;
  const { status, json } = await post(payload);
  assert.equal(status, 400);
  const details = json.details as string[];
  assert.ok(details.some((d) => d.includes('access_lat')));
  assert.ok(details.some((d) => d.includes('access_lng')));
});

test('requires a name and rejects holes and non-polygons', async () => {
  assert.equal((await post(body(square(76.755, 12.818, 0.002), { name: '   ' }))).status, 400);

  const withHole = {
    ...body(square(76.755, 12.818, 0.002)),
    polygon: {
      type: 'Polygon',
      coordinates: [square(76.755, 12.818, 0.002), square(76.755, 12.818, 0.0005)],
    },
  };
  const hole = await post(withHole);
  assert.equal(hole.status, 400);
  assert.ok((hole.json.details as string[]).some((d) => d.includes('holes are not supported')));

  const line = await post({
    ...body(square(76.755, 12.818, 0.002)),
    polygon: { type: 'LineString', coordinates: [[76.755, 12.818]] },
  });
  assert.equal(line.status, 400);
});

test('near filter returns only centroids inside the radius, nearest first', async () => {
  // Three plots spaced 0.01 deg (about 1.1 km) apart along a line of latitude.
  const created: Plot[] = [];
  for (const dLng of [0, 0.01, 0.02]) {
    const { status, json } = await post(
      body(square(77.1 + dLng, 13.0, 0.001), { name: `near-${dLng}` }),
    );
    assert.equal(status, 201);
    created.push(json as unknown as Plot);
  }

  const tight = (await get('/api/plots?near=13.0,77.1&radius_m=500')).json as Plot[];
  assert.equal(tight.length, 1);
  assert.equal(tight[0].id, created[0].id);

  const wide = (await get('/api/plots?near=13.0,77.1&radius_m=3000')).json as PlotWithDistance[];
  assert.equal(wide.length, 3);
  assert.deepEqual(
    wide.map((p) => p.id),
    created.map((p) => p.id),
    'sorted nearest first',
  );
  assert.ok(wide[0].distance_m < 1, 'first is essentially on the query point');
  assert.ok(wide[1].distance_m > 1000 && wide[1].distance_m < 1200, `got ${wide[1].distance_m}`);

  // A tight radius around a point no centroid is near returns nothing.
  const none = (await get('/api/plots?near=13.05,77.1&radius_m=25')).json as Plot[];
  assert.equal(none.length, 0);
});

test('near filter rejects malformed queries', async () => {
  assert.equal((await get('/api/plots?near=notanumber')).status, 400);
  assert.equal((await get('/api/plots?near=13.0')).status, 400);
  assert.equal((await get('/api/plots?near=99,77')).status, 400);
  assert.equal((await get('/api/plots?near=13,77&radius_m=-5')).status, 400);
});

test('get by id, geojson, and 404s', async () => {
  const { json } = await post(body(square(75.5, 15.5, 0.0015), { name: 'Geo plot' }));
  const plot = json as unknown as Plot;

  const fetched = (await get(`/api/plots/${plot.id}`)).json as Plot;
  assert.equal(fetched.id, plot.id);
  assert.equal(fetched.name, 'Geo plot');

  const feature = (await get(`/api/plots/${plot.id}/geojson`)).json as {
    type: string;
    geometry: { type: string };
    properties: Record<string, unknown>;
  };
  assert.equal(feature.type, 'Feature');
  assert.equal(feature.geometry.type, 'Polygon');
  assert.equal(feature.properties.id, plot.id);
  assert.ok(typeof feature.properties.area_ha === 'number');

  assert.equal((await get('/api/plots/PLT-9999')).status, 404);
  assert.equal((await get('/api/plots/PLT-9999/geojson')).status, 404);
});

test('list returns every plot created so far', async () => {
  const all = (await get('/api/plots')).json as Plot[];
  assert.ok(all.length >= 5);
  assert.ok(all.every((p) => PLOT_ID_PATTERN.test(p.id)));
});

/* ------------------------------------------------------- boundary colours */

test('neighbouring plots are given different colours', async () => {
  // Six plots in a row, 300 m apart, all inside each other's 500 m
  // neighbourhood at least in part. No plot may match its immediate neighbour,
  // which is the property the AR view and the map both depend on.
  const created: number[] = [];
  for (let i = 0; i < 6; i++) {
    const lat = 13.4 + i * 0.0027; // ~300 m steps
    const { status, json } = await post(body(square(77.1, lat, 0.0008)));
    assert.equal(status, 201);
    created.push((json as unknown as Plot).colour_index);
  }

  for (const slot of created) {
    assert.ok(slot >= 0 && slot < PLOT_COLOURS.length, `colour ${slot} out of range`);
  }
  for (let i = 1; i < created.length; i++) {
    assert.notEqual(created[i], created[i - 1], `plot ${i} matched its neighbour`);
  }
});

/* ------------------------------------------------------------ plot health */

test('health raster covers the plot and every hotspot lies inside it', async () => {
  const ring = square(78.2, 14.1, 0.004);
  const { json: created } = await post(body(ring));
  const plot = created as unknown as Plot;

  const { status, json } = await get(`/api/plots/${plot.id}/health`);
  assert.equal(status, 200);

  const snapshot = json as {
    cells: HealthCell[];
    hotspots: HealthHotspot[];
    synthetic: boolean;
    cell_size_m: number;
    value_mean: number;
  };

  assert.equal(snapshot.synthetic, true, 'synthetic imagery must be declared as such');
  assert.ok(snapshot.cells.length > 50, `expected a populated grid, got ${snapshot.cells.length}`);
  assert.ok(snapshot.value_mean > 0 && snapshot.value_mean < 1, 'NDVI mean should be in 0..1');

  // The bounding box of the ring. Every cell centroid and every hotspot must
  // fall within it - a hotspot outside the plot is a walk to someone else's
  // field, which is the one outcome this feature cannot have.
  const lngs = ring.map((p) => p[0] as number);
  const lats = ring.map((p) => p[1] as number);
  const [minLng, maxLng] = [Math.min(...lngs), Math.max(...lngs)];
  const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];

  for (const cell of snapshot.cells) {
    assert.ok(
      cell.centroid_lng >= minLng && cell.centroid_lng <= maxLng &&
        cell.centroid_lat >= minLat && cell.centroid_lat <= maxLat,
      'cell centroid outside the plot bounding box',
    );
  }
  for (const hotspot of snapshot.hotspots) {
    assert.ok(
      hotspot.centroid_lng >= minLng && hotspot.centroid_lng <= maxLng &&
        hotspot.centroid_lat >= minLat && hotspot.centroid_lat <= maxLat,
      `hotspot ${hotspot.rank} outside the plot`,
    );
    assert.ok(hotspot.cell_count >= 3, 'single-cell noise must not be reported');
    assert.ok(hotspot.severity >= 2, 'only stressed cells form hotspots');
  }

  // Ranked worst-first, so an agent's route is built off `rank` alone.
  const ranks = snapshot.hotspots.map((h) => h.rank);
  assert.deepEqual(ranks, ranks.map((_, i) => i + 1));
});

test('cell size scales down for a small plot so the grid stays useful', async () => {
  // The bug this covers: a fixed 10 m cell graded a 900 sq m plot as a 3x3
  // grid. Nine cells cannot show where inside a plot a problem is, and cannot
  // form a hotspot at all - a cluster needs three touching stressed cells, so
  // small plots silently reported themselves perfectly healthy.
  const small = (await post(body(square(78.1, 13.4, 0.0003)))).json as unknown as Plot;
  const large = (await post(body(square(78.2, 13.5, 0.006)))).json as unknown as Plot;

  const smallHealth = (await get(`/api/plots/${small.id}/health`)).json as {
    cell_size_m: number;
    cells: HealthCell[];
  };
  const largeHealth = (await get(`/api/plots/${large.id}/health`)).json as {
    cell_size_m: number;
    cells: HealthCell[];
  };

  assert.ok(
    smallHealth.cell_size_m < largeHealth.cell_size_m,
    `small plot should grade finer: ${smallHealth.cell_size_m} vs ${largeHealth.cell_size_m}`,
  );
  assert.equal(largeHealth.cell_size_m, 10, 'a large plot stays at the native imagery resolution');
  assert.ok(
    smallHealth.cells.length > 9,
    `expected a usable grid, got ${smallHealth.cells.length} cells`,
  );

  // Never finer than the imagery can support, however small the plot.
  assert.ok(smallHealth.cell_size_m >= 2, 'cell size must not go below the floor');

  // And an explicit request still wins - the default is a default, not a policy.
  const forced = (await get(`/api/plots/${large.id}/health?cell_size_m=25`)).json as {
    cell_size_m: number;
  };
  assert.equal(forced.cell_size_m, 25);
});

test('health raster is deterministic and rejects a silly cell size', async () => {
  const { json: created } = await post(body(square(79.3, 15.2, 0.003)));
  const plot = created as unknown as Plot;

  const first = await get(`/api/plots/${plot.id}/health`);
  const second = await get(`/api/plots/${plot.id}/health`);
  assert.deepEqual(first.json, second.json, 'the same plot must always grade the same');

  const tooFine = await get(`/api/plots/${plot.id}/health?cell_size_m=0.5`);
  assert.equal(tooFine.status, 400);

  const missing = await get('/api/plots/PLT-0000/health');
  assert.equal(missing.status, 404);
});
