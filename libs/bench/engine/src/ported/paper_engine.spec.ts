// paper-engine v2 orchestration (feat/paper-trading-v2, chore/slim-down: all_x2 only; feat/calm-sl-test: books main /
// calm_sl30 / calm_sl40 / frenzy_sl30, calm_all_x2 / frenzy_all_x2 archived but still run): position + leg parsing, fair ordering, ticks + staleness, quote amounts and candidates,
// paced/budgeted Jupiter quotes (fetch mocked: no network), paper_apply_v2 payloads for fill / legs / expire (replay =
// no-op), next_tick entries, « Calme » / « Frénésie » plans, the forced tracking read and the v1 → v2 data-migration
// mapping.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test` (zod shim below).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupZodForNode } from './test-support/zod-node';
import { buildTrackingBatch, MAX_TRACKED_MINTS, type OpenPosition } from './alert-tracking';
import {
  NETWORK_FEE_PER_TX_SOL,
  type PaperLeg,
  type PaperPosition,
  step,
  TOKEN_ACCOUNT_RENT_SOL,
  walletDelta,
} from './paper';
import { migrateV1Orders, NO_SL, NO_TP, type V1Order } from './test-support/paper-v1-migration';
import type { Book } from './paper-engine';

const zodReady = setupZodForNode();
const E = require('./paper-engine') as typeof import('./paper-engine');
const skip = !E ? 'zod unavailable' : undefined;

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const USER = '6f1c2a5e-8d3b-4f7a-9c1e-2b4d6f8a0c11';
const USER2 = '7a2d3b6f-9e4c-4a8b-8d2f-3c5e7a9b1d22';
const USER3 = '8b3e4c7a-af5d-4b9c-9e3a-4d6f8bac2e33';
const NOW = Date.parse('2026-11-18T12:01:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const quiet = () => undefined;
/** Source text for the static checks; null when file reads are not permitted (plain `deno test` without --allow-read). */
const readSource = (rel: string): string | null => {
  try {
    return readFileSync(resolve(__dirname, '../../../../..', rel), 'utf8');
  } catch {
    return null;
  }
};
// Port Node : le scan porté (bench-collect) ; la migration paper v2 d'origine (legacy/, lecture seule, historique).
const SCAN_SRC = readSource('libs/bench/collect/src/lib/scan/scan-tokens.ts');
const MIGRATION_SQL = readSource('legacy/supabase/migrations/20261118020000_paper_trading_v2.sql');

type EnginePosition = PaperPosition & { user_id: string; mint: string; book: Book };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const leg = (over: Partial<PaperLeg> = {}): PaperLeg => ({
  id: uuid(), size_pct: 100, tp_price: 2, status: 'open', stop_price: 0.7, exit_price: null, closed_at: null, ...over,
});
/** all_x2, entry target 1, SL 0.7 (30 %), stake 0.5, one leg (×2). */
const pending = (over: Partial<EnginePosition> = {}): EnginePosition => ({
  id: uuid(),
  user_id: USER,
  mint: MINT,
  book: 'main',
  strategy: 'all_x2',
  status: 'pending',
  stake_sol: 0.5,
  entry_target_price: 1,
  fill_price: null,
  sl_price: 0.7,
  created_at: iso(NOW - 30 * MIN),
  filled_at: null,
  expires_at: iso(NOW + 20 * 3_600_000),
  legs: [leg()],
  ...over,
});
const open = (over: Partial<EnginePosition> = {}) =>
  pending({ status: 'open', fill_price: 1, filled_at: iso(NOW - 20 * MIN), ...over });
const tickAt = (price: number, at = NOW - MIN) => ({ price, at });

/** In-memory mirror of paper_apply_v2 (status guard, legs, wallet), to test multi-step flows and replays. */
function applyInMemory(p: EnginePosition, wallet: { balance: number }, args: NonNullable<ReturnType<NonNullable<typeof E>['applyArgsV2']>>): boolean {
  if (p.status !== args.p_expected) return false;
  const s = args.p_step;
  if (s.kind === 'fill') {
    p.status = 'open';
    p.fill_price = s.fill_price;
    p.filled_at = iso(NOW);
    for (const l of s.legs) Object.assign(p.legs.find((x) => x.id === l.id)!, { tp_price: l.tp_price, stop_price: l.stop_price });
  } else if (s.kind === 'expire') {
    p.status = 'expired';
  } else {
    if (!s.closes.every((c) => p.legs.find((l) => l.id === c.id)?.status === 'open')) return false;
    for (const c of s.closes) Object.assign(p.legs.find((l) => l.id === c.id)!, { status: c.status, exit_price: c.exit_price, closed_at: iso(NOW) });
    if (s.position_closed) p.status = 'closed';
  }
  wallet.balance += args.p_delta;
  return true;
}

/** Jupiter quote body (priceImpactPct is a FRACTION, as returned by lite-api). */
const quote = (inputMint: string, outputMint: string, inAmount: bigint | string, outAmount: bigint | string, impact: number) =>
  JSON.stringify({ inputMint, outputMint, inAmount: String(inAmount), outAmount: String(outAmount), priceImpactPct: String(impact) });

function mockJupiter(handler: (url: URL) => { status?: number; body: string }) {
  const calls: string[] = [];
  const fetchFn = (input: string): Promise<Response> => {
    calls.push(input);
    const r = handler(new URL(input));
    return Promise.resolve(new Response(r.body, { status: r.status ?? 200 }));
  };
  return { fetchFn, calls };
}

/** Fake clock: sleep advances time instantly. */
function fakeClock(start: number) {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    slept,
  };
}

// ---------------------------------------------------------------------------------------------------------------

