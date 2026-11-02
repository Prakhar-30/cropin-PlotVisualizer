/**
 * The satellite reader, without the network: a GeoTIFF built here in memory,
 * served through a fake range fetcher, and the UTM projection against fixed
 * geodesy.
 *
 *   npm run test -w @plot/api
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { Cog, lzwDecode, type RangeFetcher } from '../satellite/geotiff.js';
import { BandWindow, distanceToRingXY, insideRingXY } from '../satellite/sentinel.js';
import { meridianArc, toUtm, zoneFromEpsg } from '../satellite/utm.js';

/* ----------------------------------------------------------------- UTM */

test('UTM: the equator on the central meridian is (500000, 0)', () => {
  const [e, n] = toUtm(0, 75, { zone: 43, south: false });
  assert.ok(Math.abs(e - 500000) < 1e-6);
  assert.ok(Math.abs(n) < 1e-6);
});

test('UTM: the meridian arc to 45 degrees is the published WGS84 value', () => {
  // 4 984 944.378 m, the standard figure for the WGS84 ellipsoid.
  assert.ok(Math.abs(meridianArc(Math.PI / 4) - 4984944.378) < 0.01);
  const [, n] = toUtm(45, 75, { zone: 43, south: false });
  assert.ok(Math.abs(n - 0.9996 * 4984944.378) < 0.01);
});

test('UTM: east and west of the central meridian mirror each other', () => {
  const zone = { zone: 43, south: false };
  const [eEast, nEast] = toUtm(12.79, 76.5, zone);
  const [eWest, nWest] = toUtm(12.79, 73.5, zone);
  assert.ok(Math.abs(eEast - 500000 - (500000 - eWest)) < 1e-6);
  assert.ok(Math.abs(nEast - nWest) < 1e-6);
});

test('UTM: 100 m on the ground is 100 m on the grid, near a plot in Karnataka', () => {
  const zone = { zone: 43, south: false };
  // 100 m north, using the WGS84 meridian radius of curvature at this latitude.
  const e2 = 0.00669437999014;
  const phi = (12.7862 * Math.PI) / 180;
  const metresPerDeg = ((6378137 * (1 - e2)) / (1 - e2 * Math.sin(phi) ** 2) ** 1.5) * (Math.PI / 180);
  const [x1, y1] = toUtm(12.7862, 76.7201, zone);
  const [x2, y2] = toUtm(12.7862 + 100 / metresPerDeg, 76.7201, zone);
  const d = Math.hypot(x2 - x1, y2 - y1);
  // 187 km east of the central meridian the scale factor is
  // 0.9996 * (1 + x^2 / 2R^2) = 1.00003: 100 m on the ground is 100.003 m on the grid.
  assert.ok(Math.abs(d - 100.003) < 0.002, `got ${d}`);
});

test('UTM: zones from EPSG codes, north and south', () => {
  assert.deepEqual(zoneFromEpsg(32643), { zone: 43, south: false });
  assert.deepEqual(zoneFromEpsg(32737), { zone: 37, south: true });
  assert.equal(zoneFromEpsg(4326), null);
});

/* ------------------------------------------------------------- GeoTIFF */

/**
 * A little-endian classic TIFF: one band, uint16, tiled, Deflate with the
 * horizontal predictor, a GeoTIFF tie point and pixel size, and GDAL nodata 0
 * - the same layout as a Sentinel-2 COG, at toy size.
 */
