import { describe, expect, it } from 'vitest';
import { legStopSlippagePct, stopSlippageByBook, summarizeSlippage } from './stop-slippage';
import { testLeg, testPosition } from '../../testing';

describe('stop slippage', () => {
  it('measures exit / stop − 1 in percent on stopped legs only', () => {
    expect(legStopSlippagePct(testLeg({ status: 'sl_hit', stop_price: 0.7, exit_price: 0.63 }))).toBeCloseTo(-10, 10);
    expect(legStopSlippagePct(testLeg({ status: 'sl_hit', stop_price: 0.5, exit_price: 0.51 }))).toBeCloseTo(2, 10);
    for (const status of ['open', 'tp_hit', 'breakeven_hit'] as const) {
      expect(legStopSlippagePct(testLeg({ status, stop_price: 0.7, exit_price: 0.6 }))).toBeNull();
    }
  });

  it('ignores missing, zero, negative or non-finite prices', () => {
    for (const [stop, exit] of [[null, 0.6], [0.7, null], [0, 0.6], [0.7, 0], [-1, 0.6], [Number.NaN, 0.6], [0.7, Infinity]] as const) {
      expect(legStopSlippagePct(testLeg({ status: 'sl_hit', stop_price: stop, exit_price: exit }))).toBeNull();
    }
  });

  it('summarizes n, mean and worst (lowest) value', () => {
    expect(summarizeSlippage('main', [])).toEqual({ book: 'main', n: 0, avgPct: null, worstPct: null });
    const s = summarizeSlippage('main', [-2, -10, 3]);
    expect(s.n).toBe(3);
    expect(s.avgPct).toBeCloseTo(-3, 10);
    expect(s.worstPct).toBe(-10);
  });

  it('groups by book in the requested order, books without a stop included', () => {
    const positions = [
      testPosition({ book: 'main', legs: [testLeg({ status: 'sl_hit', stop_price: 1, exit_price: 0.95 }), testLeg({ status: 'tp_hit', exit_price: 2 })] }),
      testPosition({ book: 'main', legs: [testLeg({ status: 'sl_hit', stop_price: 1, exit_price: 0.85 })] }),
      testPosition({ book: 'frenzy_sl30', legs: [testLeg({ status: 'sl_hit', stop_price: 2, exit_price: 1.9 })] }),
      testPosition({ book: 'calm_sl30', legs: [testLeg({ status: 'sl_hit', stop_price: 2, exit_price: 1 })] }),
    ];
    const out = stopSlippageByBook(positions, ['main', 'frenzy_sl30']);
    expect(out.map((s) => s.book)).toEqual(['main', 'frenzy_sl30']);
    expect(out[0]!.n).toBe(2);
    expect(out[0]!.avgPct).toBeCloseTo(-10, 10);
    expect(out[0]!.worstPct).toBeCloseTo(-15, 10);
    expect(out[1]).toMatchObject({ n: 1 });
    expect(stopSlippageByBook([], ['main'])).toEqual([{ book: 'main', n: 0, avgPct: null, worstPct: null }]);
  });
});
