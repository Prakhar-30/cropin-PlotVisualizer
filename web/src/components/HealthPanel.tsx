import {
  HEALTH_INDICES,
  SEVERITY_COLOURS,
  SEVERITY_LABELS,
  indexSpec,
  type IndexKey,
  type Severity,
} from '@plot/shared';
import type { PlotHealth } from '../api.js';
import { formatCoordinate } from '../lib/healthLayer.js';

/**
 * Crop condition for the selected plot: which index, its three zones, and the
 * patches worth walking to.
 *
 * Three indices, one reading: each is split into normal, moderate and critical
 * and drawn green, yellow and red, so an agent reads crop greenness, crop vigour
 * and water stress the same way. The patch list is the deliverable - a coloured
 * grid tells an agronomist there is a problem; a ranked list of places inside
 * the boundary tells a field agent where to stand.
 */

const ZONES: Severity[] = [2, 1, 0];

export interface HealthPanelProps {
  enabled: boolean;
  loading: boolean;
  plotId: string | null;
  snapshot: PlotHealth | null;
  error: string | null;
  index: IndexKey;
  onToggle: (enabled: boolean) => void;
  onIndexChange: (index: IndexKey) => void;
  onFocusPatch: (lat: number, lng: number) => void;
  /** Hidden on a phone while the draw panel is showing. */
  className?: string;
}

export function HealthPanel({
  enabled,
  loading,
  plotId,
  snapshot,
  error,
  index,
  onToggle,
  onIndexChange,
  onFocusPatch,
  className,
}: HealthPanelProps) {
  const spec = indexSpec(index);
  const summary = snapshot?.indices.find((i) => i.key === index);
  const patches = snapshot?.patches.filter((p) => p.index === index) ?? [];
  const total = summary ? summary.zone_counts.reduce((a, b) => a + b, 0) : 0;

  return (
    <section className={`health-panel ${className ?? ''}`} aria-label="Crop condition">
      <header className="health-panel__head">
        <label className="health-panel__toggle">
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
          <span>Crop condition</span>
        </label>
        {loading && <span className="health-panel__status">loading…</span>}
      </header>

      <div className="index-switch" role="tablist" aria-label="Index">
        {HEALTH_INDICES.map((option) => (
          <button
            key={option.key}
            type="button"
            role="tab"
            aria-selected={option.key === index}
            className={option.key === index ? 'is-active' : ''}
            onClick={() => onIndexChange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="health-panel__hint">{spec.description}</p>

      {!enabled && <p className="health-panel__hint">Turn on to grade the selected plot in 3 m cells.</p>}
      {enabled && !plotId && <p className="health-panel__hint">Tap a saved plot on the map to grade it.</p>}
      {enabled && error && <p className="health-panel__error">{error}</p>}

      {enabled && snapshot && summary && (
        <>
          {snapshot.synthetic && <p className="health-panel__warning">Demo values — not yet from satellite imagery.</p>}

          <ul className="health-legend">
            {ZONES.map((zone) => {
              const count = summary.zone_counts[zone];
              const share = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <li key={zone}>
                  <span className="health-legend__swatch" style={{ background: SEVERITY_COLOURS[zone] }} />
                  <span className="health-legend__label">{SEVERITY_LABELS[zone]}</span>
                  <span className="health-legend__share">{share}%</span>
                </li>
              );
            })}
          </ul>
          <p className="health-panel__hint">
            {snapshot.plot_id} · {snapshot.cell_size_m} m cells · mean {spec.key.toUpperCase()} {summary.mean.toFixed(2)}
          </p>

          <h3 className="health-panel__subhead">Patches to visit ({patches.length})</h3>
          {patches.length === 0 ? (
            <p className="health-panel__hint">No moderate or critical patches for {spec.label.toLowerCase()}.</p>
          ) : (
            <ol className="hotspot-list">
              {patches.map((patch) => (
                <li key={patch.rank}>
                  <button
                    type="button"
                    className="hotspot-list__row"
                    onClick={() => onFocusPatch(patch.centroid_lat, patch.centroid_lng)}
                  >
                    <span className="hotspot-list__rank" style={{ background: SEVERITY_COLOURS[patch.zone] }}>
                      {patch.rank}
                    </span>
                    <span className="hotspot-list__body">
                      <span className="hotspot-list__coord">
                        {formatCoordinate(patch.centroid_lat, patch.centroid_lng)}
                      </span>
                      <span className="hotspot-list__meta">
                        {SEVERITY_LABELS[patch.zone]} · {Math.round(patch.area_sq_m)} m² ·{' '}
                        {spec.key.toUpperCase()} {patch.mean_value.toFixed(2)}
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
