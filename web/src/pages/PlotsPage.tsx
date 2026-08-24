import {
  formatAcres,
  formatDate,
  formatHectares,
  formatLatLng,
  type Plot,
} from '@plot/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiRequestError } from '../api.js';

/** Saved plots, newest first. Clicking a row zooms the map to that boundary. */
export function PlotsPage() {
  const [plots, setPlots] = useState<Plot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .listPlots()
      .then(setPlots)
      .catch((err: ApiRequestError) => setError(err.fullMessage));
  }, []);

  if (error) return <p className="page warn">{error}</p>;
  if (!plots) return <p className="page">Loading…</p>;

  return (
    <div className="page">
      <h1>Saved plots</h1>
      <p className="hint">{plots.length} plot(s). Click a row to zoom it on the map.</p>
      <table className="plots-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th className="num">Area</th>
            <th className="num">Acres</th>
            <th>Centroid</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {plots.map((plot) => (
            <tr
              key={plot.id}
              onClick={() => navigate(`/?focus=${plot.id}`)}
              title="Zoom to this plot on the map"
            >
              <td className="mono">{plot.id}</td>
              <td>{plot.name}</td>
              <td className="num">{formatHectares(plot.area_sq_m)}</td>
              <td className="num">{formatAcres(plot.area_sq_m)}</td>
              <td className="mono small">{formatLatLng(plot.centroid_lat, plot.centroid_lng, 5)}</td>
              <td>{formatDate(plot.created_at)}</td>
              <td>
                <a
                  href={`/api/plots/${plot.id}/geojson`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  GeoJSON
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {plots.length === 0 && (
        <p className="hint">
          Nothing saved yet — <Link to="/">draw one on the map</Link>.
        </p>
      )}
    </div>
  );
}
