// Pure token flags + cross-source consensus (chore/slim-down: the score /100 is gone). No I/O.
// tokenFlags() is the single entry point used by scan-tokens and enrich-tokens (through final-score.ts): it returns the
// warning flags (safety, RugCheck, LP, cost, bonding curve, liquidity, crashes, « Structure cassée »…), the effective
// liquidity (median DexScreener / GeckoTerminal), the liquidity divergence and data_confidence. Nothing is weighted or
// ranked here: the scan ranks by 1 h volume (ranking.ts), the front by age.
import type { DataConfidence, TokenMetrics } from './types.ts';
import { sanitizeText } from './sanitize.ts';
import { dataConfidence, DIVERGENCE_MAX, effectiveLiquidity, priceConsensus, roundtripFlag } from './consensus.ts';
import { structureBroken } from './structure.ts';

/**
 * Young-token thresholds (feat/young-calm). On 201 detections < 24 h labelled on candles, « frenzy » (change1h > 150 %
 * or 1 h buy/sell ratio > 1.3) gave 26 % ×2 before −30 % and « calm » (ratio ≤ 1.3, change1h 0–100 %) 35–36 %. The same
 * thresholds define the « Jeune calme » / « Jeune frénésie » presets (presets.ts) and the « Frénésie » flag below.
 */
export const YOUNG_MAX_AGE_H = 24;
/** 1 h buy/sell ratio (ratio()) above which a young token is « frenzy ». */
export const YOUNG_RATIO_MAX = 1.3;
/** change1h (PERCENT) STRICTLY above which a young token is « frenzy ». */
export const YOUNG_FRENZY_1H_PCT = 150;

/** true when the age is known and < YOUNG_MAX_AGE_H. */
export const isYoungAge = (ageHours: number | null | undefined): boolean =>
  typeof ageHours === 'number' && Number.isFinite(ageHours) && ageHours < YOUNG_MAX_AGE_H;

/** Crash thresholds in PERCENT (strict: exactly −25 % / −50 % do not trigger). */
export const CRASH_1H_PCT = -25;
export const CRASH_24H_PCT = -50;

/**
 * Only the pump.fun bonding curve itself (dexId === 'pumpfun') counts. 'pumpswap' is the real AMM pool a token migrates
 * to after graduation: not flagged.
 */
export const BONDING_CURVE_DEX_ID = 'pumpfun';
export function isBondingCurve(dexId: string): boolean {
  return dexId === BONDING_CURVE_DEX_ID;
}

/** Absolute-size flags (the former score caps, without any cap). Liquidity buckets are disjoint. */
export const SIZE_FLAGS = {
  liqUnder10k: { below: 10_000, flag: 'Liquidité très faible (< 10 k$)' },
  liqUnder20k: { below: 20_000, flag: 'Liquidité faible (< 20 k$)' },
  liqUnder50k: { below: 50_000, flag: 'Liquidité limitée (< 50 k$)' },
  mcUnder100k: { below: 100_000, flag: 'Petite capitalisation (< 100 k$)' },
} as const;

/** Flags kept (the tokens.flags column stores 12). */
export const MAX_FLAGS = 12;
/** Max RugCheck danger flags and max length of a danger name. */
export const RUGCHECK_FLAGS_MAX = 2;
export const RUGCHECK_NAME_MAX = 40;
/** LP locked/burnt share (PERCENT) under which « LP peu verrouillée » is flagged. */
export const LP_LOCKED_MIN_PCT = 50;

export const FLAG_INCOHERENT_DATA = 'Données incohérentes';
export const FLAG_PRICE_DIVERGENT = 'Prix divergent entre sources';
export const FLAG_LP_UNLOCKED = 'LP peu verrouillée';
/** Price under the 0.786 retracement of the approximate swing (structure.ts). Required by the phase-2 safety rules. */
export const FLAG_ZONE_BROKEN = 'Structure cassée';
export const FLAG_BONDING_CURVE = 'Bonding curve';

export function ratio(buys: number, sells: number): number {
  return (buys + 1) / (sells + 1);
}

export interface FlagsResult {
  flags: string[];
  /** Effective liquidity: median of the valid DexScreener / GeckoTerminal values, 0 when none. */
  liquidity: number;
  /** Liquidity divergence (max − min) / min as a FRACTION, null with fewer than 2 sources. */
  divergence: number | null;
  /** Prices deviate more than 5 % from their median across sources. */
  priceDivergent: boolean;
  dataConfidence: DataConfidence;
}

