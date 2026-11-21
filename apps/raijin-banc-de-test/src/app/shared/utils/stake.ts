// The user's usual stake in SOL (public.alert_settings.stake_sol, check 0.01–100).

export const DEFAULT_STAKE_SOL = 0.05;
export const STAKE_LIMITS = { min: 0.01, max: 100, step: 0.01 } as const;

export function isValidStake(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= STAKE_LIMITS.min && value <= STAKE_LIMITS.max;
}

const STAKE_INPUT = /^(\d+([.,]\d*)?|[.,]\d+)$/;

/**
 * What the user typed → number. Accepts the French decimal comma (« 0,25 » → 0.25).
 * Empty or malformed input → NaN (reported by validation, never sent). Range is NOT checked here.
 */
export function parseStakeInput(text: string): number {
  const trimmed = text.trim().replace(/\s/g, '');
  if (!STAKE_INPUT.test(trimmed)) return Number.NaN;
  return Number(trimmed.replace(',', '.'));
}

/** Database value (number, or numeric text) → valid stake, or null. */
export function parseStakeValue(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return isValidStake(n) ? n : null;
}

const SOL_FORMAT = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** « 0,25 » — French formatting, at most 2 decimals. */
export function formatSol(value: number): string {
  return SOL_FORMAT.format(value);
}
