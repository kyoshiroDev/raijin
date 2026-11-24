import { TestBed } from '@angular/core/testing';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBenchApi, apiError, list, provideFakeBench } from '../../core/api/bench-api.testing';
import { PAPER_ERRORS } from '../../shared/models/paper';
import type { PaperDraft } from './paper-strategy';
import { PaperTradeStore } from './paper-trade-store';

/** `data` : ligne (portefeuille) ou lignes (positions en attente) ; `error` : échec de l'API. */
interface Result {
  data?: unknown;
  error: unknown;
}

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DRAFT: PaperDraft = { stake: 0.1, entry: 1, slPct: 30 };

describe('PaperTradeStore', () => {
  let wallet: Result;
  let pending: Result;
  let api: FakeBenchApi;
  /** Réponse de POST /api/paper/positions : lever une erreur simule un refus. */
  let open: ReturnType<typeof vi.fn<(body: unknown) => unknown>>;

  function setup(): PaperTradeStore {
    api = new FakeBenchApi()
      .on('GET', BENCH_ROUTES.paperWallets, () => {
        if (wallet.error) throw apiError(500);
        return list(wallet.data ? [wallet.data] : []);
      })
      .on('GET', BENCH_ROUTES.paperPositions, () => {
        if (pending.error) throw apiError(500);
        return list(Array.isArray(pending.data) ? pending.data : []);
      })
      .on('POST', BENCH_ROUTES.paperPositions, (c) => open(c.body));
    TestBed.configureTestingModule({ providers: [PaperTradeStore, ...provideFakeBench(api)] });
    return TestBed.inject(PaperTradeStore);
  }

  beforeEach(() => {
    wallet = { data: { book: 'main', balance_sol: 0.8, initial_sol: 1 }, error: null };
    pending = { data: [], error: null };
    open = vi.fn(() => ({ id: 'pos-1' }));
  });

  it('reads the main virtual wallet balance', async () => {
    const store = setup();
    await store.load();
    expect(api.callsTo('GET', BENCH_ROUTES.paperWallets)[0]?.query).toEqual({ books: ['main'] });
    expect(store.balance()).toBe(0.8);
    expect(store.available()).toBe(0.8);
  });

  it('subtracts the pending reservations of the main book (stake + buy fee + rent), like the backend', async () => {
    pending = { data: [{ status: 'pending', stake_sol: '0.2' }, { status: 'pending', stake_sol: 0.1 }], error: null };
    const store = setup();
    await store.load();
    expect(api.callsTo('GET', BENCH_ROUTES.paperPositions)[0]?.query).toMatchObject({ books: ['main'], status: 'pending' });
    expect(store.committed()).toBeCloseTo(0.3 + 2 * (0.0002 + 0.00204), 9);
    expect(store.available()).toBeCloseTo(0.8 - 0.30448, 9);
    // 0.495 + fee + rent = 0.49724 > available (0.49552): refused client-side, never sent.
    expect(await store.submit({ ...DRAFT, stake: 0.495 }, MINT)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('treats a missing wallet as a fresh 1 SOL book, and a read failure as unknown', async () => {
    wallet = { data: null, error: null };
    const store = setup();
    await store.load();
    expect(store.balance()).toBe(1);
    TestBed.resetTestingModule();
    wallet = { data: null, error: { message: 'boom' } };
    const failing = setup();
    await failing.load();
    expect(failing.loadError()).toBe(true);
    expect(failing.balance()).toBeNull();
  });

  it('opens the position through POST /api/paper/positions with the exact body', async () => {
    const store = setup();
    await store.load();
    expect(await store.submit(DRAFT, MINT)).toBe(true);
    expect(open).toHaveBeenCalledWith({
      mint: MINT,
      strategy: 'all_x2',
      stake_sol: 0.1,
      entry_price: 1,
      sl_pct: 30,
      custom_tp_price: null,
      custom_sl_price: null,
      book: 'main',
    });
    expect(store.state()).toBe('done');
  });

  it('shows « Solde virtuel insuffisant » when the API reports an insufficient balance (raw text never shown)', async () => {
    open.mockImplementationOnce(() => {
      throw apiError(422, 'PAPER_REJECTED', 'Solde virtuel insuffisant : 0,1 > 0,05 SOL.');
    });
    const store = setup();
    await store.load();
    expect(await store.submit(DRAFT, MINT)).toBe(false);
    expect(store.error()).toBe(PAPER_ERRORS.insufficient);
    expect(store.state()).toBe('error');
  });

  it('shows a generic « Position refusée » for any other error or a network failure', async () => {
    open.mockImplementationOnce(() => {
      throw apiError(422, 'PAPER_REJECTED', 'Carnet archivé.');
    });
    const store = setup();
    await store.load();
    await store.submit(DRAFT, MINT);
    expect(store.error()).toBe(PAPER_ERRORS.rejected);
    open.mockImplementationOnce(() => {
      throw apiError(0);
    });
    await store.submit(DRAFT, MINT);
    expect(store.error()).toBe(PAPER_ERRORS.rejected);
  });

  it('never sends an invalid draft or a stake above the balance', async () => {
    wallet = { data: { book: 'main', balance_sol: 0.05 }, error: null };
    const store = setup();
    await store.load();
    expect(await store.submit(DRAFT, MINT)).toBe(false);
    expect(await store.submit({ ...DRAFT, stake: 0.02, slPct: 0 }, MINT)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
