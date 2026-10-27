import {
  formatAcres,
  formatDistance,
  formatHectares,
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
  onUndo: () => void;
  onClose: () => void;
  onSave: () => void;
  /** The saved plot tapped on the map, offered for deletion. */
  selected: Plot | null;
  deleting: boolean;
  onDelete: (plot: Plot) => void;
  /** Hidden on a phone while the health panel is showing. */
  className?: string;
}

const HINTS: Record<DrawState['mode'], string> = {
  idle: 'Press "New plot", then click on the map to place the first corner.',
  drawing: 'Tap or click to add corners, then Close shape (or double-click). Drag a corner to move it.',
  ready: 'Fill in the name and an optional landmark note, then save.',
};

/**
 * Runs the shared validator so the panel reports exactly what the API would
 * reject, instead of keeping a second copy of the rules in the browser.
 */
function blockers(state: DrawState, name: string, note: string): string[] {
  if (state.vertices.length === 0) return ['Draw the plot boundary'];
  if (!state.closed) return ['Close the shape'];

  const result = validatePlotInput({
    name,
    polygon: ringToPolygon(state.vertices),
    landmark_note: note,
  });
  return result.ok ? [] : result.errors;
}

export function DrawPanel(props: Props) {
  const { state, name, note, saving, error, saved } = props;
  const measurable = state.vertices.length >= 3;
  const problems = blockers(state, name, note);

  return (
    <aside className={`panel ${props.className ?? ''}`}>
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

      {state.mode === 'drawing' && (
        <div className="actions">
          <button type="button" className="ghost" disabled={state.vertices.length === 0} onClick={props.onUndo}>
            Undo corner
          </button>
          <button type="button" disabled={state.vertices.length < 3} onClick={props.onClose}>
            Close shape
          </button>
        </div>
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

      {props.selected && (
        <section className="selected-plot">
          <div>
            <span className="label">Selected plot</span>
            <strong>{props.selected.name}</strong>
            <span className="mono small">
              {props.selected.id} · {formatHectares(props.selected.area_sq_m)}
            </span>
          </div>
          <button
            type="button"
            className="danger"
            disabled={props.deleting}
            onClick={() => props.onDelete(props.selected!)}
          >
            {props.deleting ? 'Deleting…' : 'Delete plot'}
          </button>
        </section>
      )}
    </aside>
  );
}