function buildTiff(width: number, height: number, tile: number, value: (col: number, row: number) => number): Uint8Array {
  const across = Math.ceil(width / tile);
  const down = Math.ceil(height / tile);
  const tiles: Buffer[] = [];
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      const raw = new Uint16Array(tile * tile);
      for (let r = 0; r < tile; r++) {
        for (let c = 0; c < tile; c++) {
          const col = tx * tile + c;
          const row = ty * tile + r;
          raw[r * tile + c] = col < width && row < height ? value(col, row) : 0;
        }
      }
      // Predictor 2: store each sample as the difference from its left neighbour.
      const diff = new Uint16Array(raw.length);
      for (let r = 0; r < tile; r++) {
        for (let c = 0; c < tile; c++) {
          const i = r * tile + c;
          diff[i] = c === 0 ? raw[i]! : (raw[i]! - raw[i - 1]!) & 0xffff;
        }
      }
      tiles.push(zlib.deflateSync(Buffer.from(diff.buffer)));
    }
  }

  const entries: [number, number, number, number[] | string][] = [
    [256, 3, 1, [width]],
    [257, 3, 1, [height]],
    [258, 3, 1, [16]],
    [259, 3, 1, [8]],
    [277, 3, 1, [1]],
    [317, 3, 1, [2]],
    [322, 3, 1, [tile]],
    [323, 3, 1, [tile]],
    [324, 4, tiles.length, []], // filled below
    [325, 4, tiles.length, tiles.map((t) => t.length)],
    [339, 3, 1, [1]],
    [33550, 12, 3, [10, 10, 0]],
    [33922, 12, 6, [0, 0, 0, 600000, 1420000, 0]],
    [42113, 2, 2, '0'],
  ];

  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let extraAt = ifdOffset + ifdSize;
  const extras: { at: number; bytes: Buffer }[] = [];
  const sizeOf: Record<number, number> = { 2: 1, 3: 2, 4: 4, 12: 8 };
  // Lay out out-of-line values first, so tile data can follow them.
  const placed = entries.map(([tag, type, count, values]) => {
    const size = sizeOf[type]! * count;
    if (size <= 4) return { tag, type, count, values, at: -1 };
    const at = extraAt;
    extraAt += size + (size % 2);
    return { tag, type, count, values, at };
  });
  let dataAt = extraAt;
  const offsets = tiles.map((t) => {
    const at = dataAt;
    dataAt += t.length;
    return at;
  });
  placed.find((p) => p.tag === 324)!.values = offsets;

  const out = Buffer.alloc(dataAt);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifdOffset, 4);
  out.writeUInt16LE(entries.length, ifdOffset);
  const encode = (type: number, values: number[] | string): Buffer => {
    if (typeof values === 'string') return Buffer.from(values + '\0', 'latin1');
    const b = Buffer.alloc(sizeOf[type]! * values.length);
    values.forEach((v, i) => {
      if (type === 3) b.writeUInt16LE(v, i * 2);
      else if (type === 4) b.writeUInt32LE(v, i * 4);
      else if (type === 12) b.writeDoubleLE(v, i * 8);
    });
    return b;
  };
  placed.forEach((p, i) => {
    const at = ifdOffset + 2 + i * 12;
    out.writeUInt16LE(p.tag, at);
    out.writeUInt16LE(p.type, at + 2);
    out.writeUInt32LE(p.count, at + 4);
    const bytes = encode(p.type, p.values);
    if (p.at < 0) bytes.copy(out, at + 8);
    else {
      out.writeUInt32LE(p.at, at + 8);
      extras.push({ at: p.at, bytes });
    }
  });
  for (const e of extras) e.bytes.copy(out, e.at);
  tiles.forEach((t, i) => t.copy(out, offsets[i]!));
  return new Uint8Array(out);
}

function fakeFetcher(file: Uint8Array): { fetch: RangeFetcher; requests: [number, number][] } {
  const requests: [number, number][] = [];
  return {
    requests,
    fetch: async (_url, start, end) => {
      requests.push([start, end]);
      return file.subarray(start, Math.min(file.length, end + 1));
    },
  };
}

test('GeoTIFF: reads a window across tiles, undoing Deflate and the predictor', async () => {
  const value = (c: number, r: number) => 1000 + c * 7 + r * 13;
  const file = buildTiff(50, 40, 16, value);
  const { fetch } = fakeFetcher(file);
  const cog = await Cog.open('mem://band', fetch);
  assert.equal(cog.width, 50);
  assert.equal(cog.height, 40);

  const w = await cog.readWindow(10, 12, 30, 35);
  assert.equal(w.width, 20);
  assert.equal(w.height, 23);
  for (let r = 0; r < w.height; r++) {
    for (let c = 0; c < w.width; c++) {
      assert.equal(w.data[r * w.width + c], value(10 + c, 12 + r));
    }
  }
});

test('GeoTIFF: places pixels on the map from the tie point and pixel size', async () => {
  const cog = await Cog.open('mem://band', fakeFetcher(buildTiff(20, 20, 16, () => 1)).fetch);
  // Top-left corner at (600000, 1420000), 10 m pixels, rows going south.
  assert.deepEqual(cog.pixelOf(600000, 1420000), [0, 0]);
  assert.deepEqual(cog.pixelOf(600025, 1419965), [2.5, 3.5]);
});

test('GeoTIFF: nodata reads as NaN, and the window clamps to the image', async () => {
  const file = buildTiff(20, 20, 16, (c) => (c < 5 ? 0 : 500));
  const cog = await Cog.open('mem://band', fakeFetcher(file).fetch);
  const w = await cog.readWindow(-5, -5, 8, 3);
  assert.equal(w.col0, 0);
  assert.equal(w.width, 8);
  assert.ok(Number.isNaN(w.data[0]!), 'nodata 0 is not a reading');
  assert.equal(w.data[6], 500);
});

