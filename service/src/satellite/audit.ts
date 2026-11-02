/**
 * Recomputes crop condition for every plot of a deployed API with the code in
 * this checkout, and prints what it finds per plot and index: zone shares and
 * drop points. For checking a change to the grading against real plots before
 * it ships - CI runs it.
 *
 *   npm run audit -w @plot/api -- https://your-api.example/
 */
import { buildHealthSnapshot, pointInPolygon, type Plot } from '@plot/shared';
import { sentinelSamplers } from './sentinel.js';

const base = (process.argv[2] ?? 'https://cropin-plot-visualizer-service-nu.vercel.app/').replace(/\/?$/, '/');
const plots = (await (await fetch(`${base}api/plots`)).json()) as Plot[];
console.log(`${plots.length} plots from ${base}`);

for (const plot of plots) {
  try {
    const started = Date.now();
    const { samplers, scene } = await sentinelSamplers(plot.polygon, (lat, lng) =>
      pointInPolygon(lat, lng, plot.polygon),
    );
    const s = buildHealthSnapshot({
      plotId: plot.id,
      polygon: plot.polygon,
      samplers,
      capturedOn: scene.date,
      source: 'sentinel-2-l2a',
      exclusions: plot.exclusions ?? [],
    });
    const parts = s.indices.map((ix) => {
      const n = ix.zone_counts.reduce((a, b) => a + b, 0) || 1;
      const drops = s.patches.filter((p) => p.index === ix.key);
      const pct = (z: number) => Math.round((100 * ix.zone_counts[z]!) / n);
      return `${ix.key} mean ${ix.mean.toFixed(2)} N/M/C ${pct(0)}/${pct(1)}/${pct(2)}% drops ${drops.length}` +
        (drops.length === 1 && drops[0]!.cell_count === s.cells.length ? ' (whole plot)' : '');
    });
    console.log(`${plot.id} ${(plot.area_sq_m / 10000).toFixed(2)} ha ${s.cells.length} cells ${Date.now() - started} ms | ${parts.join(' | ')}`);
  } catch (err) {
    console.log(`${plot.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
