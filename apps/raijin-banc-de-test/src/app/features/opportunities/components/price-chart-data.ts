// Price chart of the token detail (pure): parsing, downsampling, scales, marker placement, paths, ticks, text.
// Everything here is deterministic and unit-tested; the components only wire signals to these functions.
import type { PaperPosition } from '../../../shared/models/paper';
import { toNumber } from '../../../shared/models/paper';

export type ChartRange = '6h' | '24h';
export const CHART_RANGES: readonly ChartRange[] = ['6h', '24h'];
export const DEFAULT_CHART_RANGE: ChartRange = '6h';
export const RANGE_MS: Record<ChartRange, number> = { '6h': 6 * 3_600_000, '24h': 24 * 3_600_000 };
export const RANGE_LABEL: Record<ChartRange, string> = { '6h': '6 h', '24h': '24 h' };

/** Rows read from token_snapshots (24 h at one scan every 2 min ≈ 720). */
export const HISTORY_LIMIT = 1000;
/** Points drawn at most (the last point, i.e. the current price, is always kept). */
export const MAX_POINTS = 240;
/** Below this many points the chart shows « Pas assez d'historique ». */
export const MIN_POINTS = 4;
/** A marker further than this factor from the price range does not stretch the Y axis. */
export const OFF_CHART_FACTOR = 3;

export interface PricePoint {
  /** Epoch ms. */
  t: number;
  price: number;
}

export type MarkerKind = 'alert' | 'fill' | 'exit';

export interface ChartMarker {
  kind: MarkerKind;
  t: number;
  price: number;
}

const positive = (v: unknown): number | null => {
  const n = toNumber(v);
  return n !== null && n > 0 ? n : null;
};

const time = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;

// ---------------------------------------------------------------------------------------------------------------
// Parsing (rows are untrusted: anything invalid is dropped)
// ---------------------------------------------------------------------------------------------------------------

/** token_snapshots rows (price_usd, captured_at) → valid points, sorted by time, one per timestamp. */
export function parseSnapshots(rows: unknown): PricePoint[] {
  if (!Array.isArray(rows)) return [];
  const points: PricePoint[] = [];
  for (const row of rows) {
    const r = record(row);
    if (!r) continue;
    const t = time(r['captured_at']);
    const price = positive(r['price_usd']);
    if (t !== null && price !== null) points.push({ t, price });
  }
  points.sort((a, b) => a.t - b.t);
  return points.filter((p, i) => i === 0 || p.t !== points[i - 1]!.t);
}

/** alert_log rows (sent_at, entry_price) → alert markers. Rows without an entry price are ignored. */
export function parseAlertMarkers(rows: unknown): ChartMarker[] {
  if (!Array.isArray(rows)) return [];
  const markers: ChartMarker[] = [];
  for (const row of rows) {
    const r = record(row);
    if (!r) continue;
    const t = time(r['sent_at']);
    const price = positive(r['entry_price']);
    if (t !== null && price !== null) markers.push({ kind: 'alert', t, price });
  }
  return markers;
}

