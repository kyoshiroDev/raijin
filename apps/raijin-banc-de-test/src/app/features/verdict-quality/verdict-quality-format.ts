import type { Period, Proportion } from '@raijin/bench-verdicts';

/** Mise en forme fr-FR des chiffres de l'écran /justesse (aucun calcul : tout vient de @raijin/bench-verdicts). */

const PCT = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const POINTS = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' });
const RATIO = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DAY = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Fraction → « 35,1 % » ; `null` → « — ». */
export function formatPct(value: number | null): string {
  return value === null ? '—' : `${PCT.format(value * 100)} %`;
}

/** Intervalle de Wilson → « IC 95 % : 28,0 – 42,7 % ». */
export function formatInterval(p: Proportion): string {
  if (p.low === null || p.high === null) return 'IC 95 % : —';
  return `IC 95 % : ${PCT.format(p.low * 100)} – ${PCT.format(p.high * 100)} %`;
}

/** Effectif : « 34 / 97 ». */
export function formatCount(p: Proportion): string {
  return `${p.successes} / ${p.total}`;
}

/** Écart de deux parts en points de pourcentage : « +4,0 pts », « 0,0 pt » ; `null` → « — ». */
export function formatDeltaPoints(delta: number | null): string {
  if (delta === null) return '—';
  const points = delta * 100;
  return `${POINTS.format(points)} ${Math.abs(points) >= 2 ? 'pts' : 'pt'}`;
}

/** Lift → « ×2,31 » ; `null` → « non classé ». */
export function formatLift(lift: number | null): string {
  return lift === null ? 'non classé' : `×${RATIO.format(lift)}`;
}

/** Période → « 1 sept. 2026 – 20 oct. 2026 » (UTC). */
export function formatPeriod(period: Period | null): string {
  if (period === null) return 'aucune donnée';
  return `${DAY.format(new Date(period.from))} – ${DAY.format(new Date(period.to))}`;
}
