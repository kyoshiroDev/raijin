// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIVERGENCE_AGREE, DIVERGENCE_MAX, PRICE_DEVIATION_MAX, ROUNDTRIP_FLAGS,
  dataConfidence, effectiveLiquidity, isValidSourceValue, priceConsensus, roundtripFlag,
} from './consensus';

const close = (a: number | null, b: number, eps = 1e-9) => {
  assert.ok(a !== null && Math.abs(a - b) < eps, `${a} !≈ ${b}`);
};

describe('consensus thresholds', () => {
  it('exposes the documented values', () => {
    assert.equal(DIVERGENCE_MAX, 0.5);
    assert.equal(DIVERGENCE_AGREE, 0.2);
    assert.equal(PRICE_DEVIATION_MAX, 0.05);
    assert.equal(ROUNDTRIP_FLAGS.high.above, 5);
    assert.equal(ROUNDTRIP_FLAGS.extreme.above, 10);
  });
});

describe('isValidSourceValue', () => {
  it('accepts only finite strictly positive numbers', () => {
    assert.equal(isValidSourceValue(1), true);
    assert.equal(isValidSourceValue(0), false);
    assert.equal(isValidSourceValue(-1), false);
    assert.equal(isValidSourceValue(Number.NaN), false);
    assert.equal(isValidSourceValue(Number.POSITIVE_INFINITY), false);
    assert.equal(isValidSourceValue(null), false);
    assert.equal(isValidSourceValue(undefined), false);
    assert.equal(isValidSourceValue('5'), false);
  });
});

describe('effectiveLiquidity', () => {
  it('DIGS: DexScreener 41.7 k$ alone → that value, no divergence (Jupiter is not a liquidity source)', () => {
    const r = effectiveLiquidity({ dex: 41_700, gecko: null });
    assert.equal(r.value, 41_700);
    assert.equal(r.divergence, null);
    assert.equal(r.sources, 1);
    // Same disagreement reported by GeckoTerminal: median (= mean of 2) and divergence as a fraction.
    const g = effectiveLiquidity({ dex: 41_700, gecko: 20_400 });
    assert.equal(g.value, (41_700 + 20_400) / 2);
    close(g.divergence, (41_700 - 20_400) / 20_400);
    assert.equal(g.sources, 2);
  });
  it('VI (v5): 15.6 k$ DexScreener vs 6.85 k$ GeckoTerminal → value 11 225 (mean), divergence ≈ 1.277', () => {
    const r = effectiveLiquidity({ dex: 15_600, gecko: 6_850 });
    assert.equal(r.value, 11_225);
    close(r.divergence, 8_750 / 6_850);
  });
  it('the value is the median of DexScreener and GeckoTerminal', () => {
    const r = effectiveLiquidity({ dex: 40_000, gecko: 30_000 });
    assert.equal(r.value, 35_000);
    close(r.divergence, 10_000 / 30_000);
    assert.equal(r.sources, 2);
  });
  it('single source → its value, divergence null', () => {
    assert.deepEqual(effectiveLiquidity({ dex: 39_000, gecko: null }), {
      value: 39_000, divergence: null, sources: 1,
    });
    assert.deepEqual(effectiveLiquidity({ dex: null, gecko: 12_000 }), {
      value: 12_000, divergence: null, sources: 1,
    });
    assert.deepEqual(effectiveLiquidity({ dex: null, gecko: 12_000 }), {
      value: 12_000, divergence: null, sources: 1,
    });
  });
  it('no valid source → value 0, divergence null, sources 0', () => {
    assert.deepEqual(effectiveLiquidity({ dex: null, gecko: null }), { value: 0, divergence: null, sources: 0 });
    assert.deepEqual(effectiveLiquidity({ dex: 0, gecko: Number.NaN }), { value: 0, divergence: null, sources: 0 });
  });
  it('ignores zero, negative and non-finite values (not indexed ≠ empty pool)', () => {
    const r = effectiveLiquidity({ dex: 15_600, gecko: Number.POSITIVE_INFINITY });
    assert.deepEqual(r, { value: 15_600, divergence: null, sources: 1 });
  });
  it('identical sources → divergence 0', () => {
    const r = effectiveLiquidity({ dex: 39_000, gecko: 39_000 });
    assert.equal(r.divergence, 0);
  });
  it('boundary: 30 000 vs 20 000 is exactly 0.5; 30 002 vs 20 000 is 0.5001 (DexScreener vs GeckoTerminal)', () => {
    assert.equal(effectiveLiquidity({ dex: 30_000, gecko: 20_000 }).divergence, 0.5);
    assert.equal(effectiveLiquidity({ dex: 30_000, gecko: null }).divergence, null);
    const d = effectiveLiquidity({ dex: 30_002, gecko: 20_000 }).divergence;
    assert.ok(d !== null && d > DIVERGENCE_MAX);
    close(d, 0.5001);
  });
});

