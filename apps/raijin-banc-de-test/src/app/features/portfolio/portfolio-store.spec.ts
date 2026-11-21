import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPABASE } from '../../core/supabase/supabase-client';
import { PORTFOLIO_MSG, PRICE_REFRESH_MS, PortfolioStore } from './portfolio-store';

interface Result {
  data?: unknown;
  error: unknown;
}

const MINT_A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/** Chainable, awaitable query: records every call, resolves from `resolve(q)`. */
class Query implements PromiseLike<Result> {
  readonly ops: [string, unknown[]][] = [];
  constructor(
    readonly table: string,
    private readonly resolve: (q: Query) => Result,
  ) {}
  select(...a: unknown[]): this {
    return this.op('select', a);
  }
  eq(...a: unknown[]): this {
    return this.op('eq', a);
  }
  in(...a: unknown[]): this {
    return this.op('in', a);
  }
  order(...a: unknown[]): this {
    return this.op('order', a);
  }
  limit(...a: unknown[]): this {
    return this.op('limit', a);
  }
  then<T1 = Result, T2 = never>(
    onFulfilled?: ((v: Result) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.resolve(this)).then(onFulfilled, onRejected);
  }
  private op(name: string, args: unknown[]): this {
    this.ops.push([name, args]);
    return this;
  }
}

const leg = (over: Record<string, unknown>) => ({ id: 'l1', position_id: 'o1', size_pct: 100, tp_price: 2, stop_price: 0.7, status: 'open', ...over });

const row = (over: Record<string, unknown>) => ({
  id: 'o1',
  book: 'main',
  mint: MINT_A,
  symbol: 'GTA6',
  strategy: 'all_x2',
  stake_sol: 0.1,
  source: 'manual',
  status: 'open',
  entry_target_price: 1,
  fill_price: 1,
  sl_price: 0.7,
  sl_pct: 30,
  created_at: '2026-11-17T10:00:00Z',
  paper_legs: [leg({ position_id: over['id'] ?? 'o1' })],
  ...over,
});

const wallet = (book: string, balance = 1) => ({ book, balance_sol: balance, initial_sol: 1, created_at: '2026-11-01T00:00:00Z', reset_at: null });

