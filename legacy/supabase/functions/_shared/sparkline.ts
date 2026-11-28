// 6-hour price sparkline of a token (tokens.spark_6h), built by scan-tokens from the snapshot history it already
// loads (x3_snapshot_history rpc, one sample per mint per 15 min) plus the current price. The cards draw it without
// reading token_snapshots. Pure, no network, never throws.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.

export const SPARK_WINDOW_MS = 6 * 3_600_000;
export const SPARK_BUCKETS = 24;
/** Same bound as the tokens_spark_6h_check constraint (cardinality <= 48). */
export const SPARK_MAX_BUCKETS = 48;
/** Fewer valid points than this inside the window: no sparkline (null). */
export const SPARK_MIN_POINTS = 4;
/** Prices accepted: 0 < price < 1e12 (same bounds as the constraint). */
const MAX_PRICE = 1e12;

export interface SparkPoint {
  /** epoch ms */
  at: number;
  price: number;
}

/** Checked as float32 too: spark_6h is real[], and the constraint compares the stored (rounded) value. */
const MAX_PRICE_F32 = Math.fround(MAX_PRICE);
const validPrice = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v < MAX_PRICE && Math.fround(v) > 0 && Math.fround(v) < MAX_PRICE_F32;

/** 6 significant digits; null if rounding leaves the accepted range (never for valid input in practice). */
function round6(v: number): number | null {
  const r = Number(v.toPrecision(6));
  return validPrice(r) ? r : null;
}

/**
 * Last price per bucket (`buckets` equal slices of [nowMs - windowMs, nowMs]), gaps forward-filled, leading empty
 * buckets dropped. Points outside the window, with an invalid time or price are ignored. null when fewer than
 * SPARK_MIN_POINTS valid points remain, or on invalid arguments. Values rounded to 6 significant digits.
 */
export function buildSparkline(
  points: readonly SparkPoint[],
  nowMs: number,
  windowMs: number = SPARK_WINDOW_MS,
  buckets: number = SPARK_BUCKETS,
): number[] | null {
  try {
    if (!Array.isArray(points) || !Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs <= 0) return null;
    if (!Number.isInteger(buckets) || buckets < 1 || buckets > SPARK_MAX_BUCKETS) return null;
    const start = nowMs - windowMs;
    const size = windowMs / buckets;
    const last: ({ at: number; price: number } | null)[] = new Array<{ at: number; price: number } | null>(buckets).fill(null);
    let count = 0;
    for (const p of points) {
      if (typeof p !== 'object' || p === null) continue;
      const { at, price } = p;
      if (typeof at !== 'number' || !Number.isFinite(at) || at < start || at > nowMs || !validPrice(price)) continue;
      const i = Math.min(buckets - 1, Math.floor((at - start) / size));
      count++;
      const cur = last[i];
      // Last price of the bucket; on a time tie the later point in the input wins.
      if (cur === null || at >= cur.at) last[i] = { at, price };
    }
    if (count < SPARK_MIN_POINTS) return null;
    const out: number[] = [];
    let prev: number | null = null;
    for (const b of last) {
      if (b !== null) {
        const r = round6(b.price);
        if (r !== null) prev = r;
      }
      if (prev !== null) out.push(prev);
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** One history sample as parsed by parseHistoryRows (x3-rows.ts): epoch ms + nullable price. */
export interface SparkHistorySample {
  t: number;
  price: number | null;
}

/**
 * spark_6h per kept token. `requested` = mints sent to x3_snapshot_history when the read SUCCEEDED (null when it
 * failed): tokens outside it get no entry, so the upsert leaves their stored sparkline untouched. For a requested
 * mint the history (possibly empty) plus the current price at `nowMs` gives an array or null (too few points).
 */
export function sparkColumns(
  tokens: readonly { mint: string; price: number }[],
  history: ReadonlyMap<string, readonly SparkHistorySample[]>,
  requested: ReadonlySet<string> | null,
  nowMs: number,
): Map<string, number[] | null> {
  const out = new Map<string, number[] | null>();
  if (requested === null) return out;
  for (const { mint, price } of tokens) {
    if (!requested.has(mint)) continue;
    const points: SparkPoint[] = [];
    for (const s of history.get(mint) ?? []) {
      if (s.price !== null) points.push({ at: s.t, price: s.price });
    }
    points.push({ at: nowMs, price });
    out.set(mint, buildSparkline(points, nowMs));
  }
  return out;
}

/**
 * Splits the upsert payload: rows with a spark entry (null included) carry spark_6h, the others do not carry the
 * key at all. Two separate upserts are needed because supabase-js sends the union of the keys of a batch as
 * `columns`, and PostgREST writes NULL for a key missing from a row: one mixed batch would erase the stored
 * sparkline of the rows without an entry.
 */
export function splitBySpark<R extends { mint: string }>(
  rows: readonly R[],
  spark: ReadonlyMap<string, number[] | null>,
): { withSpark: (R & { spark_6h: number[] | null })[]; without: R[] } {
  const withSpark: (R & { spark_6h: number[] | null })[] = [];
  const without: R[] = [];
  for (const r of rows) {
    if (spark.has(r.mint)) withSpark.push({ ...r, spark_6h: spark.get(r.mint) ?? null });
    else without.push(r);
  }
  return { withSpark, without };
}