/** Simulated fills (filled_at, fill_price) and leg exits (closed_at, exit_price) of the user's paper positions. */
export function paperMarkers(positions: readonly PaperPosition[]): ChartMarker[] {
  const markers: ChartMarker[] = [];
  const seen = new Set<string>();
  const push = (m: ChartMarker) => {
    const key = `${m.kind}|${m.t}|${m.price}`;
    if (seen.has(key)) return;
    seen.add(key);
    markers.push(m);
  };
  for (const p of positions) {
    const filledAt = time(p.filled_at);
    if (filledAt !== null && p.fill_price !== null && p.fill_price > 0) push({ kind: 'fill', t: filledAt, price: p.fill_price });
    for (const leg of p.legs) {
      const closedAt = time(leg.closed_at);
      if (leg.status !== 'open' && closedAt !== null && leg.exit_price !== null && leg.exit_price > 0) {
        push({ kind: 'exit', t: closedAt, price: leg.exit_price });
      }
    }
  }
  return markers.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------------------------------------------

/** Appends the live token price when it is newer than the last snapshot (the detail follows Realtime). */
export function withLivePoint(points: readonly PricePoint[], price: number | null, at: string | null): PricePoint[] {
  const t = time(at);
  const p = positive(price);
  const last = points.at(-1);
  if (t === null || p === null || !last || t <= last.t) return points.slice();
  return [...points, { t, price: p }];
}

/** Points of the last `range`, ending at the most recent point. */
export function windowPoints(points: readonly PricePoint[], range: ChartRange): PricePoint[] {
  const last = points.at(-1);
  if (!last) return [];
  const start = last.t - RANGE_MS[range];
  return points.filter((p) => p.t >= start);
}

/**
 * Largest-Triangle-Three-Buckets downsampling to at most `max` points. Keeps the first and the LAST point
 * (the current price) exactly and preserves the visual peaks. Input must be sorted by time.
 */
export function downsample(points: readonly PricePoint[], max = MAX_POINTS): PricePoint[] {
  const n = points.length;
  if (n <= max) return points.slice();
  if (max < 3) return max <= 0 ? [] : max === 1 ? [points[n - 1]!] : [points[0]!, points[n - 1]!];
  const out: PricePoint[] = [points[0]!];
  const every = (n - 2) / (max - 2);
  let a = 0;
  for (let i = 0; i < max - 2; i++) {
    const avgStart = Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgT = 0;
    let avgP = 0;
    for (let j = avgStart; j < avgEnd; j++) {
      avgT += points[j]!.t;
      avgP += points[j]!.price;
    }
    const count = Math.max(1, avgEnd - avgStart);
    avgT /= count;
    avgP /= count;
    const rangeStart = Math.floor(i * every) + 1;
    const rangeEnd = Math.floor((i + 1) * every) + 1;
    const pa = points[a];
    let best = rangeStart;
    let bestArea = -1;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs((pa!.t - avgT) * (points[j]!.price - pa!.price) - (pa!.t - points[j]!.t) * (avgP - pa!.price));
      if (area > bestArea) {
        bestArea = area;
        best = j;
      }
    }
    out.push(points[best]!);
    a = best;
  }
  out.push(points[n - 1]!);
  return out;
}

/** Window + downsample: the series actually drawn for `range`. */
export function chartSeries(points: readonly PricePoint[], range: ChartRange, max = MAX_POINTS): PricePoint[] {
  return downsample(windowPoints(points, range), max);
}

/** Markers within [t0, t1]. */
export function visibleMarkers(markers: readonly ChartMarker[], t0: number, t1: number): ChartMarker[] {
  return markers.filter((m) => m.t >= t0 && m.t <= t1);
}

// ---------------------------------------------------------------------------------------------------------------
// Y domain
// ---------------------------------------------------------------------------------------------------------------

export type LevelPlacement = 'in' | 'above' | 'below';

/** Where a value falls relative to the sensible range [min / factor, max × factor] of the prices. */
export function classifyLevel(value: number, priceMin: number, priceMax: number, factor = OFF_CHART_FACTOR): LevelPlacement {
  if (value > priceMax * factor) return 'above';
  if (value < priceMin / factor) return 'below';
  return 'in';
}

export interface YDomain {
  min: number;
  max: number;
}

/**
 * Domain including the prices and the `extra` values (markers) within the sensible range (see classifyLevel),
 * padded by 8 %. Never negative; a flat series gets ±5 %.
 */
export function computeYDomain(prices: readonly number[], extra: readonly number[] = []): YDomain | null {
  const valid = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (valid.length === 0) return null;
  const pMin = Math.min(...valid);
  const pMax = Math.max(...valid);
  const include = extra.filter(
    (v): v is number => v !== null && Number.isFinite(v) && v > 0 && classifyLevel(v, pMin, pMax) === 'in',
  );
  const lo = Math.min(pMin, ...include);
  const hi = Math.max(pMax, ...include);
  const pad = hi > lo ? (hi - lo) * 0.08 : hi * 0.05;
  return { min: Math.max(0, lo - pad), max: hi + pad };
}

