import { describe, expect, it } from 'vitest';
import type { TokenRow } from '../../shared/models/token';
import { effectiveLiquidity, liquidityLabel, liquidityMethodText, liquiditySummary } from './liquidity-sources';

type Liq = Parameters<typeof liquiditySummary>[0];
const liq = (over: Partial<Liq> = {}): Liq => ({
  liquidity_usd: 85_000,
  liquidity_dex_usd: 85_000,
  liquidity_jup_usd: null,
  liquidity_gecko_usd: null,
  liquidity_effective_usd: null,
  liquidity_divergence: null,
  ...over,
});

describe('effectiveLiquidity', () => {
  it('uses liquidity_effective_usd when known', () => {
    expect(effectiveLiquidity(liq({ liquidity_effective_usd: 40_000, liquidity_jup_usd: 60_000 }))).toBe(40_000);
  });
  it('falls back to the median of DexScreener / GeckoTerminal when null; Jupiter is ignored', () => {
    expect(effectiveLiquidity(liq({ liquidity_jup_usd: 60_000 }))).toBe(85_000);
    expect(effectiveLiquidity(liq())).toBe(85_000);
    expect(effectiveLiquidity(liq({ liquidity_gecko_usd: 65_000 }))).toBe(75_000);
    expect(effectiveLiquidity(liq({ liquidity_dex_usd: null, liquidity_usd: 0, liquidity_gecko_usd: 65_000 }))).toBe(65_000);
  });
});

describe('liquiditySummary', () => {
  it('lists DexScreener and GeckoTerminal as used (median) and Jupiter as control only', () => {
    const s = liquiditySummary(liq({ liquidity_jup_usd: 60_000, liquidity_gecko_usd: 50_000, liquidity_effective_usd: 67_500 }));
    expect(s.sources.map((x) => [x.label, x.value, x.role, x.used])).toEqual([
      ['DexScreener', 85_000, 'scored', true],
      ['GeckoTerminal', 50_000, 'scored', true],
      ['Jupiter', 60_000, 'control', false],
    ]);
    expect(s.method).toBe('median');
    expect(s.effective).toBe(67_500);
    expect(liquidityLabel(s)).toBe('Liquidité (médiane 2 sources)');
    expect(liquidityMethodText(s)).toBe('Valeur retenue : médiane de DexScreener et GeckoTerminal.');
  });
  it('a lower Jupiter value is never used', () => {
    const s = liquiditySummary(liq({ liquidity_jup_usd: 1_000 }));
    expect(s.sources.find((x) => x.id === 'jup')?.used).toBe(false);
    expect(s.method).toBe('single');
    expect(s.effective).toBe(85_000);
    expect(liquidityLabel(s)).toBe('Liquidité');
  });
  it('GeckoTerminal alone → labelled as such; nothing usable → « Aucune source exploitable. »', () => {
    const g = liquiditySummary(liq({ liquidity_usd: 0, liquidity_dex_usd: null, liquidity_gecko_usd: 30_000 }));
    expect(g.method).toBe('single');
    expect(liquidityLabel(g)).toBe('Liquidité (GeckoTerminal)');
    expect(liquidityMethodText(g)).toBe('Valeur retenue : GeckoTerminal (seule source exploitable).');
    const none = liquiditySummary(liq({ liquidity_usd: 0, liquidity_dex_usd: null }));
    expect(none.method).toBe('none');
    expect(liquidityMethodText(none)).toBe('Aucune source exploitable.');
  });

  it('falls back to liquidity_usd when the generated DexScreener column is absent', () => {
    const s = liquiditySummary({ ...liq({ liquidity_dex_usd: null }), liquidity_usd: 12_000 } as Pick<TokenRow, keyof Liq>);
    expect(s.sources[0].value).toBe(12_000);
  });

  it('ignores zero / non-finite values (unknown) and keeps DexScreener when it is the only one', () => {
    const s = liquiditySummary(liq({ liquidity_jup_usd: 0, liquidity_gecko_usd: Number.NaN }));
    expect(s.sources[1].value).toBeNull();
    expect(s.sources[2].value).toBeNull();
    expect(s.sources.filter((x) => x.used).map((x) => x.id)).toEqual(['dex']);
    expect(liquidityLabel(s)).toBe('Liquidité');
  });

  it('converts the divergence fraction to percent and flags > 50 % as incoherent', () => {
    expect(liquiditySummary(liq({ liquidity_divergence: 0.06 })).divergencePct).toBeCloseTo(6, 10);
    expect(liquiditySummary(liq({ liquidity_divergence: 0.5 })).incoherent).toBe(false);
    const bad = liquiditySummary(liq({ liquidity_divergence: 0.62 }));
    expect(bad.incoherent).toBe(true);
    expect(bad.divergencePct).toBeCloseTo(62, 10);
    expect(liquiditySummary(liq()).divergencePct).toBeNull();
  });
});
