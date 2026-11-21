import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPABASE } from '../../core/supabase/supabase-client';
import { PAPER_ERRORS } from '../../shared/models/paper';
import type { PaperDraft } from './paper-strategy';
import { PaperTradeStore } from './paper-trade-store';

interface Result {
  data?: unknown;
  error: unknown;
}

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DRAFT: PaperDraft = { stake: 0.1, entry: 1, slPct: 30 };

/** Chainable, awaitable query: every eq() is recorded; maybeSingle() resolves the wallet, await resolves the rows. */
function query(table: string, cols: string, log: unknown[][], wallet: () => Result, pending: () => Result) {
  const q = {
    eq: (...args: unknown[]) => {
      log.push([table, cols, ...args]);
      return q;
    },
    maybeSingle: async () => wallet(),
    then: (ok: (v: Result) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(pending()).then(ok, ko),
  };
  return q;
}

describe('PaperTradeStore', () => {
  let wallet: Result;
  let pending: Result;
  let filters: unknown[][];
  let rpc: ReturnType<typeof vi.fn<(name: string, params?: unknown) => Promise<Result>>>;

  function setup(): PaperTradeStore {
    const client = {
      rpc,
      from: (table: string) => ({
        select: (cols: string) =>
          query(
            table,
            cols,
            filters,
            () => wallet,
            () => pending,
          ),
      }),
    };
    TestBed.configureTestingModule({ providers: [PaperTradeStore, { provide: SUPABASE, useValue: client }] });
    return TestBed.inject(PaperTradeStore);
  }

  beforeEach(() => {
    wallet = { data: { book: 'main', balance_sol: 0.8, initial_sol: 1 }, error: null };
    pending = { data: [], error: null };
    filters = [];
    rpc = vi.fn(async () => ({ data: 'pos-1', error: null }));
  });

  it('reads the main virtual wallet balance (owner RLS)', async () => {
    const store = setup();
    await store.load();
    expect(filters[0]).toEqual(['paper_wallets', 'book,balance_sol,initial_sol,created_at,reset_at', 'book', 'main']);
    expect(store.balance()).toBe(0.8);
    expect(store.available()).toBe(0.8);
  });

  it('subtracts the pending reservations of the main book (stake + buy fee + rent), like the backend', async () => {
    pending = { data: [{ status: 'pending', stake_sol: '0.2' }, { status: 'pending', stake_sol: 0.1 }], error: null };
    const store = setup();
    await store.load();
    expect(filters).toContainEqual(['paper_positions', 'status,stake_sol', 'book', 'main']);
    expect(filters).toContainEqual(['paper_positions', 'status,stake_sol', 'status', 'pending']);
    expect(store.committed()).toBeCloseTo(0.3 + 2 * (0.0002 + 0.00204), 9);
    expect(store.available()).toBeCloseTo(0.8 - 0.30448, 9);
    // 0.495 + fee + rent = 0.49724 > available (0.49552): refused client-side, never sent.
    expect(await store.submit({ ...DRAFT, stake: 0.495 }, MINT)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
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

  it('opens the position through rpc(paper_open_position) with the exact payload', async () => {
    const store = setup();
    await store.load();
    expect(await store.submit(DRAFT, MINT)).toBe(true);
    expect(rpc).toHaveBeenCalledWith('paper_open_position', {
      p_mint: MINT,
      p_strategy: 'all_x2',
      p_stake: 0.1,
      p_entry: 1,
      p_sl_pct: 30,
      p_custom_tp: null,
      p_custom_sl: null,
      p_book: 'main',
    });
    expect(store.state()).toBe('done');
  });

  it('shows « Solde virtuel insuffisant » when the RPC reports an insufficient balance (raw text never shown)', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'insufficient paper balance: 0.1 > 0.05' } });
    const store = setup();
    await store.load();
    expect(await store.submit(DRAFT, MINT)).toBe(false);
    expect(store.error()).toBe(PAPER_ERRORS.insufficient);
    expect(store.state()).toBe('error');
  });

  it('shows a generic « Position refusée » for any other error or a network failure', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied for function' } });
    const store = setup();
    await store.load();
    await store.submit(DRAFT, MINT);
    expect(store.error()).toBe(PAPER_ERRORS.rejected);
    rpc.mockRejectedValueOnce(new Error('network'));
    await store.submit(DRAFT, MINT);
    expect(store.error()).toBe(PAPER_ERRORS.rejected);
  });

  it('never sends an invalid draft or a stake above the balance', async () => {
    wallet = { data: { book: 'main', balance_sol: 0.05 }, error: null };
    const store = setup();
    await store.load();
    expect(await store.submit(DRAFT, MINT)).toBe(false);
    expect(await store.submit({ ...DRAFT, stake: 0.02, slPct: 0 }, MINT)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});
