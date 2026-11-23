import type { Proportion } from './contracts';

/** Effectif minimal d'une proportion affichée en clair (en dessous : « échantillon insuffisant »). */
export const MIN_SAMPLE_SIZE = 30;

/** Quantile normal à 95 % (bilatéral). */
export const Z_95 = 1.96;

function assertCounts(successes: number, total: number): void {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || successes < 0 || total < 0 || successes > total) {
    throw new RangeError('Effectifs invalides : 0 ≤ succès ≤ total, entiers.');
  }
}

/**
 * Intervalle de score de Wilson (docs/ARCHITECTURE.md §16.3), `null` si `total` = 0. Bornes
 * exactes à 0 (aucun succès) et à 1 (que des succès), bornées à [0, 1] sinon.
 */
export function wilsonInterval(successes: number, total: number, z: number = Z_95): { low: number; high: number } | null {
  assertCounts(successes, total);
  if (!Number.isFinite(z) || z <= 0) throw new RangeError('Quantile invalide.');
  if (total === 0) return null;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return {
    low: successes === 0 ? 0 : Math.max(0, center - half),
    high: successes === total ? 1 : Math.min(1, center + half),
  };
}

/** Proportion avec effectif, intervalle de Wilson à 95 % et drapeau « échantillon insuffisant ». */
export function proportion(successes: number, total: number, minSample: number = MIN_SAMPLE_SIZE): Proportion {
  assertCounts(successes, total);
  if (!Number.isInteger(minSample) || minSample < 1) throw new RangeError('Effectif minimal invalide.');
  const interval = wilsonInterval(successes, total);
  return {
    successes,
    total,
    value: total === 0 ? null : successes / total,
    low: interval?.low ?? null,
    high: interval?.high ?? null,
    insufficient: total < minSample,
  };
}