test('GeoTIFF: fetches only the tiles it needs', async () => {
  const file = buildTiff(64, 64, 16, () => 7);
  const { fetch, requests } = fakeFetcher(file);
  const cog = await Cog.open('mem://band', fetch);
  const before = requests.length;
  await cog.readWindow(20, 20, 24, 24); // inside one tile
  assert.equal(requests.length - before, 1);
});

test('LZW: decodes the TIFF variant', () => {
  // "TOBEORNOTTOBEORTOBEORNOT" encoded with TIFF LZW (clear code first, EOI last).
  const text = 'TOBEORNOTTOBEORTOBEORNOT';
  const encoded = lzwEncode(Buffer.from(text, 'latin1'));
  assert.equal(Buffer.from(lzwDecode(encoded)).toString('latin1'), text);
});

/** Reference encoder for the test only: MSB-first, 9-12 bits, early change. */
function lzwEncode(input: Uint8Array): Uint8Array {
  const dict = new Map<string, number>();
  for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
  let next = 258;
  let width = 9;
  const bits: number[] = [];
  const emit = (code: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((code >> i) & 1);
  };
  emit(256);
  let w = '';
  for (const byte of input) {
    const c = String.fromCharCode(byte);
    if (dict.has(w + c)) {
      w += c;
      continue;
    }
    emit(dict.get(w)!);
    dict.set(w + c, next++);
    if (next + 1 >= 1 << width && width < 12) width++;
    w = c;
  }
  if (w) emit(dict.get(w)!);
  emit(257);
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    if (b) out[i >> 3]! |= 0x80 >> (i & 7);
  });
  return out;
}

/* ------------------------------------------------------ edge contamination */

test('blend: pixels outside the plot do not bleed into its edge cells', async () => {
  // West half (cols 0-9) is road at 100, east half crop at 500; the plot is
  // the east half, its edge at x = 600100.
  const file = buildTiff(20, 20, 16, (c) => (c < 10 ? 100 : 500));
  const cog = await Cog.open('mem://band', fakeFetcher(file).fetch);
  const band = new BandWindow(cog, await cog.readWindow(0, 0, 20, 20));
  const plot: [number, number][] = [
    [600100, 1419800],
    [600200, 1419800],
    [600200, 1420000],
    [600100, 1420000],
  ];
  const inside = (x: number, y: number) => insideRingXY(plot, x, y);
  // 2 m inside the edge, between the road pixel's centre and the crop's.
  const x = 600102;
  const y = 1419905;
  assert.ok(Math.abs(band.bilinear(x, y) - 380) < 1e-6, 'the plain blend is 30% road');
  assert.equal(band.blend(x, y, inside), 500, 'the plot-only blend is all crop');
  // Well inside, both agree.
  assert.equal(band.blend(600150, 1419905, inside), 500);
});

test('insideRingXY: even-odd in map metres', () => {
  const sq: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  assert.equal(insideRingXY(sq, 5, 5), true);
  assert.equal(insideRingXY(sq, 15, 5), false);
});

test('blend: pixels wholly inside the plot are preferred to ones merely centred in it', async () => {
  // Road (100) west of x = 600100; a strip of mixed pixels (300) from there to
  // 600110; crop (500) beyond. The plot starts at 600103, so the 300 column is
  // centred inside it (600105) but half on the road.
  const file = buildTiff(20, 20, 16, (c) => (c < 10 ? 100 : c === 10 ? 300 : 500));
  const cog = await Cog.open('mem://band', fakeFetcher(file).fetch);
  const band = new BandWindow(cog, await cog.readWindow(0, 0, 20, 20));
  const plot: [number, number][] = [
    [600103, 1419800],
    [600200, 1419800],
    [600200, 1420000],
    [600103, 1420000],
  ];
  const inside = (x: number, y: number) => insideRingXY(plot, x, y);
  const wholly = (x: number, y: number) => inside(x, y) && distanceToRingXY(plot, x, y) >= band.halfDiagonal;
  const x = 600106;
  const y = 1419905;
  assert.ok(Math.abs(band.blend(x, y, inside) - 320) < 1e-9, 'centred-inside alone keeps the mixed pixel');
  assert.equal(band.blend(x, y, wholly, inside), 500, 'wholly-inside first takes the crop');
});