describe('PortfolioStore', () => {
  let queries: Query[];
  let positions: unknown[];
  let wallets: unknown[];
  let walletError: unknown;
  let tokenPrices: unknown[];
  let snapshots: Map<string, unknown[]>;
  let rpc: ReturnType<typeof vi.fn<(name: string, params?: unknown) => Promise<Result>>>;
  let channel: { on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
  let handlers: (() => void)[];
  let removeChannel: ReturnType<typeof vi.fn>;

  function resolve(q: Query): Result {
    if (q.table === 'paper_positions') return { data: positions, error: null };
    if (q.table === 'paper_wallets') return { data: wallets, error: walletError };
    if (q.table === 'tokens') return { data: tokenPrices, error: null };
    if (q.table === 'token_snapshots') {
      const mint = q.ops.find(([n]) => n === 'eq')?.[1][1];
      return { data: snapshots.get(String(mint)) ?? [], error: null };
    }
    return { data: null, error: { message: 'unexpected' } };
  }

  function setup(): PortfolioStore {
    const client = {
      rpc,
      from: (table: string) => {
        const q = new Query(table, resolve);
        queries.push(q);
        return q;
      },
      channel: vi.fn(() => channel),
      removeChannel,
    };
    TestBed.configureTestingModule({ providers: [PortfolioStore, { provide: SUPABASE, useValue: client }] });
    return TestBed.inject(PortfolioStore);
  }

  const reads = (table: string) => queries.filter((q) => q.table === table).length;

  beforeEach(() => {
    queries = [];
    positions = [];
    wallets = [wallet('main', 0.8)];
    walletError = null;
    tokenPrices = [];
    snapshots = new Map();
    handlers = [];
    rpc = vi.fn(async () => ({ data: null, error: null }));
    channel = {
      on: vi.fn((_type: string, _filter: unknown, cb: () => void) => {
        handlers.push(cb);
        return channel;
      }),
      subscribe: vi.fn(() => channel),
    };
    removeChannel = vi.fn(async () => 'ok');
  });

  afterEach(() => vi.useRealTimers());

  it('loads wallets and positions with embedded legs (most recent first, limited)', async () => {
    positions = [row({ id: 'o1' })];
    const store = setup();
    await store.load();
    const q = queries.find((x) => x.table === 'paper_positions');
    expect(String(q?.ops[0][1][0])).toContain('paper_legs(');
    expect(q?.ops.map(([n]) => n)).toEqual(['select', 'in', 'order', 'limit']);
    // Older archived books are never read; calm_all_x2 / frenzy_all_x2 are read for their history only.
    expect(q?.ops.find(([n]) => n === 'in')?.[1]).toEqual(['book', ['main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30', 'calm_all_x2', 'frenzy_all_x2']]);
    expect(queries.find((x) => x.table === 'paper_wallets')?.ops.find(([n]) => n === 'in')?.[1]).toEqual(['book', ['main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30', 'calm_all_x2', 'frenzy_all_x2']]);
    expect(store.view().wallet.balance_sol).toBe(0.8);
    expect(store.view().active[0].legs[0].state).toBe('open');
    expect(store.hasParallel()).toBe(false);
  });

  it('computes the live P&L from tokens.price_usd, else from the latest snapshot', async () => {
    positions = [row({ id: 'a', mint: MINT_A }), row({ id: 'b', mint: MINT_B, fill_price: 2, created_at: '2026-11-17T09:00:00Z' })];
    tokenPrices = [{ mint: MINT_A, price_usd: '1.5' }];
    snapshots.set(MINT_B, [{ mint: MINT_B, price_usd: 1 }]);
    const store = setup();
    await store.load();
    const [a, b] = store.view().active;
    expect(a.livePrice).toBe(1.5);
    expect(a.pnl?.pnlSol).toBeCloseTo(0.1 * (1.5 * 0.98 - 1) - 0.0004, 9);
    expect(b.livePrice).toBe(1);
    expect(b.pnl?.pnlSol).toBeLessThan(0);
    const snap = queries.find((q) => q.table === 'token_snapshots');
    expect(snap?.ops).toContainEqual(['eq', ['mint', MINT_B]]);
  });

  it('shows a generic error when the wallets cannot be read', async () => {
    walletError = { message: 'x' };
    const store = setup();
    await store.load();
    expect(store.error()).toBe(PORTFOLIO_MSG.loadFailed);
  });

  it('ignores archived books (half_x2_rest_x3, all_x2, young_*) even if the server still returns them', async () => {
    wallets = [wallet('main'), wallet('half_x2_rest_x3', 1.1), wallet('all_x2', 0.95), wallet('young_all_x2', 1.2)];
    positions = [row({ id: 'h', book: 'half_x2_rest_x3' }), row({ id: 'y', book: 'young_all_x2' }), row({ id: 'm' })];
    const store = setup();
    await store.load();
    expect(store.books()).toEqual(['main']);
    expect(store.hasParallel()).toBe(false);
    expect(store.view().active.map((v) => v.position.id)).toEqual(['m']);
  });

  it('cancels a pending position through rpc(paper_cancel_position) and reloads; never an open one', async () => {
    positions = [row({ id: 'p1', status: 'pending', fill_price: null }), row({ id: 'o1' })];
    const store = setup();
    await store.load();
    const before = reads('paper_positions');
    await store.cancel('o1');
    await store.cancel('nope');
    expect(rpc).not.toHaveBeenCalled();
    await store.cancel('p1');
    expect(rpc).toHaveBeenCalledWith('paper_cancel_position', { p_id: 'p1' });
    expect(reads('paper_positions')).toBe(before + 1);
  });

  it('reports a failed cancel, including « not cancelled » (false: already filled or expired), and reloads', async () => {
    positions = [row({ id: 'p1', status: 'pending' })];
    const store = setup();
    await store.load();
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    await store.cancel('p1');
    expect(store.feedback()).toEqual({ kind: 'error', text: PORTFOLIO_MSG.cancelFailed });
    const before = reads('paper_positions');
    rpc.mockResolvedValueOnce({ data: false, error: null });
    await store.cancel('p1');
    expect(store.feedback()).toEqual({ kind: 'error', text: PORTFOLIO_MSG.cancelFailed });
    expect(reads('paper_positions')).toBe(before + 1);
  });

  it('shows the available balance of the book: balance minus pending reservations (stake + buy fee + rent)', async () => {
    positions = [row({ id: 'p1', status: 'pending', stake_sol: 0.2 }), row({ id: 'o1' })];
    const store = setup();
    await store.load();
    expect(store.view().reservedSol).toBeCloseTo(0.2 + 0.0002 + 0.00204, 9);
    expect(store.view().availableSol).toBeCloseTo(0.8 - 0.20224, 9);
  });

  it('resets exactly the confirmed book, only after the confirmation step', async () => {
    wallets = [wallet('main'), wallet('calm_sl40')];
    const store = setup();
    await store.load();
    await store.confirmReset();
    expect(rpc).not.toHaveBeenCalled();
    store.requestReset('calm_sl40');
    expect(store.confirmingBook()).toBe('calm_sl40');
    store.dismissReset();
    await store.confirmReset();
    expect(rpc).not.toHaveBeenCalled();
    store.requestReset('calm_sl40');
    await store.confirmReset();
    expect(rpc).toHaveBeenCalledWith('paper_reset_wallet', { p_book: 'calm_sl40' });
    expect(store.confirmingBook()).toBeNull();
    expect(store.feedback()).toEqual({ kind: 'ok', text: 'Portefeuille « Calme SL −40 % » réinitialisé à 1 SOL virtuel.' });
  });

  it('reports a failed reset and keeps the confirmation open', async () => {
    const store = setup();
    await store.load();
    store.requestReset('main');
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    await store.confirmReset();
    expect(store.feedback()).toEqual({ kind: 'error', text: PORTFOLIO_MSG.resetFailed });
    expect(store.confirmingBook()).toBe('main');
  });

  it('subscribes to paper_positions and paper_legs only (wallets are not published), reloads on events, refreshes prices periodically and cleans up', async () => {
    vi.useFakeTimers();
    positions = [row({ id: 'o1' })];
    const store = setup();
    await store.load();
    store.listen();
    store.listen(); // idempotent
    expect(channel.on.mock.calls.map((c) => c[1])).toEqual([
      { event: '*', schema: 'public', table: 'paper_positions' },
      { event: '*', schema: 'public', table: 'paper_legs' },
    ]);
    const before = reads('paper_positions');
    handlers[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads('paper_positions')).toBe(before + 1);
    const tokenReads = reads('tokens');
    await vi.advanceTimersByTimeAsync(PRICE_REFRESH_MS);
    expect(reads('tokens')).toBe(tokenReads + 1);
    TestBed.resetTestingModule();
    expect(removeChannel).toHaveBeenCalledWith(channel);
    const afterDestroy = queries.length;
    await vi.advanceTimersByTimeAsync(PRICE_REFRESH_MS * 2);
    expect(queries.length).toBe(afterDestroy);
  });

  it('exposes the history, the stats per strategy and the balance curve of the selected book', async () => {
    positions = [
      row({ id: 'h1', status: 'closed', pnl_sol: 0.05, closed_at: '2026-11-16T10:00:00Z', paper_legs: [leg({ position_id: 'h1', status: 'tp_hit' })] }),
      row({ id: 'h2', status: 'closed', pnl_sol: -0.03, closed_at: '2026-11-17T10:00:00Z', paper_legs: [leg({ position_id: 'h2', status: 'sl_hit' })] }),
      row({ id: 'o1' }),
    ];
    const store = setup();
    await store.load();
    const v = store.view();
    expect(v.history.map((p) => p.id)).toEqual(['h2', 'h1']);
    expect(v.strategies).toHaveLength(1);
    expect(v.strategies[0]).toMatchObject({ strategy: 'all_x2', trades: 2, legs: { tp: 1, sl: 1, breakeven: 0, closed: 2 }, enough: false });
    expect(v.curve.map((p) => p.balanceSol)).toEqual([1, 1.05, 1.02]);
  });

  it('exposes the exit slippage on stops per available book (sl_hit legs only, numeric text parsed)', async () => {
    wallets = [wallet('main'), wallet('calm_sl30'), wallet('frenzy_sl30')];
    positions = [
      row({ id: 'm1', status: 'closed', paper_legs: [leg({ id: 'a', position_id: 'm1', status: 'sl_hit', stop_price: '0.7', exit_price: '0.63' })] }),
      row({ id: 'm2', status: 'closed', paper_legs: [leg({ id: 'b', position_id: 'm2', status: 'tp_hit', exit_price: 2 })] }),
      row({ id: 'x1', book: 'frenzy_sl30', status: 'closed', paper_legs: [leg({ id: 'c', position_id: 'x1', status: 'sl_hit', stop_price: 1, exit_price: 0.98 })] }),
    ];
    const store = setup();
    await store.load();
    const [main, calm, frenzy] = store.stopSlippage();
    expect(main).toMatchObject({ book: 'main', n: 1 });
    expect(main.avgPct).toBeCloseTo(-10, 9);
    expect(calm).toEqual({ book: 'calm_sl30', n: 0, avgPct: null, worstPct: null });
    expect(frenzy.worstPct).toBeCloseTo(-2, 9);
  });

  it('offers the test books and compares those that exist once there are at least two', async () => {
    wallets = [wallet('main'), wallet('calm_sl30', 1.1)];
    positions = [row({ id: 'c1', book: 'calm_sl30', strategy: 'all_x2' })];
    const store = setup();
    await store.load();
    expect(store.books()).toEqual(['main', 'calm_sl30']);
    expect(store.testComparison()).toBeNull();
    wallets = [wallet('main'), wallet('frenzy_sl30', 0.95), wallet('calm_sl30', 1.1), wallet('calm_sl40', 1.02)];
    await store.load();
    expect(store.books()).toEqual(['main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30']);
    expect(store.testComparison()?.map((v) => [v.book, v.wallet.balance_sol])).toEqual([
      ['calm_sl30', 1.1],
      ['calm_sl40', 1.02],
      ['frenzy_sl30', 0.95],
    ]);
    store.selectBook('calm_sl30');
    expect(store.selectedArchived()).toBe(false);
    expect(store.view().active.map((v) => v.position.id)).toEqual(['c1']);
  });

  it('keeps an archived book readable but never resets it nor cancels its positions', async () => {
    wallets = [wallet('main'), wallet('calm_all_x2', 0.9)];
    positions = [row({ id: 'a1', book: 'calm_all_x2', strategy: 'all_x2', status: 'pending' })];
    const store = setup();
    await store.load();
    expect(store.books()).toEqual(['main', 'calm_all_x2']);
    store.selectBook('calm_all_x2');
    expect(store.selectedArchived()).toBe(true);
    expect(store.view().active.map((v) => v.position.id)).toEqual(['a1']);
    store.requestReset('calm_all_x2');
    expect(store.confirmingBook()).toBeNull();
    await store.confirmReset();
    await store.cancel('a1');
    expect(rpc).not.toHaveBeenCalled();
    expect(store.testComparison()).toBeNull();
  });
});
