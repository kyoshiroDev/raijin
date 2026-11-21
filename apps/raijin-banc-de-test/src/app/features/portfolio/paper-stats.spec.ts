import { describe, expect, it } from 'vitest';
import { closedTrades, legCounts, maxDrawdown, statsFor, strategyStats, worstLosingStreak } from './paper-stats';
import { testClosed, testLeg, testPosition } from './paper-test-data';

const win = (m: number, pnl = 0.08) => testClosed(m, pnl, 'tp_hit');
const loss = (m: number, pnl = -0.03) => testClosed(m, pnl, 'sl_hit');

describe('paper stats per strategy', () => {
  it('counts closed legs by exit (TP / SL / breakeven); open legs are ignored', () => {
    const half = testPosition({
      status: 'closed',
      pnl_sol: 0.02,
      strategy: 'half_x2_rest_x3',
      legs: [testLeg({ size_pct: 50, status: 'tp_hit' }), testLeg({ size_pct: 50, tp_price: 3, status: 'breakeven_hit' })],
    });
    expect(legCounts([half, loss(1), testPosition({ legs: [testLeg()] })])).toEqual({ tp: 1, sl: 1, breakeven: 1, closed: 3 });
  });

  it('counts only filled-and-closed trades with a P&L (cancelled / expired / open excluded); leg-level TP/SL rates', () => {
    const halfBreakeven = testPosition({
      status: 'closed',
      pnl_sol: 0.03,
      closed_at: '2026-11-10T00:10:00Z',
      strategy: 'half_x2_rest_x3',
      legs: [testLeg({ size_pct: 50, status: 'tp_hit' }), testLeg({ size_pct: 50, tp_price: 3, status: 'breakeven_hit' })],
    });
    const positions = [win(1), loss(2), loss(3), testPosition({ status: 'expired' }), testPosition({ status: 'cancelled' }), testPosition()];
    const s = statsFor('all_x2', positions, 1);
    expect(s).toMatchObject({ strategy: 'all_x2', trades: 3, legs: { tp: 1, sl: 2, breakeven: 0, closed: 3 }, enough: false });
    expect(s.tpRate).toBeCloseTo(1 / 3, 9);
    expect(s.slRate).toBeCloseTo(2 / 3, 9);
    expect(s.avgWinSol).toBeCloseTo(0.08, 9);
    expect(s.avgLossSol).toBeCloseTo(-0.03, 9);
    expect(s.totalPnlSol).toBeCloseTo(0.02, 9);
    const h = statsFor('half_x2_rest_x3', [halfBreakeven], 1);
    expect(h.tpRate).toBe(0.5);
    expect(h.slRate).toBe(0);
    expect(statsFor('all_x2', [testPosition({ status: 'closed', pnl_sol: null })], 1).trades).toBe(0);
  });

  it('applies the < 30 samples rule on the closed legs (the rate denominator)', () => {
    const under = Array.from({ length: 29 }, (_, i) => (i % 2 ? win(i) : loss(i)));
    expect(statsFor('all_x2', under, 1).enough).toBe(false);
    expect(statsFor('all_x2', [...under, win(99)], 1).enough).toBe(true);
    const empty = statsFor('custom', [], 1);
    expect(empty.tpRate).toBeNull();
    expect(empty.avgWinSol).toBeNull();
  });

  it('finds the worst losing streak in closing order, whatever the input order; a flat trade resets it', () => {
    const trades = [loss(9), win(1), loss(2), loss(3), win(4), loss(5), loss(6), loss(7), win(8)];
    expect(worstLosingStreak(trades)).toEqual({ count: 3, sum: -0.09 });
    expect(statsFor('all_x2', trades, 1)).toMatchObject({ worstStreak: 3, worstStreakSol: -0.09 });
    expect(worstLosingStreak([win(1), win(2)])).toEqual({ count: 0, sum: 0 });
    expect(worstLosingStreak([loss(1), win(2, 0), loss(3)]).count).toBe(1);
  });

  it('computes the max drawdown from the running peak (SOL and % of the peak)', () => {
    // 1 → 1.2 (peak) → 1.1 → 0.9 → 1.3 → 1.25
    const dd = maxDrawdown([0.2, -0.1, -0.2, 0.4, -0.05], 1);
    expect(dd.sol).toBeCloseTo(0.3, 9);
    expect(dd.pct).toBeCloseTo(25, 6);
    expect(maxDrawdown([0.1, 0.2], 1)).toEqual({ sol: 0, pct: 0 });
    expect(maxDrawdown([-0.5], 1).pct).toBeCloseTo(50, 6);
    const s = statsFor('all_x2', [win(1, 0.2), loss(2, -0.1), loss(3, -0.2), win(4, 0.4)], 1);
    expect(s.drawdown.sol).toBeCloseTo(0.3, 9);
  });

  it('groups by strategy (fixed order), only strategies with closed trades', () => {
    const trades = [win(1), testClosed(2, 0.1, 'tp_hit', { strategy: 'half_x2_rest_x3' }), testPosition({ strategy: 'custom', status: 'expired' })];
    expect(strategyStats(trades, 1).map((s) => [s.strategy, s.trades])).toEqual([
      ['half_x2_rest_x3', 1],
      ['all_x2', 1],
    ]);
  });

  it('lists closed trades oldest first', () => {
    expect(closedTrades([win(5), loss(1), testPosition()]).map((p) => p.closed_at?.slice(14, 16))).toEqual(['01', '05']);
  });
});
