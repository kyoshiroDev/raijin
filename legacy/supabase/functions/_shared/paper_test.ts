// Runs with `deno test supabase/functions` (node:test is supported by Deno)
// and with `node --experimental-strip-types --no-warnings --test` for quick local checks.
// chore/slim-down: all_x2 is the only strategy left (half_x2_rest_x3, thirds_x2_x3_x4, custom and the stop ladders were
// removed; their positions are archived history).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_X2_TP_MULTIPLIER,
  committedSol,
  DEFAULT_SL_PCT,
  DEFAULT_SLIPPAGE_PCT,
  ENTRY_EXPIRY_MS,
  equityCurve,
  hasSufficientBalance,
  maxDrawdown,
  NETWORK_FEE_PER_TX_SOL,
  parseEntryMode,
  parseStrategy,
  planLegs,
  reservedSol,
  step,
  STRATEGIES,
  strategyStats,
  TICK_MAX_AGE_MS,
  TOKEN_ACCOUNT_RENT_SOL,
  walletDelta,
  type EngineStep,
  type PaperLeg,
  type PaperPosition,
  type PriceTick,
  type Strategy,
} from './paper.ts';

const close = (a: number, b: number, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const FEE = NETWORK_FEE_PER_TX_SOL;
const RENT = TOKEN_ACCOUNT_RENT_SOL;

const T0 = Date.parse('2026-11-17T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = T0 + 60_000;

const leg = (id: string, over: Partial<PaperLeg> = {}): PaperLeg => ({
  id,
  size_pct: 100,
  tp_price: 2,
  status: 'open',
  stop_price: 0.7,
  exit_price: null,
  closed_at: null,
  ...over,
});

/** Pending all_x2 at target 1, SL 0.7 (30 %), levels planned from the target. */
const pending = (over: Partial<PaperPosition> = {}): PaperPosition => ({
  id: 'p1',
  strategy: 'all_x2',
  status: 'pending',
  stake_sol: 1,
  entry_target_price: 1,
  fill_price: null,
  sl_price: 0.7,
  created_at: iso(T0),
  filled_at: null,
  expires_at: iso(T0 + ENTRY_EXPIRY_MS),
  legs: [leg('L')],
  ...over,
});

/** Open all_x2 filled at 1: TP 2, stop 0.7. */
const open = (over: Partial<PaperPosition> = {}): PaperPosition =>
  pending({ status: 'open', fill_price: 1, filled_at: iso(T0), ...over });

const tick = (price: number, over: Partial<PriceTick> = {}): PriceTick => ({
  price,
  at: NOW,
  buyImpactPct: null,
  sellImpactPct: null,
  ...over,
});

/** Applies an engine step to a position (what the engine/DB does), for lifecycle tests. */
function apply(p: PaperPosition, s: EngineStep, at: number): PaperPosition {
  if (s.kind === 'fill') {
    return {
      ...p,
      status: 'open',
      fill_price: s.fill_price,
      filled_at: iso(at),
      legs: p.legs.map((l) => {
        const u = s.legs.find((x) => x.id === l.id);
        return u ? { ...l, tp_price: u.tp_price, stop_price: u.stop_price } : l;
      }),
    };
  }
  if (s.kind === 'legs') {
    return {
      ...p,
      status: s.position_closed ? 'closed' : p.status,
      legs: p.legs.map((l) => {
        const c = s.closes.find((x) => x.id === l.id);
        return c ? { ...l, status: c.status, exit_price: c.exit_price, closed_at: iso(at) } : l;
      }),
    };
  }
  if (s.kind === 'expire') return { ...p, status: 'expired' };
  return p;
}

const asLegs = (s: EngineStep) => {
  assert.equal(s.kind, 'legs');
  if (s.kind !== 'legs') throw new Error('not legs');
  return s;
};

describe('strategies', () => {
  it('all_x2 only; archived strategies are not parsed', () => {
    assert.deepEqual(STRATEGIES, ['all_x2']);
    assert.equal(parseStrategy('all_x2'), 'all_x2');
    for (const v of ['half_x2_rest_x3', 'thirds_x2_x3_x4', 'custom', null]) assert.equal(parseStrategy(v), null);
    assert.equal(ALL_X2_TP_MULTIPLIER, 2);
    assert.equal(DEFAULT_SL_PCT, 30);
  });
});

describe('planLegs', () => {
  it('all_x2: one 100 % leg, TP x2, SL -slPct', () => {
    assert.deepEqual(planLegs('all_x2', 1, 30), [{ size_pct: 100, tp_price: 2, stop_price: 0.7 }]);
    const l = planLegs('all_x2', 0.5, 20);
    close(l[0].tp_price, 1);
    close(l[0].stop_price, 0.4);
  });
  it('invalid input or an archived strategy returns []', () => {
    assert.deepEqual(planLegs('all_x2', 0, 30), []);
    assert.deepEqual(planLegs('all_x2', 1, 0), []);
    assert.deepEqual(planLegs('all_x2', 1, 100), []);
    assert.deepEqual(planLegs('all_x2', Number.NaN, 30), []);
    assert.deepEqual(planLegs('half_x2_rest_x3' as Strategy, 1, 30), []);
  });
});

describe('step: entry', () => {
  it('does not fill while the price is above the target', () => {
    assert.deepEqual(step(pending(), tick(1.01), NOW), { kind: 'none' });
  });
  it('fills at the observed price + default 2 % impact and recomputes the leg from the FILL price', () => {
    const s = step(pending(), tick(0.9), NOW);
    assert.equal(s.kind, 'fill');
    if (s.kind !== 'fill') return;
    const fill = 0.9 * (1 + DEFAULT_SLIPPAGE_PCT / 100);
    close(s.fill_price, fill);
    assert.equal(s.fees_sol, FEE);
    close(s.legs[0].tp_price, fill * 2);
    close(s.legs[0].stop_price, fill * 0.7);
  });
  it('uses the known buy impact', () => {
    const s = step(pending(), tick(0.9, { buyImpactPct: 5 }), NOW);
    assert.equal(s.kind, 'fill');
    if (s.kind === 'fill') close(s.fill_price, 0.9 * 1.05);
  });
  it('ignores stale, future and pre-creation ticks', () => {
    assert.deepEqual(step(pending(), tick(0.9, { at: NOW - TICK_MAX_AGE_MS - 1 }), NOW), { kind: 'none' });
    assert.deepEqual(step(pending(), tick(0.9, { at: NOW + 61_000 }), NOW), { kind: 'none' });
    assert.deepEqual(step(pending(), tick(0.9, { at: T0 - 1 }), NOW), { kind: 'none' });
  });
});

describe('step: expiry', () => {
  const end = T0 + ENTRY_EXPIRY_MS;
  it('does not expire 1 ms before expires_at; expires exactly at it; wins over a fill', () => {
    assert.deepEqual(step(pending(), null, end - 1), { kind: 'none' });
    assert.deepEqual(step(pending(), null, end), { kind: 'expire' });
    assert.deepEqual(step(pending(), tick(0.5, { at: end }), end), { kind: 'expire' });
  });
  it('expire moves no SOL (stake was only reserved)', () => {
    assert.equal(walletDelta({ kind: 'expire' }, pending()), 0);
  });
});

describe('step: all_x2 exits', () => {
  it('TP: exit at the observed price − impact, position closed with its pnl', () => {
    const s = asLegs(step(open(), tick(2.1), NOW));
    assert.deepEqual(s.closes.map((c) => [c.id, c.status]), [['L', 'tp_hit']]);
    close(s.closes[0].exit_price, 2.1 * 0.98);
    assert.equal(s.position_closed, true);
    assert.deepEqual(s.moves, []);
    close(s.pnl_sol ?? NaN, 1 * (2.1 * 0.98 - 1) - 2 * FEE);
  });
  it('SL gap far below the stop: exit at the OBSERVED price − impact, not at the stop', () => {
    const s = asLegs(step(open(), tick(0.3, { sellImpactPct: 1 }), NOW));
    assert.equal(s.closes[0].status, 'sl_hit');
    close(s.closes[0].exit_price, 0.3 * 0.99);
  });
  it('stop wins when a tick is both at/below the stop and at/above the TP (inconsistent levels)', () => {
    const p = open({ legs: [leg('L', { tp_price: 0.5, stop_price: 0.7 })] });
    assert.equal(asLegs(step(p, tick(0.6), NOW)).closes[0].status, 'sl_hit');
  });
  it('no level touched → none; ticks before filled_at ignored', () => {
    assert.deepEqual(step(open(), tick(1.5), NOW), { kind: 'none' });
    assert.deepEqual(step(open({ filled_at: iso(NOW) }), tick(2.5, { at: NOW - 1 }), NOW), { kind: 'none' });
  });
});

describe('fees, rent and walletDelta', () => {
  it('fill debits stake + one network fee + rent', () => {
    const s = step(pending(), tick(1), NOW);
    close(walletDelta(s, pending()), -(1 + FEE + RENT));
  });
  it('the close credits proceeds − one fee and returns the rent', () => {
    const s = asLegs(step(open(), tick(2), NOW));
    close(walletDelta(s, open()), 2 * 0.98 - FEE + RENT);
  });
  it('none moves no SOL', () => {
    assert.equal(walletDelta({ kind: 'none' }, open()), 0);
  });
  it('walletDelta sums exactly to pnl_sol over a TP lifecycle and an SL lifecycle', () => {
    for (const exit of [2.5, 0.4]) {
      let p = pending();
      const fill = step(p, tick(1, { at: NOW }), NOW);
      let total = walletDelta(fill, p);
      p = apply(p, fill, NOW);
      const out = asLegs(step(p, tick(exit, { at: NOW + 1 }), NOW + 1));
      total += walletDelta(out, p);
      close(total, out.pnl_sol ?? NaN, 1e-9);
    }
  });
});

describe('balance helpers', () => {
  it('reservedSol = stake + entry fee + rent; exit fees not reserved', () => {
    close(reservedSol(1, 1), 1 + FEE + RENT);
    assert.equal(reservedSol(0, 1), 0);
    assert.equal(reservedSol(NaN, 1), 0);
    assert.equal(reservedSol(1, 0), 0);
    assert.equal(reservedSol(1, 1.5), 0);
  });
  it('hasSufficientBalance compares available SOL with reservedSol', () => {
    const need = reservedSol(1, 1);
    assert.equal(hasSufficientBalance(need, 1, 1), true);
    assert.equal(hasSufficientBalance(need - 1e-9, 1, 1), false);
    assert.equal(hasSufficientBalance(NaN, 1, 1), false);
    assert.equal(hasSufficientBalance(10, -1, 1), false);
  });
  it('committedSol only counts pending positions', () => {
    const ps = [pending(), open(), pending({ status: 'closed' }), pending({ stake_sol: 2 })];
    close(committedSol(ps), reservedSol(1, 1) + reservedSol(2, 1));
  });
});

describe('strategyStats', () => {
  const pos = (strategy: Strategy, pnl: number | null, day: number, legs: PaperLeg['status'][]) => ({
    strategy,
    pnl_sol: pnl,
    closed_at: iso(T0 + day * 86_400_000),
    legs: legs.map((status) => ({ status })),
  });
  it('all_x2: leg rates, win rate, averages, total, worst streak, max drawdown (by close date)', () => {
    const s = strategyStats([
      pos('all_x2', 0.4, 3, ['tp_hit']),
      pos('all_x2', 1.0, 0, ['tp_hit']),
      pos('all_x2', -0.3, 1, ['sl_hit']),
      pos('all_x2', -0.3, 2, ['sl_hit']),
      pos('all_x2', -0.3, 4, ['sl_hit']),
      pos('all_x2', null, 5, []), // expired / cancelled: ignored
      pos('half_x2_rest_x3' as Strategy, 5, 6, ['tp_hit', 'tp_hit']), // archived strategy: ignored
    ]).all_x2;
    assert.equal(s.trades, 5);
    close(s.tpRate ?? NaN, 2 / 5);
    close(s.slRate ?? NaN, 3 / 5);
    close(s.winRate ?? NaN, 2 / 5);
    close(s.avgWinSol ?? NaN, 0.7);
    close(s.avgLossSol ?? NaN, -0.3);
    close(s.totalPnlSol, 0.5);
    assert.equal(s.worstLosingStreak, 2);
    close(s.maxDrawdownSol, 0.6);
  });
  it('always exposes the all_x2 key, zero-trade stats when none', () => {
    const s = strategyStats([]);
    assert.deepEqual(Object.keys(s), ['all_x2']);
    assert.equal(s.all_x2.trades, 0);
    assert.equal(s.all_x2.winRate, null);
  });
});

describe('equityCurve and maxDrawdown', () => {
  it('sorts events by date (ms or ISO) and accumulates the balance', () => {
    const c = equityCurve(10, [
      { at: iso(T0 + 2000), delta: 2 },
      { at: T0, delta: -1.0002 },
      { at: T0 + 1000, delta: -3 },
    ]);
    assert.deepEqual(c.map((p) => p.at), [T0, T0 + 1000, T0 + 2000]);
    close(c[2].balance, 7.9998);
    const dd = maxDrawdown(c.map((p) => p.balance), 10);
    close(dd.maxDrawdownSol, 4.0002);
    close(dd.maxDrawdownPct ?? NaN, 4.0002 / 10);
  });
  it('maxDrawdown is 0 on a rising series and pct null when the peak is ≤ 0', () => {
    assert.deepEqual(maxDrawdown([1, 2, 3], 0), { maxDrawdownSol: 0, maxDrawdownPct: null });
    assert.equal(maxDrawdown([-1, -2], 0).maxDrawdownPct, null);
  });
});

describe('NaN / invalid guards', () => {
  it('step never throws and returns none on invalid data', () => {
    const none = { kind: 'none' };
    assert.deepEqual(step(pending(), tick(NaN), NOW), none);
    assert.deepEqual(step(pending(), tick(0.5), NaN), none);
    assert.deepEqual(step(pending({ stake_sol: NaN }), tick(0.5), NOW), none);
    assert.deepEqual(step(pending({ expires_at: 'garbage' }), tick(0.5), NOW), none);
    assert.deepEqual(step(pending({ sl_price: NaN }), tick(0.5), NOW), none);
    assert.deepEqual(step(pending({ legs: [] }), tick(0.5), NOW), none);
    assert.deepEqual(step(pending({ legs: [leg('L', { size_pct: 50 })] }), tick(0.5), NOW), none);
    assert.deepEqual(step(pending({ strategy: 'custom' as Strategy }), tick(0.5), NOW), none, 'archived strategy: no fill');
    assert.deepEqual(step(open({ fill_price: null }), tick(5), NOW), none);
    assert.deepEqual(step(open({ status: 'closed' }), tick(5), NOW), none);
    assert.deepEqual(step(null as unknown as PaperPosition, tick(1), NOW), none);
  });
  it('walletDelta returns 0 on invalid data', () => {
    const bad: EngineStep = { kind: 'legs', closes: [{ id: 'X', status: 'tp_hit', exit_price: 2 }], moves: [], fees_sol: FEE, position_closed: false, pnl_sol: null };
    assert.equal(walletDelta(bad, open()), 0);
    assert.equal(walletDelta({ kind: 'fill', fill_price: 1, fees_sol: FEE, legs: [] }, pending({ stake_sol: NaN })), 0);
  });
});

describe('entry_mode next_tick (« Calme » / « Frénésie » auto-paper)', () => {
  const nextTick = (over: Partial<PaperPosition> = {}) => pending({ entry_mode: 'next_tick', ...over });
  it('parseEntryMode: unknown → target', () => {
    assert.equal(parseEntryMode('next_tick'), 'next_tick');
    assert.equal(parseEntryMode('NEXT_TICK'), 'target');
    assert.equal(parseEntryMode(undefined), 'target');
  });
  it('fills at the first scan tick strictly after created_at, whatever the price, leg rebased', () => {
    const s = step(nextTick(), tick(1.5, { at: T0 + 1 }), NOW);
    assert.equal(s.kind, 'fill');
    if (s.kind !== 'fill') return;
    const fill = 1.5 * 1.02;
    close(s.fill_price, fill);
    close(s.legs[0].tp_price, fill * 2);
    close(s.legs[0].stop_price, fill * 0.7);
  });
  it('a tick at exactly created_at (or before) does not fill; expiry still wins', () => {
    assert.deepEqual(step(nextTick(), tick(0.5, { at: T0 }), NOW), { kind: 'none' });
    assert.deepEqual(step(nextTick(), tick(1.5), T0 + ENTRY_EXPIRY_MS), { kind: 'expire' });
  });
});
