import { UpstreamGate, type LogFields } from '@raijin/api-solana';
import { FakeRedis, jsonResponse } from '../test/fake-redis';
import { createBenchSolana } from './bench-solana';
import { PrefixedRedisCacheStore } from './redis-cache';

const BENCH_KEY = 'bench-key-0123456789abcdef';
const RAIJIN_KEY = 'raijin-key-fedcba9876543210';
const ADDRESS = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PAGE = { result: { data: [], paginationToken: null } };

describe('createBenchSolana : débits', () => {
  afterEach(() => jest.useRealTimers());

  it('Helius RPC du banc : 3 req/s au plus (rafale de 3, puis une toutes les 333 ms)', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-24T10:00:00Z') });
    const times: number[] = [];
    const bench = createBenchSolana({
      env: { BENCH_HELIUS_API_KEY: BENCH_KEY },
      redis: null,
      fetch: async () => {
        times.push(Date.now());
        return jsonResponse(PAGE);
      },
    });
    const start = Date.now();
    const pages = Promise.all(Array.from({ length: 12 }, () => bench.service.transactionHistoryPage(ADDRESS)));
    await jest.advanceTimersByTimeAsync(5_000);
    await pages;
    expect(times).toHaveLength(12);
    const elapsed = times.map((t) => t - start);
    // Dans toute fenêtre [0, T] : au plus 3 + 3·T/1000 appels.
    elapsed.forEach((t, i) => expect(i + 1).toBeLessThanOrEqual(3 + Math.floor((3 * t) / 1_000) + 1));
    expect(elapsed.filter((t) => t <= 1_000).length).toBeLessThanOrEqual(6);
    expect(elapsed.filter((t) => t < 1_000).length).toBeGreaterThanOrEqual(5);
    expect(elapsed[11]).toBeGreaterThanOrEqual(2_990);
  });

  it('Helius DAS du banc : 0,5 req/s (une requête toutes les 2 s)', async () => {
    jest.useFakeTimers({ now: 0 });
    const bench = createBenchSolana({ env: {}, redis: null });
    const limits = bench.service.config.limits.helius_das;
    expect(limits.ratePerSecond).toBe(0.5);
    const gate = new UpstreamGate({ source: 'helius_das', ratePerSecond: limits.ratePerSecond, maxQueue: limits.maxQueue, maxAttempts: 1, backoffBaseMs: 1, maxRetryAfterMs: 1, breakerThreshold: 5, breakerCooldownMs: 1 });
    const times: number[] = [];
    const runs = Promise.all(Array.from({ length: 4 }, () => gate.run(async () => times.push(Date.now()))));
    await jest.advanceTimersByTimeAsync(7_000);
    await runs;
    expect(times).toEqual([0, 2_000, 4_000, 6_000]);
  });

  it('configuration exposée : 3 / 0,5, budget 10 000, sources publiques à mi-débit', () => {
    const { service } = createBenchSolana({ env: {}, redis: null });
    expect(service.config.limits.helius_rpc.ratePerSecond).toBe(3);
    expect(service.config.limits.dexscreener.ratePerSecond).toBe(2);
    expect(service.config.limits.jupiter.ratePerSecond).toBe(0.25);
    expect(service.config.limits.geckoterminal.ratePerSecond).toBeCloseTo(5 / 60, 10);
    expect(service.config.heliusDailyCreditBudget).toBe(10_000);
    expect(service.heliusConfigured).toBe(false);
  });
});

