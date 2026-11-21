import { describe, expect, it } from 'vitest';
import { isTokenRow } from '../../shared/models/token';
import { CONFIDENCE_BADGE, buyImpactLabel, confidenceBadge, narrativeLabel, retainedLiquidity, rugcheckStats } from './token-display';

/** liquidity_jup_usd is passed on purpose: it must never change the retained value. */
const liq = (liquidity_usd: number, liquidity_jup_usd: number | null) => ({ liquidity_usd, liquidity_jup_usd });

describe('retainedLiquidity (median DexScreener / GeckoTerminal, Jupiter never used; mirrors effectiveLiquidity)', () => {
  it('ignores a lower Jupiter value (control only)', () => {
    expect(retainedLiquidity(liq(15_600, 6_850))).toBe(15_600);
  });
  it('keeps DexScreener when Jupiter is higher or equal', () => {
    expect(retainedLiquidity(liq(15_600, 40_000))).toBe(15_600);
  });
  it('keeps DexScreener when Jupiter is unknown, zero or not finite', () => {
    for (const jup of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(retainedLiquidity(liq(15_600, jup))).toBe(15_600);
    }
  });
  it('treats an absent column (old rows) as unknown', () => {
    expect(retainedLiquidity({ liquidity_usd: 15_600 } as unknown as Parameters<typeof retainedLiquidity>[0])).toBe(15_600);
  });
  it('median of DexScreener (liquidity_dex_usd, else liquidity_usd) and GeckoTerminal', () => {
    expect(retainedLiquidity({ ...liq(41_500, 66_000), liquidity_gecko_usd: 41_000 })).toBe(41_250);
    expect(retainedLiquidity({ ...liq(0, 66_000), liquidity_dex_usd: 40_000, liquidity_gecko_usd: 20_000 })).toBe(30_000);
    expect(retainedLiquidity({ ...liq(0, 66_000), liquidity_gecko_usd: 20_000 })).toBe(20_000);
    expect(retainedLiquidity({ ...liq(0, 66_000), liquidity_gecko_usd: null })).toBe(0);
  });
});

describe('isTokenRow (liquidity_jup_usd)', () => {
  const row = { mint: 'So11111111111111111111111111111111111111112', symbol: 'AAA', flags: [] };
  it('accepts null, absent or finite values', () => {
    expect(isTokenRow(row)).toBe(true);
    expect(isTokenRow({ ...row, liquidity_jup_usd: null })).toBe(true);
    expect(isTokenRow({ ...row, liquidity_jup_usd: 6_850 })).toBe(true);
  });
  it('rejects non-numeric values', () => {
    expect(isTokenRow({ ...row, liquidity_jup_usd: '6850' })).toBe(false);
    expect(isTokenRow({ ...row, liquidity_jup_usd: Number.NaN })).toBe(false);
  });
});

describe('confidenceBadge', () => {
  it('maps high / medium / low to a French label and a tone, null to no badge', () => {
    expect(confidenceBadge('high')).toEqual(CONFIDENCE_BADGE.high);
    expect(confidenceBadge('high')?.label).toBe('Données fiables');
    expect(confidenceBadge('high')?.tone).toBe('bull');
    expect(confidenceBadge('medium')?.label).toBe('Données partielles');
    expect(confidenceBadge('medium')?.tone).toBe('warn');
    expect(confidenceBadge('low')?.label).toBe('Données peu fiables');
    expect(confidenceBadge('low')?.tone).toBe('bear');
    expect(confidenceBadge(null)).toBeNull();
    expect(confidenceBadge(undefined)).toBeNull();
  });
});

describe('rugcheckStats / buyImpactLabel', () => {
  it('formats the LP lock and the score, unknown otherwise', () => {
    expect(rugcheckStats({ lp_locked_pct: 99.6, rugcheck_score: 12.4 }).map((s) => s.value)).toEqual(['100 %', '12']);
    expect(rugcheckStats({ lp_locked_pct: null, rugcheck_score: null }).map((s) => s.value)).toEqual(['Inconnue', 'Inconnu']);
  });
  it('formats the buy impact', () => {
    expect(buyImpactLabel({ buy_impact_pct: 1.25 })).toBe('1,3 %');
    expect(buyImpactLabel({ buy_impact_pct: null })).toBe('inconnu');
  });
});

describe('narrativeLabel', () => {
  it('names the narrative with its rank, nothing without a narrative', () => {
    expect(narrativeLabel({ narrative: 'GTA', narrative_rank: 2 })).toBe('Narratif GTA · n°2');
    expect(narrativeLabel({ narrative: 'GTA', narrative_rank: null })).toBe('Narratif GTA');
    expect(narrativeLabel({ narrative: null, narrative_rank: 1 })).toBeNull();
  });
});
