// Point-in-time columns of token_snapshots (feat/lab-v2, docs/contracts/lab-v2.md §2). Pure: no I/O, no Date.now().
// scan-tokens copies into every snapshot the values KNOWN AT SCAN TIME (the token row it just wrote, plus the
// enrichment it merged), so the event backtest never needs today's token row to judge a past snapshot:
//   mint_authority_disabled / freeze_authority_disabled  Jupiter audit of this scan (null = not audited)
//   top10_pct           Jupiter top 10 holders (PERCENT, 0..100)
//   insiders_detected   RugCheck insiders (enrich-tokens, null = unknown)
//   roundtrip_cost_pct  fresh Jupiter round trip (PERCENT, -100..100; null when stale / unknown)
//   change_1h           DexScreener 1 h change (PERCENT, >= -100, < 1e9)
// Every value is bounded exactly like the Postgres checks of migration 20261119100000 (else null), so a bad value
// never makes the whole snapshot insert fail.

export interface PointInTimeInput {
  mint_authority_disabled?: unknown;
  freeze_authority_disabled?: unknown;
  top10_pct?: unknown;
  change_1h?: unknown;
  insiders_detected?: unknown;
  roundtrip_cost_pct?: unknown;
}

export interface PointInTimeColumns {
  mint_authority_disabled: boolean | null;
  freeze_authority_disabled: boolean | null;
  top10_pct: number | null;
  insiders_detected: boolean | null;
  roundtrip_cost_pct: number | null;
  change_1h: number | null;
}

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Finite number in [min, max] (maxExclusive: < max), else null. Numeric strings are not accepted. */
function bounded(v: unknown, min: number, max: number, maxExclusive = false): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < min || (maxExclusive ? v >= max : v > max)) return null;
  return v;
}

/** token_snapshots point-in-time columns from the values known at scan time. */
export function pointInTimeColumns(input: PointInTimeInput | null | undefined): PointInTimeColumns {
  const r = input ?? {};
  return {
    mint_authority_disabled: bool(r.mint_authority_disabled),
    freeze_authority_disabled: bool(r.freeze_authority_disabled),
    top10_pct: bounded(r.top10_pct, 0, 100),
    insiders_detected: bool(r.insiders_detected),
    roundtrip_cost_pct: bounded(r.roundtrip_cost_pct, -100, 100),
    change_1h: bounded(r.change_1h, -100, 1e9, true),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// feat/young-calm (migration 20261120010000): point-in-time inputs of « Jeune calme » / « Jeune frénésie »
//   buys_1h / sells_1h        DexScreener 1 h transactions of the pair (integers 0..1e8), null when the pair payload
//                             did not carry them (never the 0 default of normalize.ts: unknown ratio → preset rejects)
//   liquidity_effective_usd   effective liquidity of the score (USD, 0 ≤ x < 1e13)
//   lp_locked_pct             RugCheck LP locked, FRESH enrichment only (PERCENT 0..100)
// Separate from pointInTimeColumns so scan-tokens can fall back to the lab-v2 columns alone while the migration is
// not applied (a rejected column fails the whole insert).

export interface YoungPointInTimeInput {
  buys_1h?: unknown;
  sells_1h?: unknown;
  liquidity_effective_usd?: unknown;
  lp_locked_pct?: unknown;
}

export interface YoungPointInTimeColumns {
  buys_1h: number | null;
  sells_1h: number | null;
  liquidity_effective_usd: number | null;
  lp_locked_pct: number | null;
}

/** Bound of the transaction counts (token_snapshots_buys_1h_check / _sells_1h_check). */
export const TXNS_1H_MAX = 100_000_000;

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= TXNS_1H_MAX ? v : null;

/** token_snapshots young-calm columns from the values known at scan time (each bounded like its CHECK, else null). */
export function youngPointInTimeColumns(input: YoungPointInTimeInput | null | undefined): YoungPointInTimeColumns {
  const r = input ?? {};
  return {
    buys_1h: count(r.buys_1h),
    sells_1h: count(r.sells_1h),
    liquidity_effective_usd: bounded(r.liquidity_effective_usd, 0, 1e13, true),
    lp_locked_pct: bounded(r.lp_locked_pct, 0, 100),
  };
}

/**
 * DexScreener 1 h transactions of a pair payload, only when BOTH counts are present (the zod schema already checks
 * non-negative integers); otherwise null / null (unknown, not 0).
 */
export function knownTxns1h(pair: { txns?: { h1?: { buys?: number; sells?: number } } } | null | undefined): {
  buys: number | null;
  sells: number | null;
} {
  const h1 = pair?.txns?.h1;
  const buys = count(h1?.buys);
  const sells = count(h1?.sells);
  return buys !== null && sells !== null ? { buys, sells } : { buys: null, sells: null };
}

/**
 * DexScreener 1 h price change (PERCENT) of a pair payload, only when priceChange.h1 is present and finite; otherwise
 * null (unknown, not the 0 default of normalize.ts, which would pass « Jeune calme » 0 ≤ change ≤ 100 on missing data).
 * Bounds of token_snapshots_change_1h_check (≥ -100, < 1e9), else null.
 */
export function knownChange1h(pair: { priceChange?: { h1?: number } } | null | undefined): number | null {
  return bounded(pair?.priceChange?.h1, -100, 1e9, true);
}
