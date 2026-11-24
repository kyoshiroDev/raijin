// Pure parsing / ordering / labelling of public.performance_breakdown() rows (Performance screen).
// Outcomes are labelled server-side from 15-minute GeckoTerminal OHLCV candles; `n` counts LABELLED rows and every
// rate below uses it as denominator. `n_final` is the subset whose 7-day window is over.
// Only the main scanner source is kept (slim-down 2026-11-21): Radar and the removed presets are ignored, and so is the
// entry-zone dimension (Fibonacci removed).
import { formatCount } from '../../shared/utils/format';
import { hasEnoughSample } from './performance-stats';

export type BreakdownSource = 'scan';
export type BreakdownDimension = 'all' | 'dex' | 'mc' | 'liq';

export interface BreakdownRow {
  source: BreakdownSource;
  dimension: BreakdownDimension;
  bucket: string;
  n: number;
  n_final: number;
  x2: number;
  x3: number;
  x2_before_sl30: number;
  sl30_before_x2: number;
  dd50_first: number;
  median_max_multiple: number | null;
}

export const SOURCES: readonly { id: BreakdownSource; label: string; hint: string }[] = [
  { id: 'scan', label: 'Scan', hint: 'Détections du scanner principal.' },
];

/** Breakdown dimensions in display order ('all' is the overview, not listed here). */
export const DIMENSIONS: readonly { id: Exclude<BreakdownDimension, 'all'>; title: string }[] = [
  { id: 'dex', title: 'Par DEX' },
  { id: 'mc', title: 'Par tranche de market cap' },
  { id: 'liq', title: 'Par liquidité effective' },
];

const SOURCE_IDS: readonly string[] = SOURCES.map((s) => s.id);
const DIMENSION_IDS: readonly string[] = ['all', 'dex', 'mc', 'liq'];

export function isBreakdownSource(v: unknown): v is BreakdownSource {
  return typeof v === 'string' && SOURCE_IDS.includes(v);
}

/** Non-negative integer count (PostgREST may send integers / numerics as text), else null. */
export function parseCount(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

function parseMultiple(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

const COUNT_FIELDS = ['n', 'n_final', 'x2', 'x3', 'x2_before_sl30', 'sl30_before_x2', 'dd50_first'] as const;

/**
 * Defensive parse of one row: unknown source / dimension, a missing count, or inconsistent counts
 * (a hit count or n_final above n, both orders together above n) → null.
 */
export function parseBreakdownRow(value: unknown): BreakdownRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const { source, dimension, bucket } = r;
  if (!isBreakdownSource(source) || typeof dimension !== 'string' || !DIMENSION_IDS.includes(dimension)) return null;
  if (typeof bucket !== 'string' || bucket.trim() === '') return null;
  const counts: Partial<Record<(typeof COUNT_FIELDS)[number], number>> = {};
  for (const field of COUNT_FIELDS) {
    const c = parseCount(r[field]);
    if (c === null) return null;
    counts[field] = c;
  }
  const { n = 0, n_final = 0, x2 = 0, x3 = 0, x2_before_sl30 = 0, sl30_before_x2 = 0, dd50_first = 0 } = counts;
  if ([n_final, x2, x3, x2_before_sl30, sl30_before_x2, dd50_first].some((c) => c > n)) return null;
  if (x2_before_sl30 + sl30_before_x2 > n) return null;
  return {
    source,
    dimension: dimension as BreakdownDimension,
    bucket,
    n,
    n_final,
    x2,
    x3,
    x2_before_sl30,
    sl30_before_x2,
    dd50_first,
    median_max_multiple: parseMultiple(r['median_max_multiple']),
  };
}

export function parseBreakdownRows(data: unknown): BreakdownRow[] {
  return Array.isArray(data) ? data.map(parseBreakdownRow).filter((r): r is BreakdownRow => r !== null) : [];
}

const DEX_LABEL: Record<string, string> = {
  pumpswap: 'PumpSwap',
  pumpfun: 'Pump.fun (bonding curve)',
  raydium: 'Raydium',
  meteora: 'Meteora',
  orca: 'Orca',
  other: 'Autres',
};

interface Amount {
  value: number;
  text: string;
}

const AMOUNT_FR = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

/** « 50k » → 50 000 / « 50 k$ », « 1M » → 1 000 000 / « 1 M$ », « 500 » → « 500 $ »; null when not an amount. */
function parseAmount(raw: string): Amount | null {
  const m = /^(\d+(?:[.,]\d+)?)\s*([kKmM])?$/.exec(raw.trim());
  if (!m) return null;
  const base = Number(m[1]!.replace(',', '.'));
  const unit = m[2]?.toLowerCase();
  const value = unit === 'k' ? base * 1_000 : unit === 'm' ? base * 1_000_000 : base;
  const text = `${AMOUNT_FR.format(base)}${unit === 'k' ? ' k' : unit === 'm' ? ' M' : ' '}$`;
  return { value, text };
}

interface RangeBucket {
  /** Lower bound used for sorting (upper bound for « < x »). */
  value: number;
  /** 0 = « < x » (before a range starting at x), 1 = range, 2 = « ≥ x » / « > x ». */
  rank: number;
  label: string;
}

/** « <50k », « lt20k », « 50k-100k », « 100k–1M », « >1M », « >=50k », « gte1m », « 1m+ »; null otherwise. */
export function parseRangeBucket(bucket: string): RangeBucket | null {
  const b = bucket.trim();
  let m = /^(?:<|lt)\s*(.+)$/i.exec(b);
  if (m && !/^(?:<=|lte)/i.test(b)) {
    const a = parseAmount(m[1]!);
    return a ? { value: a.value, rank: 0, label: `< ${a.text}` } : null;
  }
  m = /^(?:>=|≥|gte)\s*(.+)$/i.exec(b) ?? /^(.+?)\s*\+$/.exec(b);
  if (m) {
    const a = parseAmount(m[1]!);
    return a ? { value: a.value, rank: 2, label: `≥ ${a.text}` } : null;
  }
  m = /^(?:>|gt)\s*(.+)$/i.exec(b);
  if (m) {
    const a = parseAmount(m[1]!);
    return a ? { value: a.value, rank: 2, label: `> ${a.text}` } : null;
  }
  m = /^(.+?)\s*[-–]\s*(.+)$/.exec(b);
  if (m) {
    const lo = parseAmount(m[1]!);
    const hi = parseAmount(m[2]!);
    return lo && hi ? { value: lo.value, rank: 1, label: `${lo.text}–${hi.text}` } : null;
  }
  return null;
}

/** French label of a bucket; unknown values are shown as-is (interpolated text only, never HTML). */
export function bucketLabel(dimension: BreakdownDimension, bucket: string): string {
  if (dimension === 'all') return 'Ensemble';
  if (dimension === 'dex') return DEX_LABEL[bucket] ?? bucket;
  return parseRangeBucket(bucket)?.label ?? bucket;
}

/**
 * Display order: MC / liquidity ascending (« < x » first, « ≥ x » last), DEX by sample
 * size (largest first, « Autres » last). Unknown buckets go last, alphabetically. Returns a new array.
 */
export function sortBuckets<T extends Pick<BreakdownRow, 'dimension' | 'bucket' | 'n'>>(rows: readonly T[]): T[] {
  const key = (r: T): [number, number, number] => {
    if (r.dimension === 'mc' || r.dimension === 'liq') {
      const p = parseRangeBucket(r.bucket);
      return p ? [0, p.value, p.rank] : [1, 0, 0];
    }
    if (r.dimension === 'dex') return r.bucket === 'other' ? [1, 0, 0] : [0, -r.n, 0];
    return [0, 0, 0];
  };
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return a.bucket.localeCompare(b.bucket);
  });
}