function liquidityFlag(liquidity: number): string | null {
  if (liquidity < SIZE_FLAGS.liqUnder10k.below) return SIZE_FLAGS.liqUnder10k.flag;
  if (liquidity < SIZE_FLAGS.liqUnder20k.below) return SIZE_FLAGS.liqUnder20k.flag;
  if (liquidity < SIZE_FLAGS.liqUnder50k.below) return SIZE_FLAGS.liqUnder50k.flag;
  return null;
}

/**
 * Up to RUGCHECK_FLAGS_MAX « RugCheck : <name> » flags. Names are sanitised server-side already; sanitised AGAIN here
 * (defence in depth: invisible/bidi characters, angle brackets, length) because flags reach push payloads.
 */
function rugcheckFlags(dangers: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(dangers)) return [];
  return dangers
    .filter((d): d is string => typeof d === 'string')
    .map((d) => sanitizeText(d, RUGCHECK_NAME_MAX))
    .filter((d) => d.length > 0)
    .slice(0, RUGCHECK_FLAGS_MAX)
    .map((d) => `RugCheck : ${d}`);
}

/** Flags (most important first, cut at MAX_FLAGS) and consensus of fully merged metrics. */
export function tokenFlags(t: TokenMetrics): FlagsResult {
  const liq = effectiveLiquidity({ dex: t.liquidityUsd, gecko: t.liquidityGeckoUsd });
  const liquidity = liq.value;
  const price = priceConsensus({ dex: t.priceUsd, jup: t.priceJupUsd, gecko: t.priceGeckoUsd });
  const incoherent = liq.divergence !== null && liq.divergence > DIVERGENCE_MAX;
  const liqRatio = t.marketCap > 0 ? liquidity / t.marketCap : 0;
  const age = t.ageHours;
  const youngFrenzy = isYoungAge(age) && t.change1h > YOUNG_FRENZY_1H_PCT;
  const socials = (t.websiteUrl ? 1 : 0) + (t.xUrl ? 1 : 0) + (t.telegramUrl ? 1 : 0);
  const lpLocked = t.lpLockedPct;
  const candidates: (string | null)[] = [
    incoherent ? FLAG_INCOHERENT_DATA : null,
    structureBroken(t) ? FLAG_ZONE_BROKEN : null,
    ...rugcheckFlags(t.rugcheckDangers),
    typeof lpLocked === 'number' && Number.isFinite(lpLocked) && lpLocked < LP_LOCKED_MIN_PCT ? FLAG_LP_UNLOCKED : null,
    roundtripFlag(t.roundtripCostPct),
    isBondingCurve(t.dexId) ? FLAG_BONDING_CURVE : null,
    t.change1h < CRASH_1H_PCT ? `Chute ${Math.round(t.change1h)} % en 1 h` : null,
    t.change24h < CRASH_24H_PCT ? `Chute ${Math.round(t.change24h)} % en 24 h` : null,
    liquidityFlag(liquidity),
    t.marketCap < SIZE_FLAGS.mcUnder100k.below ? SIZE_FLAGS.mcUnder100k.flag : null,
    liqRatio < 0.05 ? 'Liquidité faible vs MC' : null,
    t.sells1h > t.buys1h * 1.3 ? 'Ventes > achats (1 h)' : null,
    t.change24h > 300 ? `Déjà +${Math.round(t.change24h)} % en 24 h (sur-extension)` : null,
    youngFrenzy ? `Frénésie : +${Math.round(t.change1h)} % en 1 h` : null,
    price.divergent ? FLAG_PRICE_DIVERGENT : null,
    age !== null && age < 1 ? 'Moins d\'1 h' : null,
    socials === 0 ? 'Aucun réseau social' : null,
  ];
  return {
    flags: candidates.filter((f): f is string => f !== null).slice(0, MAX_FLAGS),
    liquidity,
    divergence: liq.divergence,
    priceDivergent: price.divergent,
    dataConfidence: dataConfidence({
      liquiditySources: liq.sources,
      divergence: liq.divergence,
      priceDivergent: price.divergent,
      roundtripKnown: typeof t.roundtripCostPct === 'number' && Number.isFinite(t.roundtripCostPct),
    }),
  };
}
