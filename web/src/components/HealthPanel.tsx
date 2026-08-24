import { SEVERITY_COLOURS, SEVERITY_LABELS, sqMToHectares, type Severity } from '@plot/shared';
import type { PlotHealth } from '../api.js';
import { formatCoordinate } from '../lib/healthLayer.js';

/**
 * The plot-health toggle, legend, and the ranked list of places to walk to.
 *
 * The hotspot list is the deliverable here, not the pretty grid. A coloured
 * raster tells an agronomist there is a problem; a ranked set of coordinates
 * inside the boundary tells a field agent where to stand. Every row is therefore
 * a coordinate first and a statistic second.
 */

const SEVERITIES: Severity[] = [0, 1, 2, 3];

export interface HealthPanelProps {
  enabled: boolean;
  loading: boolean;
  plotId: string | null;
  snapshot: PlotHealth | null;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onFocusHotspot: (lat: number, lng: number) => void;
}

export function HealthPanel({
  enabled,
  loading,
  plotId,
  snapshot,
  error,
  onToggle,
  onFocusHotspot,
}: HealthPanelProps) {
  return (
    <section className="health-panel" aria-label="Plot health">
      <header className="health-panel__head">
        <label className="health-panel__toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span>Plot health</span>
        </label>
        {loading && <span className="health-panel__status">loading…</span>}
      </header>

      {!enabled && (
        <p className="health-panel__hint">
          Shows an NDVI grid over the selected plot and marks the patches worth
          visiting.
        </p>
      )}

      {enabled && !plotId && (
        <p className="health-panel__hint">Click a saved plot on the map to grade it.</p>
      )}

      {enabled && error && <p className="health-panel__error">{error}</p>}

      {enabled && snapshot && (
        <>
          {snapshot.synthetic && (
            // Never let a fabricated index pass for a measured one. This is the
            // difference between a demo and a wrong agronomic recommendation.
            <p className="health-panel__warning">
              Demo data — synthetic NDVI, not satellite imagery.
            </p>
          )}

          <dl className="health-panel__stats">
            <div>
              <dt>Plot</dt>
              <dd>{snapshot.plot_id}</dd>
            </div>
            <div>
              <dt>Cell</dt>
              <dd>{snapshot.cell_size_m} m</dd>
            </div>
            <div>
              <dt>Mean NDVI</dt>
              <dd>{snapshot.value_mean.toFixed(2)}</dd>
            </div>
          </dl>

          <ul className="health-legend">
            {SEVERITIES.map((severity) => (
              <li key={severity}>
                <span
                  className="health-legend__swatch"
                  style={{ background: SEVERITY_COLOURS[severity] }}
                />
                {SEVERITY_LABELS[severity]}
              </li>
            ))}
          </ul>

          <h3 className="health-panel__subhead">
            Hotspots ({snapshot.hotspots.length})
          </h3>
          {snapshot.hotspots.length === 0 ? (
            <p className="health-panel__hint">
              Nothing above the stressed threshold — no visit needed.
            </p>
          ) : (
            <ol className="hotspot-list">
              {snapshot.hotspots.map((hotspot) => (
                <li key={hotspot.rank}>
                  <button
                    type="button"
                    className="hotspot-list__row"
                    onClick={() => onFocusHotspot(hotspot.centroid_lat, hotspot.centroid_lng)}
                  >
                    <span
                      className="hotspot-list__rank"
                      style={{ background: SEVERITY_COLOURS[hotspot.severity] }}
                    >
                      {hotspot.rank}
                    </span>
                    <span className="hotspot-list__body">
                      <span className="hotspot-list__coord">
                        {formatCoordinate(hotspot.centroid_lat, hotspot.centroid_lng)}
                      </span>
                      <span className="hotspot-list__meta">
                        {SEVERITY_LABELS[hotspot.severity]} ·{' '}
                        {sqMToHectares(hotspot.area_sq_m).toFixed(2)} ha · NDVI{' '}
                        {hotspot.mean_value.toFixed(2)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
