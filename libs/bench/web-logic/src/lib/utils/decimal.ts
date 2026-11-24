// French-friendly decimal input parsing and percent ↔ fraction conversions (pure).

const DECIMAL_INPUT = /^(\d+([.,]\d*)?|[.,]\d+)$/;

/**
 * What the user typed → number. Accepts the French decimal comma (« 2,5 » → 2.5) and ignores spaces.
 * Empty, negative or malformed input → NaN (reported by validation, never sent). Range is NOT checked here.
 */
export function parseDecimalInput(text: string): number {
  const trimmed = text.replace(/\s/g, '');
  if (!DECIMAL_INPUT.test(trimmed)) return Number.NaN;
  return Number(trimmed.replace(',', '.'));
}

/** 25 (%) → 0.25. Rounded to 4 decimals to avoid binary noise (0.29 not 0.29000000000000004). NaN stays NaN. */
export function percentToFraction(pct: number): number {
  return Number.isFinite(pct) ? Math.round(pct * 100) / 10_000 : Number.NaN;
}

/** 0.25 → 25 (%), rounded to 2 decimals. */
export function fractionToPercent(f: number): number {
  return Number.isFinite(f) ? Math.round(f * 10_000) / 100 : Number.NaN;
}

const DECIMAL_FR = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2, useGrouping: false });

/** « 2,5 » — French formatting, at most 2 decimals; '' when not finite. */
export function formatDecimalFr(value: number): string {
  return Number.isFinite(value) ? DECIMAL_FR.format(value) : '';
}
