// Paper trade sheet maths (SIMULATION ONLY). Pure, no I/O. Mirrors the backend v2 engine
// (legacy Edge Function _shared/paper.ts, ported to the bench API: planLegs / step / reservedSol) for the only strategy left (slim-down 2026-11-21):
// - all_x2: one leg of 100 %, target ×2, stop −sl % (editable), MARKET entry at the current price.
// The levels are set from the entry at creation, then RECOMPUTED FROM THE FILL PRICE when the entry fills (same SL
// distance). Fees: one network fee for the buy + one for the exit. Rent: locked at the fill, returned at close (not a
// cost). Slippage: paid on the buy (fill = entry × 1.02) and on the sell (exit = level × 0.98).
import type { PaperOpenRequest } from '@raijin/bench-contracts';
import {
  PAPER_NETWORK_FEE_SOL,
  PAPER_RENT_SOL,
  SL_PCT_LIMITS,
  legGrossPnl,
  positionFees,
  roundSol,
  simulatedExitPrice,
  simulatedFillPrice,
} from '../models/paper';
import { STAKE_LIMITS } from '../utils/stake';

export const MIN_PAPER_STAKE_SOL = STAKE_LIMITS.min;
export const MAX_PAPER_STAKE_SOL = STAKE_LIMITS.max;
/** The only strategy of the sheet: everything sold at ×2. */
export const PAPER_STRATEGY = 'all_x2';
export const PAPER_TARGET_MULTIPLE = 2;

/** Editable values of the sheet (NaN = invalid input, reported by validation). The entry is the market price. */
export interface PaperDraft {
  /** Total stake in SOL. */
  stake: number;
  /** Entry price (USD): the current price, not editable. */
  entry: number;
  /** Stop in percent below the entry. */
  slPct: number;
}

export interface PaperDefaults {
  stake: number;
  slPct: number;
}

const positive = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Pre-filled draft (market entry at the current price, settings stake and stop), or null when the price is unknown. */
export function prefillDraft(priceUsd: number | null, defaults: PaperDefaults): PaperDraft | null {
  if (!positive(priceUsd)) return null;
  return { stake: defaults.stake, entry: priceUsd, slPct: defaults.slPct };
}

export interface StrategyPlan {
  /** Target price (entry × 2). */
  tpPrice: number;
  slPrice: number;
}

/** Target and stop of a draft (no validation; see validateDraft). */
export function strategyPlan(d: PaperDraft): StrategyPlan {
  return { tpPrice: d.entry * PAPER_TARGET_MULTIPLE, slPrice: d.entry * (1 - d.slPct / 100) };
}

/** SOL reserved while pending and debited at the fill: stake + buy fee + rent (backend reservedSol). */
export function requiredSol(stake: number): number {
  return roundSol(stake + PAPER_NETWORK_FEE_SOL + PAPER_RENT_SOL);
}

export type DraftField = 'stake' | 'slPct';
export type DraftErrors = Partial<Record<DraftField | 'entry', string>>;

export const DRAFT_ERRORS = {
  price: 'Prix actuel inconnu : paper trade indisponible.',
  slPct: `Le stop doit être un nombre entier entre ${SL_PCT_LIMITS.min} et ${SL_PCT_LIMITS.max} %.`,
  stake: 'La mise doit être comprise entre 0,01 et 100 SOL.',
  balance: 'Mise trop élevée pour ton solde virtuel (frais et rent compris).',
} as const;

/** Client-side validation (the RPC re-checks everything). `availableSol` null = unknown, not checked. {} = valid. */
export function validateDraft(d: PaperDraft, availableSol: number | null): DraftErrors {
  const errors: DraftErrors = {};
  if (!Number.isFinite(d.stake) || d.stake < MIN_PAPER_STAKE_SOL || d.stake > MAX_PAPER_STAKE_SOL) errors.stake = DRAFT_ERRORS.stake;
  else if (availableSol !== null && requiredSol(d.stake) > availableSol + 1e-9) errors.stake = DRAFT_ERRORS.balance;
  if (!positive(d.entry)) errors.entry = DRAFT_ERRORS.price;
  if (!Number.isInteger(d.slPct) || d.slPct < SL_PCT_LIMITS.min || d.slPct > SL_PCT_LIMITS.max) errors.slPct = DRAFT_ERRORS.slPct;
  return errors;
}

export type ScenarioKey = 'tp' | 'sl';

export interface Scenario {
  key: ScenarioKey;
  label: string;
  /** Net result: slippage and both network fees included (rent excluded: it is returned). */
  pnlSol: number;
  /** pnlSol / stake × 100. */
  pnlPct: number;
}

export interface TradeSummary {
  /** Levels from the entry (shown); the engine recomputes them from the fill price. */
  plan: StrategyPlan;
  /** Buy + sell. */
  txCount: number;
  networkFeesSol: number;
  rentSol: number;
  requiredSol: number;
  scenarios: Scenario[];
}

/** Live summary of a VALID draft (null otherwise). */
export function tradeSummary(d: PaperDraft): TradeSummary | null {
  if (Object.keys(validateDraft(d, null)).length > 0) return null;
  const plan = strategyPlan(d);
  const fill = simulatedFillPrice(d.entry);
  // Levels the engine actually uses once filled: recomputed from the fill price.
  const live = strategyPlan({ ...d, entry: fill });
  const make = (key: ScenarioKey, label: string, exit: number): Scenario => {
    const pnlSol = roundSol(legGrossPnl(d.stake, fill, simulatedExitPrice(exit)) - positionFees(1));
    return { key, label, pnlSol, pnlPct: (pnlSol / d.stake) * 100 };
  };
  return {
    plan,
    txCount: 2,
    networkFeesSol: positionFees(1),
    rentSol: PAPER_RENT_SOL,
    requiredSol: requiredSol(d.stake),
    scenarios: [make('tp', 'Objectif ×2 atteint', live.tpPrice), make('sl', `Stop touché (−${d.slPct} %)`, live.slPrice)],
  };
}

/** Body of `POST /api/paper/positions` (`PaperOpenRequest`, ex-RPC paper_open_position) for a valid draft: all_x2, market entry, main book. */
export function openPositionParams(d: PaperDraft, mint: string): PaperOpenRequest {
  return {
    mint,
    strategy: PAPER_STRATEGY,
    stake_sol: d.stake,
    entry_price: d.entry,
    sl_pct: d.slPct,
    custom_tp_price: null,
    custom_sl_price: null,
    book: 'main',
  };
}

const INPUT_FORMAT = new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 6, useGrouping: false });

/** Number → text for an input, French decimal comma, 6 significant digits, never an exponent (« 0,00012345 »). */
export function formatInputNumber(value: number): string {
  return Number.isFinite(value) ? INPUT_FORMAT.format(value) : '';
}
