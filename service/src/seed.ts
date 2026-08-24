/**
 * Seeds six adjacent farm plots in rural Karnataka so the mobile app has
 * something real to hit on day one.
 *
 * The plots sit on a shared lattice of corner nodes: neighbouring plots reuse
 * the *same* node objects, so their shared edges match to the last decimal the
 * way real cadastral neighbours do. Each node carries a small offset so the
 * blocks are irregular rather than a suspiciously perfect grid.
 *
 * Location: farmland near Bellur, Nagamangala taluk, Mandya district, Karnataka.
 * A cart track runs along the south edge of the lower row; the upper row is
 * reached from a bund track on the west.
 *
 *   npm run seed
 */
import { formatArea, validatePlotInput, type Position } from '@plot/shared';
import { describeStore, getReadyStore } from './store/index.js';

/** South-west corner of the block. */
const BASE_LNG = 76.7201;
const BASE_LAT = 12.7862;
/** One cell is about 141 m east-west by 127 m north-south, so roughly 1.8 ha. */
const CELL_LNG = 0.0013;
const CELL_LAT = 0.00115;

const COLS = 3;
const ROWS = 2;

/**
 * Per-node jitter in degrees, indexed `[col][row]` over the 4x3 lattice.
 * Hand-written rather than random so the seed is byte-for-byte reproducible.
 */
const JITTER: Array<Array<[number, number]>> = [
  [
    [0, 0],
    [0.00004, -0.00003],
    [-0.00002, 0.00005],
  ],
  [
    [-0.00003, 0.00004],
    [0.00006, 0.00002],
    [0.00003, -0.00004],
  ],
  [
    [0.00005, -0.00002],
    [-0.00004, 0.00005],
    [0.00002, 0.00003],
  ],
  [
    [-0.00002, 0.00003],
    [0.00003, -0.00005],
    [-0.00005, -0.00002],
  ],
];

/** Lattice corner `(col, row)` as `[lng, lat]`. Shared by adjacent cells. */
function node(col: number, row: number): Position {
  const [dLng, dLat] = JITTER[col][row];
  return [BASE_LNG + col * CELL_LNG + dLng, BASE_LAT + row * CELL_LAT + dLat];
}

/** Closed ring for the cell whose south-west corner is `(col, row)`. */
function cellRing(col: number, row: number): Position[] {
  const sw = node(col, row);
  return [sw, node(col + 1, row), node(col + 1, row + 1), node(col, row + 1), sw];
}

interface SeedSpec {
  id: string;
  name: string;
  landmark_note: string;
  /** Metres to shift the access point off the plot corner, towards the track. */
  access: { fromCol: number; fromRow: number; dLng: number; dLat: number };
}

/** Row 0 is the lower row (reached from the south track), row 1 the upper. */
const SPECS: SeedSpec[][] = [
  [
    {
      id: 'PLT-4471',
      name: 'Hosahalli Block A',
      landmark_note: 'Transformer pole at the SW corner, gate opens onto the cart track',
      access: { fromCol: 0, fromRow: 0, dLng: 0.00015, dLat: -0.00018 },
    },
    {
      id: 'PLT-4472',
      name: 'Hosahalli Block B',
      landmark_note: 'Neem tree beside the culvert on the south track',
      access: { fromCol: 1, fromRow: 0, dLng: 0.00025, dLat: -0.00018 },
    },
    {
      id: 'PLT-4473',
      name: 'Kere Angala',
      landmark_note: 'Borewell shed with a blue tank, 20 m in from the track',
      access: { fromCol: 2, fromRow: 0, dLng: 0.0002, dLat: -0.00018 },
    },
  ],
  [
    {
      id: 'PLT-4474',
      name: 'Doddakere North',
      landmark_note: 'Whitewashed pump house on the west bund',
      access: { fromCol: 0, fromRow: 1, dLng: -0.00016, dLat: 0.0002 },
    },
    {
      id: 'PLT-4475',
      name: 'Mavinakatte',
      landmark_note: 'Two mango trees on the bund between this plot and the next',
      access: { fromCol: 1, fromRow: 1, dLng: -0.00008, dLat: 0.0002 },
    },
    {
      id: 'PLT-4476',
      name: 'Chikkamallur Field 3',
      landmark_note: 'Stone boundary marker at the NE corner, next to the electric pole',
      access: { fromCol: 2, fromRow: 1, dLng: 0.0002, dLat: 0.00022 },
    },
  ],
];

async function seed(): Promise<void> {
  // Seeds whichever store is configured, so `npm run seed` fills the Supabase
  // project on a deployment and the local file during development.
  const store = await getReadyStore();
  await store.deleteAllPlots();

  const inserted: string[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const spec = SPECS[row][col];
      const ring = cellRing(col, row);
      const anchor = node(spec.access.fromCol, spec.access.fromRow);

      // Run seed data through the same validator the HTTP route uses, so a bad
      // fixture fails here rather than shipping a plot the API would reject.
      const result = validatePlotInput({
        name: spec.name,
        polygon: { type: 'Polygon', coordinates: [ring] },
        access_lng: anchor[0] + spec.access.dLng,
        access_lat: anchor[1] + spec.access.dLat,
        landmark_note: spec.landmark_note,
      });
      if (!result.ok) {
        throw new Error(`seed plot ${spec.id} is invalid: ${result.errors.join('; ')}`);
      }

      const plot = await store.insertPlot(result.value, spec.id);
      inserted.push(`${plot.id}  ${plot.name.padEnd(24)} ${formatArea(plot.area_sq_m)}`);
    }
  }

  console.log(`seeded ${inserted.length} plots into ${describeStore()}`);
  for (const line of inserted) console.log('  ' + line);

  const near = await store.listPlotsNear(BASE_LAT + CELL_LAT, BASE_LNG + 1.5 * CELL_LNG, 500);
  console.log(`\nnear=${(BASE_LAT + CELL_LAT).toFixed(5)},${(BASE_LNG + 1.5 * CELL_LNG).toFixed(5)} radius_m=500`);
  for (const p of near) console.log(`  ${p.id} ${p.distance_m.toFixed(0)} m`);
}

await seed();
