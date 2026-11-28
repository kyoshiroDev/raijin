// label-outcomes: GeckoTerminal OHLCV history (plan, URL, parsing of recorded real responses, pagination, 429/404,
// fixed host / address validation). fetch is mocked: no network.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test` (zod shim below).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupZodForNode } from './test-support/zod-node';
import { GECKO_404, GECKO_OHLCV_15M, GECKO_OHLCV_1H_BEFORE } from './test-support/x3-fixtures';
import type { Candle } from './types';

const zodReady = setupZodForNode();
const G = require('./gecko-history') as typeof import('./gecko-history');

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const H = 3_600_000;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

interface Call {
  url: string;
  init?: RequestInit;
}
function mockFetch(handler: (url: URL, n: number) => { status?: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const fetchFn = (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, init });
    const r = handler(new URL(input), calls.length);
    if (r instanceof Error) return Promise.reject(r);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return Promise.resolve(new Response(body, { status: r.status ?? 200 }));
  };
  return { fetchFn, calls };
}
const page = (rows: unknown[]) => ({ data: { attributes: { ohlcv_list: rows } } });
/** `n` 15-min candles, newest first, the oldest opening at `oldestSec`. */
function candles15(oldestSec: number, n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => [oldestSec + (n - 1 - i) * 900, 1, 2, 0.5, 1.5, 10] as Candle);
}

