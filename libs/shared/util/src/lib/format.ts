const LOCALE = 'fr-FR';
const NBSP = '\u00a0';

/**
 * Formateurs créés au premier usage : instancier `Intl.NumberFormat` au chargement du module coûte
 * ~15 ms de CPU par formateur sur mobile (données ICU), sur le chemin critique du premier écran.
 */
function lazyFormatter(options: Intl.NumberFormatOptions): () => Intl.NumberFormat {
  let formatter: Intl.NumberFormat | undefined;
  return () => (formatter ??= new Intl.NumberFormat(LOCALE, options));
}

const compactFormatter = lazyFormatter({ notation: 'compact', maximumFractionDigits: 1 });
const exactFormatter = lazyFormatter({ maximumFractionDigits: 2 });
const percentFormatter = lazyFormatter({ style: 'percent', maximumFractionDigits: 1 });

/** Normalise les espaces insécables fines (U+202F) en espaces insécables (U+00A0). */
function normalizeSpaces(value: string): string {
  return value.replace(/\u202f/g, NBSP);
}

/**
 * Montant compact en français : `1 234 567` → `1,2 M$`, `340 000` → `340 k$`, `12,5` → `12,5 $`.
 * La valeur exacte doit être affichée en `title` (voir `formatExactAmount`).
 */
export function formatCompactAmount(value: number, symbol = '$'): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const compact = normalizeSpaces(compactFormatter().format(value));
  if (!symbol) {
    return compact;
  }
  // Après un suffixe (k, M, Md), le symbole est collé : « 1,2 M$ ».
  return /[a-zA-Z]$/.test(compact)
    ? `${compact}${symbol}`
    : `${compact}${NBSP}${symbol}`;
}

/** Montant exact en français : `1234567.891` → `1 234 567,89 $`. */
export function formatExactAmount(value: number, symbol = '$'): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const exact = normalizeSpaces(exactFormatter().format(value));
  return symbol ? `${exact}${NBSP}${symbol}` : exact;
}

/** Pourcentage à partir d'une fraction : `0.4123` → `41,2 %`. */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) {
    return '—';
  }
  return normalizeSpaces(percentFormatter().format(fraction));
}
