import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { SUPABASE } from '../supabase/supabase-client';
import { MARKET_CONTEXT_TTL_MS, MarketContext, parseMarketRates } from './market-context';

interface Result { data: unknown; error: unknown }

function setup(result: () => Promise<Result>) {
  const maybeSingle = vi.fn(result);
  const limit = vi.fn(() => ({ maybeSingle }));
  const order = vi.fn(() => ({ limit }));
  const not = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ not }));
  const from = vi.fn(() => ({ select }));
  TestBed.configureTestingModule({ providers: [{ provide: SUPABASE, useValue: { from } }] });
  return { market: TestBed.inject(MarketContext), from, select, not, order, limit, maybeSingle };
}

describe('parseMarketRates', () => {
  it('accepts positive numbers or numeric text', () => {
    expect(parseMarketRates({ sol_usd: 162, eur_usd: '1.08' })).toEqual({ solUsd: 162, eurUsd: 1.08 });
  });
  it('is null for missing, null, zero, negative or non-numeric values', () => {
    for (const row of [null, undefined, 'x', {}, { sol_usd: 162 }, { sol_usd: null, eur_usd: 1.08 }, { sol_usd: 0, eur_usd: 1 }, { sol_usd: 162, eur_usd: -1 }, { sol_usd: 'abc', eur_usd: 1 }]) {
      expect(parseMarketRates(row)).toBeNull();
    }
  });
});

describe('MarketContext', () => {
  it('starts unknown and does not query on creation', () => {
    const { market, from } = setup(async () => ({ data: null, error: null }));
    expect(market.eurPerSol()).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it('reads the latest scan_runs rates from Supabase and computes € per SOL', async () => {
    const { market, from, select, not, order, limit } = setup(async () => ({ data: { sol_usd: 162, eur_usd: 1.08 }, error: null }));
    await market.load();
    expect(from).toHaveBeenCalledWith('scan_runs');
    expect(select).toHaveBeenCalledWith('sol_usd,eur_usd');
    expect(not).toHaveBeenCalledWith('sol_usd', 'is', null);
    expect(order).toHaveBeenCalledWith('started_at', { ascending: false });
    expect(limit).toHaveBeenCalledWith(1);
    expect(market.eurPerSol()).toBeCloseTo(150, 10);
  });

  it('stays null-safe: null values, no row, a select error (column not deployed) or a throw → no €', async () => {
    const results: (() => Promise<Result>)[] = [
      async () => ({ data: { sol_usd: null, eur_usd: null }, error: null }),
      async () => ({ data: { sol_usd: 162, eur_usd: null }, error: null }),
      async () => ({ data: null, error: null }),
      async () => ({ data: null, error: { code: '42703', message: 'column scan_runs.sol_usd does not exist' } }),
      async () => {
        throw new Error('network');
      },
    ];
    for (const r of results) {
      TestBed.resetTestingModule();
      const { market } = setup(r);
      await expect(market.load()).resolves.toBeUndefined();
      expect(market.eurPerSol()).toBeNull();
    }
  });

  it('caches for 5 minutes and shares an in-flight read', async () => {
    const { market, from } = setup(async () => ({ data: { sol_usd: 162, eur_usd: 1.08 }, error: null }));
    const t0 = 1_000_000;
    await Promise.all([market.load(t0), market.load(t0)]);
    expect(from).toHaveBeenCalledTimes(1);
    await market.load(t0 + MARKET_CONTEXT_TTL_MS - 1);
    expect(from).toHaveBeenCalledTimes(1);
    await market.load(t0 + MARKET_CONTEXT_TTL_MS);
    expect(from).toHaveBeenCalledTimes(2);
  });

  it('reset() forgets the rates and ignores a slow read from the previous session', async () => {
    let resolve: (v: Result) => void = () => undefined;
    const { market } = setup(() => new Promise<Result>((r) => (resolve = r)));
    const pending = market.load();
    market.reset();
    resolve({ data: { sol_usd: 162, eur_usd: 1.08 }, error: null });
    await pending;
    expect(market.eurPerSol()).toBeNull();
  });
});
