import { InjectionToken } from '@angular/core';
import type { ChartConfiguration } from 'chart.js';

/** Instance minimale utilisée par `rj-chart` (permet une doublure dans les tests, sans canvas). */
export interface RjChartInstance {
  config: ChartConfiguration | { type: string; data: unknown; options?: unknown };
  data: ChartConfiguration['data'];
  options: ChartConfiguration['options'];
  update(mode?: 'none'): void;
  destroy(): void;
}

export type RjChartFactory = (canvas: HTMLCanvasElement, config: ChartConfiguration) => RjChartInstance;

let loading: Promise<RjChartFactory> | null = null;

/**
 * Chart.js 4 chargé **à la demande** (chunk séparé, jamais dans le bundle initial) et enregistré module par
 * module : contrôleurs line / bar / doughnut, échelles catégorie et linéaire, infobulle, remplissage.
 * Pas d'échelle `time` (dates formatées par `Intl`), pas de `Legend` (légende HTML accessible).
 */
export function loadChartJs(): Promise<RjChartFactory> {
  loading ??= import('./chart-modules')
    .then((m) => m.createChart)
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

/** Chargeur de Chart.js utilisé par `rj-chart` (remplacé par une doublure dans les tests). */
export const RJ_CHART_LOADER = new InjectionToken<() => Promise<RjChartFactory>>('RJ_CHART_LOADER', {
  providedIn: 'root',
  factory: () => loadChartJs,
});
