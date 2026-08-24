import {
  formatAcres,
  formatDistance,
  formatHectares,
  formatLatLng,
  MAX_PLOT_AREA_HA,
  ringToPolygon,
  validatePlotInput,
  type Plot,
} from '@plot/shared';
import type { DrawState } from '../lib/drawController.js';

interface Props {
  state: DrawState;
  name: string;
  note: string;
  saving: boolean;
  error: string | null;
  saved: Plot | null;
  onNameChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onStartNew: () => void;
  onClear: () => void;
  onSave: () => void;
}

const HINTS: Record<DrawState['mode'], string> = {
  idle: 'Press "New plot", then click on the map to place the first corner.',
  drawing: 'Click to add corners. Double-click to close. Drag a corner to move it, right-click to delete it.',
  'awaiting-access': 'Now click the access point — where someone walks or drives in from the road.',
  ready: 'Fill in the name and landmark note, then save.',
};

/**
 * Runs the shared validator so the panel reports exactly what the API would
 * reject, instead of keeping a second copy of the rules in the browser.
 */
function blockers(state: DrawState, name: string, note: string): string[] {
  if (state.vertices.length === 0) return ['Draw the plot boundary'];
  if (!state.closed) return ['Double-click to close the polygon'];
  if (!state.access) return ['Place the access point'];

  const result = validatePlotInput({
    name,
    polygon: ringToPolygon(state.vertices),
    access_lng: state.access[0],
    access_lat: state.access[1],
    landmark_note: note,
  });
  return result.ok ? [] : result.errors;
}

export function DrawPanel(props: Props) {
  const { state, name, note, saving, error, saved } = props;
  const measurable = state.vertices.length >= 3;
  const problems = blockers(state, name, note);

  return (
    <aside className="panel">
      <header className="panel-header">
        <h1>Mark a plot</h1>
        <p className="hint">{HINTS[state.mode]}</p>
      </header>

      <section className="measurements">
        <div className="measure big">
          <span className="value">{measurable ? formatHectares(state.areaSqM) : '—'}</span>
          <span className="label">geodesic area</span>
        </div>
        <div className="measure">
          <span className="value">{measurable ? formatAcres(state.areaSqM) : '—'}</span>
          <span className="label">acres</span>
        </div>
        <div className="measure">
          <span className="value">{measurable ? formatDistance(state.perimeterM) : '—'}</span>
          <span className="label">perimeter</span>
        </div>
        <div className="measure">
          <span className="value">{state.vertices.length}</span>
          <span className="label">corners</span>
        </div>
      </section>

      {state.selfIntersecting && (
        <p className="warn">The boundary crosses itself. Move a corner to untangle it.</p>
      )}

      <div className="field">
        <label htmlFor="plot-name">Plot name</label>
        <input
          id="plot-name"
          value={name}
          onChange={(e) => props.onNameChange(e.target.value)}
          placeholder="Hosahalli Block A"
        />
      </div>

      <div className="field">
        <label htmlFor="access-point">
          Access point <span className="required">required</span>
        </label>
        <output id="access-point" className="readout">
          {state.access
            ? formatLatLng(state.access[1], state.access[0])
            : 'Not placed — close the polygon, then click the road entry'}
        </output>
      </div>

      <div className="field">
        <label htmlFor="landmark">Landmark note</label>
        <textarea
          id="landmark"
          rows={3}
          value={note}
          onChange={(e) => props.onNoteChange(e.target.value)}
          placeholder="transformer pole at NE corner"
        />
      </div>

      {problems.length > 0 && state.vertices.length > 0 && (
        <ul className="blockers">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {error && <p className="warn">{error}</p>}
      {saved && (
        <p className="ok">
          Saved <strong>{saved.id}</strong> — {formatHectares(saved.area_sq_m)} (recomputed by the
          server, limit {MAX_PLOT_AREA_HA} ha)
        </p>
      )}

      <div className="actions">
        <button type="button" onClick={props.onStartNew}>
          New plot
        </button>
        <button type="button" className="ghost" onClick={props.onClear}>
          Clear
        </button>
        <button
          type="button"
          className="primary"
          disabled={problems.length > 0 || saving}
          onClick={props.onSave}
        >
          {saving ? 'Saving…' : 'Save plot'}
        </button>
      </div>
    </aside>
  );
}
