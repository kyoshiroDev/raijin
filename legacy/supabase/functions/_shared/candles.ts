// Backtest candle storage (feat/strategy-lab, docs/contracts/strategy-lab.md §B1). Pure: no I/O, no Date.now(), no
// zod (type-only imports), so the backtest worker and the local scripts can load it anywhere.
//
// - Capture windows: 1-minute candles from the detection to +6 h (captured at detection + 6 h, ONE GeckoTerminal
//   request aggregate=1 limit=360) and 5-minute candles from the detection to +72 h (captured at detection + 72 h,
//   ONE request aggregate=5 limit=864). Never downloaded twice. The request itself is gecko-history.ts
//   fetchCandleWindow(pool, mint, candlePlan(window)).
// - Compact row shape of public.ohlcv_candles: one row per (detection window, timeframe) with ts = offsets in
//   seconds from ts_start (GeckoTerminal gaps kept as they are) and o/h/l/c/v arrays of the same length.
// - mergePath: the 1m / 5m / 15m series of a mint merged into ONE chronological path that uses, at each instant, the
//   finest resolution available. A coarser candle is kept only when its whole interval lies outside every finer
//   series' span (a candle straddling a span edge is dropped: never counted twice).
import type { CandlePlan } from './gecko-history.ts';
import { isSolanaAddress } from './solana.ts';
import type { Candle } from './types.ts';

/** The array itself, or [] for a non-array (keeps the element type: Array.isArray narrows readonly arrays to any[]). */
const arr = <T>(x: readonly T[] | null | undefined): readonly T[] => (Array.isArray(x) ? x : []);

export type CandleTf = '1m' | '5m' | '15m';
export const CANDLE_TFS: readonly CandleTf[] = ['1m', '5m', '15m'];
/** Candle length (seconds) per timeframe = ohlcv_candles.step_s. */
export const TF_STEP_S: Readonly<Record<CandleTf, number>> = { '1m': 60, '5m': 300, '15m': 900 };
/** Finest first: lower rank = finer. */
const TF_RANK: Readonly<Record<CandleTf, number>> = { '1m': 0, '5m': 1, '15m': 2 };
export const parseCandleTf = (v: unknown): CandleTf | null => (v === '1m' || v === '5m' || v === '15m' ? v : null);

/** Timeframes captured live from GeckoTerminal ('15m' only comes from the local seed of the label cache). */
export type CaptureTf = '1m' | '5m';
export const CAPTURE_TFS: readonly CaptureTf[] = ['1m', '5m'];

const HOUR_S = 3600;
/** Window length (hours after the detection) and candle count of each capture. */
export const CAPTURE_SPEC: Readonly<Record<CaptureTf, { hours: number; aggregate: 1 | 5; limit: number }>> = {
  '1m': { hours: 6, aggregate: 1, limit: 360 },
  '5m': { hours: 72, aggregate: 5, limit: 864 },
};

export interface CaptureWindow {
  tf: CaptureTf;
  /** epoch ms at which the window is complete and may be captured (detection + 6 h / + 72 h). */
  dueAtMs: number;
  /** Open time (s) of the candle containing the detection (detection floored to the step). */
  fromSec: number;
  /** End (s, exclusive) of the window: fromSec + limit × step. */
  toSec: number;
  stepSec: number;
  aggregate: 1 | 5;
  limit: number;
}

/** Capture window of `tf` for a detection; null for an invalid time. */
export function captureWindow(tf: CaptureTf, detectedAtMs: number): CaptureWindow | null {
  const spec = CAPTURE_SPEC[tf];
  if (!spec || !Number.isFinite(detectedAtMs) || detectedAtMs <= 0) return null;
  const stepSec = TF_STEP_S[tf];
  const fromSec = Math.floor(detectedAtMs / 1000 / stepSec) * stepSec;
  return {
    tf,
    dueAtMs: detectedAtMs + spec.hours * HOUR_S * 1000,
    fromSec,
    toSec: fromSec + spec.limit * stepSec,
    stepSec,
    aggregate: spec.aggregate,
    limit: spec.limit,
  };
}

