import { describe, expect, it } from 'vitest';
import { NETWORK_FEE_PER_TX_SOL, TOKEN_ACCOUNT_RENT_SOL, roundToLamports, roundtripCostSol } from './roundtrip-cost';

describe('roundtripCostSol', () => {
  it('documents the constants (0.0001 SOL per transaction, 0.00204 SOL of rent)', () => {
    expect(NETWORK_FEE_PER_TX_SOL).toBe(0.0001);
    expect(TOKEN_ACCOUNT_RENT_SOL).toBe(0.00204);
  });

  it('splits the cost for 0.05 SOL at 2.2 %', () => {
    expect(roundtripCostSol(0.05, 2.2)).toEqual({
      stakeSol: 0.05,
      slippageAndPoolFeesSol: 0.0011,
      networkFeesSol: 0.0002,
      rentSol: 0.00204,
      totalPaidSol: 0.00334,
      totalNetSol: 0.0013,
      breakEvenPct: 2.6,
    });
  });

  it('nets out the rent: totalNet = totalPaid − rent, break-even = net / stake', () => {
    const c = roundtripCostSol(1, 5);
    expect(c.slippageAndPoolFeesSol).toBe(0.05);
    expect(c.totalPaidSol).toBe(0.05224);
    expect(c.totalNetSol).toBe(0.0502);
    expect(c.breakEvenPct).toBe(5.02);
  });

  it('returns network fees and rent even when the cost % is unknown', () => {
    for (const pct of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(roundtripCostSol(0.05, pct)).toEqual({
        stakeSol: 0.05,
        slippageAndPoolFeesSol: null,
        networkFeesSol: 0.0002,
        rentSol: 0.00204,
        totalPaidSol: null,
        totalNetSol: null,
        breakEvenPct: null,
      });
    }
  });

  it('handles the boundaries: 0 % (network fees only) and clamps to [0, 100] %', () => {
    const zero = roundtripCostSol(0.1, 0);
    expect(zero.slippageAndPoolFeesSol).toBe(0);
    expect(zero.totalNetSol).toBe(0.0002);
    expect(zero.breakEvenPct).toBe(0.2);
    expect(roundtripCostSol(0.1, -3).slippageAndPoolFeesSol).toBe(0);
    expect(roundtripCostSol(0.1, 250).slippageAndPoolFeesSol).toBe(0.1);
    expect(roundtripCostSol(0.01, 0).breakEvenPct).toBe(2);
    expect(roundtripCostSol(100, 1).slippageAndPoolFeesSol).toBe(1);
  });

  it('falls back to the default stake (0.05 SOL) for an invalid stake', () => {
    for (const bad of [0, 0.005, 101, -1, Number.NaN]) {
      const c = roundtripCostSol(bad, 2);
      expect(c.stakeSol).toBe(0.05);
      expect(c.slippageAndPoolFeesSol).toBe(0.001);
    }
  });

  it('rounds SOL amounts to the lamport and percentages without float noise', () => {
    expect(roundToLamports(0.1 + 0.2)).toBe(0.3);
    expect(roundToLamports(0.0000000014)).toBe(0.000000001);
    // 0.05 × 2.6 % + 0.0002 = 0.0015 → exactly 3 % (bucket boundary), not 3.0000000000000004
    expect(roundtripCostSol(0.05, 2.6).breakEvenPct).toBe(3);
    expect(roundtripCostSol(0.1, 7.8).breakEvenPct).toBe(8);
    expect(roundtripCostSol(0.03, 1 / 3).slippageAndPoolFeesSol).toBe(0.0001);
  });

  it('accepts other fee assumptions through options (invalid ones ignored)', () => {
    const c = roundtripCostSol(0.05, 2, { networkFeePerTxSol: 0.000005, txCount: 2, rentSol: 0 });
    expect(c.networkFeesSol).toBe(0.00001);
    expect(c.rentSol).toBe(0);
    expect(c.totalPaidSol).toBe(c.totalNetSol);
    const d = roundtripCostSol(0.05, 2, { networkFeePerTxSol: -1, txCount: Number.NaN, rentSol: Number.NaN });
    expect(d.networkFeesSol).toBe(0.0002);
    expect(d.rentSol).toBe(0.00204);
  });
});