/** Linear map [d0, d1] → [r0, r1]; a degenerate domain maps to the middle of the range. */
export function linearScale(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  if (d1 === d0) return () => (r0 + r1) / 2;
  const k = (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

// ---------------------------------------------------------------------------------------------------------------
// Label collision
// ---------------------------------------------------------------------------------------------------------------

export interface LabelSlot {
  id: string;
  y: number;
}

/**
 * Nudges labels vertically so that two labels are at least `gap` apart, staying within [top, bottom] when there
 * is room. Order by y is preserved; output keeps the input order.
 */
export function placeLabels(items: readonly LabelSlot[], gap: number, top: number, bottom: number): LabelSlot[] {
  const sorted = items.map((it, index) => ({ ...it, index })).sort((a, b) => a.y - b.y || a.index - b.index);
  for (let i = 0; i < sorted.length; i++) {
    const min = i === 0 ? top : sorted[i - 1]!.y + gap;
    sorted[i]!.y = Math.max(sorted[i]!.y, min);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const max = i === sorted.length - 1 ? bottom : sorted[i + 1]!.y - gap;
    sorted[i]!.y = Math.min(sorted[i]!.y, max);
  }
  if (sorted.length > 0 && sorted[0]!.y < top) {
    // Not enough room: keep the top inside, accept overlap at the bottom rather than leaving the chart.
    for (let i = 0; i < sorted.length; i++) sorted[i]!.y = Math.max(sorted[i]!.y, i === 0 ? top : sorted[i - 1]!.y + gap);
  }
  const out = new Array<LabelSlot>(items.length);
  for (const s of sorted) out[s.index] = { id: s.id, y: s.y };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------

export interface XY {
  x: number;
  y: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function linePath(points: readonly XY[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${r1(p.x)} ${r1(p.y)}`).join(' ');
}

/** Line closed down to `baseY` (area under the curve). */
export function areaPath(points: readonly XY[], baseY: number): string {
  if (points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath(points)} L${r1(last!.x)} ${r1(baseY)} L${r1(first!.x)} ${r1(baseY)} Z`;
}

/** Index of the x closest to `x` (xs sorted ascending); -1 when empty. */
export function nearestIndex(xs: readonly number[], x: number): number {
  if (xs.length === 0) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xs[hi]! - x) < Math.abs(xs[lo]! - x) ? hi : lo;
}

// ---------------------------------------------------------------------------------------------------------------
// Time (Europe/Paris) and number formatting (French)
// ---------------------------------------------------------------------------------------------------------------

const PARIS_HM = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** « 12:00 » in Paris time. */
export function formatParisTime(t: number): string {
  return PARIS_HM.format(t);
}

function parisMinutesOfDay(t: number): number {
  const [h, m] = formatParisTime(t).split(':').map(Number);
  return h! * 60 + m!;
}

const QUARTER_MS = 15 * 60_000;
const TICK_STEPS_MIN = [15, 30, 60, 120, 180, 240, 360, 720];

export interface TimeTick {
  t: number;
  label: string;
}

/** Round Paris times within [t0, t1]: the finest step (15 min … 12 h) giving at most `maxTicks` ticks. */
export function timeTicks(t0: number, t1: number, maxTicks = 4): TimeTick[] {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return [];
  // Paris is a whole number of hours from UTC: quarter-hour boundaries are the same in both.
  const candidates: { t: number; minutes: number }[] = [];
  for (let t = Math.ceil(t0 / QUARTER_MS) * QUARTER_MS; t <= t1; t += QUARTER_MS) {
    candidates.push({ t, minutes: parisMinutesOfDay(t) });
  }
  for (const step of TICK_STEPS_MIN) {
    const picked = candidates.filter((c) => c.minutes % step === 0);
    if (picked.length <= maxTicks) return picked.map((c) => ({ t: c.t, label: formatParisTime(c.t) }));
  }
  return [];
}

const FR_PRICE = new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 4 });
const FR_PRICE_SHORT = new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 3 });
const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

/** « 0,00041 » (4 significant digits, French); '–' when unknown. Used for screen readers and the tooltip. */
export function formatPriceFr(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return '–';
  return FR_PRICE.format(v);
}

/** Compact label: « 0,000412 », or « 0,0₄123 » (4 zeros after the comma) below 0,0001. */
export function formatPriceShort(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return '–';
  if (v >= 0.0001) return FR_PRICE_SHORT.format(v);
  let zeros = -Math.floor(Math.log10(v)) - 1;
  let digits = Math.round(v * 10 ** (zeros + 3));
  if (digits >= 1000) {
    zeros -= 1;
    digits = Math.round(digits / 10);
  }
  const sub = String(zeros)
    .split('')
    .map((d) => SUBSCRIPT_DIGITS[Number(d)])
    .join('');
  return `0,0${sub}${String(digits).replace(/0+$/, '') || '0'}`;
}

/** Accessible summary of the chart (aria-label). `symbol` is hostile text: only ever bound as an attribute. */
export function chartSummary(symbol: string, range: ChartRange, points: readonly PricePoint[]): string {
  const head = `Prix ${RANGE_LABEL[range]} de ${symbol}`;
  if (points.length < MIN_POINTS) return `${head} : pas assez d’historique.`;
  const prices = points.map((p) => p.price);
  const last = prices[prices.length - 1];
  return `${head} : de ${formatPriceFr(Math.min(...prices))} à ${formatPriceFr(Math.max(...prices))} $, actuellement ${formatPriceFr(last)} $.`;
}

