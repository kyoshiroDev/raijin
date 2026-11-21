// Round-trip (buy + sell) cost display. The backend stores a Jupiter quote for 0.1 SOL;
// for another stake the price-impact part is scaled linearly (pure estimate, no API call),
// then converted to SOL with network fees and the recoverable rent (shared/utils/roundtrip-cost).
import type { TokenRow } from '../../shared/models/token';
import { formatPercentFr, formatSolAmount } from '../../shared/utils/format';
import { roundtripCostSol, type RoundtripCost } from '../../shared/utils/roundtrip-cost';
import { DEFAULT_STAKE_SOL, isValidStake } from '../../shared/utils/stake';

/** Stake used by the backend Jupiter quote (roundtrip_cost_pct). */
export const QUOTE_STAKE_SOL = 0.1;
export const ROUNDTRIP_WARN_PCT = 3;
export const ROUNDTRIP_BAD_PCT = 8;

export type RoundtripTone = 'bull' | 'warn' | 'bear';

type RoundtripFields = Pick<TokenRow, 'roundtrip_cost_pct' | 'roundtrip_fee_pct'>;

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * est(x) = fee + (cost − fee) × (x / 0.1), clamped to [0, 100].
 * cost = roundtrip_cost_pct (0.1 SOL quote), fee = roundtrip_fee_pct ?? 0. Unknown cost → null.
 */
export function estimateRoundtripPct(t: RoundtripFields, stakeSol: number): number | null {
  const cost = t.roundtrip_cost_pct;
  if (!finite(cost)) return null;
  const fee = finite(t.roundtrip_fee_pct) ? t.roundtrip_fee_pct : 0;
  const stake = isValidStake(stakeSol) ? stakeSol : DEFAULT_STAKE_SOL;
  const est = fee + (cost - fee) * (stake / QUOTE_STAKE_SOL);
  return Math.min(100, Math.max(0, est));
}

/** < 3 % green, 3–8 % orange (both inclusive), > 8 % red. */
export function roundtripTone(pct: number): RoundtripTone {
  if (pct < ROUNDTRIP_WARN_PCT) return 'bull';
  if (pct <= ROUNDTRIP_BAD_PCT) return 'warn';
  return 'bear';
}

export function isQuoteStake(stakeSol: number): boolean {
  return Math.abs(stakeSol - QUOTE_STAKE_SOL) < 1e-9;
}

export interface RoundtripCostView {
  /** SOL breakdown for the stake (network fees and rent always known). */
  cost: RoundtripCost;
  /** Net cost (after recovering the rent) / stake, in percent; null when the quote is unknown. */
  netPct: number | null;
  tone: RoundtripTone | null;
  /** Stake ≠ 0.1 SOL: the percentage part is scaled from the 0.1 SOL quote. */
  estimated: boolean;
  /** « Coût aller-retour : 0,0013 SOL (2,6 %) » or « Coût aller-retour : inconnu ». */
  costText: string;
  /** « · +0,002 SOL de rent récupérable ». */
  rentText: string;
}

/** Card line: net round-trip cost in SOL for the stake, coloured by net cost / stake. */
export function roundtripCostView(t: RoundtripFields, stakeSol: number): RoundtripCostView {
  const stake = isValidStake(stakeSol) ? stakeSol : DEFAULT_STAKE_SOL;
  const cost = roundtripCostSol(stake, estimateRoundtripPct(t, stake));
  const rentText = `· +${formatSolAmount(cost.rentSol)} SOL de rent récupérable`;
  const estimated = !isQuoteStake(stake);
  if (cost.totalNetSol === null || cost.breakEvenPct === null) {
    return { cost, netPct: null, tone: null, estimated, costText: 'Coût aller-retour : inconnu', rentText };
  }
  const netPct = cost.breakEvenPct;
  const costText = `Coût aller-retour : ${formatSolAmount(cost.totalNetSol)} SOL (${formatPercentFr(netPct)})`;
  return { cost, netPct, tone: roundtripTone(netPct), estimated, costText, rentText };
}
