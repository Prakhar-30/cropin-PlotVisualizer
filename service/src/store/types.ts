import type { NormalizedPlot, Plot, PlotWithDistance } from '@plot/shared';

/**
 * Where plots are kept.
 *
 * Two implementations exist because the two deployments are genuinely
 * different, not because the same thing is written twice:
 *
 *  - **sqlite** for local development and the test suite. No network, no
 *    credentials, and `:memory:` gives every test run a clean database.
 *  - **supabase** for anything deployed. Vercel functions have an ephemeral
 *    filesystem, so a file-backed database there would lose every plot between
 *    invocations.
 *
 * What is *not* duplicated is the part that matters: validation. Both drivers
 * receive a `NormalizedPlot` that has already been through
 * `validatePlotInput()` in `@plot/shared`, so the area, the centroid and every
 * rejection rule are decided in one place regardless of where the row lands.
 *
 * The interface is async even though SQLite is synchronous. Making the fast
 * driver look slow is the right way round - the alternative is a synchronous
 * interface that the network driver cannot implement.
 */
export interface PlotStore {
  /** Which driver this is, for the `/api/health` readout. */
  readonly kind: 'sqlite' | 'supabase';

  /** Ensures the schema exists. Safe to call more than once. */
  init(): Promise<void>;

  /**
   * @param forcedId only the seed script passes this, so that development ids
   *   stay stable. The HTTP route never does, which is why an id in a request
   *   body is always ignored.
   */
  insertPlot(value: NormalizedPlot, forcedId?: string): Promise<Plot>;

  getPlot(id: string): Promise<Plot | null>;

  listPlots(): Promise<Plot[]>;

  /** Plots whose centroid is within `radiusM`, nearest first. */
  listPlotsNear(lat: number, lng: number, radiusM: number): Promise<PlotWithDistance[]>;

  deleteAllPlots(): Promise<void>;
}
