import { type Plot } from '@plot/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiRequestError, type PlotHealth } from '../api.js';
import { DrawPanel } from '../components/DrawPanel.js';
import { HealthPanel } from '../components/HealthPanel.js';
import { LocateButton } from '../components/LocateButton.js';
import { SearchBox } from '../components/SearchBox.js';
import { emptyDrawState, PlotDrawController, type DrawState } from '../lib/drawController.js';
import { CurrentLocationLayer } from '../lib/currentLocationLayer.js';
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

  const [drawState, setDrawState] = useState<DrawState>(emptyDrawState);
  const [plots, setPlotList] = useState<Plot[]>([]);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Plot | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const [healthOn, setHealthOn] = useState(false);
  const [health, setHealth] = useState<PlotHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);

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
    savedLayer.current = layer;
    healthLayer.current = grid;
    hereLayer.current = here;
    controller.current = draw;
    void refreshPlots();
    return () => {
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
    savedLayer.current?.setPlots(plots);
  }, [map, plots]);

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
   * Health follows the focused plot. Fetching only when the toggle is on keeps
   * the raster off the wire for the common case - drawing a new boundary - where
   * it would be a few hundred kilobytes of nothing anyone asked for.
   */
  useEffect(() => {
    if (!healthOn || !focusId) {
      setHealth(null);
      healthLayer.current?.clear();
      return;
    }
    let cancelled = false;
    setHealthLoading(true);
    setHealthError(null);
    api
      .getPlotHealth(focusId)
      .then((snapshot) => {
        if (cancelled) return;
        setHealth(snapshot);
        healthLayer.current?.setSnapshot(snapshot);
      })
      .catch((err: ApiRequestError) => {
        if (!cancelled) setHealthError(err.fullMessage);
      })
      .finally(() => {
        if (!cancelled) setHealthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [healthOn, focusId]);

  useEffect(() => {
    healthLayer.current?.setVisible(healthOn);
  }, [healthOn, health]);

  const handleSave = async () => {
    const polygon = controller.current?.toPolygon();
    const access = controller.current?.getAccessPoint();
    if (!polygon || !access) return;

    setSaving(true);
    setError(null);
    try {
      const plot = await api.createPlot({
        name,
        polygon,
        access_lng: access[0],
        access_lat: access[1],
        landmark_note: note,
      });
      setSaved(plot);
      setName('');
      setNote('');
      controller.current?.reset();
      await refreshPlots();
    } catch (err) {
      setError((err as ApiRequestError).fullMessage);
    } finally {
      setSaving(false);
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
      <HealthPanel
        enabled={healthOn}
        loading={healthLoading}
        plotId={focusId}
        snapshot={health}
        error={healthError}
        onToggle={setHealthOn}
        onFocusHotspot={(lat, lng) => map?.flyTo({ center: [lng, lat], zoom: 19, duration: 700 })}
      />
      <DrawPanel
        state={drawState}
        name={name}
        note={note}
        saving={saving}
        error={error}
        saved={saved}
        onNameChange={setName}
        onNoteChange={setNote}
        onStartNew={() => {
          setSaved(null);
          setError(null);
          controller.current?.startNew();
        }}
        onClear={() => {
          setSaved(null);
          setError(null);
          controller.current?.reset();
        }}
        onSave={handleSave}
      />
    </div>
  );
}
