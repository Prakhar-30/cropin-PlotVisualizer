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
/**
 * One cell is about 43 m east-west by 40 m north-south, about 0.17 ha - the
 * size of the plots the field app is used on, and a couple of hundred 3 m
 * health cells each.
 */
const CELL_LNG = 0.0004;
const CELL_LAT = 0.00036;

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
  // Jitter was written for 140 m cells; a third of it suits 40 m ones.
  return [BASE_LNG + col * CELL_LNG + dLng / 3, BASE_LAT + row * CELL_LAT + dLat / 3];
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
}

/** Row 0 is the lower row (reached from the south track), row 1 the upper. */
const SPECS: SeedSpec[][] = [
  [
    {
      id: 'PLT-4471',
      name: 'Hosahalli Block A',
      landmark_note: 'Transformer pole at the SW corner, gate opens onto the cart track',
    },
    {
      id: 'PLT-4472',
      name: 'Hosahalli Block B',
      landmark_note: 'Neem tree beside the culvert on the south track',
    },
    {
      id: 'PLT-4473',
      name: 'Kere Angala',
      landmark_note: 'Borewell shed with a blue tank, 20 m in from the track',
    },
  ],
  [
    {
      id: 'PLT-4474',
      name: 'Doddakere North',
      landmark_note: 'Whitewashed pump house on the west bund',
    },
    {
      id: 'PLT-4475',
      name: 'Mavinakatte',
      landmark_note: 'Two mango trees on the bund between this plot and the next',
    },
    {
      id: 'PLT-4476',
      name: 'Chikkamallur Field 3',
      landmark_note: 'Stone boundary marker at the NE corner, next to the electric pole',
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

      // Run seed data through the same validator the HTTP route uses, so a bad
      // fixture fails here rather than shipping a plot the API would reject.
      const result = validatePlotInput({
        name: spec.name,
        polygon: { type: 'Polygon', coordinates: [ring] },
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