describe('parseEnginePositions', { skip }, () => {
  const legRow = (over: Record<string, unknown> = {}) => ({
    id: uuid(), size_pct: 100, tp_price: '2', status: 'open', stop_price: '0.7', exit_price: null, closed_at: null, ...over,
  });
  const row = (over: Record<string, unknown> = {}) => ({
    id: uuid(), user_id: USER, book: 'main', mint: MINT, strategy: 'all_x2', status: 'pending', stake_sol: '0.5',
    entry_target_price: '1', fill_price: null, sl_price: '0.7', created_at: iso(NOW - MIN), filled_at: null,
    expires_at: iso(NOW + 3_600_000), paper_legs: [legRow()], ...over,
  });
  it('keeps valid pending/open all_x2 positions of the active books (numeric strings → numbers)', () => {
    const out = E!.parseEnginePositions([
      row(),
      row({ status: 'open', fill_price: '1', filled_at: iso(NOW - MIN), book: 'calm_all_x2', entry_mode: 'next_tick' }),
      row({ book: 'frenzy_all_x2', entry_mode: 'weird' }),
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[0].stake_sol, 0.5);
    assert.equal(out[0].legs[0].tp_price, 2);
    assert.deepEqual(out.map((p) => [p.book, p.entry_mode]), [['main', 'target'], ['calm_all_x2', 'next_tick'], ['frenzy_all_x2', 'target']]);
    assert.ok(E!.ENGINE_POSITION_SELECT.includes('entry_mode'));
  });
  it('skips the archived books and strategies (cancelled by the migration, never executed again)', () => {
    const out = E!.parseEnginePositions([
      row({ book: 'all_x2' }),
      row({ book: 'half_x2_rest_x3', strategy: 'half_x2_rest_x3', paper_legs: [legRow({ size_pct: 50 }), legRow({ size_pct: 50, tp_price: '3' })] }),
      row({ book: 'young_thirds_x2_x3_x4' }),
      row({ strategy: 'custom' }),
    ]);
    assert.deepEqual(out, []);
  });
  it('drops the whole position on any invalid field or leg', () => {
    const bad = [
      row({ status: 'closed' }),
      row({ book: 'other' }),
      row({ strategy: 'yolo' }),
      row({ mint: 'not-a-mint' }),
      row({ user_id: 'x' }),
      row({ stake_sol: '0' }),
      row({ sl_price: null }),
      row({ status: 'open' }), // open without fill
      row({ paper_legs: [] }),
      row({ paper_legs: null }),
      row({ paper_legs: [legRow({ tp_price: 'NaN' })] }),
      row({ paper_legs: [legRow({ status: 'tp_hit' })] }), // closed leg without exit
      row({ paper_legs: [legRow({ exit_price: '2' })] }), // open leg with an exit
      row({ paper_legs: [legRow({ status: 'cancelled' })] }),
      row({ paper_legs: [legRow(), legRow()] }), // all_x2 has ONE leg
      null,
      'x',
    ];
    assert.deepEqual(E!.parseEnginePositions(bad), []);
    assert.deepEqual(E!.parseEnginePositions(null), []);
  });
});

describe('fairOrder', { skip }, () => {
  it('round robin across users, each user oldest first, capped', () => {
    const items = [
      { user_id: USER, n: 'a1' }, { user_id: USER, n: 'a2' }, { user_id: USER, n: 'a3' },
      { user_id: USER2, n: 'b1' }, { user_id: USER3, n: 'c1' }, { user_id: USER3, n: 'c2' },
    ];
    assert.deepEqual(E!.fairOrder(items, 100).map((i) => i.n), ['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
    assert.deepEqual(E!.fairOrder(items, 4).map((i) => i.n), ['a1', 'b1', 'c1', 'a2']);
    assert.deepEqual(E!.fairOrder([], 4), []);
  });
});

describe('buildTicks', { skip }, () => {
  it('keeps the latest fresh snapshot per mint', () => {
    const t = E!.buildTicks([
      { mint: MINT, price_usd: '1.1', captured_at: iso(NOW - 4 * MIN) },
      { mint: MINT, price_usd: 1.2, captured_at: iso(NOW - MIN) },
      { mint: BONK, price_usd: 3, captured_at: iso(NOW - 2 * MIN) },
    ], NOW);
    assert.deepEqual(t.get(MINT), { price: 1.2, at: NOW - MIN });
    assert.equal(t.get(BONK)?.price, 3);
  });
  it('stale (> 6 min), future (> 1 min), invalid prices and mints give no tick', () => {
    const t = E!.buildTicks([
      { mint: MINT, price_usd: 1, captured_at: iso(NOW - 6 * MIN - 1) },
      { mint: BONK, price_usd: 1, captured_at: iso(NOW + 2 * MIN) },
      { mint: USDC, price_usd: 0, captured_at: iso(NOW) },
      { mint: 'bad', price_usd: 1, captured_at: iso(NOW) },
    ], NOW);
    assert.equal(t.size, 0);
  });
});

describe('buildTicks', { skip }, () => {
  it('keeps the latest fresh snapshot per mint', () => {
    const t = E!.buildTicks([
      { mint: MINT, price_usd: '1.1', captured_at: iso(NOW - 4 * MIN) },
      { mint: MINT, price_usd: 1.2, captured_at: iso(NOW - MIN) },
      { mint: BONK, price_usd: 3, captured_at: iso(NOW - 2 * MIN) },
    ], NOW);
    assert.deepEqual(t.get(MINT), { price: 1.2, at: NOW - MIN });
    assert.equal(t.get(BONK)?.price, 3);
  });
  it('stale (> 6 min), future (> 1 min), invalid prices and mints give no tick', () => {
    const t = E!.buildTicks([
      { mint: MINT, price_usd: 1, captured_at: iso(NOW - 6 * MIN - 1) },
      { mint: BONK, price_usd: 1, captured_at: iso(NOW + 2 * MIN) },
      { mint: USDC, price_usd: 0, captured_at: iso(NOW) },
      { mint: 'bad', price_usd: 1, captured_at: iso(NOW) },
    ], NOW);
    assert.equal(t.size, 0);
  });
});

describe('nextTickEntries (moved from young-wiring.ts)', { skip }, () => {
  const pos = (over: Record<string, unknown> = {}) => ({ id: 'p1', mint: MINT, status: 'pending', entry_mode: 'next_tick', created_at: iso(NOW - 3 * MIN), ...over });
  it('the EARLIEST fresh scan snapshot strictly after created_at, whatever the price', () => {
    const rows = [
      { mint: MINT, price_usd: '1.3', captured_at: iso(NOW - MIN) },
      { mint: MINT, price_usd: 1.1, captured_at: iso(NOW - 2 * MIN) },
      { mint: MINT, price_usd: 9, captured_at: iso(NOW - 3 * MIN) }, // at created_at: not after
    ];
    assert.deepEqual(E!.nextTickEntries(rows, [pos()], NOW, 6 * MIN).get('p1'), { price: 1.1, at: NOW - 2 * MIN, source: 'scan' });
  });
  it('only pending next_tick positions; stale / future / invalid rows ignored', () => {
    const rows = [{ mint: MINT, price_usd: 1, captured_at: iso(NOW - MIN) }];
    assert.equal(E!.nextTickEntries(rows, [pos({ entry_mode: 'target' })], NOW, 6 * MIN).size, 0);
    assert.equal(E!.nextTickEntries(rows, [pos({ status: 'open' })], NOW, 6 * MIN).size, 0);
    assert.equal(E!.nextTickEntries([{ mint: MINT, price_usd: 1, captured_at: iso(NOW - 7 * MIN) }], [pos({ created_at: iso(NOW - 8 * MIN) })], NOW, 6 * MIN).size, 0);
    assert.equal(E!.nextTickEntries([{ mint: MINT, price_usd: 0, captured_at: iso(NOW - MIN) }], [pos()], NOW, 6 * MIN).size, 0);
    assert.equal(E!.nextTickEntries('junk', [pos()], NOW, 6 * MIN).size, 0);
  });
});

describe('quote amounts', { skip }, () => {
  it('buy = the whole stake', () => {
    assert.equal(E!.buyLamports({ stake_sol: 0.5 }), 500_000_000n);
    assert.equal(E!.buyLamports({ stake_sol: 0 }), null);
  });
  it('sell = stake × size/100 × current / fill', () => {
    const p = open();
    assert.equal(E!.sellLamports(p, [p.legs[0].id], 2.1), 1_050_000_000n, '0.5 × 100 % × 2.1');
    assert.equal(E!.sellLamports(p, [], 1), null);
    assert.equal(E!.sellLamports(p, ['unknown'], 1), null);
    assert.equal(E!.sellLamports(pending(), [p.legs[0].id], 1), null, 'no fill price');
  });
});

describe('quoteCandidates', { skip }, () => {
  it('fill → buy of the stake; TP or SL → sell of the leg; exits first', () => {
    const fillMe = pending({ mint: USDC });
    const tp = open({ mint: MINT });
    const sl = open({ mint: BONK });
    const ticks = new Map([[USDC, tickAt(0.95)], [MINT, tickAt(2.1)], [BONK, tickAt(0.6)]]);
    const reqs = E!.quoteCandidates([fillMe, tp, sl], ticks, NOW);
    assert.deepEqual(reqs.map((r) => [r.kind, r.mint, r.lamports]), [
      ['sell', MINT, 1_050_000_000n],
      ['sell', BONK, 300_000_000n],
      ['buy', USDC, 500_000_000n],
    ]);
  });
  it('same mint + amount share one quote; no tick, expired or nothing to do → no quote', () => {
    const ticks = new Map([[MINT, tickAt(0.95)]]);
    assert.equal(E!.quoteCandidates([pending(), pending()], ticks, NOW).length, 1);
    assert.equal(E!.quoteCandidates([pending({ mint: BONK })], ticks, NOW).length, 0);
    assert.equal(E!.quoteCandidates([pending({ expires_at: iso(NOW - 1) })], ticks, NOW).length, 0);
    assert.equal(E!.quoteCandidates([open()], new Map([[MINT, tickAt(1.5)]]), NOW).length, 0);
  });
});

describe('tickForPosition', { skip }, () => {
  it('uses the impact quoted for THIS position amount, null (→ +2 %) otherwise', () => {
    const p = open();
    const impacts = new Map([[E!.quoteKey('sell', MINT, 1_050_000_000n), 3.4]]);
    const t = E!.tickForPosition(p, tickAt(2.1), impacts, NOW)!;
    assert.equal(t.sellImpactPct, 3.4);
    assert.equal(t.buyImpactPct, null);
    assert.equal(E!.tickForPosition(p, tickAt(0.6), impacts, NOW)!.sellImpactPct, null, 'other amount: not quoted');
    assert.equal(E!.tickForPosition(p, undefined, impacts, NOW), null);
  });
  it('end to end: a fill uses the quoted buy impact; without a quote step() applies +2 %', () => {
    const p = pending();
    const impacts = new Map([[E!.quoteKey('buy', MINT, 500_000_000n), 1.2]]);
    const s = step(p, E!.tickForPosition(p, tickAt(0.95), impacts, NOW), NOW);
    assert.equal(s.kind, 'fill');
    if (s.kind === 'fill') close(s.fill_price, 0.95 * 1.012);
    const d = step(p, E!.tickForPosition(p, tickAt(0.95), new Map(), NOW), NOW);
    if (d.kind === 'fill') close(d.fill_price, 0.95 * 1.02);
  });
});

describe('runQuotes', { skip }, () => {
  const buyReq = (mint: string, lamports: bigint) => ({ kind: 'buy' as const, mint, lamports, key: E!.quoteKey('buy', mint, lamports) });
  const sellReq = (mint: string, lamports: bigint) => ({ kind: 'sell' as const, mint, lamports, key: E!.quoteKey('sell', mint, lamports) });

  it('buy = 1 quote SOL → mint for the stake; sell = value quote then exact token amount back to SOL', async () => {
    const { fetchFn, calls } = mockJupiter((u) => {
      const inM = u.searchParams.get('inputMint')!;
      const outM = u.searchParams.get('outputMint')!;
      const amount = u.searchParams.get('amount')!;
      if (inM === SOL && outM === MINT) return { body: quote(SOL, MINT, amount, 123_456n, 0.012) };
      if (inM === SOL && outM === BONK) return { body: quote(SOL, BONK, amount, 999_000n, 0.001) };
      if (inM === BONK && outM === SOL) {
        assert.equal(amount, '999000', 'sells exactly the tokens received');
        return { body: quote(BONK, SOL, amount, 900_000_000n, 0.034) };
      }
      return { status: 400, body: '{}' };
    });
    const clock = fakeClock(NOW);
    const res = await E!.runQuotes([sellReq(BONK, 525_000_000n), buyReq(MINT, 500_000_000n)], {
      fetchFn, now: clock.now, sleep: clock.sleep, stopAt: NOW + 60_000, log: quiet,
    });
    assert.equal(res.calls, 3);
    assert.ok(calls.every((c) => c.startsWith('https://lite-api.jup.ag/swap/v1/quote?')));
    assert.equal(res.impacts.get(E!.quoteKey('sell', BONK, 525_000_000n)), 3.4);
    assert.equal(res.impacts.get(E!.quoteKey('buy', MINT, 500_000_000n)), 1.2);
    assert.deepEqual(clock.slept, [E!.QUOTE_GAP_MS, E!.QUOTE_GAP_MS], 'paced 2.1 s apart');
  });
  it('waits until startAt, respects maxCalls (a sell costs 2) and stopAt', async () => {
    const { fetchFn, calls } = mockJupiter((u) => ({ body: quote(SOL, u.searchParams.get('outputMint')!, u.searchParams.get('amount')!, 10n, 0.01) }));
    const clock = fakeClock(NOW);
    const reqs = [buyReq(MINT, 1_000_000n), sellReq(BONK, 2_000_000n), buyReq(USDC, 3_000_000n)];
    const res = await E!.runQuotes(reqs, { fetchFn, now: clock.now, sleep: clock.sleep, startAt: NOW + 10_000, stopAt: NOW + 60_000, maxCalls: 2, log: quiet });
    assert.equal(clock.slept[0], 10_000, 'first quote waits for startAt');
    assert.equal(res.calls, 1, 'the sell (2 calls) does not fit in the remaining budget');
    assert.equal(calls.length, 1);
    const late = fakeClock(NOW + 60_000);
    const none = await E!.runQuotes(reqs, { fetchFn, now: late.now, sleep: late.sleep, stopAt: NOW + 60_000, log: quiet });
    assert.equal(none.calls, 0);
  });
  it('stops at the first 429; invalid / mismatched quotes are null; never throws', async () => {
    let n = 0;
    const { fetchFn, calls } = mockJupiter((u) => {
      n++;
      if (n === 1) return { body: quote(SOL, USDC, u.searchParams.get('amount')!, 10n, 0.01) }; // wrong output mint
      if (n === 2) return { body: 'not json' };
      return { status: 429, body: '{}' };
    });
    const clock = fakeClock(NOW);
    const res = await E!.runQuotes([buyReq(MINT, 1n), buyReq(BONK, 2n), buyReq(MINT, 3n), buyReq(BONK, 4n)], {
      fetchFn, now: clock.now, sleep: clock.sleep, stopAt: NOW + 60_000, log: quiet,
    });
    assert.equal(res.rateLimited, true);
    assert.equal(calls.length, 3, 'nothing after the 429');
    assert.equal(res.impacts.get(E!.quoteKey('buy', MINT, 1n)), null);
    assert.equal(res.impacts.has(E!.quoteKey('buy', BONK, 4n)), false);
  });
  it('an aborted run signal makes no call', async () => {
    const { fetchFn, calls } = mockJupiter(() => ({ body: '{}' }));
    const ac = new AbortController();
    ac.abort();
    const res = await E!.runQuotes([buyReq(MINT, 1n)], { fetchFn, signal: ac.signal, stopAt: Date.now() + 60_000, log: quiet });
    assert.equal(res.calls, 0);
    assert.equal(calls.length, 0);
  });
});

describe('applyArgsV2 (paper_apply_v2 payloads)', { skip }, () => {
  const noImpact = (price: number) => ({ price, at: NOW - MIN, buyImpactPct: 0, sellImpactPct: 0 });

  it('fill: expected pending, leg re-based on the fill price, delta −(stake + entry fee + rent)', () => {
    const p = pending();
    const a = E!.applyArgsV2(p, step(p, { ...noImpact(0.95), buyImpactPct: 1.2 }, NOW))!;
    assert.equal(a.p_position, p.id);
    assert.equal(a.p_expected, 'pending');
    assert.equal(a.p_step.kind, 'fill');
    if (a.p_step.kind !== 'fill') return;
    const fill = 0.95 * 1.012;
    close(a.p_step.fill_price, fill);
    assert.equal(a.p_step.fees_sol, NETWORK_FEE_PER_TX_SOL);
    assert.deepEqual(a.p_step.legs.map((l) => l.id), p.legs.map((l) => l.id));
    close(a.p_step.legs[0].tp_price, fill * 2);
    close(a.p_step.legs[0].stop_price, fill * 0.7);
    close(a.p_delta, -(0.5 + NETWORK_FEE_PER_TX_SOL + TOKEN_ACCOUNT_RENT_SOL));
    assert.equal(E!.stepLabel(a), 'filled');
  });
  it('expire: expected pending, delta 0 (a pending position is only reserved)', () => {
    const p = pending({ expires_at: iso(NOW - 1) });
    assert.deepEqual(E!.applyArgsV2(p, step(p, noImpact(0.5), NOW)), { p_position: p.id, p_expected: 'pending', p_step: { kind: 'expire' }, p_delta: 0 });
  });
  it('TP: closes the position with its pnl and the rent back; replay is refused; Σ deltas = pnl', () => {
    const p = pending();
    const wallet = { balance: 1 };
    const fill = E!.applyArgsV2(p, step(p, noImpact(1), NOW))!;
    assert.equal(applyInMemory(p, wallet, fill), true);
    const a = E!.applyArgsV2(p, step(p, { ...noImpact(2.1), at: NOW, sellImpactPct: 3.4 }, NOW))!;
    assert.equal(a.p_expected, 'open');
    if (a.p_step.kind !== 'legs') return assert.fail('legs expected');
    assert.deepEqual(a.p_step.closes.map((c) => c.status), ['tp_hit']);
    close(a.p_step.closes[0].exit_price, 2.1 * 0.966);
    assert.deepEqual(a.p_step.moves, []);
    assert.equal(a.p_step.position_closed, true);
    close(a.p_delta, 0.5 * 2.1 * 0.966 / 1 - NETWORK_FEE_PER_TX_SOL + TOKEN_ACCOUNT_RENT_SOL);
    assert.equal(E!.stepLabel(a), 'closed');
    assert.equal(applyInMemory(p, wallet, a), true);
    assert.equal(applyInMemory(p, wallet, a), false, 'replay: already closed');
    close(wallet.balance - 1, a.p_step.pnl_sol!, 1e-11);
  });
  it('SL closes the position in one step; fill + close deltas = pnl', () => {
    const p = open();
    const a = E!.applyArgsV2(p, step(p, noImpact(0.6), NOW))!;
    if (a.p_step.kind !== 'legs') return assert.fail('legs expected');
    assert.deepEqual(a.p_step.closes.map((c) => c.status), ['sl_hit']);
    assert.equal(a.p_step.fees_sol, NETWORK_FEE_PER_TX_SOL);
    const fillDelta = -(0.5 + NETWORK_FEE_PER_TX_SOL + TOKEN_ACCOUNT_RENT_SOL);
    close(fillDelta + a.p_delta, a.p_step.pnl_sol!);
  });
  it('none, a step that does not match the status, or legs of another position → null (never sent)', () => {
    const p = pending();
    assert.equal(E!.applyArgsV2(p, { kind: 'none' }), null);
    assert.equal(E!.applyArgsV2(open(), { kind: 'expire' }), null);
    assert.equal(E!.applyArgsV2(p, { kind: 'fill', fill_price: 1, fees_sol: 0.0002, legs: [{ id: uuid(), tp_price: 2, stop_price: 0.7 }] }), null);
    const o = open();
    assert.equal(E!.applyArgsV2(o, { kind: 'legs', closes: [{ id: uuid(), status: 'tp_hit', exit_price: 2 }], moves: [], fees_sol: 0.0002, position_closed: true, pnl_sol: 0.1 }), null);
    assert.equal(E!.applyArgsV2(o, { kind: 'legs', closes: [], moves: [], fees_sol: 0, position_closed: false, pnl_sol: null }), null);
  });
  it('expiry wins over a fill once expires_at has passed', () => {
    const p = pending({ expires_at: iso(NOW) });
    assert.equal(E!.applyArgsV2(p, step(p, noImpact(0.5), NOW))?.p_step.kind, 'expire');
  });
  it('payload shape matches the paper_apply_v2 contract (no extra keys, JSON-safe numbers)', () => {
    const p = open();
    const a = E!.applyArgsV2(p, step(p, noImpact(2.1), NOW))!;
    assert.deepEqual(Object.keys(a).sort(), ['p_delta', 'p_expected', 'p_position', 'p_step']);
    assert.deepEqual(Object.keys(a.p_step).sort(), ['closes', 'fees_sol', 'kind', 'moves', 'pnl_sol', 'position_closed']);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
    assert.equal(walletDelta(step(p, noImpact(2.1), NOW), p) > 0, true);
  });
});

describe('forced tracking: paper_positions mints + buildTrackingBatch priority', { skip }, () => {
  const pos = (id: number, mint: string, sentAt: number): OpenPosition => ({
    id, userId: USER, mint, sentAt, entry: 1, target: 1.2, stop: 0.8, maxPrice: null, minPrice: null, firstHit: null, followupSentAt: null,
  });
  it('scan-tokens reads paper_positions (pending / open), not the frozen v1 table', { skip: SCAN_SRC === null ? 'no read permission' : undefined }, () => {
    const src = SCAN_SRC!;
    const body = src.slice(src.indexOf('async function loadPaperMints'), src.indexOf('interface TrackingStats'));
    assert.match(body, /\.from\('paper_positions'\)/);
    assert.match(body, /\.in\('status', \['pending', 'open'\]\)/);
    assert.doesNotMatch(src, /paper_orders/);
  });
  it('open positions, then pending entries, then alerts (newest first); closed / cancelled ignored', () => {
    const paper = E!.parsePaperMints([
      { mint: BONK, status: 'pending' },
      { mint: MINT, status: 'open' },
      { mint: MINT, status: 'pending' },
      { mint: 'bad', status: 'open' },
      { mint: USDC, status: 'closed' },
      { mint: USDC, status: 'cancelled' },
    ]);
    assert.deepEqual(paper, { open: [MINT], pending: [BONK] });
    const b = buildTrackingBatch([pos(1, USDC, NOW - MIN), pos(2, BONK, NOW)], new Set([USDC]), MAX_TRACKED_MINTS, paper);
    assert.deepEqual(b.tracked, [MINT, BONK, USDC]);
  });
  it('the ≤ 50 % share rule still holds (paper first pass capped at half, alerts the rest)', () => {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const gen = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => `${prefix}${alphabet[Math.floor(i / 58) % 58]}${alphabet[i % 58]}v`);
    const paperOpen = gen(60, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTD');
    const alerts = gen(60, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB');
    const b = buildTrackingBatch(alerts.map((m, i) => pos(i, m, NOW - i)), new Set(), MAX_TRACKED_MINTS, { open: paperOpen, pending: [] });
    assert.equal(b.tracked.length, MAX_TRACKED_MINTS);
    assert.deepEqual(b.tracked.slice(0, 50), paperOpen.slice(0, 50));
    assert.deepEqual(b.tracked.slice(50), alerts.slice(0, 50));
  });
});

describe('v1 → v2 data migration mapping (mirror of 20261118020000 section 5)', () => {
  const U1 = '11111111-1111-4111-8111-111111111111';
  const U2 = '22222222-2222-4222-8222-222222222222';
  const EXP = '2026-11-19T08:00:00.000Z';
  const o = (over: Partial<V1Order>): V1Order => ({
    id: uuid(), user_id: U1, mint: MINT, type: 'limit_entry', stake_sol: 0.05, entry_price: 1, tp_price: 2, sl_price: 0.7,
    status: 'pending', group_id: null, source: 'manual', expires_at: EXP, fill_price: null, exit_price: null, fees_sol: null,
    pnl_sol: null, ...over,
  });
  // Same scenarios as the local SQL run of the migration (seed_v1.sql in the scratchpad).
  const G = (n: string) => `${n.repeat(8)}-0000-4000-8000-00000000000${n}`;
  const orders: V1Order[] = [
    o({ id: 'a1', group_id: G('a'), source: 'auto', entry_price: 0.1, tp_price: 0.2, sl_price: 0.07 }),
    o({ id: 'a2', group_id: G('a'), source: 'auto', entry_price: 0.1, tp_price: 0.30000000000000004, sl_price: 0.07 }),
    o({ id: 'b1', group_id: G('b'), type: 'market', stake_sol: 0.1, status: 'open', fill_price: 1.02, fees_sol: 0.0002 }),
    o({ id: 'b2', group_id: G('b'), type: 'market', stake_sol: 0.1, tp_price: 3, status: 'open', fill_price: 1.02, fees_sol: 0.0002 }),
    o({ id: 'c1', group_id: G('c'), mint: BONK, stake_sol: 0.1, status: 'tp_hit', fill_price: 1, exit_price: 1.96, fees_sol: 0.0004, pnl_sol: 0.0976 }),
    o({ id: 'c2', group_id: G('c'), mint: BONK, stake_sol: 0.1, tp_price: 3, status: 'open', fill_price: 1, fees_sol: 0.0002 }),
    o({ id: 'd1', mint: BONK, stake_sol: 0.02, entry_price: 0.9, tp_price: 5, sl_price: 0.5 }),
    o({ id: 'e1', user_id: U2, group_id: G('e'), type: 'market', stake_sol: 0.2, status: 'tp_hit', fill_price: 1, exit_price: 1.96, fees_sol: 0.0004, pnl_sol: 0.1916 }),
    o({ id: 'e2', user_id: U2, group_id: G('e'), type: 'market', stake_sol: 0.2, tp_price: 3, status: 'sl_hit', fill_price: 1, exit_price: 0.68, fees_sol: 0.0004, pnl_sol: -0.0644 }),
    o({ id: 'f1', user_id: U2, group_id: G('f'), entry_price: 0.5, tp_price: 1, sl_price: 0.35 }),
    o({ id: 'f2', user_id: U2, group_id: G('f'), entry_price: 0.5, tp_price: 1.5, sl_price: 0.35, status: 'cancelled' }),
    o({ id: 'g1', user_id: U2, mint: BONK, type: 'market', stake_sol: 0.01, entry_price: null, tp_price: null, sl_price: null, status: 'expired' }),
  ];
  const { positions, legs, credits } = migrateV1Orders(orders, () => 1);
  const byId = new Map(positions.map((p) => [p.id, p]));

  it('every order becomes exactly one leg (leg id = order id); stakes are preserved', () => {
    assert.equal(legs.length, orders.length);
    assert.deepEqual(legs.map((l) => l.id).sort(), orders.map((x) => x.id).sort());
    close(positions.reduce((a, p) => a + p.stake_sol, 0), orders.reduce((a, x) => a + x.stake_sol, 0));
    assert.equal(positions.length, 8);
  });
  it('default-strategy groups merge into half_x2_rest_x3 (2 × 50 %, id = group_id); status mapping', () => {
    assert.deepEqual(
      [G('a'), G('b'), G('c'), G('e')].map((k) => [byId.get(k)!.strategy, byId.get(k)!.status]),
      [['half_x2_rest_x3', 'pending'], ['half_x2_rest_x3', 'open'], ['half_x2_rest_x3', 'open'], ['half_x2_rest_x3', 'closed']],
    );
    assert.ok(legs.filter((l) => l.position_id === G('c')).every((l) => l.size_pct === 50));
    assert.deepEqual(legs.filter((l) => l.position_id === G('c')).map((l) => l.status), ['tp_hit', 'open'], 'half already at TP stays closed');
    close(byId.get(G('e'))!.pnl_sol!, 0.1272);
    close(byId.get(G('c'))!.fees_sol!, 0.0006);
    assert.equal(byId.get(G('c'))!.pnl_sol, null, 'still open: no pnl yet');
    assert.equal(byId.get(G('a'))!.source, 'auto_alert');
  });
  it('anything else becomes one custom position per order (100 %), missing levels get never-reached sentinels', () => {
    assert.equal(byId.get('d1')!.strategy, 'custom');
    assert.equal(byId.get('d1')!.custom_tp_price, 5);
    close(byId.get('d1')!.sl_pct, 44.444444);
    assert.deepEqual([byId.get('f1')!.status, byId.get('f2')!.status], ['pending', 'cancelled'], 'pending + cancelled group is split');
    const g = byId.get('g1')!;
    assert.deepEqual([g.status, g.entry_target_price, g.sl_price, g.custom_tp_price, g.sl_pct], ['expired', 1, NO_SL, NO_TP, 30]);
    assert.deepEqual(legs.find((l) => l.id === 'g1'), { id: 'g1', position_id: 'g1', size_pct: 100, tp_price: NO_TP, stop_price: NO_SL, status: 'open', exit_price: null });
  });
  it('rent credit: only merged groups whose two halves are still open (v1 locked 2 rents, v2 returns 1)', () => {
    assert.deepEqual([...credits], [[U1, 0.00204]]);
  });
  it('SQL review: the migration implements the same rules', { skip: MIGRATION_SQL === null ? 'no read permission' : undefined }, () => {
    const sql = MIGRATION_SQL!;
    for (const fragment of [
      'count(*) = 2',
      'round(min(tp_price / entry_price), 6) = 2 and round(max(tp_price / entry_price), 6) = 3',
      "when bool_and(o.status = 'pending') then 'pending'",
      "when bool_or(o.status = 'open') then 'open'",
      "case when m.merged then 50 else 100 end",
      "case when min(o.source) = 'auto' then 'auto_alert' else 'manual' end",
      'coalesce(o.tp_price, 1e11)',
      'coalesce(o.sl_price, 1e-12)',
      'set balance_sol = w.balance_sol + 0.00204 * x.groups',
      'alter table public.paper_orders rename to paper_orders_v1',
      'revoke all on public.paper_orders_v1 from anon, authenticated',
      "raise exception 'paper v2 data migration incomplete",
    ]) {
      assert.ok(sql.includes(fragment), `missing in SQL: ${fragment}`);
    }
    // No literal invisible / bidi characters in the migration (the symbol check uses \\u escapes).
    assert.doesNotMatch(sql, /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/);
  });
});

describe('buildTrackingBatch — alert positions keep their slots (review M1)', () => {
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const mintN = (n: number): string => {
    const bytes = new Uint8Array(32);
    bytes[0] = 1 + (n % 200);
    bytes[1] = Math.floor(n / 200) % 256;
    for (let i = 2; i < 32; i++) bytes[i] = (n * 31 + i * 7) % 256;
    let num = 0n;
    for (const b of bytes) num = num * 256n + BigInt(b);
    let out = '';
    while (num > 0n) { out = ALPHA[Number(num % 58n)] + out; num /= 58n; }
    return out;
  };
  const paper = Array.from({ length: 80 }, (_, i) => mintN(1000 + i));
  const alerts = Array.from({ length: 40 }, (_, i) => ({ mint: mintN(5000 + i), sentAt: 1_000 + i }));

  it('caps paper mints at half the batch and keeps every alert position', () => {
    const b = buildTrackingBatch(alerts as never, new Set(), 100, { open: paper, pending: [] });
    assert.equal(b.tracked.length, 100);
    for (const a of alerts) assert.ok(b.tracked.includes(a.mint), 'alert mint evicted');
    assert.equal(b.tracked.filter((m) => paper.includes(m)).length, 60, '50 reserved + 10 refilled');
  });
  it('gives paper mints the unused slots when there are few alerts', () => {
    const b = buildTrackingBatch(alerts.slice(0, 5) as never, new Set(), 100, { open: paper, pending: [] });
    assert.equal(b.tracked.length, 85);
    assert.equal(b.tracked.filter((m) => paper.includes(m)).length, 80);
  });
});

describe('« Calme » / « Frénésie » auto-paper (feat/calm-sl-test)', { skip }, () => {
  it('books: main + the three test books open; calm_all_x2 / frenzy_all_x2 archived but still run by the engine', () => {
    assert.deepEqual(E!.BOOKS, ['main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30', 'calm_all_x2', 'frenzy_all_x2']);
    assert.deepEqual(E!.OPEN_BOOKS, ['main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30']);
    assert.deepEqual(E!.CALM_FRENZY_BOOKS, ['calm_sl30', 'calm_sl40', 'frenzy_sl30']);
    assert.deepEqual(E!.ARCHIVED_CALM_FRENZY_BOOKS, ['calm_all_x2', 'frenzy_all_x2']);
    assert.deepEqual(E!.CALM_BOOKS, ['calm_sl30', 'calm_sl40']);
    assert.equal(E!.isCalmFrenzyBook('calm_sl40'), true);
    assert.equal(E!.isCalmFrenzyBook('calm_all_x2'), false, 'archived');
    assert.equal(E!.isCalmFrenzyBook('main'), false);
  });
  it('the alert guard reads the calm books (preset-alerts.ts mirror)', async () => {
    const { ALERT_GUARD_BOOKS } = await import('./preset-alerts');
    assert.deepEqual([...ALERT_GUARD_BOOKS], [...E!.CALM_BOOKS]);
  });
  it('archived-book positions still parse (run to completion)', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: uuid(), user_id: USER, book: 'main', mint: MINT, strategy: 'all_x2', status: 'pending', stake_sol: '0.1',
      entry_target_price: '1', fill_price: null, sl_price: '0.7', created_at: iso(NOW - MIN), filled_at: null,
      expires_at: iso(NOW + 3_600_000), ...over,
      paper_legs: [{ id: uuid(), size_pct: 100, tp_price: '2', status: 'open', stop_price: '0.7', exit_price: null, closed_at: null }],
    });
    const out = E!.parseEnginePositions([
      row({ book: 'calm_all_x2', entry_mode: 'next_tick' }),
      row({ book: 'calm_sl40', entry_mode: 'next_tick' }),
      row({ book: 'young_all_x2' }),
    ]);
    assert.deepEqual(out.map((p) => p.book), ['calm_all_x2', 'calm_sl40']);
  });
  it('calmFrenzyPlans: calm → calm_sl30 (SL 30) + calm_sl40 (SL 40); frenzy → frenzy_sl30 (SL 30); 0.1 SOL, next_tick', () => {
    assert.deepEqual(E!.calmFrenzyPlans({ mint: MINT, price_usd: 1.5 }, 'young_calm'), [
      { book: 'calm_sl30', strategy: 'all_x2', stake_sol: 0.1, entry: 1.5, sl_pct: 30, entry_mode: 'next_tick' },
      { book: 'calm_sl40', strategy: 'all_x2', stake_sol: 0.1, entry: 1.5, sl_pct: 40, entry_mode: 'next_tick' },
    ]);
    assert.deepEqual(E!.calmFrenzyPlans({ mint: MINT, price_usd: 1 }, 'young_frenzy'), [
      { book: 'frenzy_sl30', strategy: 'all_x2', stake_sol: 0.1, entry: 1, sl_pct: 30, entry_mode: 'next_tick' },
    ]);
    const args = E!.openPositionArgs(USER, MINT, E!.calmFrenzyPlans({ mint: MINT, price_usd: 1 }, 'young_calm')[1], null);
    assert.equal(args?.p_book, 'calm_sl40');
    assert.equal(args?.p_sl_pct, 40);
    assert.equal(args?.p_entry_mode, 'next_tick');
    assert.equal(args?.p_alert_id, null);
  });
  it('calmFrenzyPlans: unusable input → []', () => {
    assert.deepEqual(E!.calmFrenzyPlans({ mint: 'bad', price_usd: 1 }, 'young_calm'), []);
    assert.deepEqual(E!.calmFrenzyPlans({ mint: MINT, price_usd: 0 }, 'young_calm'), []);
    assert.deepEqual(E!.calmFrenzyPlans({ mint: MINT, price_usd: null }, 'young_frenzy'), []);
    assert.deepEqual(E!.calmFrenzyPlans({ mint: MINT, price_usd: 1 }, 'momentum' as never), []);
    assert.deepEqual(E!.calmFrenzyPlans({ mint: MINT, price_usd: 6e11 }, 'young_calm'), [], 'TP ×2 not storable');
  });
  it('calmFrenzyOpenings: every auto-paper user × match × book; only a pending / open position of the same book blocks', () => {
    const matches = [
      { preset: 'young_calm' as const, token: { mint: MINT, price_usd: 1 } },
      { preset: 'young_frenzy' as const, token: { mint: BONK, price_usd: 2 } },
    ];
    const key = (o: { user_id: string; plan: { book: string }; mint: string }) => `${o.user_id}|${o.plan.book}|${o.mint}`;
    const all = E!.calmFrenzyOpenings(matches, [USER, USER2], [], NOW);
    assert.deepEqual(all.map(key), [
      `${USER}|calm_sl30|${MINT}`, `${USER}|calm_sl40|${MINT}`, `${USER2}|calm_sl30|${MINT}`, `${USER2}|calm_sl40|${MINT}`,
      `${USER}|frenzy_sl30|${BONK}`, `${USER2}|frenzy_sl30|${BONK}`,
    ]);
    const existing = [
      // closed by TP / expired / cancelled: reopening allowed
      { user_id: USER, book: 'calm_sl30', mint: MINT, status: 'closed', paper_legs: [{ status: 'tp_hit', closed_at: iso(NOW - MIN) }] },
      { user_id: USER2, book: 'frenzy_sl30', mint: BONK, status: 'expired' },
      { user_id: USER2, book: 'calm_sl30', mint: MINT, status: 'cancelled', paper_legs: [] },
      // active in calm_sl40 for USER: blocks calm_sl40 only
      { user_id: USER, book: 'calm_sl40', mint: MINT, status: 'open', paper_legs: [{ status: 'open', closed_at: null }] },
      // pending in frenzy_sl30 for USER
      { user_id: USER, book: 'frenzy_sl30', mint: BONK, status: 'pending', paper_legs: [] },
      // another book (main) never blocks the test books
      { user_id: USER2, book: 'main', mint: MINT, status: 'open', paper_legs: [] },
    ];
    assert.deepEqual(E!.calmFrenzyOpenings(matches, [USER, USER2], existing, NOW).map(key), [
      `${USER}|calm_sl30|${MINT}`, `${USER2}|calm_sl30|${MINT}`, `${USER2}|calm_sl40|${MINT}`, `${USER2}|frenzy_sl30|${BONK}`,
    ]);
    // Unreadable status = treated as active (fail safe).
    assert.deepEqual(
      E!.calmFrenzyOpenings([matches[1]], [USER], [{ user_id: USER, book: 'frenzy_sl30', mint: BONK, status: 'weird' }], NOW),
      [],
    );
    // The same match twice in one scan opens once per book; invalid users ignored.
    assert.equal(E!.calmFrenzyOpenings([matches[0], matches[0]], [USER, 'nope', USER], [], NOW).length, 2);
  });
  it('calmFrenzyOpenings: 12 h cooldown after a stop on the mint IN THE SAME BOOK (unreadable date = recent)', () => {
    const m = [{ preset: 'young_calm' as const, token: { mint: MINT, price_usd: 1 } }];
    const stop = (closedAt: string, book = 'calm_sl30') => [
      { user_id: USER, book, mint: MINT, status: 'closed', paper_legs: [{ status: 'sl_hit', closed_at: closedAt }] },
    ];
    const books = (rows: unknown) => E!.calmFrenzyOpenings(m, [USER], rows, NOW).map((o) => o.plan.book);
    assert.deepEqual(books(stop(iso(NOW - 11 * 60 * MIN))), ['calm_sl40'], 'calm_sl40 not kept out by the calm_sl30 stop');
    assert.deepEqual(books(stop(iso(NOW - 12 * 60 * MIN))), ['calm_sl30', 'calm_sl40']);
    assert.deepEqual(books(stop('garbage')), ['calm_sl40']);
    assert.deepEqual(books(stop(iso(NOW - MIN), 'main')), ['calm_sl30', 'calm_sl40'], 'a main stop does not block');
    assert.equal(E!.calmFrenzyOpenings(m, [USER2], stop(iso(NOW - MIN)), NOW).length, 2, 'other user unaffected');
  });
  it('calmFrenzyOpenings: never throws on junk', () => {
    assert.deepEqual(E!.calmFrenzyOpenings(null as never, [USER], null, NOW), []);
    assert.deepEqual(E!.calmFrenzyOpenings([null as never], [USER], 'x', NOW), []);
  });
});

