import { describe, expect, it } from 'vitest';
import type { TokenRow } from '../models/token';
import { DEFAULT_FILTERS, RISKY_CHANGE_1H_PCT, RISKY_LIQUIDITY_USD, activeFilterCount, applyFilters, isBondingCurve, isRisky } from './opportunity-filters';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const token = (over: Partial<TokenRow>): TokenRow =>
  ({
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'AAA',
    name: 'Alpha',
    dex_id: 'raydium',
    market_cap: 1_000_000,
    pair_created_at: hoursAgo(2),
    change_1h: 2,
    liquidity_usd: 100_000,
    liquidity_dex_usd: 100_000,
    liquidity_jup_usd: null,
    liquidity_gecko_usd: null,
    liquidity_effective_usd: null,
    flags: [],
    mint_authority_disabled: true,
    freeze_authority_disabled: true,
    ...over,
  }) as TokenRow;

describe('applyFilters', () => {
  it('lists only pairs younger than 24 h by default (unknown age hidden), all of them with « Afficher les tokens anciens »', () => {
    const list = [token({ symbol: 'YOUNG', pair_created_at: hoursAgo(23.9) }), token({ symbol: 'OLD', pair_created_at: hoursAgo(24) }), token({ symbol: 'UNKNOWN', pair_created_at: null })];
    expect(DEFAULT_FILTERS.showOld).toBe(false);
    expect(applyFilters(list, DEFAULT_FILTERS, NOW).map((t) => t.symbol)).toEqual(['YOUNG']);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, showOld: true }, NOW).map((t) => t.symbol)).toEqual(['YOUNG', 'OLD', 'UNKNOWN']);
  });
  it('filters by market cap', () => {
    const list = [token({ symbol: 'BIG', market_cap: 50_000_000 }), token({ symbol: 'OK' })];
    expect(applyFilters(list, DEFAULT_FILTERS, NOW).map((t) => t.symbol)).toEqual(['OK']);
  });
  it('sorts the youngest pair first (no score ordering), unknown age last', () => {
    const list = [
      token({ symbol: 'A', pair_created_at: hoursAgo(10) }),
      token({ symbol: 'Z', pair_created_at: null }),
      token({ symbol: 'B', pair_created_at: hoursAgo(0.5) }),
      token({ symbol: 'C', pair_created_at: hoursAgo(80) }),
    ];
    expect(applyFilters(list, { ...DEFAULT_FILTERS, showOld: true }, NOW).map((t) => t.symbol)).toEqual(['B', 'A', 'C', 'Z']);
  });
  it('hides risky tokens when asked', () => {
    const risky = token({ symbol: 'RUG', freeze_authority_disabled: false });
    expect(isRisky(risky)).toBe(true);
    expect(applyFilters([risky], DEFAULT_FILTERS, NOW)).toHaveLength(0);
    expect(applyFilters([risky], { ...DEFAULT_FILTERS, hideRisky: false }, NOW)).toHaveLength(1);
  });
  it('searches symbol, name and exact mint', () => {
    const list = [token({ symbol: 'GTA6', name: 'GTA VI' }), token({ symbol: 'DOG', name: 'Doge' })];
    expect(applyFilters(list, { ...DEFAULT_FILTERS, search: 'gta' }, NOW)).toHaveLength(1);
  });
});

