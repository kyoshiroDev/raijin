// Shared contract of the detection features and outcome labels (feat/x3-model). Pure types only. The ×3 model itself
// (model.ts, ModelWeights, public.model_weights) was removed by chore/slim-down; signal_outcomes.features keeps these
// names (read by the backtest). Implementations:
//   _shared/features.ts  — feature computation from metrics + snapshots
//   _shared/outcomes.ts  — labelling from GeckoTerminal candles
//   scan-tokens / label-outcomes / migrations

/** Feature names (keys of signal_outcomes.features). */
export const FEATURE_NAMES = [
  'score', // current heuristic score 0–100
  'log_mc', // ln(market cap USD)
  'log_liq_eff', // ln(effective liquidity USD)
  'liq_mc_ratio', // effective liquidity / MC
  'roundtrip_cost_pct', // PERCENT, null → imputed
  'zone_in', 'zone_wait', 'zone_deep', 'zone_broken', // one-hot of zone_status ('none' = all 0)
  'zone_from_candles', // 1 if zone_source = 'candles'
  'change_1h', 'change_6h', 'change_24h', // PERCENT
  'buy_sell_ratio_1h', // (buys+1)/(sells+1)
  'log_age_h', // ln(1 + age hours)
  'holder_growth_1h', 'holder_growth_6h', // fraction (0.1 = +10 %), from Jupiter holderCount snapshots
  'volume_accel', // vol1h / (vol24h / 24)
  'migrated_recently', // 1 if dexId moved from 'pumpfun' to 'pumpswap'/raydium in the last 24 h
  'narrative_rank', // 1 = largest MC in its narrative group, 0 if no group
  'narrative_size', // number of tokens in the group (0 if none)
  'organic_score', // Jupiter organic score 0–100
  'log_avg_trade_usd', // ln(1 + vol1h / txns1h)
  'rug_insiders', // 1 if RugCheck reports insiders
  'rug_creator_bad', // 1 if RugCheck flags the creator history
  'lp_locked_pct', // 0–100
  'sol_change_24h', // PERCENT, market context
  'log_scan_volume_24h', // ln(1 + total 24 h volume of the scanned tokens), market context
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

/** null = unknown (the model imputes with the training mean). */
export type FeatureVector = Record<FeatureName, number | null>;

export type OutcomeStatus = 'pending' | 'final';

/** Label computed from candles after the first detection (entry = price at detection). */
export interface OutcomeLabel {
  status: OutcomeStatus; // 'final' once x3 or −50 % happened, or 7 days elapsed
  hit_x2: boolean;
  hit_x3: boolean;
  hit_x5: boolean;
  /** −50 % from entry reached BEFORE ×3 (or without ever reaching ×3). */
  dd50_first: boolean;
  max_multiple_7d: number; // max high / entry over the observed window (≤ 7 days)
  hours_to_x3: number | null;
  /** min low / entry over the observed window (0 when no candle). */
  min_multiple_7d: number;
  /** Some low ≤ 0.7 × entry (−30 %, the default stop) within the window. */
  hit_sl30: boolean;
  /** ×2 reached strictly before any −30 % candle (same candle → counted as stop first, conservative). */
  x2_before_sl30: boolean;
  /** −30 % reached before ×2 (or in the same candle). At most one of x2_before_sl30 / sl30_before_x2 is true. */
  sl30_before_x2: boolean;
  /** Open time of the first ×2 candle − detection, hours. */
  hours_to_x2: number | null;
  observed_hours: number;
}
