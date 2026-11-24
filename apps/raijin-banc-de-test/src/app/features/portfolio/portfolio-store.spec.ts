import { TestBed } from '@angular/core/testing';
import { BENCH_ROUTES, type BenchRoute } from '@raijin/bench-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBenchApi, FakeBenchEvents, apiError, list, provideFakeBench } from '../../core/api/bench-api.testing';
import { PORTFOLIO_MSG, PRICE_REFRESH_MS, PortfolioStore } from './portfolio-store';

const MINT_A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

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
  legs: [leg({ position_id: over['id'] ?? 'o1' })],
  ...over,
});

const wallet = (book: string, balance = 1) => ({ book, balance_sol: balance, initial_sol: 1, created_at: '2026-11-01T00:00:00Z', reset_at: null });

describe('PortfolioStore', () => {
  let api: FakeBenchApi;
  let events: FakeBenchEvents;
  let positions: unknown[];
  let wallets: unknown[];
  let walletError: unknown;
  let briefs: unknown[];
  /** Réponse des écritures (annulation, remise à zéro) : lever une erreur simule un refus. */
  let write: ReturnType<typeof vi.fn<() => unknown>>;

  function setup(): PortfolioStore {
    api = new FakeBenchApi()
      .on('GET', BENCH_ROUTES.paperPositions, () => list(positions))
      .on('GET', BENCH_ROUTES.paperWallets, () => {
        if (walletError) throw walletError;
        return list(wallets);
      })
      .on('GET', BENCH_ROUTES.tokenBriefs, () => list(briefs))
      .on('POST', BENCH_ROUTES.paperPositionCancel, () => write())
      .on('POST', BENCH_ROUTES.paperWalletReset, () => write());
    events = new FakeBenchEvents();
    TestBed.configureTestingModule({ providers: [PortfolioStore, ...provideFakeBench(api, events)] });
    return TestBed.inject(PortfolioStore);
  }

  const reads = (route: BenchRoute) => api.callsTo('GET', route).length;
  const writes = () => api.calls.filter((c) => c.method === 'POST');

  beforeEach(() => {
    positions = [];
    wallets = [wallet('main', 0.8)];
    walletError = null;
    briefs = [];
    write = vi.fn(() => ({}));
  });

  afterEach(() => vi.useRealTimers());

  it('loads wallets and positions with embedded legs (most recent first, limited)', async () => {
    positions = [row({ id: 'o1' })];
    const store = setup();
    await store.load();
    const books = ['main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30', 'calm_all_x2', 'frenzy_all_x2'];
    // Older archived books are never read; calm_all_x2 / frenzy_all_x2 are read for their history only.
    expect(api.callsTo('GET', BENCH_ROUTES.paperPositions)[0]?.query).toEqual({ books, limit: 500 });
    expect(api.callsTo('GET', BENCH_ROUTES.paperWallets)[0]?.query).toEqual({ books });
    expect(store.view().wallet.balance_sol).toBe(0.8);
    expect(store.view().active[0]!.legs[0]!.state).toBe('open');
    expect(store.hasParallel()).toBe(false);
  });

  it('computes the live P&L from the token briefs (tokens.price_usd, else the latest snapshot, chosen by the API)', async () => {
    positions = [row({ id: 'a', mint: MINT_A }), row({ id: 'b', mint: MINT_B, fill_price: 2, created_at: '2026-11-17T09:00:00Z' })];
    briefs = [
      { mint: MINT_A, symbol: 'A', price_usd: 1.5 },
      { mint: MINT_B, symbol: 'B', price_usd: 1 },
    ];
    const store = setup();
    await store.load();
    const [a, b] = store.view().active;
    expect(a!.livePrice).toBe(1.5);
    expect(a!.pnl?.pnlSol).toBeCloseTo(0.1 * (1.5 * 0.98 - 1) - 0.0004, 9);
    expect(b!.livePrice).toBe(1);
    expect(b!.pnl?.pnlSol).toBeLessThan(0);
    expect(api.callsTo('GET', BENCH_ROUTES.tokenBriefs)[0]?.query).toEqual({ mints: [MINT_A, MINT_B] });
  });

  it('shows a generic error when the wallets cannot be read', async () => {
    walletError = apiError(500);
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

  it('cancels a pending position through POST /api/paper/positions/:id/cancel and reloads; never an open one', async () => {
    positions = [row({ id: 'p1', status: 'pending', fill_price: null }), row({ id: 'o1' })];
    const store = setup();
    await store.load();
    const before = reads(BENCH_ROUTES.paperPositions);
    await store.cancel('o1');
    await store.cancel('nope');
    expect(writes()).toHaveLength(0);
    await store.cancel('p1');
    expect(writes().map((c) => [c.route, c.params])).toEqual([[BENCH_ROUTES.paperPositionCancel, { id: 'p1' }]]);
    expect(reads(BENCH_ROUTES.paperPositions)).toBe(before + 1);
  });

  it('reports a refused cancel (already filled or expired) and reloads', async () => {
    positions = [row({ id: 'p1', status: 'pending' })];
    const store = setup();
    await store.load();
    write.mockImplementationOnce(() => {
      throw apiError(422, 'PAPER_REJECTED');
    });
    const before = reads(BENCH_ROUTES.paperPositions);
    await store.cancel('p1');
    expect(store.feedback()).toEqual({ kind: 'error', text: PORTFOLIO_MSG.cancelFailed });
    expect(reads(BENCH_ROUTES.paperPositions)).toBe(before + 1);
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
    expect(writes()).toHaveLength(0);
    store.requestReset('calm_sl40');
    expect(store.confirmingBook()).toBe('calm_sl40');
    store.dismissReset();
    await store.confirmReset();
    expect(writes()).toHaveLength(0);
    store.requestReset('calm_sl40');
    await store.confirmReset();
    expect(writes().map((c) => [c.route, c.params])).toEqual([[BENCH_ROUTES.paperWalletReset, { book: 'calm_sl40' }]]);
    expect(store.confirmingBook()).toBeNull();
    expect(store.feedback()).toEqual({ kind: 'ok', text: 'Portefeuille « Calme SL −40 % » réinitialisé à 1 SOL virtuel.' });
  });

  it('reports a failed reset and keeps the confirmation open', async () => {
    const store = setup();
    await store.load();
    store.requestReset('main');
    write.mockImplementationOnce(() => {
      throw apiError(500);
    });
    await store.confirmReset();
    expect(store.feedback()).toEqual({ kind: 'error', text: PORTFOLIO_MSG.resetFailed });
    expect(store.confirmingBook()).toBe('main');
  });

  it('follows the SSE « paper » stream, reloads on events and after a reconnection, refreshes prices periodically and cleans up', async () => {
    vi.useFakeTimers();
    positions = [row({ id: 'o1' })];
    const store = setup();
    await store.load();
    store.listen();
    store.listen(); // idempotent
    expect(events.subscriptions.map((s) => s.topics)).toEqual([['paper']]);
    const before = reads(BENCH_ROUTES.paperPositions);
    events.emit({ type: 'paper.changed', book: 'main', position_id: 'o1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(reads(BENCH_ROUTES.paperPositions)).toBe(before + 1);
    events.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads(BENCH_ROUTES.paperPositions)).toBe(before + 2);
    const priceReads = reads(BENCH_ROUTES.tokenBriefs);
    await vi.advanceTimersByTimeAsync(PRICE_REFRESH_MS);
    expect(reads(BENCH_ROUTES.tokenBriefs)).toBe(priceReads + 1);
    TestBed.resetTestingModule();
    expect(events.open).toBe(0);
    const afterDestroy = api.calls.length;
    await vi.advanceTimersByTimeAsync(PRICE_REFRESH_MS * 2);
    expect(api.calls.length).toBe(afterDestroy);
  });

  it('exposes the history, the stats per strategy and the balance curve of the selected book', async () => {
    positions = [
      row({ id: 'h1', status: 'closed', pnl_sol: 0.05, closed_at: '2026-11-16T10:00:00Z', legs: [leg({ position_id: 'h1', status: 'tp_hit' })] }),
      row({ id: 'h2', status: 'closed', pnl_sol: -0.03, closed_at: '2026-11-17T10:00:00Z', legs: [leg({ position_id: 'h2', status: 'sl_hit' })] }),
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
      row({ id: 'm1', status: 'closed', legs: [leg({ id: 'a', position_id: 'm1', status: 'sl_hit', stop_price: '0.7', exit_price: '0.63' })] }),
      row({ id: 'm2', status: 'closed', legs: [leg({ id: 'b', position_id: 'm2', status: 'tp_hit', exit_price: 2 })] }),
      row({ id: 'x1', book: 'frenzy_sl30', status: 'closed', legs: [leg({ id: 'c', position_id: 'x1', status: 'sl_hit', stop_price: 1, exit_price: 0.98 })] }),
    ];
    const store = setup();
    await store.load();
    const [main, calm, frenzy] = store.stopSlippage();
    expect(main).toMatchObject({ book: 'main', n: 1 });
    expect(main!.avgPct).toBeCloseTo(-10, 9);
    expect(calm).toEqual({ book: 'calm_sl30', n: 0, avgPct: null, worstPct: null });
    expect(frenzy!.worstPct).toBeCloseTo(-2, 9);
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
    expect(writes()).toHaveLength(0);
    expect(store.testComparison()).toBeNull();
  });
});
