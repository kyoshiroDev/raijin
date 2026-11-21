// Pure cross-source consensus (DexScreener / Jupiter / GeckoTerminal). No score since chore/slim-down: these values
// feed the flags (flags.ts), liquidity_effective_usd and data_confidence.
// Liquidity: median of DexScreener + GeckoTerminal. Jupiter's liquidity is not part of any computation (only shown in
// the front tooltip, archived column tokens.liquidity_jup_usd no longer written).
// Prices: all three sources (Jupiter price included) feed the price-divergence flag.
import type { DataConfidence } from './types.ts';

/** Liquidity divergence (fraction, (max − min) / min) above which the data are "incoherent": flag + penalty. */
export const DIVERGENCE_MAX = 0.5;
/** Liquidity divergence (fraction) up to which sources are considered in agreement (needed for 'high'). */
export const DIVERGENCE_AGREE = 0.2;
/** Max price deviation from the median (fraction) before prices are flagged as divergent. */
export const PRICE_DEVIATION_MAX = 0.05;

/**
 * Round-trip cost flags (0.1 SOL → token → SOL via Jupiter), roundtripCostPct in PERCENT, strictly above `above`.
 * The highest applicable one is flagged.
 */
export const ROUNDTRIP_FLAGS = {
  high: { above: 5, flag: "Coût d'aller-retour élevé (> 5 %)" },
  extreme: { above: 10, flag: "Coût d'aller-retour élevé (> 10 %)" },
} as const;

export interface SourceValues {
  dex: number | null;
  jup: number | null;
  gecko: number | null;
}

/** Liquidity sources (Jupiter is not one: chore/slim-down item 8). */
export interface LiquiditySources {
  dex: number | null;
  gecko: number | null;
}

export interface EffectiveLiquidity {
  /** Median of the valid DexScreener / GeckoTerminal values (2 values → their mean, 1 → that one), 0 when none. */
  value: number;
  /** (max − min) / min between DexScreener and GeckoTerminal as a fraction, null unless both are valid. */
  divergence: number | null;
  /** Number of valid scoring sources used (DexScreener, GeckoTerminal): 0–2. */
  sources: number;
}

export interface PriceConsensus {
  median: number | null;
  /** max |p − median| / median as a fraction, null when no valid price. */
  maxDeviation: number | null;
  /** maxDeviation > PRICE_DEVIATION_MAX. */
  divergent: boolean;
}

export interface ConfidenceInput {
  liquiditySources: number;
  divergence: number | null;
  priceDivergent: boolean;
  roundtripKnown: boolean;
}

/** A source value is usable only when it is a finite, strictly positive number (0 = "not indexed", not "empty"). */
export function isValidSourceValue(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function validValues(src: SourceValues): number[] {
  return [src.dex, src.jup, src.gecko].filter(isValidSourceValue);
}

/** Effective liquidity: median of the valid DexScreener and GeckoTerminal values, plus how much they disagree. */
export function effectiveLiquidity(src: LiquiditySources): EffectiveLiquidity {
  const values = [src.dex, src.gecko].filter(isValidSourceValue);
  if (values.length === 0) return { value: 0, divergence: null, sources: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    value: values.length === 2 ? (min + max) / 2 : min,
    divergence: values.length === 2 ? (max - min) / min : null,
    sources: values.length,
  };
}

/** Median price across sources (median of 2 = mean) and the largest relative deviation from it. */
export function priceConsensus(src: SourceValues): PriceConsensus {
  const values = validValues(src).sort((a, b) => a - b);
  if (values.length === 0) return { median: null, maxDeviation: null, divergent: false };
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  const maxDeviation = Math.max(...values.map((p) => Math.abs(p - median) / median));
  return { median, maxDeviation, divergent: maxDeviation > PRICE_DEVIATION_MAX };
}

/**
 * How much the displayed numbers can be trusted. `liquiditySources` / `divergence` come from effectiveLiquidity
 * (DexScreener + GeckoTerminal only, Jupiter excluded).
 * - 'low': fewer than 2 scoring liquidity sources (DexScreener or GeckoTerminal missing), divergence > DIVERGENCE_MAX, or price divergent while the
 *   liquidity divergence already exceeds DIVERGENCE_AGREE.
 * - 'high': ≥ 2 liquidity sources within DIVERGENCE_AGREE, prices agree and the round trip is known.
 * - 'medium': everything else.
 */
export function dataConfidence(i: ConfidenceInput): DataConfidence {
  const div = i.divergence;
  if (i.liquiditySources < 2 || div === null || !Number.isFinite(div)) return 'low';
  if (div > DIVERGENCE_MAX) return 'low';
  if (i.priceDivergent && div > DIVERGENCE_AGREE) return 'low';
  if (div <= DIVERGENCE_AGREE && !i.priceDivergent && i.roundtripKnown) return 'high';
  return 'medium';
}

/** Round-trip flag that applies to roundtripCostPct (PERCENT), or null (unknown / within limits). */
export function roundtripFlag(roundtripCostPct: number | null | undefined): string | null {
  if (typeof roundtripCostPct !== 'number' || !Number.isFinite(roundtripCostPct)) return null;
  if (roundtripCostPct > ROUNDTRIP_FLAGS.extreme.above) return ROUNDTRIP_FLAGS.extreme.flag;
  if (roundtripCostPct > ROUNDTRIP_FLAGS.high.above) return ROUNDTRIP_FLAGS.high.flag;
  return null;
}