/** gecko-history CandlePlan of a capture window (input of fetchCandleWindow / buildOhlcvUrl). */
export function candlePlan(w: CaptureWindow): CandlePlan {
  return { timeframe: 'minute', aggregate: w.aggregate, stepSec: w.stepSec, fromSec: w.fromSec, toSec: w.toSec, limit: w.limit };
}

/** Initial queue columns of a new detection row (candles_1m_at = detection + 6 h, candles_5m_at = detection + 72 h). */
export function initialCandleSchedule(detectedAtMs: number): { candles_1m_at: string; candles_5m_at: string } | null {
  const w1 = captureWindow('1m', detectedAtMs);
  const w5 = captureWindow('5m', detectedAtMs);
  if (!w1 || !w5) return null;
  return { candles_1m_at: new Date(w1.dueAtMs).toISOString(), candles_5m_at: new Date(w5.dueAtMs).toISOString() };
}

// ---------------------------------------------------------------------------------------------------------------
// Compact encoding (ohlcv_candles row)

export type OhlcvSource = 'signal_outcomes' | 'preset_signals' | 'backtest_events';
export const OHLCV_SOURCES: readonly OhlcvSource[] = ['signal_outcomes', 'preset_signals', 'backtest_events'];

/** Insert shape of public.ohlcv_candles (id is an identity column, not sent). */
export interface OhlcvCandlesRow {
  mint: string;
  pool: string;
  tf: CandleTf;
  /** ISO, open time of the first candle. */
  ts_start: string;
  step_s: number;
  /** Offsets (s) from ts_start, strictly increasing, first = 0. */
  ts: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  source: OhlcvSource;
  /** ISO, detection the window belongs to. */
  detected_at: string;
  /** ISO. */
  fetched_at: string;
}

/** Largest number of candles accepted in one row (7 days of 15 min = 673; 864 × 5 min; margin). */
export const MAX_CANDLES_PER_ROW = 1000;
/** Prices outside (0, PRICE_MAX) are dropped (same bound as the price columns). */
const PRICE_MAX = 1e12;

const validCandle = (c: unknown): c is Candle =>
  Array.isArray(c) &&
  c.length >= 6 &&
  Number.isSafeInteger(c[0]) &&
  c[0] > 0 &&
  [c[1], c[2], c[3], c[4]].every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x < PRICE_MAX) &&
  typeof c[5] === 'number' &&
  Number.isFinite(c[5]) &&
  c[5] >= 0 &&
  c[2] >= c[3];

/** Valid candles, oldest first, one per open time (first seen wins), capped at MAX_CANDLES_PER_ROW (oldest kept). */
export function cleanCandles(candles: readonly unknown[]): Candle[] {
  const byTs = new Map<number, Candle>();
  for (const c of arr(candles)) {
    if (validCandle(c) && !byTs.has(c[0])) byTs.set(c[0], [c[0], c[1], c[2], c[3], c[4], c[5]]);
  }
  return [...byTs.values()].sort((a, b) => a[0] - b[0]).slice(0, MAX_CANDLES_PER_ROW);
}

