// Runs with `deno test supabase/functions` (node:test is supported by Deno)
// and with `node --experimental-strip-types --test` for quick local checks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixedExitPlan, PLAN_PRICE_MAX, STOP_MULTIPLE, TARGET_MULTIPLE } from './exit-plan';
import { approxSwing, BROKEN_RETRACEMENT, MIN_IMPULSE, structureBroken } from './structure';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

describe('fixedExitPlan (×2 / ×0.7)', () => {
  it('target = entry × 2, stop = entry × 0.7, rr 3.333, +100 % / −30 %', () => {
    const p = fixedExitPlan(0.001);
    assert.ok(p);
    close(p.target, 0.002);
    close(p.stop, 0.0007);
    assert.equal(p.rr, 3.333);
    close(p.targetPct, 100);
    close(p.stopPct, -30);
    assert.equal(TARGET_MULTIPLE, 2);
    assert.equal(STOP_MULTIPLE, 0.7);
  });
  it('unusable entry → null (≤ 0, NaN, ∞, null, target at the alert_log bound)', () => {
    for (const e of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, PLAN_PRICE_MAX / 2]) {
      assert.equal(fixedExitPlan(e), null, String(e));
    }
    assert.ok(fixedExitPlan(PLAN_PRICE_MAX / 2 - 1));
  });
});

const metrics = (price: number, c5m: number, c1h: number, c6h: number, c24h: number) => ({
  priceUsd: price,
  change5m: c5m,
  change1h: c1h,
  change6h: c6h,
  change24h: c24h,
});

describe('approxSwing', () => {
  it('rebuilds the past prices from the % changes', () => {
    const s = approxSwing(metrics(1, 0, 100, 0, -50));
    assert.ok(s);
    close(s.low, 0.5);
    close(s.high, 2);
  });
  it('ignores non-finite changes and ≤ −99.9 %; unusable price → null', () => {
    const s = approxSwing(metrics(1, Number.NaN, -99.9, 0, 0));
    assert.deepEqual(s, { low: 1, high: 1 });
    assert.equal(approxSwing(metrics(0, 1, 1, 1, 1)), null);
  });
});

describe('structureBroken (« Structure cassée » without candles)', () => {
  it('price under the 0.786 retracement of the approximate swing → broken', () => {
    // Swing 1 → 2 (+100 % then back): the price came from 2 (change1h −50 %) and from 1 (change24h 0 %)... price 1.1
    // gives points {1.1, 2.2 (−50 % 1 h), 1.1}: low 1.1, high 2.2, deep = 2.2 − 1.1 × 0.786 = 1.3354 > 1.1 → broken.
    assert.equal(structureBroken(metrics(1.1, 0, -50, 0, 0)), true);
  });
  it('a pullback above the 0.786 level is not broken (former « deep » / « in » / « wait » zones)', () => {
    // Points {1, 0.5 (+100 % 24 h)}: low 0.5, high 1 = price → price at the top: not broken.
    assert.equal(structureBroken(metrics(1, 0, 0, 0, 100)), false);
    // Price 1.6 after a 1 → 2 swing: points {1.6, 2 (−20 % 1 h), 1 (+60 % 24 h)}: deep = 2 − 0.786 = 1.214 → not broken.
    assert.equal(structureBroken(metrics(1.6, 0, -20, 0, 60)), false);
  });
  it('around the 0.786 level: just above → not broken, just under → broken', () => {
    // Swing low 1, high 2: deep = 2 − 0.786 = 1.214 (change1h brings the high 2, change24h the low 1).
    const at = (p: number) => metrics(p, 0, (p / 2 - 1) * 100, 0, (p / 1 - 1) * 100);
    const level = 2 - BROKEN_RETRACEMENT;
    assert.equal(structureBroken(at(level * 1.001)), false);
    assert.equal(structureBroken(at(level * 0.999)), true);
  });
  it('an impulse under 15 % is never broken; unknown price → false', () => {
    assert.equal(MIN_IMPULSE, 0.15);
    // Swing 1 → 1.1 (+10 %): price at the low → no flag.
    assert.equal(structureBroken(metrics(1, 0, -9.0909, 0, 0)), false);
    assert.equal(structureBroken(metrics(0, 0, -50, 0, 0)), false);
    assert.equal(structureBroken(metrics(Number.NaN, 0, -50, 0, 0)), false);
  });
});