export interface TableRow {
  label: string;
  value: string;
}

const MARKER_LABEL: Record<MarkerKind, string> = {
  alert: 'Alerte reçue',
  fill: 'Achat simulé',
  exit: 'Sortie simulée',
};

/** Rows of the visually hidden data table: min / max / last, then markers. */
export function chartTableRows(points: readonly PricePoint[], markers: readonly ChartMarker[] = []): TableRow[] {
  if (points.length === 0) return [];
  const prices = points.map((p) => p.price);
  const usd = (v: number) => `${formatPriceFr(v)} $`;
  const rows: TableRow[] = [
    { label: 'Plus bas', value: usd(Math.min(...prices)) },
    { label: 'Plus haut', value: usd(Math.max(...prices)) },
    { label: 'Dernier prix', value: usd(prices[prices.length - 1]!) },
  ];
  for (const m of markers) rows.push({ label: `${MARKER_LABEL[m.kind]} à ${formatParisTime(m.t)}`, value: usd(m.price) });
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry (everything the SVG needs)
// ---------------------------------------------------------------------------------------------------------------

export const CHART_HEIGHT = 200;
export const LABEL_COLUMN = 58;
const PAD_TOP = 10;
const AXIS_HEIGHT = 18;
const LABEL_GAP = 12;
const X_INSET_LEFT = 2;
const X_INSET_RIGHT = 6;
const TICK_EDGE = 14;

export type LabelTone = 'current';

export interface ChartLabel {
  id: string;
  text: string;
  y: number;
  tone: LabelTone;
}

export interface ChartGeometry {
  width: number;
  height: number;
  plotTop: number;
  plotBottom: number;
  plotRight: number;
  line: string;
  area: string;
  xs: number[];
  ys: number[];
  labels: ChartLabel[];
  ticks: { x: number; label: string }[];
  markers: { kind: MarkerKind; x: number; y: number }[];
  dot: XY;
}

/** Lays out the chart in a `width × height` box. Null when there is nothing to draw. */
export function buildChartGeometry(
  points: readonly PricePoint[],
  markers: readonly ChartMarker[],
  width: number,
  height = CHART_HEIGHT,
): ChartGeometry | null {
  if (points.length === 0) return null;
  const prices = points.map((p) => p.price);
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const shown = visibleMarkers(markers, t0, t1);
  const domain = computeYDomain(prices, shown.map((m) => m.price));
  if (!domain) return null;

  const plotTop = PAD_TOP;
  const plotBottom = height - AXIS_HEIGHT;
  const plotRight = Math.max(40, width - LABEL_COLUMN);
  const x = linearScale(t0, t1, X_INSET_LEFT, plotRight - X_INSET_RIGHT);
  const y = linearScale(domain.min, domain.max, plotBottom, plotTop);
  const clampY = (v: number) => Math.min(plotBottom, Math.max(plotTop, v));

  const xy = points.map((p) => ({ x: t1 === t0 ? plotRight - X_INSET_RIGHT : x(p.t), y: y(p.price) }));
  const last = xy[xy.length - 1];
  const slots: (LabelSlot & { text: string; tone: LabelTone })[] = [];
  slots.push({ id: 'current', text: formatPriceShort(prices[prices.length - 1]), y: last!.y, tone: 'current' });

  const placed = placeLabels(slots, LABEL_GAP, plotTop + 4, plotBottom - 2);
  const labels = slots.map((s, i) => ({ id: s.id, text: s.text, tone: s.tone, y: r1(placed[i]!.y) }));

  const ticks = timeTicks(t0, t1)
    .map((tk) => ({ x: r1(x(tk.t)), label: tk.label }))
    .filter((tk) => tk.x >= TICK_EDGE && tk.x <= plotRight - TICK_EDGE);

  return {
    width,
    height,
    plotTop,
    plotBottom,
    plotRight,
    line: linePath(xy),
    area: areaPath(xy, plotBottom),
    xs: xy.map((p) => p.x),
    ys: xy.map((p) => p.y),
    labels,
    ticks,
    markers: shown.map((m) => ({ kind: m.kind, x: r1(x(m.t)), y: r1(clampY(y(m.price))) })),
    dot: { x: r1(last!.x), y: r1(last!.y) },
  };
}
