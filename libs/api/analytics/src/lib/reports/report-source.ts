import type { AdminSeoData, AdminTrafficData, DateRange, SeoWindow } from '@raijin/shared-contracts';

/** Période de l'écran Trafic : courante et précédente (même longueur), jours inclus. */
export interface TrafficQuery {
  readonly current: DateRange;
  readonly previous: DateRange;
}

/** Fenêtre de l'écran SEO, relative au jour UTC `today` (`AAAA-MM-JJ`). */
export interface SeoQuery {
  readonly window: SeoWindow;
  readonly today: string;
}

/**
 * Source des rapports Google : API réelles (`GoogleReportSource`) ou données simulées (`FakeReportSource`).
 * Les données renvoyées sont **validées par les contrats** avant de sortir de la lib (textes hostiles bornés).
 * Une erreur Google est levée en `GoogleApiError` (code interne seulement).
 */
export interface ReportSource {
  readonly simulated: boolean;
  traffic(query: TrafficQuery): Promise<AdminTrafficData>;
  seo(query: SeoQuery): Promise<AdminSeoData>;
}

const DAY_MS = 86_400_000;

/** Jours `AAAA-MM-JJ` de `from` à `to` inclus. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length < 400; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Décale un jour UTC de `days` jours. */
export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