export interface CompactCandles {
  ts_start: string;
  ts: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

/** Candles → compact arrays (cleanCandles applied). null when no valid candle remains. */
export function encodeCandles(candles: readonly unknown[]): CompactCandles | null {
  const clean = cleanCandles(candles);
  if (clean.length === 0) return null;
  const t0 = clean[0][0];
  return {
    ts_start: new Date(t0 * 1000).toISOString(),
    ts: clean.map((c) => c[0] - t0),
    o: clean.map((c) => c[1]),
    h: clean.map((c) => c[2]),
    l: clean.map((c) => c[3]),
    c: clean.map((c) => c[4]),
    v: clean.map((c) => c[5]),
  };
}

export interface OhlcvRowInput {
  mint: string;
  pool: string;
  tf: CandleTf;
  candles: readonly unknown[];
  source: OhlcvSource;
  detectedAtMs: number;
  fetchedAtMs: number;
}

/** Insert row for one captured window; null when an address / tf / source / time is invalid or no candle is valid. */
export function ohlcvRow(input: OhlcvRowInput): OhlcvCandlesRow | null {
  if (!input || !isSolanaAddress(input.mint) || !isSolanaAddress(input.pool)) return null;
  const tf = parseCandleTf(input.tf);
  if (!tf || !OHLCV_SOURCES.includes(input.source)) return null;
  if (!Number.isFinite(input.detectedAtMs) || input.detectedAtMs <= 0 || !Number.isFinite(input.fetchedAtMs)) return null;
  const enc = encodeCandles(input.candles);
  if (!enc) return null;
  return {
    mint: input.mint,
    pool: input.pool,
    tf,
    ts_start: enc.ts_start,
    step_s: TF_STEP_S[tf],
    ts: enc.ts,
    o: enc.o,
    h: enc.h,
    l: enc.l,
    c: enc.c,
    v: enc.v,
    source: input.source,
    detected_at: new Date(input.detectedAtMs).toISOString(),
    fetched_at: new Date(input.fetchedAtMs).toISOString(),
  };
}

const numArray = (v: unknown, n: number): number[] | null => {
  if (!Array.isArray(v) || v.length !== n) return null;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const x = typeof v[i] === 'number' ? v[i] : typeof v[i] === 'string' && v[i].length <= 40 ? Number(v[i]) : NaN;
    if (!Number.isFinite(x)) return null;
    out[i] = x;
  }
  return out;
};

/** A series read back from ohlcv_candles: timeframe + candles oldest first. */
export interface CandleSeries {
  tf: CandleTf;
  candles: Candle[];
}

/**
 * ohlcv_candles row (as returned by PostgREST / the CLI: arrays of numbers or numeric strings) → series, or null when
 * the row is malformed (unknown tf, step_s ≠ tf step, arrays of different lengths, unparsable ts_start). Invalid
 * candles inside a valid row are dropped (cleanCandles), offsets need not be sorted.
 */
export function decodeOhlcvRow(row: unknown): CandleSeries | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const tf = parseCandleTf(r.tf);
  if (!tf || Number(r.step_s) !== TF_STEP_S[tf]) return null;
  if (typeof r.ts_start !== 'string' || r.ts_start.length > 40) return null;
  const startMs = Date.parse(r.ts_start);
  if (!Number.isFinite(startMs)) return null;
  const n = Array.isArray(r.ts) ? r.ts.length : -1;
  if (n < 0 || n > MAX_CANDLES_PER_ROW) return null;
  const ts = numArray(r.ts, n);
  const o = numArray(r.o, n);
  const h = numArray(r.h, n);
  const l = numArray(r.l, n);
  const c = numArray(r.c, n);
  const v = numArray(r.v, n);
  if (!ts || !o || !h || !l || !c || !v) return null;
  const t0 = Math.round(startMs / 1000);
  const raw: Candle[] = ts.map((off, i) => [t0 + Math.round(off), o[i], h[i], l[i], c[i], v[i]] as Candle);
  return { tf, candles: cleanCandles(raw) };
}

// ---------------------------------------------------------------------------------------------------------------
// Merged path

/** One chronological path, structure of arrays (typed, fast to scan). t = candle open time (s), end = close time. */
export interface CandlePath {
  n: number;
  t: Float64Array;
  end: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  /** Finest timeframe present in the path (null when empty). */
  finest: CandleTf | null;
  /** Timeframes that contributed at least one candle. */
  tfs: CandleTf[];
}

interface Span {
  from: number;
  to: number;
}

