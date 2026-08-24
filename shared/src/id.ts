import { PLOT_ID_PREFIX } from './constants.js';

/** Short, human-readable, speakable over a phone: PLT-4471. */
export function generatePlotId(): string {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${PLOT_ID_PREFIX}-${n}`;
}
