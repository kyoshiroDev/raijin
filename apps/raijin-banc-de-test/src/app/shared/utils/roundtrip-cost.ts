// Round-trip (buy then sell) cost in SOL for the user's stake. Pure, no I/O.
// The percentage part comes from the backend Jupiter quote (0.1 SOL), already scaled to the
// stake by the caller (features/opportunities/roundtrip.ts → estimateRoundtripPct): it stays an
// ESTIMATE whenever the stake differs from 0.1 SOL.
import { DEFAULT_STAKE_SOL, isValidStake } from './stake';

/**
 * Solana network fee per transaction, in SOL. The base fee is 0.000005 SOL per signature; we
 * budget 0.0001 SOL to stay conservative and include a typical priority fee.
 */
export const NETWORK_FEE_PER_TX_SOL = 0.0001;
/** Buy + sell = 2 transactions. */
export const ROUNDTRIP_TX_COUNT = 2;
/**
 * Rent-exempt deposit of the associated token account (165 bytes) created on the first buy:
 * 0.00203928 SOL, rounded to 0.00204. Recoverable: refunded when the token account is closed
 * after the sale (wallet « Close token account » / « Burn »).
 */
export const TOKEN_ACCOUNT_RENT_SOL = 0.00204;

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface RoundtripCostOptions {
  networkFeePerTxSol?: number;
  txCount?: number;
  rentSol?: number;
}

export interface RoundtripCost {
  /** Stake actually used (invalid input → DEFAULT_STAKE_SOL). */
  stakeSol: number;
  /** stake × cost % (price impact + pool/DEX fees). null when the quote is unknown. */
  slippageAndPoolFeesSol: number | null;
  /** txCount × fee per transaction. Always known. */
  networkFeesSol: number;
  /** Token-account rent deposit, recoverable. Always known. */
  rentSol: number;
  /** slippage + network + rent: what leaves the wallet during the round trip. */
  totalPaidSol: number | null;
  /** totalPaid − rent: the real cost once the rent has been recovered. */
  totalNetSol: number | null;
  /** totalNet / stake × 100: the token must rise at least this much to cover the costs. */
  breakEvenPct: number | null;
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const nonNegative = (v: number | undefined, fallback: number): number => (finite(v) && v >= 0 ? v : fallback);

/** Rounded to the lamport (1e-9 SOL), the smallest on-chain unit: removes float noise. */
export function roundToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;
}

/** Percentages rounded to 1e-6 so bucket thresholds (3 %, 8 %) are not missed by float noise. */
function roundPct(pct: number): number {
  return Math.round(pct * 1e6) / 1e6;
}

/**
 * @param stakeSol the user's stake in SOL (0.01–100; anything else → DEFAULT_STAKE_SOL).
 * @param roundtripCostPct round-trip cost in PERCENT for this stake (clamped to [0, 100]);
 *   null/non-finite → unknown: slippage and totals are null, network fees and rent are still returned.
 */
export function roundtripCostSol(stakeSol: number, roundtripCostPct: number | null | undefined, opts: RoundtripCostOptions = {}): RoundtripCost {
  const stake = isValidStake(stakeSol) ? stakeSol : DEFAULT_STAKE_SOL;
  const perTx = nonNegative(opts.networkFeePerTxSol, NETWORK_FEE_PER_TX_SOL);
  const txCount = finite(opts.txCount) && opts.txCount >= 0 ? Math.floor(opts.txCount) : ROUNDTRIP_TX_COUNT;
  const rentSol = roundToLamports(nonNegative(opts.rentSol, TOKEN_ACCOUNT_RENT_SOL));
  const networkFeesSol = roundToLamports(perTx * txCount);

  if (!finite(roundtripCostPct)) {
    return { stakeSol: stake, slippageAndPoolFeesSol: null, networkFeesSol, rentSol, totalPaidSol: null, totalNetSol: null, breakEvenPct: null };
  }

  const pct = Math.min(100, Math.max(0, roundtripCostPct));
  const slippageAndPoolFeesSol = roundToLamports((stake * pct) / 100);
  const totalPaidSol = roundToLamports(slippageAndPoolFeesSol + networkFeesSol + rentSol);
  const totalNetSol = roundToLamports(totalPaidSol - rentSol);
  const breakEvenPct = roundPct((totalNetSol / stake) * 100);
  return { stakeSol: stake, slippageAndPoolFeesSol, networkFeesSol, rentSol, totalPaidSol, totalNetSol, breakEvenPct };
}
