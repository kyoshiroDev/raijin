// THE single flags entry point of the Edge Functions (pure, no I/O). chore/slim-down: no score, no zone any more.
// `finalFlags` is the only function scan-tokens and enrich-tokens call to get the persisted flag columns (flagColumns
// of normalize.ts: flags, liquidity_effective_usd, liquidity_divergence, data_confidence). It reads ALL final data from
// TokenMetrics (DexScreener / GeckoTerminal liquidity, prices, round trip, RugCheck, % changes for « Structure cassée »).
// Ranking (who gets a Jupiter audit, the snapshot history, the old-token slots of the age quota, the young watch, the
// alert candidates): rankByActivity, 1 h volume first, then liquidity — never the flags.
import type { ScanItem, FlagOutput } from './normalize.ts';
import { isYoungAge, tokenFlags } from './flags.ts';
import type { TokenMetrics } from './types.ts';

/** Flags, effective liquidity, divergence and confidence for fully merged metrics. */
export function finalFlags(t: TokenMetrics): FlagOutput {
  const { flags, liquidity, divergence, dataConfidence } = tokenFlags(t);
  return { flags, liquidity, divergence, dataConfidence };
}

/** A scan item: the metrics and their flags. */
export function flagItem(t: TokenMetrics): ScanItem {
  return { t, ...finalFlags(t) };
}

const finiteOr = (v: number | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** 1 h volume descending (unknown = 0), then DexScreener liquidity descending, then mint (deterministic). */
export function compareActivity(
  a: Pick<TokenMetrics, 'mint' | 'volume1h' | 'liquidityUsd'>,
  b: Pick<TokenMetrics, 'mint' | 'volume1h' | 'liquidityUsd'>,
): number {
  const v = finiteOr(b.volume1h, 0) - finiteOr(a.volume1h, 0);
  if (v !== 0) return v;
  const l = finiteOr(b.liquidityUsd, 0) - finiteOr(a.liquidityUsd, 0);
  if (l !== 0) return l;
  return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
}

/** Metrics sorted by activity (compareActivity). New array. */
export function rankByActivity<T extends Pick<TokenMetrics, 'mint' | 'volume1h' | 'liquidityUsd'>>(items: readonly T[]): T[] {
  return [...items].sort(compareActivity);
}

/**
 * Same order with the tokens younger than 24 h first (Jupiter audits and the enrich-tokens targets: the only alert
 * preset, « Jeune calme », needs top 10 / authorities / round trip on young tokens).
 */
export function rankYoungFirst<T extends Pick<TokenMetrics, 'mint' | 'volume1h' | 'liquidityUsd' | 'ageHours'>>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const ya = isYoungAge(a.ageHours) ? 0 : 1;
    const yb = isYoungAge(b.ageHours) ? 0 : 1;
    return ya - yb || compareActivity(a, b);
  });
}