describe('createBenchSolana : budget 10 000/jour puis repli', () => {
  it('au-delà du budget du jour : plus aucun appel Helius (contrôle « indisponible »), compteurs raijin-bench: seulement', async () => {
    const redis = new FakeRedis();
    const day = '2026-11-24';
    redis.counters.set(`raijin:helius:credits:${day}`, 21_990);
    redis.counters.set(`raijin-bench:helius:credits:${day}`, 9_990);
    let calls = 0;
    const bench = createBenchSolana({
      env: { BENCH_HELIUS_API_KEY: BENCH_KEY, BENCH_WALLET_STUDY_DAILY_CREDITS: '10000' },
      redis,
      clock: { now: () => Date.parse(`${day}T12:00:00Z`) },
      fetch: async () => {
        calls += 1;
        return jsonResponse(PAGE);
      },
    });
    expect((await bench.walletStudy.page(ADDRESS)).status).toBe('ok');
    expect(await bench.walletStudy.page(ADDRESS)).toEqual({ status: 'unavailable', reason: 'budget_exhausted' });
    expect(calls).toBe(1);
    expect(redis.counters.get(`raijin-bench:helius:credits:${day}`)).toBe(10_000);
    // Le compteur de Raijin n'est ni lu ni modifié par le banc.
    expect(redis.counters.get(`raijin:helius:credits:${day}`)).toBe(21_990);
    expect(redis.keys().every((key) => key.startsWith('raijin-bench:') || key.startsWith('raijin:helius'))).toBe(true);
    expect(await bench.heliusCredits()).toEqual({ used: 10_000, budget: 10_000, ratio: 1 });
  });

  it('budget nul : ratio 1', async () => {
    const bench = createBenchSolana({ env: { BENCH_HELIUS_API_KEY: BENCH_KEY, BENCH_HELIUS_DAILY_CREDIT_BUDGET: '0' }, redis: new FakeRedis() });
    expect(await bench.heliusCredits()).toEqual({ used: 0, budget: 0, ratio: 1 });
  });
});

describe('createBenchSolana : anti-fuite de la clé', () => {
  it('BENCH_HELIUS_API_KEY seulement dans l’URL appelée ; HELIUS_API_KEY jamais utilisée ; rien dans journaux, erreurs, santé', async () => {
    const lines: string[] = [];
    const urls: string[] = [];
    const redis = new FakeRedis();
    const bench = createBenchSolana({
      env: { BENCH_HELIUS_API_KEY: BENCH_KEY, HELIUS_API_KEY: RAIJIN_KEY },
      redis,
      logger: {
        debug: (event: string, fields: LogFields) => lines.push(JSON.stringify({ event, fields })),
        warn: (event: string, fields: LogFields) => lines.push(JSON.stringify({ event, fields })),
      },
      fetch: async (url) => {
        urls.push(url);
        throw new TypeError(`fetch failed: ${url}`);
      },
    });
    const result = await bench.walletStudy.page(ADDRESS);
    const error = (await bench.service.transactionHistoryPage(ADDRESS).catch((e: unknown) => e)) as Error;
    const facts = await bench.service.collectFacts(ADDRESS).catch((e: unknown) => e);
    redis.failing = true;
    await bench.budget.tryConsume(10, 'interactive');

    expect(urls.some((url) => url.includes(BENCH_KEY))).toBe(true);
    expect(urls.join('\n')).not.toContain(RAIJIN_KEY);
    const everything = [
      JSON.stringify(result),
      error.message,
      error.stack ?? '',
      JSON.stringify(error),
      JSON.stringify(facts),
      ...lines,
      JSON.stringify(await bench.walletStudy.health()),
      JSON.stringify(await bench.heliusCredits()),
      JSON.stringify(bench.backoff.snapshot()),
      JSON.stringify(bench.service.config),
      JSON.stringify(bench.service.breakerStates()),
      JSON.stringify([...redis.counters.keys(), ...redis.strings.keys()]),
    ].join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(everything).not.toContain(BENCH_KEY);
    expect(everything).not.toContain(RAIJIN_KEY);
    expect(everything).not.toContain('api-key');
  });
});

describe('PrefixedRedisCacheStore', () => {
  it('clés préfixées, TTL entier ≥ 1 s, panne = défaut de cache', async () => {
    const redis = new FakeRedis();
    const cache = new PrefixedRedisCacheStore(redis, 'raijin-bench:solana:');
    await cache.set('rugcheck:x', '{"a":1}', 0.2);
    expect(redis.strings.get('raijin-bench:solana:rugcheck:x')).toEqual({ value: '{"a":1}', ttl: 1 });
    expect(await cache.get('rugcheck:x')).toBe('{"a":1}');
    expect(await cache.get('absent')).toBeNull();
    redis.failing = true;
    expect(await cache.get('rugcheck:x')).toBeNull();
    await expect(cache.set('k', 'v', 10)).resolves.toBeUndefined();
    expect(() => new PrefixedRedisCacheStore(redis, 'raijin-bench')).toThrow(RangeError);
    expect(() => new PrefixedRedisCacheStore(redis, '*:')).toThrow(RangeError);
  });
});
