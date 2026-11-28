// scan-tokens candidate sources (chore/slim-down: young GeckoTerminal pools incl. new_pools, Jupiter « recent »):
// parsers on REAL trimmed responses (GeckoTerminal, Jupiter),
// quote-side filtering, Jupiter tag exclusion, migration wiring, source_counts, failure isolation, pacing, host
// allowlist and the upsert payload. No network: fetch is mocked.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test` (zod shim below).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupZodForNode } from './test-support/zod-node';
import {
  GECKO_TRENDING,
  JUP_ORGANIC_6H,
  JUP_RECENT,
  JUP_SOL_EURC_SEARCH,
  JUP_TRENDING_1H,
} from './test-support/source-fixtures';

const zodReady = setupZodForNode();
const S = require('./source-clients') as typeof import('./source-clients');
const Q = require('./sources') as typeof import('./sources');
const E = require('./enrich-clients') as typeof import('./enrich-clients');
const M = require('./market-context') as typeof import('./market-context');

// Real mints (from the fixtures / well-known tokens).
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const GTA6 = '4kjruqGHDsSqkMdFfCjV7Vb62HPFhtXyWc2t6JpQzDnz';
const TTWO = 'TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo';
const ORCA = 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE';
const ZEC = 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS';
const FART = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
const GATO = 'HsprHxBRgiVaQdRf3TnKNuZZtaX9JUSPgMFdAkk6pump';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const POOL = '5AFbwVSQPJf4cgEjq4TajZYyPYUvYktrRN3SahNrPnmv';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const quiet = () => undefined;
const NOW = Date.parse('2026-11-17T19:00:00Z');

function pair(mint: string, dexId: string, liq: number, createdAt?: number) {
  return {
    chainId: 'solana',
    dexId,
    pairAddress: POOL,
    baseToken: { address: mint, name: 'x', symbol: 'X' },
    liquidity: { usd: liq },
    ...(createdAt === undefined ? {} : { pairCreatedAt: createdAt }),
  };
}