export type RateKey = 'x2' | 'x2_before_sl30' | 'sl30_before_x2' | 'x3' | 'dd50_first';

export interface RateCell {
  key: RateKey;
  label: string;
  hits: number;
  /** hits / n, null when n = 0. */
  rate: number | null;
  tone: 'bull' | 'bear';
}

const RATE_DEFS: readonly { key: Exclude<RateKey, 'dd50_first'>; label: string; tone: 'bull' | 'bear' }[] = [
  { key: 'x2', label: 'Taux ×2', tone: 'bull' },
  { key: 'x2_before_sl30', label: '×2 avant −30 %', tone: 'bull' },
  { key: 'sl30_before_x2', label: '−30 % avant ×2', tone: 'bear' },
  { key: 'x3', label: 'Taux ×3', tone: 'bull' },
];

export interface BucketView {
  bucket: string;
  label: string;
  n: number;
  /** Rows whose 7-day window is over. */
  nFinal: number;
  /** n ≥ 30: the rates may be shown prominently. Otherwise small, muted, with the sample note. */
  enough: boolean;
  rates: RateCell[];
  dd50: RateCell;
  medianMultiple: number | null;
}

export function bucketView(row: BreakdownRow): BucketView {
  const rate = (hits: number) => (row.n > 0 ? hits / row.n : null);
  return {
    bucket: row.bucket,
    label: bucketLabel(row.dimension, row.bucket),
    n: row.n,
    nFinal: row.n_final,
    enough: hasEnoughSample(row.n),
    rates: RATE_DEFS.map((d) => ({ ...d, hits: row[d.key], rate: rate(row[d.key]) })),
    dd50: { key: 'dd50_first', label: '−50 % d’abord', tone: 'bear', hits: row.dd50_first, rate: rate(row.dd50_first) },
    medianMultiple: row.median_max_multiple,
  };
}

export interface DimensionView {
  id: Exclude<BreakdownDimension, 'all'>;
  title: string;
  buckets: BucketView[];
}

export interface SourceView {
  /** The 'all' row of the source, null when the source has no labelled row yet. */
  overall: BucketView | null;
  dimensions: DimensionView[];
}

/** Everything the screen shows for one source. Dimensions without a bucket are kept (empty list). */
export function sourceView(rows: readonly BreakdownRow[], source: BreakdownSource): SourceView {
  const own = rows.filter((r) => r.source === source);
  const all = own.find((r) => r.dimension === 'all');
  return {
    overall: all ? bucketView(all) : null,
    dimensions: DIMENSIONS.map((d) => ({ ...d, buckets: sortBuckets(own.filter((r) => r.dimension === d.id)).map(bucketView) })),
  };
}

/** « n = 12, échantillon trop petit » under 30, else « n = 48 ». */
export function sampleNote(n: number): string {
  const text = `n = ${formatCount(n)}`;
  return hasEnoughSample(n) ? text : `${text}, échantillon trop petit`;
}

const MULTIPLE_FR = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 2 });

/** « ×1,85 »; « — » when unknown. */
export function formatMultiple(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '—' : `×${MULTIPLE_FR.format(v)}`;
}
