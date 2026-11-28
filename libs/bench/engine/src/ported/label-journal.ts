// Journal of label-outcomes (feat/lab-v2, docs/contracts/lab-v2.md §1): one compact public.label_runs row per call,
// counts only, so rpc('backfill_progress') reports a MEASURED hosted throughput. Pure: no I/O, no Date.now().
// Every value is clamped to the Postgres checks of migration 20261119100000 (0..100, ms 0..600 000,
// rate_limited <= requests, rows_written = labels + candles), so the insert can never be rejected.

export interface LabelRunCounts {
  /** GeckoTerminal requests made in the call. */
  requests: number;
  /** Requests answered 429 (the call stops at the first one: 0 or 1). */
  rateLimited: number;
  /** Label rows written successfully. */
  labels: number;
  /** Candle items done (captured, empty window or already covered). */
  candles: number;
  /** Label and candle failures (not 429). */
  failed: number;
  /** Items planned by the merged queue. */
  queued: number;
  ms: number;
}

export interface LabelRunRow {
  requests: number;
  rate_limited: number;
  rows_written: number;
  labels: number;
  candles: number;
  failed: number;
  queued: number;
  ms: number;
}

const clampInt = (v: number, max: number): number => (Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 0);

/** public.label_runs insert row (at = now() by default in the database). */
export function labelRunRow(c: LabelRunCounts): LabelRunRow {
  const requests = clampInt(c.requests, 100);
  let labels = clampInt(c.labels, 100);
  let candles = clampInt(c.candles, 100);
  // rows_written = labels + candles must stay <= 100.
  if (labels + candles > 100) {
    candles = Math.max(0, 100 - labels);
    labels = Math.min(labels, 100);
  }
  return {
    requests,
    rate_limited: Math.min(requests, clampInt(c.rateLimited, 100)),
    rows_written: labels + candles,
    labels,
    candles,
    failed: clampInt(c.failed, 100),
    queued: clampInt(c.queued, 100),
    ms: clampInt(c.ms, 600_000),
  };
}