describe('source-clients', { skip: !zodReady && 'zod not found in node_modules/.pnpm' }, () => {
  const s = S as NonNullable<typeof S>;
  const q = Q as NonNullable<typeof Q>;
  const e = E as NonNullable<typeof E>;
  const m = M as NonNullable<typeof M>;

  describe('parseJupRecent (Jupiter tokens v2 recent, real response)', () => {
    const NOW_R = Date.parse('2026-11-21T12:30:00Z');
    it('keeps the recent tokens (first pool < 24 h) with their records, reusable as audits', () => {
      const r = s.parseJupRecent(JUP_RECENT, NOW_R);
      assert.deepEqual(r.mints, JUP_RECENT.map((t) => t.id));
      assert.deepEqual(r.excluded, []);
      assert.deepEqual(r.tokens.map((t) => t.id), r.mints);
      assert.equal(r.tokens[0].audit?.mintAuthorityDisabled, true);
      assert.equal(r.tokens[2].audit?.topHoldersPercentage, JUP_RECENT[2].audit.topHoldersPercentage);
    });
    it('drops a token whose first pool is KNOWN to be ≥ 24 h old or > 5 min in the future; unknown date kept', () => {
      const old = { ...clone(JUP_RECENT[0]), firstPool: { id: 'x', createdAt: '2026-11-20T12:29:59Z' } };
      const future = { ...clone(JUP_RECENT[1]), firstPool: { id: 'x', createdAt: '2026-11-21T12:36:00Z' } };
      const unknown = { ...clone(JUP_RECENT[2]), firstPool: undefined };
      assert.deepEqual(s.parseJupRecent([old, future, unknown], NOW_R).mints, [JUP_RECENT[2].id]);
      const skew = { ...clone(JUP_RECENT[0]), firstPool: { id: 'x', createdAt: '2026-11-21T12:33:00Z' } };
      assert.deepEqual(s.parseJupRecent([skew], NOW_R).mints, [JUP_RECENT[0].id], '3 min of clock skew tolerated');
    });
    it('keeps the non-memecoin tag exclusion (stocks, LSTs, stables, DeFi) and quote assets', () => {
      const r = s.parseJupRecent(JUP_TRENDING_1H, NOW_R);
      assert.deepEqual(r.mints, [ZEC]);
      assert.deepEqual(r.excluded.sort(), [ORCA, TTWO].sort());
      const o = s.parseJupRecent(JUP_ORGANIC_6H, NOW_R);
      assert.ok(o.excluded.includes(SOL) && o.excluded.includes(USDC) && o.excluded.includes(TTWO));
      assert.ok(!o.tokens.some((t) => o.excluded.includes(t.id)));
    });
    it('untrusted payloads: invalid items dropped, ≤ 200 read, junk → empty', () => {
      const payload = [...clone(JUP_RECENT), { id: 'not-a-mint' }, { id: 42 }, null, { id: JUP_RECENT[0].id }];
      assert.equal(s.parseJupRecent(payload, NOW_R).mints.length, JUP_RECENT.length);
      for (const bad of [null, { error: 'x' }, 'x']) assert.deepEqual(s.parseJupRecent(bad, NOW_R), { mints: [], excluded: [], tokens: [] });
      assert.deepEqual(s.parseJupRecent(JUP_RECENT, Number.NaN).mints, []);
      const many = Array.from({ length: 250 }, () => clone(JUP_RECENT[0]));
      assert.equal(s.parseJupRecent(many, NOW_R).mints.length, 1);
    });
  });

  describe('parseDexRefMints / parseKeywords', () => {
    it('keeps valid Solana mints of the DexScreener lists only', () => {
      const r = s.parseDexRefMints([
        { chainId: 'solana', tokenAddress: GTA6 },
        { chainId: 'solana', tokenAddress: GTA6 },
        { chainId: 'ethereum', tokenAddress: '0xabc' },
        { chainId: 'solana', tokenAddress: 'bad' },
        { chainId: 'solana', tokenAddress: SOL },
      ]);
      assert.deepEqual(r, [GTA6]);
    });
    it('bounds SCAN_KEYWORDS (≤ 10, 1–40 chars)', () => {
      assert.deepEqual(s.parseKeywords(' gta , ,ai agent'), ['gta', 'ai agent']);
      assert.equal(s.parseKeywords(Array.from({ length: 15 }, (_, i) => `k${i}`).join(',')).length, 10);
      assert.deepEqual(s.parseKeywords('x'.repeat(41)), []);
      assert.deepEqual(s.parseKeywords(undefined), []);
    });
  });

  describe('withoutExcluded', () => {
    it('removes Jupiter-excluded mints from the new sources only; quote assets everywhere', () => {
      const lists = s.withoutExcluded(
        [
          { source: 'dex_boosts_top', mints: [TTWO, SOL, GTA6] },
          { source: 'gecko_new_pools', mints: [TTWO, GTA6] },
        ],
        new Set([TTWO]),
      );
      assert.deepEqual(lists[0].mints, [TTWO, GTA6]);
      assert.deepEqual(lists[1].mints, [GTA6]);
    });
  });

  describe('collectSources (mocked fetch)', () => {
    const routes = (url: string): unknown => {
      const u = new URL(url);
      if (u.hostname === 'api.dexscreener.com') {
        if (u.pathname === '/token-profiles/latest/v1') return [{ chainId: 'solana', tokenAddress: BONK }];
        if (u.pathname === '/latest/dex/search') return { pairs: [pair(FART, 'raydium', 1e6)] };
        return [];
      }
      // GeckoTerminal lists: months-old pools (no young pool → pagination stops after page 1).
      if (u.hostname === 'api.geckoterminal.com') return GECKO_TRENDING;
      // Jupiter recent: the trending fixture (tags exercise the exclusion; no firstPool → age unknown → kept).
      return JUP_TRENDING_1H;
    };
    const deps = (fetchJson: (url: string) => Promise<unknown>) => {
      const paced = { jup: 0, gecko: 0 };
      return {
        paced,
        deps: {
          fetchJson,
          jupPace: () => {
            paced.jup++;
            return Promise.resolve();
          },
          geckoPace: () => {
            paced.gecko++;
            return Promise.resolve();
          },
          keywords: ['gta'],
          log: quiet,
        },
      };
    };

    it('calls only fixed hosts, paces 3 GeckoTerminal calls (trending 1h, PumpSwap, new pools) and 1 Jupiter call', async () => {
      const urls: string[] = [];
      const { deps: d, paced } = deps((url) => {
        urls.push(url);
        return Promise.resolve(clone(routes(url)));
      });
      const r = await s.collectSources(d);
      assert.deepEqual(paced, { jup: 1, gecko: 3 });
      assert.equal(urls.length, 4 + 1 + 3 + 1);
      assert.ok(urls.includes(`https://api.geckoterminal.com/api/v2${s.GECKO_PUMPSWAP_PATH}&page=1`));
      assert.ok(urls.includes(`https://api.geckoterminal.com/api/v2${s.GECKO_TRENDING_1H_PATH}&page=1`));
      assert.ok(urls.includes('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1'));
      assert.ok(urls.includes('https://lite-api.jup.ag/tokens/v2/recent'));
      // Removed sources are never requested any more.
      assert.ok(!urls.some((u) => /toptrending|toporganicscore|toptraded|trending_pools\?page=|h24_volume_usd_desc/.test(u)));
      for (const url of urls) assert.ok(s.SOURCE_HOSTS.has(new URL(url).hostname), url);
      assert.deepEqual(r.lists.map((l) => l.source), [
        'dex_profiles', 'dex_boosts_latest', 'dex_boosts_top', 'dex_cto', 'dex_search',
        'gecko_trending_1h', 'gecko_pumpswap', 'gecko_new_pools', 'jup_recent',
      ]);
      assert.deepEqual(r.failed, []);
      assert.deepEqual(r.lists.find((l) => l.source === 'gecko_new_pools')?.mints, []);
      assert.equal(r.searchPairs.length, 1);
      assert.ok(r.excluded.has(TTWO));
      assert.deepEqual(r.lists.find((l) => l.source === 'jup_recent')?.mints, [ZEC]);
      assert.deepEqual(r.lists.find((l) => l.source === 'dex_profiles')?.mints, [BONK]);
      assert.ok(r.jupTokens.has(ZEC) && !r.jupTokens.has(TTWO));
    });

    it('isolates failures: a throwing source, a null payload and a throwing parser input never stop the others', async () => {
      const { deps: d } = deps((url) => {
        const u = new URL(url);
        if (u.hostname === 'api.geckoterminal.com') return Promise.reject(new Error('boom'));
        if (u.pathname.includes('/recent')) return Promise.resolve(null);
        if (u.pathname === '/token-boosts/top/v1') return Promise.resolve({ not: 'an array' });
        return Promise.resolve(clone(routes(url)));
      });
      const r = await s.collectSources(d);
      assert.deepEqual(r.failed, ['gecko_trending_1h', 'gecko_pumpswap', 'gecko_new_pools', 'jup_recent']);
      assert.deepEqual(r.lists.find((l) => l.source === 'dex_profiles')?.mints, [BONK]);
      assert.deepEqual(r.lists.find((l) => l.source === 'dex_boosts_top')?.mints, []);
    });

    it('all sources down → empty lists, scan input still well-formed', async () => {
      const { deps: d } = deps(() => Promise.reject(new Error('offline')));
      const r = await s.collectSources(d);
      assert.equal(r.failed.length, r.lists.length);
      assert.ok(r.lists.every((l) => l.mints.length === 0));
      assert.equal(s.planCandidates(r.lists, new Map()).fetchMints.length, 0);
    });
  });

  describe('collectSources: deadline and 429 (security review M1/L2)', () => {
    const okList = (url: string): unknown => {
      const u = new URL(url);
      if (u.hostname === 'api.geckoterminal.com') return clone(GECKO_TRENDING);
      if (u.hostname === 'api.dexscreener.com') return [{ chainId: 'solana', tokenAddress: BONK }];
      return clone(JUP_RECENT);
    };
    it('no new request once the deadline is passed (fake clock advanced by the pacers)', async () => {
      let t = 0;
      const urls: string[] = [];
      const r = await s.collectSources({
        fetchJson: (url) => {
          urls.push(url);
          return Promise.resolve(okList(url));
        },
        // each paced call costs 2.1 s (Jupiter) / 2.2 s (Gecko) of fake time
        jupPace: () => {
          t += 2_100;
          return Promise.resolve();
        },
        geckoPace: () => {
          t += 2_200;
          return Promise.resolve();
        },
        now: () => t,
        deadline: 5_000,
        log: quiet,
      });
      // dex lists start at t=0; then gecko/jup interleave until the fake clock passes 5 s
      const jup = urls.filter((u) => u.includes('jup.ag')).length;
      const gecko = urls.filter((u) => u.includes('geckoterminal')).length;
      assert.ok(jup <= 1 && gecko < 3, `jup=${jup} gecko=${gecko}`);
      assert.equal(urls.filter((u) => u.includes('dexscreener')).length, 4);
      assert.ok(r.skipped.includes('gecko_new_pools'));
      assert.deepEqual(r.rateLimited, []);
    });
    it('deadline already passed → no request at all, every source skipped and failed', async () => {
      let calls = 0;
      const r = await s.collectSources({
        fetchJson: () => {
          calls++;
          return Promise.resolve([]);
        },
        jupPace: () => Promise.resolve(),
        geckoPace: () => Promise.resolve(),
        now: () => 10,
        deadline: 0,
        log: quiet,
      });
      assert.equal(calls, 0);
      assert.equal(r.skipped.length, r.lists.length);
      assert.equal(r.failed.length, r.lists.length);
    });
    it('first 429 stops the rest of that group only; the log names the source, nothing else', async () => {
      const urls: string[] = [];
      const logs: string[] = [];
      const r = await s.collectSources({
        fetchJson: (url) => {
          urls.push(url);
          if (url.includes('duration=1h')) return Promise.reject(new s.RateLimitedError());
          return Promise.resolve(okList(url));
        },
        jupPace: () => Promise.resolve(),
        geckoPace: () => Promise.resolve(),
        log: (m) => logs.push(m),
      });
      // order: trending 1h → 429, then nothing else on GeckoTerminal; Jupiter unaffected
      assert.equal(urls.filter((u) => u.includes('geckoterminal')).length, 1);
      assert.equal(urls.filter((u) => u.includes('jup.ag')).length, 1);
      assert.deepEqual(r.rateLimited, ['gecko']);
      assert.deepEqual(r.skipped, ['gecko_trending_1h', 'gecko_pumpswap', 'gecko_new_pools'], 'page 2 of trending 1h too');
      assert.ok(r.failed.includes('gecko_trending_1h') && !r.failed.includes('jup_recent'));
      assert.deepEqual(logs, ['source gecko_trending_1h rate limited']);
    });
    it('sourceFetcher: HTTP 429 → RateLimitedError, other errors → null, aborted signal → no request', async () => {
      const mk = (status: number) => () => Promise.resolve(new Response('{}', { status }));
      await assert.rejects(s.sourceFetcher(undefined, undefined, mk(429))('https://lite-api.jup.ag/tokens/v2/recent'), s.RateLimitedError);
      assert.equal(await s.sourceFetcher(undefined, undefined, mk(500))('https://api.geckoterminal.com/api/v2/x'), null);
      let called = 0;
      const ac = new AbortController();
      ac.abort();
      const f = s.sourceFetcher(undefined, ac.signal, () => {
        called++;
        return Promise.resolve(new Response('[]'));
      });
      assert.equal(await f('https://api.dexscreener.com/token-boosts/top/v1'), null);
      assert.equal(called, 0);
    });
  });

  describe('dex_search cap (L6: no regression vs before)', () => {
    it('keeps up to 300 keyword-search mints, other sources stay at 100', () => {
      const many = (n: number) => {
        // distinct valid mints: vary the last char of real ones is unsafe; use the Jupiter fixture + generated base58
        const out: string[] = [];
        const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        for (let i = 0; out.length < n; i++) {
          const a = alphabet[i % 58];
          const b = alphabet[Math.floor(i / 58) % 58];
          const cand = `${b}${a}` + GTA6.slice(2);
          if (q.mergeSources([{ source: 'dex_cto', mints: [cand] }]).size === 1) out.push(cand);
        }
        return out;
      };
      const mints = many(350);
      const lists = s.withoutExcluded(
        [
          { source: 'dex_search', mints },
          { source: 'gecko_new_pools', mints },
        ],
        new Set(),
      );
      assert.equal(lists[0].mints.length, 300);
      assert.equal(lists[1].mints.length, 100);
      const merged = s.mergeAll(lists);
      const counts = q.countBySource(merged, new Set());
      assert.equal(counts.dex_search.seen, 300);
      assert.equal(counts.gecko_new_pools.seen, 100);
    });
  });

  describe('getJson host allowlist (sourceFetcher uses SOURCE_HOSTS)', () => {
    it('allows DexScreener with SOURCE_HOSTS, refuses it with the default enrich hosts and refuses other hosts', async () => {
      const calls: string[] = [];
      const fetchFn = (input: string) => {
        calls.push(input);
        return Promise.resolve(new Response('[]'));
      };
      assert.deepEqual(await e.getJson('https://api.dexscreener.com/token-boosts/top/v1', { fetchFn, hosts: s.SOURCE_HOSTS, log: quiet }), []);
      assert.equal(await e.getJson('https://api.dexscreener.com/token-boosts/top/v1', { fetchFn, log: quiet }), null);
      assert.equal(await e.getJson('https://evil.example.com/x', { fetchFn, hosts: s.SOURCE_HOSTS, log: quiet }), null);
      assert.equal(await e.getJson('http://api.dexscreener.com/x', { fetchFn, hosts: s.SOURCE_HOSTS, log: quiet }), null);
      assert.equal(calls.length, 1);
    });
  });

  describe('createPacer', () => {
    it('releases calls at least gapMs apart (FIFO)', async () => {
      let t = 1_000;
      const slept: number[] = [];
      const pace = s.createPacer(2_100, {
        now: () => t,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      });
      await Promise.all([pace(), pace(), pace()]);
      assert.deepEqual(slept, [2_100, 4_200]);
      t += 10_000;
      await pace();
      assert.deepEqual(slept, [2_100, 4_200]);
    });
  });

  describe('planCandidates', () => {
    it('dedups by mint, does not refetch search-only mints, appends the pump.fun watch list', () => {
      const plan = s.planCandidates(
        [
          { source: 'dex_profiles', mints: [BONK, GTA6] },
          { source: 'dex_search', mints: [FART, GTA6] },
          { source: 'jup_recent', mints: [GTA6, ZEC] },
        ],
        new Map([[GATO, 'pumpfun'], [BONK, 'pumpfun']]),
      );
      assert.deepEqual(plan.merged.get(GTA6), ['dex_profiles', 'dex_search', 'jup_recent']);
      assert.deepEqual(plan.fetchMints, [BONK, GTA6, ZEC, GATO]);
    });
    it('over budget: mints seen by more sources first', () => {
      const plan = s.planCandidates(
        [
          { source: 'dex_profiles', mints: [BONK, GTA6] },
          { source: 'gecko_new_pools', mints: [ZEC, GTA6] },
        ],
        new Map(),
        1,
      );
      assert.deepEqual(plan.fetchMints, [GTA6]);
    });
  });

  describe('migrations', () => {
    it('recentMigrationsFromPairs: fresh PumpSwap/Raydium pair on a pump.fun token only', () => {
      const pairs = [
        pair(BONK, 'pumpfun', 0),
        pair(BONK, 'pumpswap', 50_000, NOW - 30 * 60_000), // curve pair + fresh AMM pair
        pair(FART, 'raydium-cpmm', 80_000, NOW - 60 * 60_000), // "pump" vanity suffix
        pair(GTA6, 'pumpswap', 80_000, NOW - 30 * 60_000), // no curve pair, no suffix
        pair(GATO, 'pumpswap', 80_000, NOW - 5 * 3_600_000), // too old
      ];
      // deno-lint-ignore no-explicit-any
      assert.deepEqual(s.recentMigrationsFromPairs(pairs as any, NOW), [BONK, FART].sort());
    });
    it('addMigrations: persisted pumpfun → pumpswap now gets the migration source (watch-only mint included)', () => {
      const lists = [{ source: 'dex_profiles' as const, mints: [GTA6] }];
      const watch = new Map([[GATO, 'pumpfun'], [ZEC, 'pumpfun']]);
      const best = [pair(GTA6, 'raydium', 1e5), pair(GATO, 'pumpswap', 1e5), pair(ZEC, 'pumpfun', 1e4)];
      // deno-lint-ignore no-explicit-any
      const r = s.addMigrations(lists, watch, best as any, best as any, NOW);
      assert.deepEqual(r.migrated, [GATO]);
      assert.deepEqual(r.merged.get(GATO), ['migration']);
      assert.deepEqual(r.merged.get(GTA6), ['dex_profiles']);
      assert.ok(!r.merged.has(ZEC)); // still on the curve and no source: not a candidate
    });
    it('addMigrations: fresh migrations only for candidates or watched mints', () => {
      const lists = [{ source: 'gecko_new_pools' as const, mints: [FART] }];
      const all = [pair(FART, 'pumpswap', 1e5, NOW - 10 * 60_000), pair(GATO, 'pumpswap', 1e5, NOW - 10 * 60_000)];
      // deno-lint-ignore no-explicit-any
      const r = s.addMigrations(lists, new Map(), all as any, all as any, NOW);
      assert.deepEqual(r.migrated, [FART]);
      assert.deepEqual(r.merged.get(FART), ['gecko_new_pools', 'migration']);
    });
  });

  describe('source_counts', () => {
    it('counts seen / kept / unique per source and fits the scan_runs CHECK (≤ 8192 bytes)', () => {
      const merged = q.mergeSources([
        { source: 'dex_profiles', mints: [BONK, GTA6] },
        { source: 'gecko_new_pools', mints: [GTA6, ZEC] },
        { source: 'migration', mints: [GATO] },
      ]);
      const counts = q.countBySource(merged, new Set([GTA6, GATO]));
      assert.deepEqual(counts.gecko_new_pools, { seen: 2, kept: 1, unique: 1, uniqueKept: 0 });
      assert.deepEqual(counts.migration, { seen: 1, kept: 1, unique: 1, uniqueKept: 1 });
      assert.equal(Object.keys(counts).length, q.SOURCE_NAMES.length);
      const big = Object.fromEntries(q.SOURCE_NAMES.map((n) => [n, { seen: 99_999, kept: 99_999, unique: 99_999, uniqueKept: 99_999 }]));
      assert.ok(new TextEncoder().encode(JSON.stringify(big)).length <= 8192);
    });
  });

  describe('withSources (upsert payload)', () => {
    it('adds tokens.sources in canonical order, [] for a mint without source, keeps the other columns', () => {
      const merged = new Map([[GTA6, ['jup_recent', 'dex_cto', 'migration'] as ('jup_recent' | 'dex_cto' | 'migration')[]]]);
      const rows = s.withSources([{ mint: GTA6, symbol: 'A' }, { mint: BONK, symbol: 'B' }], merged);
      assert.deepEqual(rows[0], { mint: GTA6, symbol: 'A', sources: ['dex_cto', 'jup_recent', 'migration'] });
      assert.deepEqual(rows[1].sources, []);
    });
    it('never exceeds 10 entries (tokens.sources CHECK)', () => {
      const merged = new Map([[GTA6, [...q.SOURCE_NAMES]]]);
      assert.equal(s.withSources([{ mint: GTA6 }], merged)[0].sources.length, 10);
    });
  });

  describe('market quotes (SOL + EURC in one Jupiter call)', () => {
    it('parses SOL change, SOL/USD and EUR/USD from the real search response', () => {
      const r = m.parseMarketQuotes(JUP_SOL_EURC_SEARCH);
      assert.ok(r.solUsd !== null && r.solUsd > 70 && r.solUsd < 75);
      assert.ok(r.eurUsd !== null && r.eurUsd > 1.09 && r.eurUsd < 1.11);
      assert.ok(r.solChange24h !== null && Math.abs(r.solChange24h - 2.3921) < 1e-3);
    });
    it('implausible prices are null, independently', () => {
      const bad = clone(JUP_SOL_EURC_SEARCH).map((t) => ({ ...t, usdPrice: t.symbol === 'EURC' ? 5 : -1 }));
      const r = m.parseMarketQuotes(bad);
      assert.equal(r.solUsd, null);
      assert.equal(r.eurUsd, null);
      assert.ok(r.solChange24h !== null);
      assert.deepEqual(m.parseMarketQuotes(null), { solChange24h: null, solUsd: null, eurUsd: null });
    });
    it('fetchMarketQuotes: one request for both mints, Jupiter hosts only, null on failure', async () => {
      const calls: string[] = [];
      const ok = (input: string) => {
        calls.push(input);
        return Promise.resolve(new Response(JSON.stringify(JUP_SOL_EURC_SEARCH)));
      };
      const r = await m.fetchMarketQuotes({ fetchFn: ok, log: quiet });
      assert.equal(calls.length, 1);
      assert.equal(calls[0], `https://lite-api.jup.ag/tokens/v2/search?query=${SOL},${m.EURC_MINT}`);
      assert.ok(r.eurUsd !== null);
      await m.fetchMarketQuotes({ fetchFn: ok, log: quiet, jupBase: 'https://evil.example.com' });
      assert.ok(calls[1].startsWith('https://lite-api.jup.ag/'));
      const down = await m.fetchMarketQuotes({ fetchFn: () => Promise.reject(new Error('x')), log: quiet });
      assert.deepEqual(down, { solChange24h: null, solUsd: null, eurUsd: null });
    });
  });
});