describe('gecko-history', { skip: !zodReady && 'zod not found in node_modules/.pnpm' }, () => {
  const g = G as NonNullable<typeof G>;

  describe('planCandles', () => {
    const det = Date.UTC(2026, 10, 17, 10, 7);
    it('15-minute candles under 48 h, from the candle containing the detection', () => {
      const p = g.planCandles(det, det + 6 * H);
      assert.ok(p);
      assert.equal(p.timeframe, 'minute');
      assert.equal(p.aggregate, 15);
      assert.equal(p.fromSec, Date.UTC(2026, 10, 17, 10, 0) / 1000);
      assert.equal(p.limit, Math.ceil((p.toSec - p.fromSec) / 900) + 1);
    });
    it('15-minute candles over the whole 7-day window (one request), window capped at 7 days', () => {
      const p = g.planCandles(det, det + 48 * H);
      assert.equal(p?.timeframe, 'minute');
      const late = g.planCandles(det, det + 30 * 24 * H);
      assert.equal(late?.timeframe, 'minute');
      assert.equal(late?.aggregate, 15);
      assert.equal(late?.toSec, Math.floor((det + 168 * H) / 1000));
      assert.ok((late?.limit ?? 0) <= 674 && (late?.limit ?? 0) <= 1000);
    });
    it('rejects invalid times and detections in the future', () => {
      assert.equal(g.planCandles(Number.NaN, det), null);
      assert.equal(g.planCandles(det, det - 1), null);
      assert.equal(g.planCandles(0, det), null);
    });
  });

  describe('buildOhlcvUrl', () => {
    const plan = g.planCandles(Date.UTC(2026, 10, 17), Date.UTC(2026, 10, 17, 6)) as NonNullable<ReturnType<typeof g.planCandles>>;
    it('fixed host, pool path, token priced in USD, optional before_timestamp', () => {
      const u = new URL(g.buildOhlcvUrl(PAIR, MINT, plan, 1794892500) as string);
      assert.equal(u.origin, 'https://api.geckoterminal.com');
      assert.equal(u.pathname, `/api/v2/networks/solana/pools/${PAIR}/ohlcv/minute`);
      assert.equal(u.searchParams.get('aggregate'), '15');
      assert.equal(u.searchParams.get('token'), MINT);
      assert.equal(u.searchParams.get('currency'), 'usd');
      assert.equal(u.searchParams.get('before_timestamp'), '1794892500');
      assert.equal(new URL(g.buildOhlcvUrl(PAIR, MINT, plan) as string).searchParams.has('before_timestamp'), false);
    });
    it('refuses anything that is not a Solana address (no URL injection)', () => {
      for (const bad of ['../x', `${PAIR}?x=1`, 'evil.com', '', `${PAIR}/../../x`]) {
        assert.equal(g.buildOhlcvUrl(bad, MINT, plan), null, bad);
        assert.equal(g.buildOhlcvUrl(PAIR, bad, plan), null, bad);
      }
    });
  });

  describe('parseOhlcv (real responses)', () => {
    it('returns the candles oldest first', () => {
      const c = g.parseOhlcv(GECKO_OHLCV_15M);
      assert.equal(c?.length, 3);
      assert.deepEqual(c?.map((x) => x[0]), [1794890700, 1794891600, 1794892500]);
      assert.equal(c?.[0][2], 0.00112273329527967);
      assert.equal(g.parseOhlcv(GECKO_OHLCV_1H_BEFORE)?.length, 2);
    });
    it('drops bad rows one by one, rejects a bad envelope', () => {
      const body = clone(GECKO_OHLCV_15M) as { data: { attributes: { ohlcv_list: unknown[] } } };
      body.data.attributes.ohlcv_list.push(
        [1794880000, 1, 2, 0, 1, 1], // low 0
        [1794880900, 1, 1, 2, 1, 1], // high < low
        [1794881800, 'NaN', 2, 1, 1, 1],
        [1794882700, 1, 2],
        ['1794883600', 1, 2, 1, 1, 1],
        [1794884500, '1.5', '2', '1', '1.2', '3'], // numeric strings are fine
      );
      const c = g.parseOhlcv(body);
      assert.equal(c?.length, 4);
      assert.equal(c?.[0][1], 1.5);
      assert.equal(g.parseOhlcv(GECKO_404), null);
      assert.equal(g.parseOhlcv(null), null);
      assert.equal(g.parseOhlcv({ data: { attributes: { ohlcv_list: 'x' } } }), null);
    });
    it('mergeCandles dedupes by open time and sorts', () => {
      const a: Candle[] = [[2, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1]];
      const b: Candle[] = [[2, 9, 9, 9, 9, 9], [0, 1, 1, 1, 1, 1]];
      assert.deepEqual(g.mergeCandles([a, b]).map((c) => [c[0], c[1]]), [[0, 1], [1, 1], [2, 1]]);
    });
  });

  describe('fetchCandleHistory (mocked fetch)', () => {
    const det = 1794890700 * 1000 + 60_000; // inside the oldest candle of the fixture
    const now = 1794892500 * 1000 + 600_000;

    it('one request when the page is short, candles from the detection candle on', async () => {
      const { fetchFn, calls } = mockFetch(() => ({ body: GECKO_OHLCV_15M }));
      const h = await g.fetchCandleHistory(PAIR, MINT, det, now, { fetchFn });
      assert.equal(h.status, 'ok');
      assert.equal(h.calls, 1);
      assert.equal(calls.length, 1);
      assert.deepEqual(h.candles.map((c) => c[0]), [1794890700, 1794891600, 1794892500]);
      assert.equal(calls[0].init?.redirect, 'error');
      assert.ok(calls[0].init?.signal, 'timeout signal');
      assert.match(calls[0].url, /^https:\/\/api\.geckoterminal\.com\/api\/v2\/networks\/solana\/pools\//);
    });

    it('pages back with before_timestamp until the detection is reached', async () => {
      const detection = Date.UTC(2026, 10, 17, 0, 0);
      const nowMs = detection + 6 * H;
      const plan = g.planCandles(detection, nowMs) as NonNullable<ReturnType<typeof g.planCandles>>;
      const fromSec = plan.fromSec;
      // Page 1: a FULL page (plan.limit candles) whose oldest is still after the detection → page 2 needed.
      const p1 = candles15(fromSec + 4 * 900, plan.limit);
      const p2 = candles15(fromSec - 2 * 900, 7); // overlaps p1 by one candle, goes before the detection
      let waits = 0;
      const { fetchFn, calls } = mockFetch((_u, n) => ({ body: page(n === 1 ? p1 : p2) }));
      const h = await g.fetchCandleHistory(PAIR, MINT, detection, nowMs, {
        fetchFn,
        beforeRequest: () => {
          waits++;
          return Promise.resolve();
        },
      });
      assert.equal(h.status, 'ok');
      assert.equal(calls.length, 2);
      assert.equal(waits, 1, 'pacing hook before the 2nd request only');
      assert.equal(new URL(calls[1].url).searchParams.get('before_timestamp'), String(fromSec + 4 * 900));
      assert.equal(h.candles[0][0], fromSec, 'candles before the detection candle are dropped');
      const ts = h.candles.map((c) => c[0]);
      assert.equal(new Set(ts).size, ts.length, 'no duplicate');
      assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
    });

    it('a closed window (detection > 7 days ago) starts at the window end, 15-minute candles', async () => {
      const detection = Date.UTC(2026, 10, 1, 10, 30);
      const nowMs = Date.UTC(2026, 10, 17, 12, 0);
      const plan = g.planCandles(detection, nowMs) as NonNullable<ReturnType<typeof g.planCandles>>;
      const { fetchFn, calls } = mockFetch(() => ({ body: page([[plan.fromSec + 900, 1, 3.5, 0.9, 1, 1]]) }));
      const h = await g.fetchCandleHistory(PAIR, MINT, detection, nowMs, { fetchFn });
      assert.equal(h.status, 'ok');
      assert.equal(calls.length, 1);
      const u = new URL(calls[0].url);
      assert.match(u.pathname, /\/ohlcv\/minute$/);
      assert.equal(u.searchParams.get('aggregate'), '15');
      assert.equal(u.searchParams.get('before_timestamp'), String(plan.toSec + 900));
      assert.equal(plan.toSec, (detection + 168 * H) / 1000);
    });
    it('stops after maxPages even if the detection is not reached', async () => {
      const detection = Date.UTC(2026, 10, 17, 0, 0);
      const nowMs = detection + 6 * H;
      const plan = g.planCandles(detection, nowMs) as NonNullable<ReturnType<typeof g.planCandles>>;
      let oldest = plan.fromSec + 400 * 900;
      const { fetchFn, calls } = mockFetch(() => {
        oldest -= plan.limit * 900;
        return { body: page(candles15(oldest + 200 * 900, plan.limit)) };
      });
      const h = await g.fetchCandleHistory(PAIR, MINT, detection, nowMs, { fetchFn, maxPages: 2 });
      assert.equal(h.status, 'ok');
      assert.equal(calls.length, 2);
    });

    it('429 → rate_limited (no candles), 404 → not_found, 5xx / bad JSON / rejection → error', async () => {
      const r429 = await g.fetchCandleHistory(PAIR, MINT, det, now, { fetchFn: mockFetch(() => ({ status: 429, body: '{}' })).fetchFn });
      assert.equal(r429.status, 'rate_limited');
      assert.deepEqual(r429.candles, []);
      const r404 = await g.fetchCandleHistory(PAIR, MINT, det, now, { fetchFn: mockFetch(() => ({ status: 404, body: GECKO_404 })).fetchFn });
      assert.equal(r404.status, 'not_found');
      assert.match(r404.error ?? '', /404/);
      for (const f of [
        mockFetch(() => ({ status: 500, body: '{}' })),
        mockFetch(() => ({ body: '<html>' })),
        mockFetch(() => ({ body: { data: null } })),
        mockFetch(() => new Error('timeout')),
      ]) {
        const r = await g.fetchCandleHistory(PAIR, MINT, det, now, { fetchFn: f.fetchFn });
        assert.equal(r.status, 'error');
        assert.ok(r.error && r.error.length <= 200 && !/https?:/.test(r.error), 'short reason, no URL');
      }
    });

    it('never calls fetch for invalid addresses, times or an aborted run', async () => {
      const { fetchFn, calls } = mockFetch(() => ({ body: GECKO_OHLCV_15M }));
      assert.equal((await g.fetchCandleHistory('../x', MINT, det, now, { fetchFn })).status, 'invalid');
      assert.equal((await g.fetchCandleHistory(PAIR, 'nope', det, now, { fetchFn })).status, 'invalid');
      assert.equal((await g.fetchCandleHistory(PAIR, MINT, now, det, { fetchFn })).status, 'invalid');
      const ac = new AbortController();
      ac.abort();
      assert.equal((await g.fetchCandleHistory(PAIR, MINT, det, now, { fetchFn, signal: ac.signal })).status, 'error');
      assert.equal(calls.length, 0);
    });
  });
});
