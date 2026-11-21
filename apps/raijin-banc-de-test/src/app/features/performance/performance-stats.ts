// Shared sample-size rule and formatters (Performance screen, portfolio stats).
import { formatCount } from '../../shared/utils/format';
/**
 * Below this many labelled rows (a KPI, or one bucket of a breakdown) a rate is NEVER shown in large type:
 * only small and muted, with the sample size and « échantillon trop petit ».
 */
export const MIN_SAMPLE_FOR_RATE = 30;

/** True from MIN_SAMPLE_FOR_RATE labelled rows upwards. */
export function hasEnoughSample(n: number): boolean {
  return Number.isFinite(n) && n >= MIN_SAMPLE_FOR_RATE;
}

/** « 3 / 12 » (counts, French grouping). */
export function formatHits(hits: number, n: number): string {
  return `${formatCount(hits)} / ${formatCount(n)}`;
}

const RATE_FR = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Fraction → « 8,4 % »; « — » when unknown. */
export function formatRate(r: number | null): string {
  return r === null || !Number.isFinite(r) ? '—' : `${RATE_FR.format(r * 100)} %`;
}
