// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { labelOutcome, OUTCOME_HORIZON_H } from './outcomes.ts';
import type { Candle } from './types.ts';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 10, 0, 0, 0);
const sec = (ms: number) => ms / 1000;
/** Candle opened `h` hours after detection. */
const c = (h: number, high: number, low: number, close = (high + low) / 2): Candle => [sec(T0 + h * H), close, high, low, close, 1];

describe('labelOutcome', () => {
  it('×3 reached: final, hours_to_x3, dd50_first false', () => {
    const l = labelOutcome(1, T0, [c(0, 1.2, 0.9), c(1, 2.1, 1.1), c(5, 3.0, 2.0)], T0 + 10 * H);
    assert.equal(l.status, 'final');
    assert.equal(l.hit_x2, true);
    assert.equal(l.hit_x3, true);
    assert.equal(l.hit_x5, false);
    assert.equal(l.dd50_first, false);
    assert.equal(l.hours_to_x3, 5);
    assert.equal(l.max_multiple_7d, 3);
    assert.equal(l.observed_hours, 10);
  });

  it('counts ×3 despite floating point (0.1 → 0.3)', () => {
    const l = labelOutcome(0.1, T0, [c(1, 0.3, 0.1)], T0 + 2 * H);
    assert.equal(l.hit_x3, true);
  });

  it('−50 % before ×3: dd50_first settled true, still pending until 7 days, hit_x3 may flip later', () => {
    const early = labelOutcome(1, T0, [c(1, 1.1, 0.45)], T0 + 2 * H);
    assert.equal(early.dd50_first, true);
    assert.equal(early.hit_x3, false);
    assert.equal(early.status, 'pending');
    const later = labelOutcome(1, T0, [c(1, 1.1, 0.45), c(30, 3.5, 0.6)], T0 + 40 * H);
    assert.equal(later.dd50_first, true);
    assert.equal(later.hit_x3, true);
    assert.equal(later.status, 'final');
  });

  it('−50 % after ×3 does not count', () => {
    const l = labelOutcome(1, T0, [c(1, 3.2, 1.0), c(2, 1.0, 0.2)], T0 + 3 * H);
    assert.equal(l.hit_x3, true);
    assert.equal(l.dd50_first, false);
  });

  it('same candle touching ×3 and −50 %: order unknown → conservative dd50_first true', () => {
    const l = labelOutcome(1, T0, [c(2, 3.5, 0.4)], T0 + 3 * H);
    assert.equal(l.hit_x3, true);
    assert.equal(l.dd50_first, true);
    assert.equal(l.hours_to_x3, 2);
    assert.equal(l.status, 'final');
  });

  it('no ×3 after 7 days: final, dd50_first when −50 % happened at any time', () => {
    const l = labelOutcome(1, T0, [c(1, 1.5, 0.9), c(100, 2.4, 0.3)], T0 + 200 * H);
    assert.equal(l.status, 'final');
    assert.equal(l.hit_x2, true);
    assert.equal(l.hit_x3, false);
    assert.equal(l.dd50_first, true);
    assert.equal(l.observed_hours, OUTCOME_HORIZON_H);
    assert.equal(l.hours_to_x3, null);
  });

  it('ignores candles before detection, after 7 days and in the future, regardless of input order', () => {
    const candles = [c(170, 10, 5), c(-1, 9, 0.1), c(3, 2.5, 0.8), c(1, 1.2, 0.9)];
    const l = labelOutcome(1, T0, candles, T0 + 400 * H);
    assert.equal(l.max_multiple_7d, 2.5);
    assert.equal(l.hit_x3, false);
    assert.equal(l.dd50_first, false);
    const future = labelOutcome(1, T0, [c(1, 1.1, 1), c(5, 4, 1)], T0 + 2 * H);
    assert.equal(future.hit_x3, false);
  });

  it('gaps between candles are fine (no trades = no move)', () => {
    const l = labelOutcome(1, T0, [c(0, 1.1, 0.95), c(150, 1.3, 1.0)], T0 + 170 * H);
    assert.equal(l.status, 'final');
    assert.equal(l.max_multiple_7d, 1.3);
    assert.equal(l.dd50_first, false);
  });

  it('skips invalid candles', () => {
    const bad: Candle[] = [[sec(T0 + H), 1, Number.NaN, 0.5, 1, 1], [sec(T0 + H), 1, 0.5, 2, 1, 1], [sec(T0 + H), 1, 4, 0, 1, 1]];
    const l = labelOutcome(1, T0, [...bad, c(2, 1.4, 0.9)], T0 + 3 * H);
    assert.equal(l.max_multiple_7d, 1.4);
    assert.equal(l.hit_x3, false);
    assert.equal(l.dd50_first, false);
  });

  it('no candles: pending even after 7 days (no data ≠ no move)', () => {
    const l = labelOutcome(1, T0, [], T0 + 300 * H);
    assert.equal(l.status, 'pending');
    assert.equal(l.max_multiple_7d, 0);
    assert.equal(l.observed_hours, OUTCOME_HORIZON_H);
  });

  it('entry ≤ 0 or not finite: never final', () => {
    for (const entry of [0, -1, Number.NaN]) {
      const l = labelOutcome(entry, T0, [c(1, 5, 1)], T0 + 300 * H);
      assert.equal(l.status, 'pending');
      assert.equal(l.hit_x3, false);
      assert.equal(l.max_multiple_7d, 0);
    }
  });

  it('now before detection: observed_hours 0, pending', () => {
    const l = labelOutcome(1, T0, [c(1, 5, 1)], T0 - H);
    assert.equal(l.observed_hours, 0);
    assert.equal(l.status, 'pending');
  });

  describe('×2 vs −30 % (fix/measurement-and-criteria)', () => {
    it('×2 strictly before −30 %: x2_before_sl30, hit_sl30 still recorded later', () => {
      const l = labelOutcome(1, T0, [c(0, 1.1, 0.95), c(2, 2.05, 1.5), c(6, 1.2, 0.6)], T0 + 10 * H);
      assert.equal(l.x2_before_sl30, true);
      assert.equal(l.sl30_before_x2, false);
      assert.equal(l.hit_sl30, true);
      assert.equal(l.hours_to_x2, 2);
      assert.equal(l.min_multiple_7d, 0.6);
    });
    it('−30 % before ×2: sl30_before_x2 even if ×2 comes later', () => {
      const l = labelOutcome(1, T0, [c(0, 1.05, 0.69), c(3, 2.5, 1.2)], T0 + 10 * H);
      assert.equal(l.sl30_before_x2, true);
      assert.equal(l.x2_before_sl30, false);
      assert.equal(l.hit_x2, true);
      assert.equal(l.hours_to_x2, 3);
    });
    it('same candle touching ×2 and −30 %: conservative, stop first', () => {
      const l = labelOutcome(1, T0, [c(1, 2.2, 0.65)], T0 + 5 * H);
      assert.equal(l.sl30_before_x2, true);
      assert.equal(l.x2_before_sl30, false);
    });
    it('neither yet: both false, min_multiple_7d tracks the lowest low', () => {
      const l = labelOutcome(1, T0, [c(0, 1.3, 0.8), c(1, 1.5, 0.75)], T0 + 5 * H);
      assert.equal(l.x2_before_sl30, false);
      assert.equal(l.sl30_before_x2, false);
      assert.equal(l.hit_sl30, false);
      assert.equal(l.hours_to_x2, null);
      assert.equal(l.min_multiple_7d, 0.75);
    });
    it('exactly −30 % counts as the stop (float tolerance)', () => {
      const l = labelOutcome(0.1, T0, [c(1, 0.1, 0.07)], T0 + 2 * H);
      assert.equal(l.hit_sl30, true);
      assert.equal(l.sl30_before_x2, true);
    });
  });
});
