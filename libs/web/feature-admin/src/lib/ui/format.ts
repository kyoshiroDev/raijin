import { type MetricUnit } from '@raijin/shared-contracts';

/**
 * Formatage des métriques de l'admin (fr-FR). L'API envoie des valeurs brutes et une unité (`MetricUnit`) :
 * seul le front choisit l'affichage. Formateurs `Intl` créés au premier usage (docs/ARCHITECTURE.md §10.2).
 */

const cache = new Map<string, Intl.NumberFormat>();

function numberFormat(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  let format = cache.get(key);
  if (!format) {
    format = new Intl.NumberFormat('fr-FR', options);
    cache.set(key, format);
  }
  return format;
}

/** Tiret affiché à la place d'une valeur absente. */
export const NO_VALUE = '—';
/** Vrai signe moins (U+2212), plus lisible que le trait d'union dans les chiffres. */
const MINUS = '−';

export interface MetricFormatOptions {
  /** Devise des montants (`cents`), `EUR` par défaut. */
  readonly currency?: string;
  /** Notation compacte (« 12,4 k ») pour les axes et les cartes étroites. */
  readonly compact?: boolean;
}

/** Valeur d'une métrique selon son unité ; `null` → « — ». */
export function formatMetric(value: number | null | undefined, unit: MetricUnit, options: MetricFormatOptions = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  const compact = options.compact === true;
  switch (unit) {
    case 'count':
      return compact && Math.abs(value) >= 10_000
        ? numberFormat('count-compact', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
        : numberFormat('count', { maximumFractionDigits: 0 }).format(value);
    case 'cents': {
      const currency = options.currency ?? 'EUR';
      const euros = value / 100;
      if (compact && Math.abs(euros) >= 10_000) {
        return numberFormat(`cents-compact-${currency}`, {
          style: 'currency',
          currency,
          notation: 'compact',
          maximumFractionDigits: 1,
        }).format(euros);
      }
      // Cartes étroites : pas de centimes au-delà de 1 000 (« 4 124 € »).
      const whole = Number.isInteger(euros) || (compact && Math.abs(euros) >= 1000);
      return numberFormat(`cents-${currency}-${whole}`, {
        style: 'currency',
        currency,
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: whole ? 0 : 2,
      }).format(euros);
    }
    case 'ratio':
      return numberFormat('ratio', { style: 'percent', maximumFractionDigits: 1 }).format(value);
    case 'ms':
      return value >= 1000
        ? `${numberFormat('s1', { maximumFractionDigits: 1 }).format(value / 1000)} s`
        : `${numberFormat('count', { maximumFractionDigits: 0 }).format(value)} ms`;
    case 'seconds':
      return formatDuration(value);
    case 'bytes':
      return formatBytes(value);
    case 'position':
      return numberFormat('position', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
  }
}

/**
 * Durée lisible : « 45 s », « 1 min 22 s », « 2 h 5 min ». Espace insécable entre nombre et unité : à l'étroit,
 * la valeur passe à la ligne entre les groupes (« 1 min » / « 22 s »), jamais entre « 22 » et « s ».
 */
function formatDuration(seconds: number): string {
  const nb = '\u00a0';
  const total = Math.round(seconds);
  if (total < 60) return `${total}${nb}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest ? `${minutes}${nb}min ${rest}${nb}s` : `${minutes}${nb}min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}${nb}h ${restMinutes}${nb}min` : `${hours}${nb}h`;
}

function formatBytes(bytes: number): string {
  const units = ['o', 'ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let index = 0;
  while (Math.abs(value) >= 1000 && index < units.length - 1) {
    value /= 1000;
    index++;
  }
  return `${numberFormat('bytes', { maximumFractionDigits: index === 0 ? 0 : 1 }).format(value)} ${units[index]}`;
}

/** Sens d'une variation, pour l'icône (flèche montante, descendante, stable). */
export type ChangeDirection = 'up' | 'down' | 'flat';
/** Lecture d'une variation : bonne, mauvaise ou neutre (selon `higherIsBetter`). */
export type ChangeTone = 'good' | 'bad' | 'neutral';

/** Variation inférieure à 0,05 % en valeur absolue : considérée stable. */
const FLAT_THRESHOLD = 0.0005;

export function changeDirection(change: number): ChangeDirection {
  if (Math.abs(change) < FLAT_THRESHOLD) return 'flat';
  return change > 0 ? 'up' : 'down';
}

export function changeTone(change: number, higherIsBetter: boolean): ChangeTone {
  const direction = changeDirection(change);
  if (direction === 'flat') return 'neutral';
  return (direction === 'up') === higherIsBetter ? 'good' : 'bad';
}

/** Variation relative signée : « +12,4 % », « −3 % », « 0 % ». */
export function formatChange(change: number): string {
  const direction = changeDirection(change);
  const magnitude = numberFormat('change', { style: 'percent', maximumFractionDigits: 1 }).format(Math.abs(change));
  if (direction === 'flat') return numberFormat('change', { style: 'percent', maximumFractionDigits: 1 }).format(0);
  return `${direction === 'up' ? '+' : MINUS}${magnitude}`;
}

/** Phrase complète pour les lecteurs d'écran : « en hausse de 12,4 % ». */
export function describeChange(change: number): string {
  const direction = changeDirection(change);
  if (direction === 'flat') return 'stable';
  const magnitude = numberFormat('change', { style: 'percent', maximumFractionDigits: 1 }).format(Math.abs(change));
  return `${direction === 'up' ? 'en hausse' : 'en baisse'} de ${magnitude}`;
}

const dayFormat = new Map<string, Intl.DateTimeFormat>();

function dateFormat(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let format = dayFormat.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', ...options });
    dayFormat.set(key, format);
  }
  return format;
}

/** Jour UTC court d'un axe de graphique : « 22 nov. ». */
export function formatDay(isoDate: string): string {
  return dateFormat('day', { day: 'numeric', month: 'short' }).format(new Date(`${isoDate.slice(0, 10)}T00:00:00Z`));
}

/** Jour UTC long : « 22 novembre 2026 ». */
export function formatLongDay(isoDate: string): string {
  return dateFormat('long', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${isoDate.slice(0, 10)}T00:00:00Z`));
}

/** Période « du 16 au 22 nov. » (ou « 22 nov. » sur un seul jour). */
export function formatRange(from: string, to: string): string {
  if (from === to) return formatDay(from);
  return `du ${formatDay(from)} au ${formatDay(to)}`;
}

/** Heure locale « 14:32 » d'un horodatage ISO (session admin, mise à jour des données). */
export function formatTime(iso: string | number): string {
  return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
