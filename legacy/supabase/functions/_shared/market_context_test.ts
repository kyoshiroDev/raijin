// scan-tokens market context: SOL 24 h change from a recorded Jupiter response (fixed hosts, never throws) and the
// total 24 h volume of the scanned tokens. fetch is mocked: no network.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test` (zod shim below).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupZodForNode } from './test-support/zod-node.ts';
import { JUP_SOL_SEARCH } from './test-support/x3-fixtures.ts';

const zodReady = await setupZodForNode();
const M = zodReady ? await import('./market-context.ts') : null;

const SOL = 'So11111111111111111111111111111111111111112';
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function mockFetch(handler: () => { status?: number; body: unknown } | Error) {
  const calls: string[] = [];
  const fetchFn = (input: string): Promise<Response> => {
    calls.push(input);
    const r = handler();
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 }));
  };
  return { fetchFn, calls };
}
const quiet = () => undefined;

describe('market-context', { skip: !zodReady && 'zod not found in node_modules/.pnpm' }, () => {
  const m = M as NonNullable<typeof M>;

  describe('parseSolChange24h (real response)', () => {
    it('reads stats24h.priceChange (PERCENT) of the SOL item', () => {
      assert.equal(m.parseSolChange24h(JUP_SOL_SEARCH), 1.726);
    });
    it('ignores other tokens, invalid items and implausible values', () => {
      const other = [{ id: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', stats24h: { priceChange: 50 } }, ...clone(JUP_SOL_SEARCH)];
      assert.equal(m.parseSolChange24h(other), 1.726);
      assert.equal(m.parseSolChange24h([{ id: SOL, stats24h: { priceChange: 'NaN' } }]), null);
      assert.equal(m.parseSolChange24h([{ id: SOL, stats24h: { priceChange: -99 } }]), null);
      assert.equal(m.parseSolChange24h([{ id: SOL, stats24h: { priceChange: 5000 } }]), null);
      assert.equal(m.parseSolChange24h([{ id: SOL }]), null);
      assert.equal(m.parseSolChange24h({ id: SOL }), null);
      assert.equal(m.parseSolChange24h(null), null);
      assert.equal(m.parseSolChange24h([]), null);
    });
  });

  describe('fetchSolChange24h (mocked fetch)', () => {
    it('one request to the Jupiter search for the SOL mint', async () => {
      const { fetchFn, calls } = mockFetch(() => ({ body: JUP_SOL_SEARCH }));
      assert.equal(await m.fetchSolChange24h({ fetchFn, log: quiet }), 1.726);
      assert.equal(calls.length, 1);
      assert.equal(calls[0], `https://lite-api.jup.ag/tokens/v2/search?query=${SOL}`);
    });
    it('a JUP_API_BASE outside the Jupiter hosts falls back to lite-api', async () => {
      const { fetchFn, calls } = mockFetch(() => ({ body: JUP_SOL_SEARCH }));
      await m.fetchSolChange24h({ fetchFn, log: quiet, jupBase: 'https://evil.example.com' });
      assert.match(calls[0], /^https:\/\/lite-api\.jup\.ag\//);
      await m.fetchSolChange24h({ fetchFn, log: quiet, jupBase: 'https://api.jup.ag' });
      assert.match(calls[1], /^https:\/\/api\.jup\.ag\//);
    });
    it('null on HTTP error, bad JSON or rejection (never throws)', async () => {
      for (const f of [mockFetch(() => ({ status: 429, body: '{}' })), mockFetch(() => ({ body: '<html>' })), mockFetch(() => new Error('x'))]) {
        assert.equal(await m.fetchSolChange24h({ fetchFn: f.fetchFn, log: quiet }), null);
      }
    });
  });

  describe('scanVolume24h', () => {
    it('sums finite non-negative volumes, null when none', () => {
      assert.equal(m.scanVolume24h([{ volume24h: 1000 }, { volume24h: 250.5 }, { volume24h: Number.NaN }, { volume24h: -5 }, { volume24h: null }]), 1250.5);
      assert.equal(m.scanVolume24h([]), null);
      assert.equal(m.scanVolume24h([{ volume24h: Number.POSITIVE_INFINITY }]), null);
      assert.equal(m.scanVolume24h([{ volume24h: 0 }]), 0);
    });
  });
});
