import {
  formatAcres,
  formatDistance,
  formatHectares,
  MAX_PATH_WIDTH_M,
  MAX_PLOT_AREA_HA,
  MIN_PATH_WIDTH_M,
  ringToPolygon,
  WALK_MAX_ACCURACY_M,
  WALK_MAX_SPACING_M,
  WALK_MIN_SPACING_M,
  type PathExclusion,
  validatePlotInput,
  type Plot,
} from '@plot/shared';
import type { DrawState } from '../lib/drawController.js';
import { pathLengthM, type PathDrawState } from '../lib/pathDrawController.js';
import type { GpsWalkState } from '../lib/useGpsWalk.js';

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
  /** The saved plot tapped on the map, offered for editing and deletion. */
  selected: Plot | null;
  deleting: boolean;
  onDelete: (plot: Plot) => void;
  onEdit: (plot: Plot) => void;
  /** The plot being edited, or null when drawing a new one. */
  editing: Plot | null;
  onCancelEdit: () => void;
  /** Walking paths of the plot being drawn or edited. */
  paths: PathDrawState;
  onAddPath: () => void;
  onFinishPath: () => void;
  onCancelPath: () => void;
  onRemovePath: (index: number) => void;
  onPathWidth: (widthM: number) => void;
  /** Marking the boundary by walking it with GPS. */
  walk: GpsWalkState;
  onWalkStart: () => void;
  onWalkStop: () => void;
  onMarkHere: () => void;
  onWalkAuto: (auto: boolean) => void;
  onWalkSpacing: (spacingM: number) => void;
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
function blockers(state: DrawState, name: string, note: string, paths: PathExclusion[]): string[] {
  if (state.vertices.length === 0) return ['Draw the plot boundary'];
  if (!state.closed) return ['Close the shape'];

  const result = validatePlotInput({
    name,
    polygon: ringToPolygon(state.vertices),
    landmark_note: note,
    exclusions: paths,
  });
  return result.ok ? [] : result.errors;
}

export function DrawPanel(props: Props) {
  const { state, name, note, saving, error, saved } = props;
  const measurable = state.vertices.length >= 3;
  const { editing, paths } = props;
  const problems = blockers(state, name, note, paths.paths);
  if (paths.current) problems.push('Finish or cancel the path being drawn');

  return (
    <aside className={`panel ${props.className ?? ''}`}>
      <header className="panel-header">
        <h1>{editing ? `Edit ${editing.id}` : 'Mark a plot'}</h1>
        <p className="hint">
          {editing && state.mode === 'ready'
            ? 'Drag a corner to move it, right-click it to remove it. Add or remove paths below, then save.'
            : HINTS[state.mode]}
        </p>
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

      {!state.closed && <WalkSection {...props} />}

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

      {state.closed && (
        <section className="paths">
          <div className="paths__head">
            <span className="label">Paths - not graded</span>
            <label className="paths__width">
              width
              <input
                type="number"
                min={MIN_PATH_WIDTH_M}
                max={MAX_PATH_WIDTH_M}
                step={0.5}
                value={paths.widthM}
                onChange={(e) => {
                  const w = Number(e.target.value);
                  if (Number.isFinite(w)) props.onPathWidth(w);
                }}
              />
              m
            </label>
          </div>
          <p className="hint">
            {paths.current
              ? `Click along the path (${paths.current.length} point${paths.current.length === 1 ? '' : 's'}), then Finish path or double-click.`
              : 'Walking paths and tracks inside the plot. Their cells get no crop colours.'}
          </p>
          {paths.paths.length > 0 && (
            <ul className="paths__list">
              {paths.paths.map((path, i) => (
                <li key={i}>
                  <span>
                    Path {i + 1} · {formatDistance(pathLengthM(path))} long · {path.width_m} m wide
                  </span>
                  <button type="button" className="ghost small" onClick={() => props.onRemovePath(i)} aria-label={`Remove path ${i + 1}`}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="actions">
            {paths.current ? (
              <>
                <button type="button" disabled={paths.current.length < 2} onClick={props.onFinishPath}>
                  Finish path
                </button>
                <button type="button" className="ghost" onClick={props.onCancelPath}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" onClick={props.onAddPath}>
                Add path
              </button>
            )}
          </div>
        </section>
      )}

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
        {editing ? (
          <button type="button" className="ghost" onClick={props.onCancelEdit}>
            Cancel edit
          </button>
        ) : (
          <>
            <button type="button" onClick={props.onStartNew}>
              New plot
            </button>
            <button type="button" className="ghost" onClick={props.onClear}>
              Clear
            </button>
          </>
        )}
        <button
          type="button"
          className="primary"
          disabled={problems.length > 0 || saving}
          onClick={props.onSave}
        >
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Save plot'}
        </button>
      </div>

      {props.selected && !editing && (
        <section className="selected-plot">
          <div>
            <span className="label">Selected plot</span>
            <strong>{props.selected.name}</strong>
            <span className="mono small">
              {props.selected.id} · {formatHectares(props.selected.area_sq_m)}
            </span>
          </div>
          <div className="selected-plot__actions">
            <button type="button" onClick={() => props.onEdit(props.selected!)}>
              Edit plot
            </button>
            <button
              type="button"
              className="danger"
              disabled={props.deleting}
              onClick={() => props.onDelete(props.selected!)}
            >
              {props.deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </section>
      )}
    </aside>
  );
}

/**
 * Walk the boundary: GPS marks each corner, by a press while standing at it or
 * automatically every few metres - for edges the imagery does not show well.
 */
function WalkSection(props: Props) {
  const { walk } = props;
  const accuracy = walk.latest?.accuracyM ?? null;
  const good = accuracy !== null && accuracy <= WALK_MAX_ACCURACY_M;
  return (
    <section className="walk">
      <div className="paths__head">
        <span className="label">Walk the boundary with GPS</span>
        {walk.active && (
          <span className={good ? 'walk__gps ok' : 'walk__gps warn'}>
            {accuracy === null ? 'waiting for GPS…' : `GPS ±${Math.round(accuracy)} m`}
          </span>
        )}
      </div>
      <p className="hint">
        {walk.active
          ? `Stand at a corner for a few seconds, then Mark point - or turn on auto-mark and walk the edge. ` +
            `Close shape when you are back at the start.${walk.marked > 0 ? ` ${walk.marked} marked this walk.` : ''}`
          : 'On a phone at the plot: walk round the edge and mark corners where you stand.'}
      </p>
      {walk.active && (
        <label className="walk__auto">
          <input type="checkbox" checked={walk.auto} onChange={(e) => props.onWalkAuto(e.target.checked)} />
          Auto-mark every
          <input
            type="number"
            min={WALK_MIN_SPACING_M}
            max={WALK_MAX_SPACING_M}
            step={1}
            value={walk.spacingM}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) props.onWalkSpacing(Math.min(WALK_MAX_SPACING_M, Math.max(WALK_MIN_SPACING_M, v)));
            }}
          />
          m while walking
        </label>
      )}
      {walk.error && <p className="warn">{walk.error}</p>}
      <div className="actions">
        {walk.active ? (
          <>
            <button type="button" className="primary" disabled={!good} onClick={props.onMarkHere}>
              Mark point here
            </button>
            <button type="button" className="ghost" onClick={props.onWalkStop}>
              Stop GPS
            </button>
          </>
        ) : (
          <button type="button" onClick={props.onWalkStart}>
            Start GPS walk
          </button>
        )}
      </div>
    </section>
  );
}