describe('isRisky (« Masquer les tokens risqués »)', () => {
  it('a healthy token is not risky', () => {
    expect(isRisky(token({}))).toBe(false);
  });
  it('keeps the existing criteria: 2+ flags, active mint or freeze authority', () => {
    expect(isRisky(token({ flags: ['a'] }))).toBe(false);
    expect(isRisky(token({ flags: ['a', 'b'] }))).toBe(true);
    expect(isRisky(token({ mint_authority_disabled: false }))).toBe(true);
    expect(isRisky(token({ freeze_authority_disabled: false }))).toBe(true);
    expect(isRisky(token({ mint_authority_disabled: null, freeze_authority_disabled: null }))).toBe(false);
  });
  it('hides a « Structure cassée » flag even alone', () => {
    expect(isRisky(token({ flags: ['Structure cassée'] }))).toBe(true);
    expect(isRisky(token({ flags: ['RugCheck : Low liquidity'] }))).toBe(false);
  });
  it(`hides a crash of more than 25 % in 1 h (${RISKY_CHANGE_1H_PCT} kept, −25.01 hidden)`, () => {
    expect(isRisky(token({ change_1h: -25 }))).toBe(false);
    expect(isRisky(token({ change_1h: -25.01 }))).toBe(true);
  });
  it(`hides an effective liquidity under ${RISKY_LIQUIDITY_USD} $ (liquidity_effective_usd first)`, () => {
    expect(isRisky(token({ liquidity_effective_usd: 20_000 }))).toBe(false);
    expect(isRisky(token({ liquidity_effective_usd: 19_999 }))).toBe(true);
    // The backend value wins over the raw sources.
    expect(isRisky(token({ liquidity_usd: 15_000, liquidity_dex_usd: 15_000, liquidity_effective_usd: 25_000 }))).toBe(false);
  });
  it('falls back to the median of DexScreener / GeckoTerminal when liquidity_effective_usd is null; Jupiter ignored', () => {
    expect(isRisky(token({ liquidity_usd: 19_999, liquidity_dex_usd: 19_999 }))).toBe(true);
    // median(30 k$, 9 k$) = 19.5 k$ → risky; median(30 k$, 10 k$) = 20 k$ → not risky.
    expect(isRisky(token({ liquidity_usd: 30_000, liquidity_dex_usd: 30_000, liquidity_gecko_usd: 9_000 }))).toBe(true);
    expect(isRisky(token({ liquidity_usd: 30_000, liquidity_dex_usd: 30_000, liquidity_gecko_usd: 10_000 }))).toBe(false);
    expect(isRisky(token({ liquidity_usd: 19_000, liquidity_dex_usd: 19_000, liquidity_jup_usd: 500_000 }))).toBe(true);
  });
  it('the filter hides each new criterion and shows them when unchecked', () => {
    const list = [
      token({ symbol: 'OK' }),
      token({ symbol: 'BROKEN', flags: ['Structure cassée'] }),
      token({ symbol: 'CRASH', change_1h: -40 }),
      token({ symbol: 'THIN', liquidity_effective_usd: 12_000 }),
    ];
    expect(applyFilters(list, DEFAULT_FILTERS, NOW).map((t) => t.symbol)).toEqual(['OK']);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, hideRisky: false }, NOW)).toHaveLength(4);
  });
});

describe('bonding curve filter', () => {
  it('detects bonding curves by dex_id === "pumpfun" only', () => {
    expect(isBondingCurve(token({ dex_id: 'pumpfun' }))).toBe(true);
    expect(isBondingCurve(token({ dex_id: 'pumpswap' }))).toBe(false);
    expect(isBondingCurve(token({ dex_id: 'PumpFun' }))).toBe(false);
    expect(isBondingCurve(token({ dex_id: 'raydium' }))).toBe(false);
    expect(isBondingCurve(token({ dex_id: '' }))).toBe(false);
  });
  it('hides bonding curves by default', () => {
    expect(DEFAULT_FILTERS.hideBondingCurves).toBe(true);
    const list = [token({ symbol: 'PUMP', dex_id: 'pumpfun' }), token({ symbol: 'RAY', dex_id: 'raydium' })];
    expect(applyFilters(list, DEFAULT_FILTERS, NOW).map((t) => t.symbol)).toEqual(['RAY']);
  });
  it('never hides pumpswap tokens (graduated, real pool)', () => {
    const list = [token({ symbol: 'SWAP', dex_id: 'pumpswap' }), token({ symbol: 'PUMP', dex_id: 'pumpfun' })];
    expect(applyFilters(list, DEFAULT_FILTERS, NOW).map((t) => t.symbol)).toEqual(['SWAP']);
  });
  it('shows bonding curves when the filter is unchecked', () => {
    const list = [token({ symbol: 'PUMP', dex_id: 'pumpfun', pair_created_at: hoursAgo(1) }), token({ symbol: 'RAY', dex_id: 'raydium' })];
    expect(applyFilters(list, { ...DEFAULT_FILTERS, hideBondingCurves: false }, NOW).map((t) => t.symbol)).toEqual(['PUMP', 'RAY']);
  });
});

describe('activeFilterCount', () => {
  it('is 0 for the defaults', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, search: '   ' })).toBe(0);
  });
  it('counts each filter that differs from the defaults', () => {
    expect(activeFilterCount({ ...DEFAULT_FILTERS, maxMarketCap: null })).toBe(1);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, maxMarketCap: null, hideRisky: false, search: 'gta' })).toBe(3);
    expect(activeFilterCount({ showOld: false, maxMarketCap: 1_000_000, hideRisky: false, hideBondingCurves: false, search: 'x' })).toBe(4);
  });
  it('does not count « Afficher les tokens anciens » (visible switch on the page)', () => {
    expect(activeFilterCount({ ...DEFAULT_FILTERS, showOld: true })).toBe(0);
  });
});
