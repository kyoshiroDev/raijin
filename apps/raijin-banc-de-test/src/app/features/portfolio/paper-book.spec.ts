import { describe, expect, it } from 'vitest';
import type { PaperWallet } from '../../shared/models/paper';
import { availableBooks, buildBookView, legViews, livePnl } from './paper-book';
import { TEST_MINT, testClosed, testLeg, testPosition } from './paper-test-data';

const FEE = 0.0002;

const half = (aStatus: 'open' | 'tp_hit', bOver: Partial<ReturnType<typeof testLeg>> = {}) =>
  testPosition({
    strategy: 'half_x2_rest_x3',
    fill_price: 1,
    legs: [
      testLeg({ size_pct: 50, tp_price: 2, stop_price: 0.7, status: aStatus, exit_price: aStatus === 'tp_hit' ? 1.96 : null }),
      testLeg({ size_pct: 50, tp_price: 3, stop_price: 0.7, status: 'open', ...bOver }),
    ],
  });

describe('paper book view', () => {
  it('live P&L: open legs at the live price (sell slippage), closed legs at their exit, buy fee + one fee per leg', () => {
    const p = half('tp_hit', { stop_price: 1 });
    const pnl = livePnl(p, 1.5);
    const expected = 0.05 * (1.96 - 1) + 0.05 * (1.5 * 0.98 - 1) - 3 * FEE;
    expect(pnl?.pnlSol).toBeCloseTo(expected, 9);
    expect(pnl?.pnlPct).toBeCloseTo((expected / 0.1) * 100, 6);
    expect(pnl?.openValueSol).toBeCloseTo(0.05 * 1.5 * 0.98, 9);
    expect(livePnl(p, null)).toBeNull();
    expect(livePnl(testPosition({ status: 'pending' }), 1)).toBeNull();
  });

  it('labels the legs (Moitié A ×2 / Moitié B ×3 / Position ×2) with their state badge', () => {
    expect(legViews(half('open')).map((l) => [l.label, l.state])).toEqual([
      ['Moitié A · ×2', 'open'],
      ['Moitié B · ×3', 'open'],
    ]);
    expect(legViews(testPosition()).map((l) => l.label)).toEqual(['Position · ×2']);
    expect(legViews(testPosition({ strategy: 'custom' })).map((l) => l.label)).toEqual(['Position']);
  });

  it('shows the breakeven move on B once A hit its target (current stop = fill price)', () => {
    const before = legViews(half('open'));
    expect(before[1]).toMatchObject({ breakevenMoved: false, currentStop: 0.7 });
    const after = legViews(half('tp_hit', { stop_price: 1 }));
    expect(after[0].state).toBe('tp_hit');
    expect(after[1]).toMatchObject({ state: 'open', breakevenMoved: true, currentStop: 1 });
    const closed = legViews(half('tp_hit', { status: 'breakeven_hit', exit_price: 0.98, stop_price: 1 }));
    expect(closed[1]).toMatchObject({ state: 'breakeven_hit', breakevenMoved: false });
  });

  it('thirds: labels « Tiers A/B/C », breakeven on B and C after A, stop at ×2 on C after B', () => {
    const thirds = (a: 'open' | 'tp_hit', b: 'open' | 'tp_hit', stops: [number, number]) =>
      testPosition({
        strategy: 'thirds_x2_x3_x4',
        fill_price: 1,
        sl_price: 0.7,
        legs: [
          testLeg({ size_pct: 33, tp_price: 2, stop_price: 0.7, status: a, exit_price: a === 'tp_hit' ? 1.96 : null }),
          testLeg({ size_pct: 33, tp_price: 3, stop_price: stops[0], status: b, exit_price: b === 'tp_hit' ? 2.94 : null }),
          testLeg({ size_pct: 34, tp_price: 4, stop_price: stops[1], status: 'open' }),
        ],
      });
    expect(legViews(thirds('open', 'open', [0.7, 0.7])).map((l) => [l.label, l.raisedTo])).toEqual([
      ['Tiers A · ×2', null],
      ['Tiers B · ×3', null],
      ['Tiers C · ×4', null],
    ]);
    const afterA = legViews(thirds('tp_hit', 'open', [1, 1]));
    expect(afterA.slice(1).map((l) => [l.breakevenMoved, l.raisedTo, l.currentStop])).toEqual([
      [true, 'breakeven', 1],
      [true, 'breakeven', 1],
    ]);
    const afterB = legViews(thirds('tp_hit', 'tp_hit', [1, 2]));
    expect(afterB[2]).toMatchObject({ breakevenMoved: true, raisedTo: 'x2', currentStop: 2 });
    const pnl = livePnl(thirds('tp_hit', 'tp_hit', [1, 2]), 2.5);
    expect(pnl?.pnlSol).toBeCloseTo(0.033 * 0.96 + 0.033 * 1.94 + 0.034 * (2.5 * 0.98 - 1) - 4 * FEE, 9);
  });

  it('builds the book: balance, open value, realized + unrealized P&L in SOL and % of initial_sol, history', () => {
    const wallets: PaperWallet[] = [{ book: 'main', balance_sol: 0.85, initial_sol: 1, created_at: '2026-11-01T00:00:00Z', reset_at: null }];
    const open = testPosition({ id: 'o1', fill_price: 1 });
    const v = buildBookView(
      'main',
      wallets,
      [open, testClosed(1, 0.05, 'tp_hit', { id: 'c1' }), testPosition({ id: 'x1', status: 'expired' }), testPosition({ id: 'other', book: 'calm_sl30' })],
      new Map([[TEST_MINT, 1.2]]),
    );
    expect(v.wallet.balance_sol).toBe(0.85);
    expect(v.active.map((a) => a.position.id)).toEqual(['o1']);
    expect(v.history.map((h) => h.id)).toEqual(['c1', 'x1']);
    const unrealized = 0.1 * (1.2 * 0.98 - 1) - 2 * FEE;
    expect(v.unrealizedSol).toBeCloseTo(unrealized, 9);
    expect(v.realizedSol).toBeCloseTo(0.05, 9);
    expect(v.totalPnlSol).toBeCloseTo(0.05 + unrealized, 9);
    expect(v.totalPnlPct).toBeCloseTo((0.05 + unrealized) * 100, 6);
    expect(v.openValueSol).toBeCloseTo(0.1 * 1.2 * 0.98, 9);
    expect(v.trades).toBe(1);
    expect(v.curve.map((p) => p.balanceSol)).toEqual([1, 1.05]);
  });

  it('ignores positions created before the last reset and defaults a missing wallet to 1 SOL', () => {
    const wallets: PaperWallet[] = [{ book: 'calm_sl40', balance_sol: 1, initial_sol: 1, created_at: null, reset_at: '2026-11-12T00:00:00Z' }];
    const v = buildBookView('calm_sl40', wallets, [testClosed(1, -0.05, 'sl_hit', { book: 'calm_sl40' })], new Map());
    expect(v.history).toEqual([]);
    expect(v.totalPnlSol).toBe(0);
    expect(buildBookView('frenzy_sl30', [], [], new Map()).wallet).toMatchObject({ balance_sol: 1, initial_sol: 1 });
  });

  it('offers the test books only when they have a wallet or a position, in a fixed order', () => {
    expect(availableBooks([], [])).toEqual(['main']);
    const w = (book: PaperWallet['book']): PaperWallet => ({ book, balance_sol: 1, initial_sol: 1, created_at: null, reset_at: null });
    expect(availableBooks([w('main'), w('frenzy_sl30')], [testPosition({ book: 'calm_sl30' })])).toEqual(['main', 'calm_sl30', 'frenzy_sl30']);
    expect(availableBooks([w('calm_sl40'), w('calm_sl30'), w('frenzy_sl30')], [])).toEqual(['main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30']);
  });

  it('offers an archived book only while it still has positions (an empty archived wallet is hidden)', () => {
    const w = (book: PaperWallet['book']): PaperWallet => ({ book, balance_sol: 1, initial_sol: 1, created_at: null, reset_at: null });
    expect(availableBooks([w('calm_all_x2'), w('frenzy_all_x2')], [])).toEqual(['main']);
    expect(availableBooks([w('calm_sl30')], [testPosition({ book: 'frenzy_all_x2' })])).toEqual(['main', 'calm_sl30', 'frenzy_all_x2']);
  });

});
