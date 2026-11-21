// enrich-tokens: zod schemas against recorded real responses, round-trip math, RugCheck dangers, Gecko multi,
// fixed hosts / mint validation / never-throw behaviour of the clients (fetch is mocked: no network).
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test` (zod shim below).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupZodForNode } from './test-support/zod-node.ts';
import {
  GECKO_MULTI,
  JUP_BUY,
  JUP_NOT_TRADABLE,
  JUP_SEARCH_USDPRICE,
  JUP_SELL,
  RUG_CLEAN,
  RUG_DANGER,
  RUG_INVALID_MINT,
  RUG_REPORT_CLEAN,
  RUG_REPORT_INSIDERS,
  RUG_WARN,
} from './test-support/enrich-fixtures.ts';

const zodReady = await setupZodForNode();
const S = zodReady ? await import('./enrich-schemas.ts') : null;
const C = zodReady ? await import('./enrich-clients.ts') : null;
const J = zodReady ? await import('./schemas.ts') : null;

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BONK_PAIR = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';
const SOL = 'So11111111111111111111111111111111111111112';
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const quiet = () => undefined;

interface Call {
  url: string;
  init?: RequestInit;
}
/** Mock fetch: answers with `handler(url)`; records every call. */
function mockFetch(handler: (url: URL) => { status?: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const fetchFn = (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, init });
    const r = handler(new URL(input));
    if (r instanceof Error) return Promise.reject(r);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return Promise.resolve(new Response(body, { status: r.status ?? 200 }));
  };
  return { fetchFn, calls };
}

if (!zodReady || !S || !C || !J) {
  it('enrich schemas/clients (skipped: zod not resolvable under node — run `deno test supabase/functions`)', { skip: true }, () => {});
} else {
  describe('JupQuoteSchema (real lite-api swap/v1 responses)', () => {
    it('parses the recorded buy and sell legs', () => {
      const buy = S.JupQuoteSchema.parse(JUP_BUY);
      assert.equal(buy.inputMint, SOL);
      assert.equal(buy.outputMint, MINT);
      assert.equal(buy.inAmount, '100000000');
      assert.equal(buy.outAmount, '4289987600');
      assert.ok(Math.abs(buy.priceImpactPct - 0.0069193663175585) < 1e-12);
      const sell = S.JupQuoteSchema.parse(JUP_SELL);
      assert.equal(sell.inAmount, buy.outAmount);
      assert.equal(sell.outAmount, '98242777');
    });
    it('rejects the error body and malformed amounts / impacts', () => {
      assert.equal(S.JupQuoteSchema.safeParse(JUP_NOT_TRADABLE).success, false);
      for (const bad of ['-5', '1e9', '12.5', '', '9'.repeat(31)]) {
        assert.equal(S.JupQuoteSchema.safeParse({ ...clone(JUP_BUY), outAmount: bad }).success, false, bad);
      }
      assert.equal(S.JupQuoteSchema.safeParse({ ...clone(JUP_BUY), outAmount: 4289987600 }).success, false);
      assert.equal(S.JupQuoteSchema.safeParse({ ...clone(JUP_BUY), priceImpactPct: 'abc' }).success, false);
      assert.equal(S.JupQuoteSchema.safeParse({ ...clone(JUP_BUY), inputMint: undefined }).success, false);
      assert.equal(S.JupQuoteSchema.safeParse(null).success, false);
      assert.equal(S.JupQuoteSchema.safeParse([JUP_BUY]).success, false);
    });
  });

  describe('RugCheck summary (real responses)', () => {
    it('extracts score, LP locked and danger names', () => {
      assert.deepEqual(C.parseRugSummary(RUG_DANGER), {
        lpLockedPct: 100,
        score: 33601,
        dangers: ['Creator history of rugged tokens'],
        insidersDetected: null,
        creatorRugHistory: true,
      });
    });
    it('keeps a clean report (no danger) and ignores warn-level risks', () => {
      assert.deepEqual(C.parseRugSummary(RUG_CLEAN), {
        lpLockedPct: 99.9971,
        score: 1,
        dangers: [],
        insidersDetected: null,
        creatorRugHistory: false,
      });
      assert.deepEqual(C.parseRugSummary(RUG_WARN)?.dangers, []);
      assert.equal(C.parseRugSummary(RUG_WARN)?.score, 101);
    });
    it('returns null for the error body and non-objects', () => {
      assert.equal(C.parseRugSummary(RUG_INVALID_MINT), null);
      assert.equal(C.parseRugSummary(null), null);
      assert.equal(C.parseRugSummary('oops'), null);
    });
    it('drops invalid fields one by one instead of the whole report', () => {
      const r = C.parseRugSummary({ ...clone(RUG_DANGER), lpLockedPct: 150, score: 'NaN' });
      assert.deepEqual(r, {
        lpLockedPct: null,
        score: null,
        dangers: ['Creator history of rugged tokens'],
        insidersDetected: null,
        creatorRugHistory: true,
      });
      assert.deepEqual(C.parseRugSummary({ ...clone(RUG_CLEAN), risks: 'nope' })?.dangers, []);
      assert.equal(C.parseRugSummary({ ...clone(RUG_CLEAN), risks: 'nope' })?.creatorRugHistory, null);
    });
    it('creator history is detected at any level, insiders only from an explicit risk', () => {
      const warn = { ...clone(RUG_CLEAN), risks: [{ name: 'Creator history of rugged tokens', level: 'warn' }] };
      assert.equal(C.parseRugSummary(warn)?.creatorRugHistory, true);
      assert.deepEqual(C.parseRugSummary(warn)?.dangers, []);
      const ins = { ...clone(RUG_CLEAN), risks: [{ name: 'Insiders detected', level: 'warn' }] };
      assert.equal(C.parseRugSummary(ins)?.insidersDetected, true);
      assert.equal(C.parseRugSummary(RUG_WARN)?.insidersDetected, null);
    });
  });

  describe('RugCheck full report: insiders (real responses)', () => {
    it('graphInsidersDetected > 0 → true, 0 → false, missing/invalid → null', () => {
      assert.equal(C.parseRugInsiders(RUG_REPORT_INSIDERS), true);
      assert.equal(C.parseRugInsiders(RUG_REPORT_CLEAN), false);
      assert.equal(C.parseRugInsiders({ ...clone(RUG_REPORT_CLEAN), graphInsidersDetected: -1 }), null);
      assert.equal(C.parseRugInsiders({ ...clone(RUG_REPORT_CLEAN), graphInsidersDetected: '9' }), null);
      assert.equal(C.parseRugInsiders({ graphInsidersDetected: null }), null);
      assert.equal(C.parseRugInsiders(RUG_INVALID_MINT), null);
      assert.equal(C.parseRugInsiders('x'), null);
    });
  });

  describe('extractDangers (hostile names)', () => {
    it('sanitises markup, bidi overrides, control chars and caps length at 40', () => {
      const d = C.extractDangers([
        { name: '<script>alert(1)</script>', level: 'danger' },
        { name: '\u202Egnp.exe\u202C Rug', level: 'danger' },
        { name: 'Line\u0000break\u200B', level: 'DANGER' },
        { name: 'x'.repeat(150), level: 'danger' },
      ]);
      assert.deepEqual(d, ['scriptalert(1)/script', 'gnp.exe Rug', 'Linebreak', 'x'.repeat(40)]);
      for (const name of d) assert.ok(!/[<>\u202A-\u202E\u2066-\u2069\u0000-\u001F]/.test(name));
    });
    it('keeps only level danger, skips invalid items, dedupes and keeps at most 5', () => {
      const d = C.extractDangers([
        { name: 'warn only', level: 'warn' },
        { name: 42, level: 'danger' },
        'string item',
        null,
        { name: '<>', level: 'danger' }, // empty after sanitising
        ...['a', 'a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name, level: 'danger' })),
      ]);
      assert.deepEqual(d, ['a', 'b', 'c', 'd', 'e']);
      assert.deepEqual(C.extractDangers(undefined), []);
      assert.deepEqual(C.extractDangers({ length: 3 }), []);
    });
  });

  describe('GeckoTerminal multi pools (real response)', () => {
    const refs = [{ mint: MINT, pairAddress: PAIR }, { mint: BONK, pairAddress: BONK_PAIR }];
    it('maps reserve and the price of the side that matches the mint', () => {
      const m = C.parseGeckoMulti(GECKO_MULTI, refs);
      assert.equal(m.size, 2);
      assert.equal(m.get(PAIR)?.liquidityUsd, 95340.4401);
      assert.ok(Math.abs((m.get(PAIR)?.priceUsd ?? 0) - 0.0016521289800773) < 1e-15);
      assert.equal(m.get(BONK_PAIR)?.liquidityUsd, 231446.9161);
    });
    it('uses quote_token_price_usd when the token is the quote side', () => {
      const g = clone(GECKO_MULTI) as { data: { relationships: Record<string, unknown> }[] };
      const rel = g.data[0].relationships;
      [rel.base_token, rel.quote_token] = [rel.quote_token, rel.base_token];
      const p = C.parseGeckoMulti(g, refs).get(PAIR);
      assert.ok(p && p.priceUsd !== null && p.priceUsd > 70, 'quote side price picked');
    });
    it('gives no price when no side matches, ignores unrequested pools and bad items', () => {
      const m = C.parseGeckoMulti(GECKO_MULTI, [{ mint: BONK, pairAddress: PAIR }]);
      assert.equal(m.size, 1);
      assert.equal(m.get(PAIR)?.priceUsd, null);
      assert.equal(m.get(PAIR)?.liquidityUsd, 95340.4401);
      const g = clone(GECKO_MULTI) as { data: unknown[] };
      g.data.push({ attributes: { address: '<script>' } }, 'junk', null);
      (g.data[0] as { attributes: Record<string, unknown> }).attributes.reserve_in_usd = '0';
      const m2 = C.parseGeckoMulti(g, refs);
      assert.equal(m2.size, 2);
      assert.equal(m2.get(PAIR)?.liquidityUsd, null);
    });
    it('returns an empty map for malformed top-level payloads', () => {
      assert.equal(C.parseGeckoMulti({ data: 'x' }, refs).size, 0);
      assert.equal(C.parseGeckoMulti(null, refs).size, 0);
      assert.equal(C.parseGeckoMulti({ errors: [{ status: '429' }] }, refs).size, 0);
    });
  });

  describe('JupiterTokenSchema usdPrice (tokens v2 search)', () => {
    it('reads usdPrice and drops an invalid one without losing the audit', () => {
      const [t] = J.parseEach(J.JupiterTokenSchema, JUP_SEARCH_USDPRICE);
      assert.equal(t.usdPrice, 0.0018141054159705058);
      const [bad] = J.parseEach(J.JupiterTokenSchema, [{ ...clone(JUP_SEARCH_USDPRICE[0]), usdPrice: 'x' }]);
      assert.equal(bad.usdPrice, undefined);
      assert.equal(bad.liquidity, 49063.01829306509);
    });
  });

  describe('JupiterTokenSchema stats1h / stats6h holderChange (feat/calm-sl-test)', () => {
    it('reads holderChange (percent) and drops an invalid one without losing the audit', () => {
      const base = clone(JUP_SEARCH_USDPRICE[0]);
      const [t] = J.parseEach(J.JupiterTokenSchema, [{ ...base, stats1h: { holderChange: 50, numBuys: 3 }, stats6h: { holderChange: -5.7 } }]);
      assert.equal(t.stats1h?.holderChange, 50);
      assert.equal(t.stats6h?.holderChange, -5.7);
      const [bad] = J.parseEach(J.JupiterTokenSchema, [{ ...base, stats1h: { holderChange: 'x' }, stats6h: 'junk' }]);
      assert.equal(bad.stats1h?.holderChange, undefined);
      assert.equal(bad.stats6h, undefined);
      assert.equal(bad.usdPrice, 0.0018141054159705058);
    });
  });

  describe('computeRoundTrip (BigInt)', () => {
    const buy = S.JupQuoteSchema.parse(JUP_BUY);
    const sell = S.JupQuoteSchema.parse(JUP_SELL);
    it('computes cost, impacts (fraction × 100) and the fee approximation on real quotes', () => {
      const rt = C.computeRoundTrip(MINT, buy, sell);
      // 1 − 98 242 777 / 100 000 000 = 1.757223 %
      assert.deepEqual(rt, { roundtripCostPct: 1.7572, buyImpactPct: 0.6919, sellImpactPct: 1.0165, roundtripFeePct: 0.0488 });
    });
    it('returns null when a leg is missing or the legs do not chain', () => {
      assert.equal(C.computeRoundTrip(MINT, buy, null), null);
      assert.equal(C.computeRoundTrip(MINT, null, sell), null);
      assert.equal(C.computeRoundTrip(MINT, buy, { ...sell, inAmount: '1' }), null);
      assert.equal(C.computeRoundTrip(BONK, buy, sell), null);
      assert.equal(C.computeRoundTrip(MINT, { ...buy, inAmount: '200000000' }, sell), null);
      assert.equal(C.computeRoundTrip(MINT, buy, { ...sell, outputMint: BONK }), null);
      assert.equal(C.computeRoundTrip(MINT, { ...buy, outAmount: '0' }, { ...sell, inAmount: '0' }), null);
    });
    it('rejects absurd quotes (> +100 % back, impact beyond ±100 %)', () => {
      assert.equal(C.computeRoundTrip(MINT, buy, { ...sell, outAmount: '200000001' }), null);
      assert.equal(C.computeRoundTrip(MINT, { ...buy, priceImpactPct: 1.5 }, sell), null);
    });
    it('allows a small negative cost (positive slippage) and clamps the fee at 0', () => {
      const rt = C.computeRoundTrip(MINT, { ...buy, priceImpactPct: 0 }, { ...sell, outAmount: '101000000', priceImpactPct: 0 });
      assert.equal(rt?.roundtripCostPct, -1);
      assert.equal(rt?.roundtripFeePct, 0);
    });
    it('keeps full precision on amounts beyond Number.MAX_SAFE_INTEGER', () => {
      const big = '123456789012345678901234';
      const rt = C.computeRoundTrip(MINT, { ...buy, outAmount: big }, { ...sell, inAmount: big, outAmount: '99990000' });
      assert.equal(rt?.roundtripCostPct, 0.01);
      // Off by one base unit: equal as floats (Number(big) === Number(big + 1)), different as BigInt.
      const off = '123456789012345678901235';
      assert.equal(Number(big), Number(off));
      assert.equal(C.computeRoundTrip(MINT, { ...buy, outAmount: big }, { ...sell, inAmount: off }), null);
    });
    it('impactToPercent converts a fraction and rejects out-of-range values', () => {
      assert.equal(C.impactToPercent(0.0101652974913344), 1.0165);
      assert.equal(C.impactToPercent(-0.002), -0.2);
      assert.equal(C.impactToPercent(2), null);
      assert.equal(C.impactToPercent(Number.NaN), null);
    });
  });

  describe('fetchRoundTrip (mocked fetch)', () => {
    const handler = (u: URL) => {
      if (u.searchParams.get('inputMint') === SOL) return { body: JUP_BUY };
      return { body: JUP_SELL };
    };
    it('chains buy then sell of exactly the bought amount on the fixed host', async () => {
      const { fetchFn, calls } = mockFetch(handler);
      const rt = await C.fetchRoundTrip(MINT, { fetchFn, log: quiet });
      assert.equal(rt?.roundtripCostPct, 1.7572);
      assert.equal(calls.length, 2);
      const [b, s] = calls.map((c) => new URL(c.url));
      assert.equal(b.origin, 'https://lite-api.jup.ag');
      assert.equal(b.pathname, '/swap/v1/quote');
      assert.equal(b.searchParams.get('amount'), '100000000');
      assert.equal(b.searchParams.get('outputMint'), MINT);
      assert.equal(b.searchParams.get('slippageBps'), '300');
      assert.equal(s.searchParams.get('inputMint'), MINT);
      assert.equal(s.searchParams.get('amount'), JUP_BUY.outAmount);
      assert.ok(calls.every((c) => c.init?.signal instanceof AbortSignal));
      assert.equal(calls[0].init?.redirect, 'error');
    });
    it('any failing leg → null (HTTP 429, not tradable, network error)', async () => {
      const sell429 = mockFetch((u) => (u.searchParams.get('inputMint') === SOL ? { body: JUP_BUY } : { status: 429, body: '{}' }));
      assert.equal(await C.fetchRoundTrip(MINT, { fetchFn: sell429.fetchFn, log: quiet }), null);
      const notTradable = mockFetch(() => ({ status: 400, body: JUP_NOT_TRADABLE }));
      assert.equal(await C.fetchRoundTrip(MINT, { fetchFn: notTradable.fetchFn, log: quiet }), null);
      assert.equal(notTradable.calls.length, 1, 'no sell quote after a failed buy');
      const down = mockFetch(() => new TypeError('network'));
      assert.equal(await C.fetchRoundTrip(MINT, { fetchFn: down.fetchFn, log: quiet }), null);
    });
    it('never builds a URL for an invalid mint', async () => {
      const { fetchFn, calls } = mockFetch(handler);
      for (const bad of ['../../admin', `${MINT}&amount=1`, 'So1111', SOL, '']) {
        assert.equal(await C.fetchRoundTrip(bad, { fetchFn, log: quiet }), null);
      }
      assert.equal(calls.length, 0);
    });
    it('only accepts a JUP_API_BASE on a Jupiter host and forwards the optional key header', async () => {
      assert.equal(C.resolveJupBase('https://evil.example.com'), 'https://lite-api.jup.ag');
      assert.equal(C.resolveJupBase('http://api.jup.ag'), 'https://lite-api.jup.ag');
      assert.equal(C.resolveJupBase('https://api.jup.ag:8443'), 'https://lite-api.jup.ag');
      assert.equal(C.resolveJupBase('https://api.jup.ag/'), 'https://api.jup.ag');
      const { fetchFn, calls } = mockFetch(handler);
      await C.fetchRoundTrip(MINT, { fetchFn, log: quiet, jupBase: 'https://api.jup.ag', headers: { 'x-api-key': 'k' } });
      assert.equal(new URL(calls[0].url).origin, 'https://api.jup.ag');
      assert.equal((calls[0].init?.headers as Record<string, string>)['x-api-key'], 'k');
    });
  });

  describe('getJson / fetchRugcheck / fetchGeckoPools (mocked fetch)', () => {
    it('refuses hosts outside the allow-list, http and credentials without calling fetch', async () => {
      const { fetchFn, calls } = mockFetch(() => ({ body: {} }));
      for (const url of [
        'https://evil.example.com/x',
        'http://api.rugcheck.xyz/v1',
        'https://user:pw@api.rugcheck.xyz/v1',
        'https://api.rugcheck.xyz.evil.com/v1',
        'not a url',
      ]) {
        assert.equal(await C.getJson(url, { fetchFn, log: quiet }), null, url);
      }
      assert.equal(calls.length, 0);
    });
    it('never throws: non-JSON, HTTP errors and rejections → null', async () => {
      const html = mockFetch(() => ({ body: '<html>' }));
      assert.equal(await C.getJson('https://api.rugcheck.xyz/x', { fetchFn: html.fetchFn, log: quiet }), null);
      const e500 = mockFetch(() => ({ status: 500, body: '{}' }));
      assert.equal(await C.getJson('https://api.rugcheck.xyz/x', { fetchFn: e500.fetchFn, log: quiet }), null);
      const boom = mockFetch(() => new Error('timeout'));
      assert.equal(await C.getJson('https://api.rugcheck.xyz/x', { fetchFn: boom.fetchFn, log: quiet }), null);
    });
    it('fetchRugcheck calls the summary then the full report of a validated mint', async () => {
      const { fetchFn, calls } = mockFetch((u) => ({ body: u.pathname.endsWith('/summary') ? RUG_DANGER : RUG_REPORT_INSIDERS }));
      const r = await C.fetchRugcheck(MINT, { fetchFn, log: quiet });
      assert.deepEqual(r?.dangers, ['Creator history of rugged tokens']);
      assert.equal(r?.insidersDetected, true);
      assert.equal(r?.creatorRugHistory, true);
      assert.equal(calls[0].url, `https://api.rugcheck.xyz/v1/tokens/${MINT}/report/summary`);
      assert.equal(calls[1].url, `https://api.rugcheck.xyz/v1/tokens/${MINT}/report`);
      assert.equal(await C.fetchRugcheck('../x', { fetchFn, log: quiet }), null);
      assert.equal(calls.length, 2);
      const bad = mockFetch(() => ({ status: 400, body: RUG_INVALID_MINT }));
      assert.equal(await C.fetchRugcheck(MINT, { fetchFn: bad.fetchFn, log: quiet }), null);
      assert.equal(bad.calls.length, 1, 'no report call when the summary failed');
    });
    it('fetchRugcheck keeps the summary when the full report fails (insiders unknown)', async () => {
      const { fetchFn } = mockFetch((u) => (u.pathname.endsWith('/summary') ? { body: RUG_CLEAN } : { status: 429, body: '{}' }));
      const r = await C.fetchRugcheck(MINT, { fetchFn, log: quiet });
      assert.equal(r?.score, 1);
      assert.equal(r?.insidersDetected, null);
      assert.equal(r?.creatorRugHistory, false);
      const clean = mockFetch((u) => ({ body: u.pathname.endsWith('/summary') ? RUG_CLEAN : RUG_REPORT_CLEAN }));
      assert.equal((await C.fetchRugcheck(MINT, { fetchFn: clean.fetchFn, log: quiet }))?.insidersDetected, false);
    });
    it('fetchGeckoPools makes one call with at most 30 valid, distinct pair addresses', async () => {
      const { fetchFn, calls } = mockFetch(() => ({ body: GECKO_MULTI }));
      const refs = [
        { mint: MINT, pairAddress: PAIR },
        { mint: MINT, pairAddress: PAIR }, // duplicate
        { mint: 'bad', pairAddress: BONK_PAIR }, // invalid mint
        { mint: BONK, pairAddress: 'x,y' }, // invalid pair
        ...Array.from({ length: 40 }, () => ({ mint: BONK, pairAddress: BONK_PAIR })),
      ];
      const m = await C.fetchGeckoPools(refs, { fetchFn, log: quiet });
      assert.equal(calls.length, 1);
      const u = new URL(calls[0].url);
      assert.equal(u.origin, 'https://api.geckoterminal.com');
      assert.equal(u.pathname, `/api/v2/networks/solana/pools/multi/${PAIR},${BONK_PAIR}`);
      assert.equal(m.size, 2);
      const none = mockFetch(() => ({ body: GECKO_MULTI }));
      assert.equal((await C.fetchGeckoPools([], { fetchFn: none.fetchFn })).size, 0);
      assert.equal(none.calls.length, 0);
    });
    it('caps the multi call at 30 addresses', async () => {
      const { fetchFn, calls } = mockFetch(() => ({ body: { data: [] } }));
      // 31 distinct valid addresses: base58 of 32 bytes built from distinct prefixes of a valid key.
      const addrs = Array.from({ length: 31 }, (_, i) => `${'123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghij'[i]}${BONK_PAIR.slice(1)}`);
      await C.fetchGeckoPools(addrs.map((a) => ({ mint: BONK, pairAddress: a })), { fetchFn, log: quiet });
      const list = new URL(calls[0].url).pathname.split('/').pop() ?? '';
      assert.ok(list.split(',').length <= C.GECKO_MULTI_MAX);
    });
  });

  describe('run budget (fake clock)', () => {
    const handler = (u: URL) => (u.searchParams.get('inputMint') === SOL ? { body: JUP_BUY } : { body: JUP_SELL });

    it('createRunBudget: stop new tasks at 30 s, sell legs at 34 s, abort at 40 s (< 55 s pg_net)', () => {
      let timerMs = -1;
      let fire: () => void = () => undefined;
      let cleared = false;
      const b = C.createRunBudget(1_000, {
        now: () => 1_500,
        setTimer: (fn, ms) => {
          fire = fn;
          timerMs = ms;
          return 7;
        },
        clearTimer: (h) => void (cleared = h === 7),
      });
      assert.equal(b.stopNewAt, 31_000);
      assert.equal(b.sellDeadline, 35_000);
      assert.equal(b.abortAt, 41_000);
      assert.equal(timerMs, 39_500); // relative to the injected clock
      assert.ok(b.stopNewAt < b.sellDeadline && b.sellDeadline < b.abortAt && b.abortAt - 1_000 < 55_000);
      assert.equal(b.signal.aborted, false);
      fire();
      assert.equal(b.signal.aborted, true);
      b.dispose();
      assert.equal(cleared, true);
    });
    it('getJson makes no request once the run signal is aborted', async () => {
      const { fetchFn, calls } = mockFetch(handler);
      const ac = new AbortController();
      ac.abort();
      assert.equal(await C.getJson('https://api.rugcheck.xyz/v1/x', { fetchFn, log: quiet, signal: ac.signal }), null);
      assert.equal(await C.fetchRugcheck(MINT, { fetchFn, log: quiet, signal: ac.signal }), null);
      assert.equal(calls.length, 0);
    });
    it('the run signal is passed to fetch (combined with the 8 s timeout)', async () => {
      const { fetchFn, calls } = mockFetch(handler);
      const ac = new AbortController();
      await C.fetchRoundTrip(MINT, { fetchFn, log: quiet, signal: ac.signal });
      assert.equal(calls.length, 2);
      const sig = calls[0].init?.signal;
      assert.ok(sig instanceof AbortSignal);
      assert.equal(sig.aborted, false);
      ac.abort();
      assert.equal(sig.aborted, true); // aborting the run cancels the request signal
    });
    it('no sell leg after the sell deadline → undefined (not quoted this run, columns untouched)', async () => {
      let clock = 0;
      const { fetchFn, calls } = mockFetch((u) => {
        clock += 5_000; // each quote takes 5 s on the fake clock
        return handler(u);
      });
      const late = await C.fetchRoundTrip(MINT, { fetchFn, log: quiet, now: () => clock, sellDeadline: 4_000 });
      assert.equal(late, undefined);
      assert.equal(calls.length, 1, 'buy only');
      clock = 0;
      const inTime = await C.fetchRoundTrip(MINT, { fetchFn, log: quiet, now: () => clock, sellDeadline: 6_000 });
      assert.equal(inTime?.roundtripCostPct, 1.7572);
      assert.equal(calls.length, 3);
    });
    it('aborted before or during the round trip → undefined, never null', async () => {
      const ac = new AbortController();
      ac.abort();
      const pre = mockFetch(handler);
      assert.equal(await C.fetchRoundTrip(MINT, { fetchFn: pre.fetchFn, log: quiet, signal: ac.signal }), undefined);
      assert.equal(pre.calls.length, 0);
      const mid = new AbortController();
      const during = mockFetch((u) => {
        mid.abort(); // the budget fires while the buy leg is in flight
        return handler(u);
      });
      assert.equal(await C.fetchRoundTrip(MINT, { fetchFn: during.fetchFn, log: quiet, signal: mid.signal }), undefined);
      assert.equal(during.calls.length, 1);
    });
  });

  describe('mapLimit', () => {
    it('keeps order, respects the concurrency and maps throws to undefined', async () => {
      let inFlight = 0;
      let peak = 0;
      const out = await C.mapLimit([1, 2, 3, 4, 5, 6], { concurrency: 2, delayMs: 0, deadline: Number.POSITIVE_INFINITY }, async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        if (n === 4) throw new Error('x');
        return n * 10;
      });
      assert.deepEqual(out, [10, 20, 30, undefined, 50, 60]);
      assert.equal(peak, 2);
    });
    it('starts nothing new after the deadline', async () => {
      let clock = 0;
      const started: number[] = [];
      const out = await C.mapLimit(
        [1, 2, 3, 4],
        { concurrency: 1, delayMs: 10, deadline: 15, now: () => clock, sleep: async (ms) => void (clock += ms) },
        async (n) => {
          started.push(n);
          return n;
        },
      );
      assert.deepEqual(started, [1, 2]);
      assert.deepEqual(out, [1, 2, undefined, undefined]);
    });
  });
}
