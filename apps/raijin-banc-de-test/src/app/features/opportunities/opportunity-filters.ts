import type { TokenRow } from '../../shared/models/token';
import { effectiveLiquidity } from './liquidity-sources';
import { FLAG_BROKEN_STRUCTURE, isYoung, pairAgeHours } from './token-signals';

export interface OpportunityFilters {
  /** « Afficher les tokens anciens »: off by default, only pairs younger than 24 h are listed. */
  showOld: boolean;
  maxMarketCap: number | null;
  hideRisky: boolean; // see isRisky()
  hideBondingCurves: boolean; // hide tokens still on the pump.fun bonding curve (dex_id === 'pumpfun')
  search: string;
}

export const DEFAULT_FILTERS: OpportunityFilters = {
  showOld: false,
  maxMarketCap: 20_000_000,
  hideRisky: true,
  hideBondingCurves: true,
  search: '',
};

/**
 * Number of sheet filters that differ from the defaults (badge on the « Filtres » button). « Afficher les tokens
 * anciens » is a visible switch on the page, not counted here.
 */
export function activeFilterCount(f: OpportunityFilters, defaults: OpportunityFilters = DEFAULT_FILTERS): number {
  let n = 0;
  if (f.maxMarketCap !== defaults.maxMarketCap) n++;
  if (f.hideRisky !== defaults.hideRisky) n++;
  if (f.hideBondingCurves !== defaults.hideBondingCurves) n++;
  if (f.search.trim() !== defaults.search.trim()) n++;
  return n;
}

/** Hourly drop (PERCENT, strict) and effective liquidity (USD, strict) beyond which a token is « risqué ». */
export const RISKY_CHANGE_1H_PCT = -25;
export const RISKY_LIQUIDITY_USD = 20_000;

/**
 * « Masquer les tokens risqués »: 2+ red flags, an active mint/freeze authority, a « Structure cassée » flag, a crash
 * of more than 25 % in 1 h, or an effective liquidity under 20 k$ (liquidity_effective_usd, else the median of
 * DexScreener / GeckoTerminal).
 */
export function isRisky(t: TokenRow): boolean {
  return (
    t.flags.length >= 2 ||
    t.mint_authority_disabled === false ||
    t.freeze_authority_disabled === false ||
    t.flags.includes(FLAG_BROKEN_STRUCTURE) ||
    (Number.isFinite(t.change_1h) && t.change_1h < RISKY_CHANGE_1H_PCT) ||
    effectiveLiquidity(t) < RISKY_LIQUIDITY_USD
  );
}

/** Same rule as the backend: dex_id === 'pumpfun' exactly ('pumpswap' is a real pool). */
export function isBondingCurve(t: Pick<TokenRow, 'dex_id'>): boolean {
  return t.dex_id === 'pumpfun';
}

/** Age used for sorting: unknown ages go last. */
const ageKey = (t: TokenRow, now: number): number => pairAgeHours(t.pair_created_at, now) ?? Number.POSITIVE_INFINITY;

/** Pure: filter then sort, youngest pair first (unknown age last). */
export function applyFilters(tokens: readonly TokenRow[], f: OpportunityFilters, now = Date.now()): TokenRow[] {
  const q = f.search.trim().toLowerCase();
  return tokens
    .filter((t) => f.showOld || isYoung(t, now))
    .filter((t) => f.maxMarketCap === null || t.market_cap <= f.maxMarketCap)
    .filter((t) => !f.hideRisky || !isRisky(t))
    .filter((t) => !f.hideBondingCurves || !isBondingCurve(t))
    .filter((t) => !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.mint === f.search.trim())
    .sort((a, b) => ageKey(a, now) - ageKey(b, now));
}
