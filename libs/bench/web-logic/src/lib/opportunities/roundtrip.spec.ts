import { describe, expect, it } from 'vitest';
import { estimateRoundtripPct, isQuoteStake, roundtripCostView, roundtripTone } from './roundtrip';

const rt = (roundtrip_cost_pct: number | null, roundtrip_fee_pct: number | null = null) => ({ roundtrip_cost_pct, roundtrip_fee_pct });

describe('roundtripTone (colour buckets)', () => {
  it('is green below 3 %, orange from 3 to 8 % inclusive, red above 8 %', () => {
    expect(roundtripTone(0)).toBe('bull');
    expect(roundtripTone(2.99)).toBe('bull');
    expect(roundtripTone(3)).toBe('warn');
    expect(roundtripTone(8)).toBe('warn');
    expect(roundtripTone(8.01)).toBe('bear');
    expect(roundtripTone(100)).toBe('bear');
  });
});

describe('estimateRoundtripPct: fee + (cost − fee) × (x / 0.1)', () => {
  it('returns the quote itself for 0.1 SOL', () => {
    expect(estimateRoundtripPct(rt(2.4, 0.5), 0.1)).toBeCloseTo(2.4, 10);
  });
  it('scales only the size-dependent part', () => {
    // fee 0.5, impact part 1.9 → ×2.5 for 0.25 SOL
    expect(estimateRoundtripPct(rt(2.4, 0.5), 0.25)).toBeCloseTo(0.5 + 1.9 * 2.5, 10);
    expect(estimateRoundtripPct(rt(2.4, 0.5), 0.05)).toBeCloseTo(0.5 + 1.9 * 0.5, 10);
  });
  it('treats a missing fee as 0 (fully proportional)', () => {
    expect(estimateRoundtripPct(rt(2, null), 1)).toBeCloseTo(20, 10);
  });
  it('clamps to [0, 100]', () => {
    expect(estimateRoundtripPct(rt(30, 0), 1)).toBe(100);
    expect(estimateRoundtripPct(rt(-5, 0), 0.1)).toBe(0);
  });
  it('is unknown without a quote', () => {
    expect(estimateRoundtripPct(rt(null, 0.5), 0.5)).toBeNull();
    expect(estimateRoundtripPct(rt(Number.NaN), 0.5)).toBeNull();
  });
  it('falls back to the default stake (0.05 SOL) for an invalid stake', () => {
    expect(estimateRoundtripPct(rt(2.4, 0.5), Number.NaN)).toBeCloseTo(0.5 + 1.9 * 0.5, 10);
    expect(estimateRoundtripPct(rt(2.4, 0.5), 0)).toBeCloseTo(0.5 + 1.9 * 0.5, 10);
  });
});

describe('roundtripCostView (card line)', () => {
  it('shows the net SOL cost and its share of the stake, without estimate at 0.1 SOL', () => {
    // 0.1 SOL × 2.4 % = 0.0024 + 0.0002 network = 0.0026 net → 2.6 %
    const v = roundtripCostView(rt(2.4, 0.5), 0.1);
    expect(v.costText).toBe('Coût aller-retour : 0,0026 SOL (2,6 %)');
    expect(v.rentText).toBe('· +0,002 SOL de rent récupérable');
    expect(v.estimated).toBe(false);
    expect(v.tone).toBe('bull');
    expect(isQuoteStake(0.1)).toBe(true);
  });
  it('estimates other stakes from the 0.1 SOL quote', () => {
    // 0.3 SOL: 6.2 % → 0.0186 + 0.0002 = 0.0188 SOL → 6.27 %
    const v = roundtripCostView(rt(2.4, 0.5), 0.3);
    expect(v.costText).toBe('Coût aller-retour : 0,019 SOL (6,3 %)');
    expect(v.estimated).toBe(true);
    expect(v.tone).toBe('warn');
  });
  it('says « inconnu » without colour when there is no quote, rent still shown', () => {
    const v = roundtripCostView(rt(null), 0.5);
    expect(v.costText).toBe('Coût aller-retour : inconnu');
    expect(v.rentText).toBe('· +0,002 SOL de rent récupérable');
    expect(v.tone).toBeNull();
    expect(v.netPct).toBeNull();
    expect(v.cost.networkFeesSol).toBe(0.0002);
  });
});
