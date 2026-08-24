import type { ApiError, HealthSnapshot, Plot, PlotInput, PlotWithDistance } from '@plot/shared';

/** The only place in the web app that talks HTTP. */

const BASE: string = import.meta.env.VITE_API_BASE ?? '/api';

export class ApiRequestError extends Error {
  readonly details: string[];
  readonly status: number;

  constructor(status: number, message: string, details: string[] = []) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.details = details;
  }

  /** Everything the server complained about, as one readable string. */
  get fullMessage(): string {
    return this.details.length > 0 ? `${this.message}: ${this.details.join('; ')}` : this.message;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch (cause) {
    throw new ApiRequestError(0, 'cannot reach the API', [(cause as Error).message]);
  }
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (payload ?? {}) as ApiError;
    throw new ApiRequestError(res.status, err.error ?? res.statusText, err.details ?? []);
  }
  return payload as T;
}

/** A health snapshot as the API serves it, including its provenance warning. */
export interface PlotHealth extends HealthSnapshot {
  synthetic: boolean;
  note: string;
}

export const api = {
  listPlots: () => request<Plot[]>('/plots'),

  listPlotsNear: (lat: number, lng: number, radiusM: number) =>
    request<PlotWithDistance[]>(
      `/plots?near=${lat},${lng}&radius_m=${radiusM}`,
    ),

  getPlot: (id: string) => request<Plot>(`/plots/${encodeURIComponent(id)}`),

  /** The pixelated health raster for one plot, plus its ranked hotspots. */
  getPlotHealth: (id: string) =>
    request<PlotHealth>(`/plots/${encodeURIComponent(id)}/health`),

  createPlot: (input: PlotInput) =>
    request<Plot>('/plots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
};