const overlaps = (spans: readonly Span[], from: number, to: number): boolean =>
  spans.some((s) => from < s.to && to > s.from);

/**
 * Merges series of any timeframes (several rows of the same timeframe allowed, e.g. a scan and a preset detection of
 * the same mint) into one path. Rules:
 * - every series has a span [first open, last open + step) (its captured data, gaps inside included);
 * - finer timeframes are taken whole; a candle of a coarser timeframe is kept only if [open, open + step) does not
 *   intersect any span of a finer timeframe (a straddling coarse candle is dropped, so no move is counted twice);
 * - duplicates of the same open time within a timeframe: first seen wins.
 * Output sorted by open time.
 */
export function mergePath(series: readonly CandleSeries[]): CandlePath {
  const byTf = new Map<CandleTf, Candle[][]>();
  for (const s of arr(series)) {
    const tf = parseCandleTf(s?.tf);
    if (!tf || !Array.isArray(s.candles)) continue;
    const clean = cleanCandles(s.candles);
    if (clean.length === 0) continue;
    const list = byTf.get(tf) ?? [];
    list.push(clean);
    byTf.set(tf, list);
  }
  const finerSpans: Span[] = [];
  const picked: { c: Candle; step: number }[] = [];
  const tfs: CandleTf[] = [];
  for (const tf of [...CANDLE_TFS].sort((a, b) => TF_RANK[a] - TF_RANK[b])) {
    const lists = byTf.get(tf);
    if (!lists) continue;
    const step = TF_STEP_S[tf];
    const seen = new Set<number>();
    const spans: Span[] = [];
    let used = false;
    for (const list of lists) {
      spans.push({ from: list[0][0], to: list[list.length - 1][0] + step });
      for (const c of list) {
        if (seen.has(c[0])) continue;
        seen.add(c[0]);
        if (overlaps(finerSpans, c[0], c[0] + step)) continue;
        picked.push({ c, step });
        used = true;
      }
    }
    if (used) tfs.push(tf);
    finerSpans.push(...spans);
  }
  picked.sort((a, b) => a.c[0] - b.c[0] || a.step - b.step);
  const n = picked.length;
  const path: CandlePath = {
    n,
    t: new Float64Array(n),
    end: new Float64Array(n),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    finest: tfs.length > 0 ? tfs[0] : null,
    tfs,
  };
  picked.forEach(({ c, step }, i) => {
    path.t[i] = c[0];
    path.end[i] = c[0] + step;
    path.o[i] = c[1];
    path.h[i] = c[2];
    path.l[i] = c[3];
    path.c[i] = c[4];
  });
  return path;
}

/** Index of the first candle with open time ≥ sec (n when none). Binary search. */
export function firstAtOrAfter(path: Pick<CandlePath, 'n' | 't'>, sec: number): number {
  let lo = 0;
  let hi = path.n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (path.t[mid] < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * True when a stored window of the same mint and timeframe (rows { tf, detected_at }) already covers at least
 * `minFraction` of the capture window `w` (nominal windows compared, from each detection). Lets the capture skip a
 * second download when the scan and a preset detected the same mint a few minutes apart (GeckoTerminal budget).
 */
export function isWindowCovered(
  stored: ReadonlyArray<{ tf: unknown; detected_at: unknown }>,
  w: Pick<CaptureWindow, 'tf' | 'fromSec' | 'toSec'>,
  minFraction = 0.75,
): boolean {
  const len = w.toSec - w.fromSec;
  if (!(len > 0)) return false;
  for (const r of arr(stored)) {
    if (parseCandleTf(r?.tf) !== w.tf || typeof r.detected_at !== 'string' || r.detected_at.length > 40) continue;
    const other = captureWindow(w.tf, Date.parse(r.detected_at));
    if (!other) continue;
    const overlap = Math.min(other.toSec, w.toSec) - Math.max(other.fromSec, w.fromSec);
    if (overlap / len >= minFraction) return true;
  }
  return false;
}
