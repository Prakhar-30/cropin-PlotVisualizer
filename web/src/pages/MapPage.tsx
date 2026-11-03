import { type IndexKey, type Plot } from '@plot/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiRequestError, type PlotHealth } from '../api.js';
import { DrawPanel } from '../components/DrawPanel.js';
import { HealthPanel } from '../components/HealthPanel.js';
import { LocateButton } from '../components/LocateButton.js';
import { SearchBox } from '../components/SearchBox.js';
import { emptyDrawState, PlotDrawController, type DrawState } from '../lib/drawController.js';
import { useGpsWalk } from '../lib/useGpsWalk.js';
import { CurrentLocationLayer } from '../lib/currentLocationLayer.js';
import { emptyPathState, PathDrawController, type PathDrawState } from '../lib/pathDrawController.js';
import { PlotHealthLayer } from '../lib/healthLayer.js';
import { SavedPlotsLayer } from '../lib/plotsLayer.js';
import { useMapLibre } from '../lib/useMapLibre.js';

export function MapPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const map = useMapLibre(containerRef);
  const controller = useRef<PlotDrawController | null>(null);
  const savedLayer = useRef<SavedPlotsLayer | null>(null);
  const healthLayer = useRef<PlotHealthLayer | null>(null);
  const hereLayer = useRef<CurrentLocationLayer | null>(null);
  const pathsLayer = useRef<PathDrawController | null>(null);

  const [drawState, setDrawState] = useState<DrawState>(emptyDrawState);
  const [plots, setPlotList] = useState<Plot[]>([]);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Plot | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** The saved plot being edited, or null when drawing a new one. */
  const [editing, setEditing] = useState<Plot | null>(null);
  const [pathState, setPathState] = useState<PathDrawState>(emptyPathState);
  const [searchParams, setSearchParams] = useSearchParams();

  const [healthOn, setHealthOn] = useState(true);
  const [healthByPlot, setHealthByPlot] = useState<ReadonlyMap<string, PlotHealth>>(new Map());
  const [healthPending, setHealthPending] = useState(0);
  /** Ids asked for already, so a plot list refresh does not refetch them. */
  const healthRequested = useRef(new Set<string>());
  const [healthIndex, setHealthIndex] = useState<IndexKey>('ndvi');
  /** On a phone only one panel fits; this says which. Ignored on a desktop. */
  const [mobilePanel, setMobilePanel] = useState<'draw' | 'health'>('health');

  const gps = useGpsWalk({
    mark: (position) => controller.current?.addVertex(position) ?? false,
    lastVertex: () => controller.current?.lastVertex() ?? null,
    onFix: (fix, first) => {
      hereLayer.current?.setFix(fix);
      if (first) map?.flyTo({ center: [fix.lng, fix.lat], zoom: Math.max(map.getZoom(), 18), duration: 700 });
    },
  });

  const refreshPlots = useCallback(async () => {
    try {
      setPlotList(await api.listPlots());
    } catch (err) {
      setError((err as ApiRequestError).fullMessage);
    }
  }, []);

  /*
   * `setSearchParams` gets a fresh identity on every render, so putting it in
   * the effect below would rebuild both overlays constantly - and the rebuild
   * throws on the second `addSource` for an id that already exists. Reading it
   * through a ref keeps the overlays tied to the map's lifetime alone.
   */
  const selectPlot = useRef<(id: string) => void>(() => {});
  selectPlot.current = (id) => setSearchParams({ focus: id });

  // Draw tool and saved-plot layers live for as long as the map does.
  useEffect(() => {
    if (!map) return;
    const layer = new SavedPlotsLayer(map, (id) => selectPlot.current(id));
    // Health cells go underneath the saved-plot outlines: the grid is context,
    // the boundary is the thing being agreed on, so the boundary stays on top.
    const grid = new PlotHealthLayer(map, layer.bottomLayerId());
    const here = new CurrentLocationLayer(map, layer.bottomLayerId());
    const draw = new PlotDrawController(map, setDrawState);
    // Paths sit over the health grid and under the boundaries, like the ground they are.
    const paths = new PathDrawController(map, setPathState, layer.bottomLayerId());
    savedLayer.current = layer;
    pathsLayer.current = paths;
    healthLayer.current = grid;
    hereLayer.current = here;
    controller.current = draw;
    void refreshPlots();
    return () => {
      paths.destroy();
      pathsLayer.current = null;
      draw.destroy();
      here.destroy();
      grid.destroy();
      layer.destroy();
      controller.current = null;
      savedLayer.current = null;
      healthLayer.current = null;
      hereLayer.current = null;
    };
  }, [map, refreshPlots]);

  useEffect(() => {
    // The plot being edited is drawn by the editor, not as a saved plot.
    savedLayer.current?.setPlots(plots.filter((p) => p.id !== editing?.id));
    pathsLayer.current?.setSaved(plots, editing?.id ?? null);
  }, [map, plots, editing]);

  /** Forgets a plot's crop condition, so it is fetched again - after an edit. */
  const refetchHealth = (id: string) => {
    healthRequested.current.delete(id);
    setHealthByPlot((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  };

  const stopEditing = () => {
    setEditing(null);
    setName('');
    setNote('');
    controller.current?.reset();
    pathsLayer.current?.clear();
  };

  const handleEdit = (plot: Plot) => {
    setSaved(null);
    setError(null);
    setEditing(plot);
    setName(plot.name);
    setNote(plot.landmark_note);
    controller.current?.load(plot.polygon);
    pathsLayer.current?.load(plot.exclusions);
    setMobilePanel('draw');
  };

  // `?focus=PLT-4471` is how the list page zooms the map to a row.
  const focusId = searchParams.get('focus');
  useEffect(() => {
    if (!map || !focusId) return;
    const layer = savedLayer.current;
    if (!layer) return;
    const known = plots.find((p) => p.id === focusId);
    if (known) {
      layer.zoomTo(known);
      return;
    }
    api
      .getPlot(focusId)
      .then((plot) => layer.zoomTo(plot))
      .catch((err: ApiRequestError) => setError(err.fullMessage));
  }, [map, focusId, plots]);

  /*
   * Crop condition for every saved plot, fetched once each and kept: a few at a
   * time so a long plot list does not open dozens of connections at once, and
   * only while the toggle is on, so drawing a boundary costs no rasters. A
   * failed fetch is forgotten, so the next refresh of the list retries it.
   */
  useEffect(() => {
    if (!healthOn) return;
    const todo = plots.map((p) => p.id).filter((id) => !healthRequested.current.has(id));
    if (todo.length === 0) return;
    for (const id of todo) healthRequested.current.add(id);
    setHealthPending((n) => n + todo.length);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const id = todo[next++];
        try {
          const snapshot = await api.getPlotHealth(id);
          setHealthByPlot((current) => new Map(current).set(id, snapshot));
        } catch {
          healthRequested.current.delete(id);
        } finally {
          setHealthPending((n) => n - 1);
        }
      }
    };
    for (let i = 0; i < Math.min(4, todo.length); i++) void worker();
  }, [healthOn, plots]);

  // One fetch carries all three indices; switching index only redraws.
  useEffect(() => {
    const names = new Map(plots.map((p) => [p.id, p.name] as const));
    const snapshots = plots.flatMap((p) => healthByPlot.get(p.id) ?? []);
    healthLayer.current?.setSnapshots(snapshots, healthIndex, names);
    healthLayer.current?.setVisible(healthOn);
  }, [map, healthOn, healthByPlot, healthIndex, plots]);

  const handleSave = async () => {
    const polygon = controller.current?.toPolygon();
    if (!polygon) return;

    setSaving(true);
    setError(null);
    try {
      const input = {
        name,
        polygon,
        landmark_note: note,
        exclusions: pathsLayer.current?.toExclusions() ?? [],
      };
      const plot = editing ? await api.updatePlot(editing.id, input) : await api.createPlot(input);
      if (editing) refetchHealth(plot.id);
      setSaved(plot);
      stopEditing();
      await refreshPlots();
    } catch (err) {
      setError((err as ApiRequestError).fullMessage);
    } finally {
      setSaving(false);
    }
  };

  const selectedPlot = plots.find((p) => p.id === focusId) ?? null;

  const handleDelete = async (plot: Plot) => {
    if (!window.confirm(`Delete ${plot.id} "${plot.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deletePlot(plot.id);
      if (saved?.id === plot.id) setSaved(null);
      if (editing?.id === plot.id) stopEditing();
      setSearchParams({});
      await refreshPlots();
    } catch (err) {
      setError((err as ApiRequestError).fullMessage);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="map-page">
      <div ref={containerRef} className="map" />
      <SearchBox
        onPick={(hit) => {
          if (!map) return;
          if (hit.bbox) {
            map.fitBounds([[hit.bbox[0], hit.bbox[1]], [hit.bbox[2], hit.bbox[3]]], { padding: 60 });
          } else {
            map.flyTo({ center: [hit.lng, hit.lat], zoom: 16 });
          }
        }}
      />
      <LocateButton
        onLocated={(fix) => {
          hereLayer.current?.setFix(fix);
          // Zoom chosen from the fix's own accuracy rather than fixed: framing
          // a 2 km Wi-Fi fix at building zoom would imply a precision the
          // position does not have.
          map?.flyTo({
            center: [fix.lng, fix.lat],
            zoom: fix.accuracyM > 500 ? 15 : 18,
            duration: 900,
          });
        }}
      />
      <div className="mobile-tabs" role="tablist" aria-label="Panel">
        <button
          type="button"
          role="tab"
          aria-selected={mobilePanel === 'health'}
          className={mobilePanel === 'health' ? 'is-active' : ''}
          onClick={() => setMobilePanel('health')}
        >
          Crop condition
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobilePanel === 'draw'}
          className={mobilePanel === 'draw' ? 'is-active' : ''}
          onClick={() => setMobilePanel('draw')}
        >
          Mark a plot
        </button>
      </div>
      <HealthPanel
        className={mobilePanel === 'health' ? '' : 'is-mobile-hidden'}
        enabled={healthOn}
        pending={healthPending}
        plots={plots}
        snapshots={healthByPlot}
        index={healthIndex}
        onToggle={setHealthOn}
        onIndexChange={setHealthIndex}
        onFocusPatch={(lat, lng) => map?.flyTo({ center: [lng, lat], zoom: 19, duration: 700 })}
      />
      <DrawPanel
        className={mobilePanel === 'draw' ? '' : 'is-mobile-hidden'}
        state={drawState}
        name={name}
        note={note}
        saving={saving}
        error={error}
        saved={saved}
        onNameChange={setName}
        onNoteChange={setNote}
        onUndo={() => controller.current?.undoLast()}
        onClose={() => controller.current?.close()}
        onStartNew={() => {
          setSaved(null);
          setError(null);
          controller.current?.startNew();
          pathsLayer.current?.clear();
        }}
        onClear={() => {
          setSaved(null);
          setError(null);
          controller.current?.reset();
          pathsLayer.current?.clear();
        }}
        onSave={handleSave}
        selected={selectedPlot}
        deleting={deleting}
        onDelete={(plot) => void handleDelete(plot)}
        onEdit={handleEdit}
        editing={editing}
        onCancelEdit={stopEditing}
        paths={pathState}
        onAddPath={() => pathsLayer.current?.startPath()}
        onFinishPath={() => pathsLayer.current?.finishPath()}
        onCancelPath={() => pathsLayer.current?.cancelPath()}
        onRemovePath={(i) => pathsLayer.current?.removePath(i)}
        onPathWidth={(w) => pathsLayer.current?.setWidth(w)}
        walk={gps.walk}
        onWalkStart={() => {
          setSaved(null);
          setError(null);
          gps.start();
        }}
        onWalkStop={gps.stop}
        onMarkHere={gps.markHere}
        onWalkAuto={gps.setAuto}
        onWalkSpacing={gps.setSpacing}
      />
    </div>
  );
}
