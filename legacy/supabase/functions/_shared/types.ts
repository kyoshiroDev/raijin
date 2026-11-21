// Shared domain types (no runtime code).

/**
 * Historical Fibonacci zone status (archived columns tokens.zone_status, preset_signals.entry_zone, alert_log.entry_zone,
 * signal_outcomes.entry_zone): read back for the history only, never computed since chore/slim-down.
 */
export type ZoneStatus = 'in' | 'wait' | 'deep' | 'broken' | 'none';
/** Historical zone source (features.ts zone_from_candles, always null for new rows). */
export type ZoneSource = 'candles' | 'approx';

/** Flat, validated and sanitised view of a DexScreener pair. */
export interface TokenMetrics {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  imageUrl: string | null;
  websiteUrl: string | null;
  xUrl: string | null;
  telegramUrl: string | null;
  priceUsd: number;
  marketCap: number;
  liquidityUsd: number; // DexScreener (best pair)
  volume24h: number;
  /** DexScreener 1 h volume (USD) of the best pair. Optional: absent when rebuilt from a tokens row (no column). */
  volume1h?: number;
  change5m: number;
  change1h: number;
  change6h: number;
  change24h: number;
  buys1h: number;
  sells1h: number;
  buys24h: number;
  sells24h: number;
  pairCreatedAt: number | null; // epoch ms
  ageHours: number | null;

  // ---- Cross-source enrichment (feat/data-consensus). null = unknown / not fetched. ----
  // Written by the enrich-tokens Edge Function, persisted on public.tokens, read back by
  // scan-tokens so every flag uses the latest known enrichment.
  /** GeckoTerminal pool `reserve_in_usd` for pairAddress (USD). */
  liquidityGeckoUsd: number | null;
  /** Jupiter tokens v2 `usdPrice` (USD). */
  priceJupUsd: number | null;
  /** GeckoTerminal pool `base_token_price_usd` (USD). */
  priceGeckoUsd: number | null;
  /** Round trip 0.1 SOL → token → SOL via Jupiter quotes, in PERCENT (4.2 = 4.2 %). */
  roundtripCostPct: number | null;
  /** Part of roundtripCostPct that does not scale with size (route fees, both legs), in PERCENT. */
  roundtripFeePct: number | null;
  /** Price impact of the 0.1 SOL buy leg reported by Jupiter, in PERCENT. */
  buyImpactPct: number | null;
  /** RugCheck: share of LP locked/burnt, PERCENT 0–100. */
  lpLockedPct: number | null;
  /** RugCheck summary risk score (higher = riskier, as returned by the API). */
  rugcheckScore: number | null;
  /** RugCheck risks with level 'danger', names only, already sanitised (≤ 5). */
  rugcheckDangers: string[];
}

export type DataConfidence = 'high' | 'medium' | 'low';

/** OHLCV candle: [timestampSec, open, high, low, close, volume], oldest first. */
export type Candle = [number, number, number, number, number, number];
