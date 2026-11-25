/** Non-breaking space placed before a unit (« 85,0 k$ », « 0,0004200 $ ») so the number never wraps away from it. */
export const NBSP = '\u00a0';

const FIXED_FR = new Map<number, Intl.NumberFormat>();

/** fr-FR number with exactly `decimals` decimals (decimal comma, fr grouping). */
export function fixedFr(value: number, decimals: number): string {
  let f = FIXED_FR.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    FIXED_FR.set(decimals, f);
  }
  return f.format(value);
}

/** USD amount, fr-FR compact: « 1,23 Md$ », « 1,23 M$ », « 85,0 k$ », « 420 $ » (non-breaking space); '–' when unknown. */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '–';
  if (value >= 1e9) return `${fixedFr(value / 1e9, 2)}${NBSP}Md$`;
  if (value >= 1e6) return `${fixedFr(value / 1e6, 2)}${NBSP}M$`;
  if (value >= 1e3) return `${fixedFr(value / 1e3, 1)}${NBSP}k$`;
  return `${fixedFr(value, 0)}${NBSP}$`;
}

/** Decimals of a sub-dollar price: 4 significant digits (« 0,0004200 »), between 2 and 12. */
export function priceDecimals(value: number): number {
  return Math.min(12, Math.max(2, -Math.floor(Math.log10(value)) + 3));
}

/** USD price, fr-FR: « 2,000 $ », « 0,0004200 $ » (non-breaking space); '–' when unknown. */
export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '–';
  return `${fixedFr(value, value >= 1 ? 3 : priceDecimals(value))}${NBSP}$`;
}

/** « +4,2 % » / « −3,1 % » (U+2212 minus) / « 0,0 % »; '–' when unknown. */
export function formatPct(value: number | null | undefined): string {
  return formatSignedPercentFr(value);
}

export function formatAge(isoDate: string | null | undefined, now = Date.now()): string {
  if (!isoDate) return '–';
  const hours = (now - new Date(isoDate).getTime()) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 0) return '–';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} j`;
}

const COUNT_FORMAT = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '–';
  return COUNT_FORMAT.format(value);
}

/** « Mis à jour il y a X min » — pure, `now` injectable for tests; `prefix` e.g. « Enrichi ». */
export function formatUpdatedAgo(at: Date | string | null | undefined, now = Date.now(), prefix = 'Mis à jour'): string {
  if (at == null) return 'Pas encore de données';
  const ms = typeof at === 'string' ? Date.parse(at) : at.getTime();
  if (!Number.isFinite(ms)) return 'Pas encore de données';
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return `${prefix} à l’instant`;
  if (minutes < 60) return `${prefix} il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${prefix} il y a ${hours} h`;
  return `${prefix} il y a ${Math.floor(hours / 24)} j`;
}

const PCT_FR = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** « 2,4 % » (French decimal comma, 1 decimal, no sign); '–' when unknown. */
export function formatPercentFr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '–';
  return `${PCT_FR.format(value)} %`;
}

/** « +20,0 % » / « −12,5 % » (U+2212 minus) / « 0,0 % »; '–' when unknown. */
export function formatSignedPercentFr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '–';
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return `${sign}${formatPercentFr(Math.abs(rounded))}`;
}

const SOL_SMALL = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
const SOL_LARGE = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
/** Smallest amount shown as a number; anything positive below reads « < 0,0001 ». */
const SOL_MIN_SHOWN = 0.0001;

/**
 * SOL amount, French decimal comma, no unit: at most 4 decimals under 0.01 SOL (« 0,0013 »),
 * otherwise at most 3 (« 0,125 », « 1,5 »). Positive amounts below 0.0001 → « < 0,0001 ».
 * Negative or non-finite → '–'.
 */
export function formatSolAmount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '–';
  if (value > 0 && value < SOL_MIN_SHOWN) return '< 0,0001';
  return (value < 0.01 ? SOL_SMALL : SOL_LARGE).format(value);
}

const EUR_FORMAT = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** « 0,19 € » (2 decimals); positive amounts below 1 centime → « < 0,01 € »; '–' when unknown. */
export function formatEur(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '–';
  if (value > 0 && value < 0.005) return '< 0,01 €';
  return `${EUR_FORMAT.format(value)} €`;
}

/**
 * « 0,0013 SOL (≈ 0,19 €) » — the € part only when a valid EUR-per-SOL rate is known
 * (from the latest scan run; never fetched from the browser). '–' when the amount is unknown.
 */
export function formatSolEur(sol: number | null | undefined, eurPerSol: number | null | undefined): string {
  const amount = formatSolAmount(sol);
  if (amount === '–' || sol == null) return amount;
  const withUnit = `${amount} SOL`;
  if (eurPerSol == null || !Number.isFinite(eurPerSol) || eurPerSol <= 0) return withUnit;
  return `${withUnit} (≈ ${formatEur(sol * eurPerSol)})`;
}

/** « +0,05 SOL » / « −0,0123 SOL » (U+2212 minus) / « 0 SOL »; '–' when unknown. */
export function formatSignedSol(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '–';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${formatSolAmount(Math.abs(value))} SOL`;
}