describe('priceConsensus', () => {
  it('median of 3 is the middle value', () => {
    const r = priceConsensus({ dex: 1.0, jup: 1.02, gecko: 0.99 });
    assert.equal(r.median, 1.0);
    close(r.maxDeviation, 0.02);
    assert.equal(r.divergent, false);
  });
  it('median of 2 is the mean', () => {
    const r = priceConsensus({ dex: 1.0, jup: 1.2, gecko: null });
    close(r.median, 1.1);
    close(r.maxDeviation, 0.1 / 1.1);
    assert.equal(r.divergent, true);
  });
  it('boundary: exactly 5 % is not divergent, 5.01 % is', () => {
    const at = priceConsensus({ dex: 100, jup: 100, gecko: 105 });
    assert.equal(at.maxDeviation, 0.05);
    assert.equal(at.divergent, false);
    const over = priceConsensus({ dex: 100, jup: 100, gecko: 105.01 });
    assert.equal(over.divergent, true);
  });
  it('single price → deviation 0, not divergent', () => {
    assert.deepEqual(priceConsensus({ dex: 0.01, jup: null, gecko: null }), { median: 0.01, maxDeviation: 0, divergent: false });
  });
  it('no valid price → nulls, not divergent; invalid values ignored', () => {
    assert.deepEqual(priceConsensus({ dex: null, jup: 0, gecko: Number.NaN }), { median: null, maxDeviation: null, divergent: false });
    assert.equal(priceConsensus({ dex: 1, jup: -1, gecko: Number.POSITIVE_INFINITY }).median, 1);
  });
});

describe('dataConfidence', () => {
  const ok = { liquiditySources: 2, divergence: 0.1, priceDivergent: false, roundtripKnown: true };
  it("'high' with ≥ 2 agreeing sources, aligned prices and a known round trip", () => {
    assert.equal(dataConfidence(ok), 'high');
    assert.equal(dataConfidence({ ...ok, divergence: 0.2 }), 'high');
    assert.equal(dataConfidence({ ...ok, liquiditySources: 3, divergence: 0 }), 'high');
  });
  it("'medium' when the round trip is unknown, divergence is in (0.2, 0.5], or only prices diverge", () => {
    assert.equal(dataConfidence({ ...ok, roundtripKnown: false }), 'medium');
    assert.equal(dataConfidence({ ...ok, divergence: 0.2001 }), 'medium');
    assert.equal(dataConfidence({ ...ok, divergence: 0.5 }), 'medium');
    assert.equal(dataConfidence({ ...ok, priceDivergent: true }), 'medium');
  });
  it("'low' when divergence > 0.5", () => {
    assert.equal(dataConfidence({ ...ok, divergence: 0.5001 }), 'low');
  });
  it("'low' with a single source or none", () => {
    assert.equal(dataConfidence({ ...ok, liquiditySources: 1, divergence: null }), 'low');
    assert.equal(dataConfidence({ ...ok, liquiditySources: 0, divergence: null }), 'low');
  });
  it("'low' when prices diverge and liquidity divergence > 0.2", () => {
    assert.equal(dataConfidence({ ...ok, priceDivergent: true, divergence: 0.3 }), 'low');
    assert.equal(dataConfidence({ ...ok, priceDivergent: true, divergence: 0.2 }), 'medium');
  });
  it("defensive: ≥ 2 sources but null divergence → 'low'", () => {
    assert.equal(dataConfidence({ ...ok, divergence: null }), 'low');
  });
});

describe('roundtripFlag', () => {
  it('5 % → none, 5.01 % and 10 % → > 5 %, 10.01 % → > 10 %', () => {
    assert.equal(roundtripFlag(5), null);
    assert.equal(roundtripFlag(5.01), ROUNDTRIP_FLAGS.high.flag);
    assert.equal(roundtripFlag(10), ROUNDTRIP_FLAGS.high.flag);
    assert.equal(roundtripFlag(10.01), ROUNDTRIP_FLAGS.extreme.flag);
  });
  it('unknown or invalid → none', () => {
    assert.equal(roundtripFlag(null), null);
    assert.equal(roundtripFlag(undefined), null);
    assert.equal(roundtripFlag(Number.NaN), null);
  });
  it("the flags start with « Coût d'aller-retour élevé » and no longer mention a score", () => {
    for (const f of [ROUNDTRIP_FLAGS.high.flag, ROUNDTRIP_FLAGS.extreme.flag]) {
      assert.ok(f.startsWith("Coût d'aller-retour élevé"));
      assert.ok(!f.includes('score'));
    }
  });
});
