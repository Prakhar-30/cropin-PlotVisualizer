import {
  HEALTH_INDICES,
  SEVERITY_COLOURS,
  SEVERITY_LABELS,
  indexSpec,
  type HealthPatch,
  type IndexKey,
  type Plot,
  type Severity,
} from '@plot/shared';
import type { PlotHealth } from '../api.js';
import { formatCoordinate } from '../lib/healthLayer.js';

/**
 * Crop condition across every saved plot: which index, how the ground splits
 * into its three zones, and the patches worth walking to.
 *
 * Three indices, one reading: each is split into normal, moderate and critical
 * and drawn green, yellow and red, so an agent reads crop greenness, crop vigour
 * and water stress the same way. The patch list is the deliverable - a coloured
 * grid tells an agronomist there is a problem; a list of places, worst first,
 * tells a field agent where to stand.
 */

const ZONES: Severity[] = [2, 1, 0];

/** Beyond this the list stops helping; the map shows the rest. */
const MAX_LISTED = 40;

export interface HealthPanelProps {
  enabled: boolean;
  /** Snapshots still being fetched. */
  pending: number;
  plots: Plot[];
  snapshots: ReadonlyMap<string, PlotHealth>;
  index: IndexKey;
  onToggle: (enabled: boolean) => void;
  onIndexChange: (index: IndexKey) => void;
  onFocusPatch: (lat: number, lng: number) => void;
  /** Hidden on a phone while the draw panel is showing. */
  className?: string;
}

interface ListedPatch extends HealthPatch {
  plotId: string;
  plotName: string;
}

export function HealthPanel({
  enabled,
  pending,
  plots,
  snapshots,
  index,
  onToggle,
  onIndexChange,
  onFocusPatch,
  className,
}: HealthPanelProps) {
  const spec = indexSpec(index);

  const counts = [0, 0, 0];
  const patches: ListedPatch[] = [];
  let synthetic = false;
  for (const plot of plots) {
    const snapshot = snapshots.get(plot.id);
    if (!snapshot) continue;
    synthetic ||= snapshot.synthetic;
    const summary = snapshot.indices.find((i) => i.key === index);
    summary?.zone_counts.forEach((n, zone) => (counts[zone] += n));
    for (const patch of snapshot.patches) {
      if (patch.index === index) patches.push({ ...patch, plotId: plot.id, plotName: plot.name });
    }
  }
  patches.sort((a, b) => b.zone - a.zone || b.area_sq_m - a.area_sq_m);
  const total = counts[0] + counts[1] + counts[2];
  const graded = plots.filter((p) => snapshots.has(p.id)).length;

  return (
    <section className={`health-panel ${className ?? ''}`} aria-label="Crop condition">
      <header className="health-panel__head">
        <label className="health-panel__toggle">
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
          <span>Crop condition</span>
        </label>
        {enabled && pending > 0 && <span className="health-panel__status">loading {pending}…</span>}
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

      {!enabled && <p className="health-panel__hint">Turn on to grade every saved plot in 3 m cells.</p>}
      {enabled && plots.length === 0 && <p className="health-panel__hint">No saved plots yet.</p>}

      {enabled && total > 0 && (
        <>
          {synthetic && <p className="health-panel__warning">Demo values — not yet from satellite imagery.</p>}

          <ul className="health-legend">
            {ZONES.map((zone) => {
              const share = Math.round((counts[zone] / total) * 100);
              return (
                <li key={zone}>
                  <span className="health-legend__swatch" style={{ background: SEVERITY_COLOURS[zone] }} />
                  <span className="health-legend__label">
                    {SEVERITY_LABELS[zone]}
                    {zone === 0 ? ' (not drawn)' : ''}
                  </span>
                  <span className="health-legend__share">{share}%</span>
                </li>
              );
            })}
          </ul>
          <p className="health-panel__hint">
            {graded} of {plots.length} plots · 3 m cells · {spec.key.toUpperCase()}
          </p>

          <h3 className="health-panel__subhead">Drop points ({patches.length})</h3>
          {patches.length === 0 ? (
            <p className="health-panel__hint">No moderate or critical patches for {spec.label.toLowerCase()}.</p>
          ) : (
            <ol className="hotspot-list">
              {patches.slice(0, MAX_LISTED).map((patch) => (
                <li key={`${patch.plotId}-${patch.rank}`}>
                  <button
                    type="button"
                    className="hotspot-list__row"
                    onClick={() => onFocusPatch(patch.centroid_lat, patch.centroid_lng)}
                  >
                    <span className="hotspot-list__rank" style={{ background: SEVERITY_COLOURS[patch.zone] }}>
                      {patch.rank}
                    </span>
                    <span className="hotspot-list__body">
                      <span className="hotspot-list__coord">{patch.plotName}</span>
                      <span className="hotspot-list__meta">
                        {SEVERITY_LABELS[patch.zone]} · {Math.round(patch.area_sq_m)} m² ·{' '}
                        {formatCoordinate(patch.centroid_lat, patch.centroid_lng)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          {patches.length > MAX_LISTED && (
            <p className="health-panel__hint">and {patches.length - MAX_LISTED} more on the map.</p>
          )}
        </>
      )}
    </section>
  );
}