describe('young sources (fix/young-sources, chore/slim-down)', { skip: !zodReady && 'zod not found' }, () => {
  const s = S as NonNullable<typeof S>;
  const H = 3_600_000;
  const NOW_Y = Date.parse('2026-11-21T12:00:00Z');
  /** GeckoTerminal pool item (real response shape, trimmed). */
  const pool = (mint: string, ageH: number | null, reserve: string | number | null = '0', quote = SOL) => ({
    id: `solana_${POOL}`,
    type: 'pool',
    attributes: {
      address: POOL,
      name: 'X / SOL',
      ...(ageH === null ? {} : { pool_created_at: new Date(NOW_Y - ageH * H).toISOString().replace('.000Z', 'Z') }),
      ...(reserve === null ? {} : { reserve_in_usd: reserve }),
    },
    relationships: {
      base_token: { data: { id: `solana_${mint}`, type: 'token' } },
      quote_token: { data: { id: `solana_${quote}`, type: 'token' } },
      dex: { data: { id: 'pumpswap', type: 'dex' } },
    },
  });
  const page = (items: unknown[]) => ({ data: items });

  describe('parseGeckoYoungPools', () => {
    it('keeps the base mints of pools < 24 h, page order, deduped; counts items and young pools', () => {
      const r = s.parseGeckoYoungPools(page([pool(FART, 2), pool(GATO, 30), pool(BONK, 23.9), pool(FART, 1), pool(GTA6, null)]), NOW_Y);
      assert.deepEqual(r.mints, [FART, BONK]);
      assert.equal(r.items, 5);
      assert.equal(r.young, 3);
    });
    it('skips quote assets on the base side, invalid ids, future dates (> 5 min) and hostile items', () => {
      const r = s.parseGeckoYoungPools(
        page([
          pool(SOL, 1, '0', FART),
          { ...pool(FART, 1), relationships: { base_token: { data: { id: 'solana_<script>' } } } },
          pool(GATO, -1),
          pool(BONK, -0.05), // 3 min in the future: tolerated clock skew
          null,
          'x',
          { attributes: { pool_created_at: 42 } },
        ]),
        NOW_Y,
      );
      assert.deepEqual(r.mints, [BONK]);
      assert.equal(r.items, 7);
    });
    it('optional reserve floor (string or number reserves; missing = rejected when a floor is set)', () => {
      const items = page([pool(FART, 1, '15000.5'), pool(GATO, 1, 9_999), pool(BONK, 1, null), pool(GTA6, 1, 'abc')]);
      assert.deepEqual(s.parseGeckoYoungPools(items, NOW_Y, { minReserveUsd: 10_000 }).mints, [FART]);
      assert.equal(s.parseGeckoYoungPools(items, NOW_Y).mints.length, 4); // default: no floor (PumpSwap reserve 0)
    });
    it('custom max age; unusable payloads → empty page', () => {
      assert.deepEqual(s.parseGeckoYoungPools(page([pool(FART, 2), pool(GATO, 7)]), NOW_Y, { maxAgeMs: 6 * H }).mints, [FART]);
      for (const bad of [null, undefined, 'x', 42, {}, { data: 'x' }, []]) {
        assert.deepEqual(s.parseGeckoYoungPools(bad, NOW_Y), { mints: [], items: 0, young: 0 });
      }
      assert.deepEqual(s.parseGeckoYoungPools(page([pool(FART, 1)]), Number.NaN), { mints: [], items: 0, young: 0 });
    });
    it('reads at most 100 items', () => {
      const r = s.parseGeckoYoungPools(page(Array.from({ length: 150 }, () => pool(FART, 1))), NOW_Y);
      assert.equal(r.items, 100);
    });
  });

  describe('pagination', () => {
    it('hasNextYoungPage: only after a full page that still had young pools', () => {
      assert.equal(s.hasNextYoungPage({ mints: [], items: 20, young: 1 }), true);
      assert.equal(s.hasNextYoungPage({ mints: [], items: 20, young: 0 }), false);
      assert.equal(s.hasNextYoungPage({ mints: [FART], items: 19, young: 19 }), false);
      assert.equal(s.hasNextYoungPage({ mints: [], items: 0, young: 0 }), false);
    });
    it('geckoPageUrls: pages 1..n on the fixed host, clamped to 0..10, & or ? separator', () => {
      assert.deepEqual(s.geckoPageUrls('/networks/solana/new_pools', 2), [
        'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1',
        'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=2',
      ]);
      assert.equal(s.geckoPageUrls(s.GECKO_PUMPSWAP_PATH, 1)[0], `https://api.geckoterminal.com/api/v2${s.GECKO_PUMPSWAP_PATH}&page=1`);
      assert.equal(s.geckoPageUrls('/x', 50).length, 10);
      assert.deepEqual(s.geckoPageUrls('/x', -1), []);
      assert.deepEqual(s.geckoPageUrls('/x', Number.NaN), []);
      for (const u of s.geckoPageUrls(s.GECKO_PUMPSWAP_PATH, s.GECKO_PUMPSWAP_PAGES)) assert.ok(s.SOURCE_HOSTS.has(new URL(u).hostname));
    });

    const young20 = (offset: number) => page(Array.from({ length: 20 }, (_, i) => pool(i % 2 ? FART : GATO, offset + i * 0.1)));
    /**
     * Young-pool lists served per page: `trending` = trending_pools?duration=1h, `pump` = PumpSwap by tx count,
     * `fresh` = new_pools.
     */
    const run = async (
      pages: { trending?: Record<number, unknown>; pump?: Record<number, unknown>; fresh?: Record<number, unknown> },
      opts: { includeGecko?: boolean } = {},
    ) => {
      const urls: string[] = [];
      const r = await s.collectSources({
        fetchJson: (url) => {
          urls.push(url);
          const u = new URL(url);
          if (u.hostname !== 'api.geckoterminal.com') return Promise.resolve([]);
          const served = u.pathname.includes('/dexes/pumpswap/') ? pages.pump
            : u.searchParams.get('duration') === '1h' ? pages.trending
            : u.pathname.endsWith('/new_pools') ? pages.fresh
            : undefined;
          const n = Number(u.searchParams.get('page'));
          return Promise.resolve(served && n in served ? clone(served[n]) : page([]));
        },
        jupPace: () => Promise.resolve(),
        geckoPace: () => Promise.resolve(),
        now: () => NOW_Y,
        log: quiet,
        ...opts,
      });
      return {
        r,
        trendUrls: urls.filter((u) => u.includes('duration=1h')),
        pumpUrls: urls.filter((u) => u.includes('/dexes/pumpswap/')),
        freshUrls: urls.filter((u) => u.includes('/new_pools')),
        geckoUrls: urls.filter((u) => u.includes('geckoterminal')),
      };
    };
    const all = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, young20(1)]));

    it('follows full young pages up to the page limit of each list (trending 1h: 2, PumpSwap: 1)', async () => {
      const { r, trendUrls, pumpUrls } = await run({ trending: all(10), pump: all(10) });
      assert.equal(trendUrls.length, s.GECKO_TRENDING_1H_PAGES);
      assert.equal(pumpUrls.length, s.GECKO_PUMPSWAP_PAGES);
      assert.deepEqual(trendUrls, s.geckoPageUrls(s.GECKO_TRENDING_1H_PATH, s.GECKO_TRENDING_1H_PAGES));
      // raw list (pages concatenated); withoutExcluded dedups before the merge
      assert.deepEqual([...new Set(r.lists.find((l) => l.source === 'gecko_trending_1h')?.mints)].sort(), [FART, GATO].sort());
      assert.deepEqual([...new Set(r.lists.find((l) => l.source === 'gecko_pumpswap')?.mints)].sort(), [FART, GATO].sort());
      assert.deepEqual(r.skipped, []);
    });
    it('stops after a short page or a page without young pools (not counted as skipped)', async () => {
      const short = await run({ trending: { 1: page([pool(FART, 1)]), 2: young20(1) } });
      assert.equal(short.trendUrls.length, 1);
      const old = await run({ trending: { 1: page(Array.from({ length: 20 }, () => pool(GTA6, 48))), 2: young20(1) } });
      assert.equal(old.trendUrls.length, 1);
      assert.deepEqual(old.r.lists.find((l) => l.source === 'gecko_trending_1h')?.mints, []);
      assert.equal(old.r.failed.includes('gecko_trending_1h'), false);
      assert.deepEqual(old.r.skipped, []);
      // an empty list = the end of the ranking → stop
      const empty = await run({ trending: { 2: young20(1) } });
      assert.equal(empty.trendUrls.length, 1);
    });
    it('a failed page (null payload) does not stop the next one', async () => {
      const failed = await run({ trending: { 1: null, 2: young20(1) } });
      assert.equal(failed.trendUrls.length, 2);
      assert.equal(failed.r.failed.includes('gecko_trending_1h'), false);
      assert.deepEqual([...new Set(failed.r.lists.find((l) => l.source === 'gecko_trending_1h')?.mints)].sort(), [FART, GATO].sort());
    });
    it('new_pools: GECKO_NEW_POOLS_PAGES page(s) on the fixed path, pools < 24 h only, same pagination rule', async () => {
      const { r, freshUrls } = await run({ fresh: all(10) });
      assert.equal(freshUrls.length, s.GECKO_NEW_POOLS_PAGES);
      assert.deepEqual(freshUrls, s.geckoPageUrls(s.GECKO_NEW_POOLS_PATH, s.GECKO_NEW_POOLS_PAGES));
      assert.equal(freshUrls[0], 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1');
      assert.deepEqual([...new Set(r.lists.find((l) => l.source === 'gecko_new_pools')?.mints)].sort(), [FART, GATO].sort());
      // A new_pools page with an old pool (cannot happen live, defensive): the old pool is dropped.
      const mixed = await run({ fresh: { 1: page([pool(FART, 1), pool(GATO, 30)]) } });
      assert.deepEqual(mixed.r.lists.find((l) => l.source === 'gecko_new_pools')?.mints, [FART]);
      // Short page, empty page or failed page: no extra request, not failed when a page answered.
      const empty = await run({ fresh: {} });
      assert.equal(empty.freshUrls.length, 1);
      assert.equal(empty.r.failed.includes('gecko_new_pools'), false);
    });
    it('new_pools pagination rule (sourceJobs parse): more pages only after a full page that still had young pools', () => {
      const job = s.sourceJobs(null, [], () => NOW_Y).find((j) => j.source === 'gecko_new_pools');
      assert.ok(job);
      assert.equal(job.group, 'gecko');
      assert.equal(job.urls.length, s.GECKO_NEW_POOLS_PAGES);
      assert.equal(job.parse(young20(1)).more, true, 'full young page → next page allowed (within the page cap)');
      assert.equal(job.parse(page([pool(FART, 1)])).more, false, 'short page → stop');
      assert.equal(job.parse(page(Array.from({ length: 20 }, () => pool(GTA6, 48)))).more, false, 'no young pool → stop');
    });
    it('includeGecko false → no GeckoTerminal call at all', async () => {
      const off = await run({ trending: all(2), pump: all(1), fresh: all(1) }, { includeGecko: false });
      assert.equal(off.geckoUrls.length, 0);
      assert.equal(off.r.lists.some((l) => l.source.startsWith('gecko_')), false);
    });
    it('at most GECKO_SOURCE_CALLS_MAX (4) GeckoTerminal source calls per scan, every scan', async () => {
      assert.equal(s.GECKO_SOURCE_CALLS_MAX, s.GECKO_TRENDING_1H_PAGES + s.GECKO_PUMPSWAP_PAGES + s.GECKO_NEW_POOLS_PAGES);
      assert.ok(s.GECKO_SOURCE_CALLS_MAX <= 4);
      const full = await run({ trending: all(10), pump: all(10), fresh: all(10) });
      assert.equal(full.geckoUrls.length, s.GECKO_SOURCE_CALLS_MAX);
    });
  });

  describe('parseYoungWatchRows', () => {
    const iso = (ageH: number) => new Date(NOW_Y - ageH * H).toISOString();
    it('keeps valid mints whose pair is still < 24 h, deduped, row order, capped', () => {
      const rows = [
        { mint: FART, pair_created_at: iso(1) },
        { mint: GATO, pair_created_at: iso(24.01) },
        { mint: FART, pair_created_at: iso(1) },
        { mint: BONK, pair_created_at: iso(23) },
        { mint: '<script>', pair_created_at: iso(1) },
        { mint: SOL, pair_created_at: iso(1) },
        { mint: GTA6, pair_created_at: null },
        { mint: ZEC, pair_created_at: iso(-1) }, // 1 h in the future
        null,
        'x',
      ];
      assert.deepEqual(s.parseYoungWatchRows(rows, NOW_Y), [FART, BONK]);
      assert.deepEqual(s.parseYoungWatchRows(rows, NOW_Y, 1), [FART]);
      assert.deepEqual(s.parseYoungWatchRows(null, NOW_Y), []);
      assert.deepEqual(s.parseYoungWatchRows(rows, Number.NaN), []);
    });
  });

  describe('young sources through the candidate plan', () => {
    it('excluded by Jupiter tags like every non-DexScreener source and keep their tokens.sources names', () => {
      const lists = s.withoutExcluded(
        [
          { source: 'gecko_pumpswap', mints: [FART, TTWO] },
          { source: 'young_watch', mints: [GATO, TTWO, USDC] },
          { source: 'gecko_new_pools', mints: [BONK, TTWO] },
          { source: 'jup_recent', mints: [GTA6, TTWO] },
        ],
        new Set([TTWO]),
      );
      assert.deepEqual(lists.map((l) => l.mints), [[FART], [GATO], [BONK], [GTA6]]);
      const rows = s.withSources([{ mint: FART }, { mint: GATO }, { mint: BONK }, { mint: GTA6 }], s.mergeAll(lists));
      assert.deepEqual(rows.map((r) => r.sources), [['gecko_pumpswap'], ['young_watch'], ['gecko_new_pools'], ['jup_recent']]);
    });
  });
});
