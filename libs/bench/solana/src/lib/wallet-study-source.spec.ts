import { walletStudyHealthSchema } from '@raijin/bench-contracts';
import { MemoryCacheStore, UpstreamError, type LogFields } from '@raijin/api-solana';
import { FakeRedis, jsonResponse } from '../test/fake-redis';
import { createBenchSolana } from './bench-solana';
import { BenchWalletStudySource, WALLET_STUDY_UNAVAILABLE_FLAG } from './wallet-study-source';

const KEY = 'bench-key-0123456789abcdef';
const ADDRESS = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PAGE = { jsonrpc: '2.0', id: 1, result: { data: [{ slot: 1, transactionIndex: 0, blockTime: 1, transaction: {}, meta: {} }], paginationToken: '1:0' } };

function manualClock(start = Date.parse('2026-11-24T10:00:00Z')) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function setup(options: { env?: Record<string, string>; responses?: Response[]; redis?: FakeRedis; clock?: ReturnType<typeof manualClock> } = {}) {
  const methods: string[] = [];
  const warnings: Array<[string, LogFields]> = [];
  const responses = options.responses ?? [];
  const redis = options.redis ?? new FakeRedis();
  const clock = options.clock ?? manualClock();
  const bench = createBenchSolana({
    env: { BENCH_HELIUS_API_KEY: KEY, ...options.env },
    redis,
    clock,
    random: () => 0,
    logger: { debug: () => undefined, warn: (event, fields) => warnings.push([event, fields]) },
    fetch: async (_url, init) => {
      methods.push((JSON.parse(String(init?.body)) as { method: string }).method);
      return responses.shift() ?? jsonResponse(PAGE);
    },
  });
  return { bench, methods, warnings, redis, clock };
}

describe('BenchWalletStudySource', () => {
  it('active : page obtenue, 10 crédits comptés sur raijin-bench:…:wallet et dans le global', async () => {
    const { bench, redis } = setup();
    const result = await bench.walletStudy.page(ADDRESS);
    expect(result).toMatchObject({ status: 'ok', page: { next: '1:0', dropped: 0 } });
    expect(redis.counters.get('raijin-bench:helius:credits:2026-11-24')).toBe(10);
    expect(redis.counters.get('raijin-bench:helius:credits:wallet:2026-11-24')).toBe(10);
    const health = await bench.walletStudy.health();
    expect(walletStudyHealthSchema.parse(health)).toEqual({ state: 'active', credits_used: 10, credits_budget: 2_000 });
    expect(await bench.heliusCredits()).toEqual({ used: 10, budget: 10_000, ratio: 0.001 });
  });

  it('sans clé : not_configured, aucun appel', async () => {
    const { bench, methods } = setup({ env: { BENCH_HELIUS_API_KEY: '' } });
    expect(await bench.walletStudy.page(ADDRESS)).toEqual({ status: 'unavailable', reason: 'not_configured' });
    expect((await bench.walletStudy.health()).state).toBe('not_configured');
    expect(await bench.heliusCredits()).toBeNull();
    expect(methods).toEqual([]);
  });

  it('plafond BENCH_WALLET_STUDY_DAILY_CREDITS atteint : budget_exhausted sans appel, le reste du budget est préservé', async () => {
    const { bench, methods } = setup({ env: { BENCH_WALLET_STUDY_DAILY_CREDITS: '20' } });
    expect((await bench.walletStudy.page(ADDRESS)).status).toBe('ok');
    expect((await bench.walletStudy.page(ADDRESS)).status).toBe('ok');
    expect(await bench.walletStudy.page(ADDRESS)).toEqual({ status: 'unavailable', reason: 'budget_exhausted' });
    expect(methods).toHaveLength(2);
    expect(await bench.budget.tryConsume(10, 'interactive')).toBe(true);
    expect((await bench.walletStudy.health()).state).toBe('budget_exhausted');
  });

  it('réservation refusée au moment de l’appel (budget global épuisé entre-temps) : budget_exhausted', async () => {
    const { bench, redis } = setup({ env: { BENCH_HELIUS_DAILY_CREDIT_BUDGET: '15', BENCH_WALLET_STUDY_DAILY_CREDITS: '15' } });
    redis.counters.set('raijin-bench:helius:credits:2026-11-24', 10);
    expect(await bench.walletStudy.page(ADDRESS)).toEqual({ status: 'unavailable', reason: 'budget_exhausted' });
  });

  it('méthode absente de l’offre : désactivation propre, signalée une fois, partagée via Redis, nouvel essai le lendemain', async () => {
    const clock = manualClock();
    const redis = new FakeRedis();
    const first = setup({ redis, clock, responses: [jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } })] });
    expect(await first.bench.walletStudy.page(ADDRESS)).toEqual({ status: 'unavailable', reason: 'method_unavailable' });
    expect(await first.bench.walletStudy.page(ADDRESS)).toEqual({ status: 'unavailable', reason: 'method_unavailable' });
    expect(first.methods).toEqual(['getTransactionsForAddress']);
    expect(first.warnings).toEqual([['wallet_study_disabled', { reason: 'method_unavailable', retryInSeconds: 50_400 }]]);
    const flag = redis.strings.get(`raijin-bench:solana:${WALLET_STUDY_UNAVAILABLE_FLAG}`);
    expect(flag?.ttl).toBe(50_400);
    expect((await first.bench.walletStudy.health()).state).toBe('method_unavailable');

    // Autre processus du banc : lit l'indicateur, n'appelle pas Helius.
    const second = setup({ redis, clock });
    expect((await second.bench.walletStudy.page(ADDRESS)).status).toBe('unavailable');
    expect(second.methods).toEqual([]);

    // Jour UTC suivant : nouvel essai.
    clock.advance(50_400_000);
    expect((await first.bench.walletStudy.page(ADDRESS)).status).toBe('ok');
  });

  it('panne du fournisseur : upstream (dégradation propre) ; entrée invalide : RangeError', async () => {
    const { bench } = setup({
      env: {},
      responses: [jsonResponse({ error: { code: -32602, message: 'invalid' } })],
    });
    expect(await bench.walletStudy.page(ADDRESS)).toEqual({ status: 'unavailable', reason: 'upstream' });
    await expect(bench.walletStudy.page(ADDRESS, { limit: 500 })).rejects.toThrow(RangeError);
  });

  it('indicateur illisible ou stockage en panne : traité comme absent', async () => {
    const flags = new MemoryCacheStore();
    const service = { heliusConfigured: true, transactionHistoryPage: jest.fn(async () => ({ entries: [], dropped: 0, next: null })) };
    const budget = { used: async () => 0, limit: () => 100 };
    await flags.set(WALLET_STUDY_UNAVAILABLE_FLAG, 'oui', 60);
    const source = new BenchWalletStudySource({ service, budget, flags });
    expect((await source.page(ADDRESS)).status).toBe('ok');
    const broken = new BenchWalletStudySource({
      service: { ...service, transactionHistoryPage: jest.fn(async () => Promise.reject(new Error('x'))) },
      budget,
      flags: { get: async () => Promise.reject(new Error('down')), set: async () => Promise.reject(new Error('down')) },
    });
    expect(await broken.page(ADDRESS)).toEqual({ status: 'unavailable', reason: 'upstream' });
  });

  it('erreurs typées du service converties : not_configured', async () => {
    const source = new BenchWalletStudySource({
      service: {
        heliusConfigured: true,
        transactionHistoryPage: async () => {
          throw new UpstreamError('helius_rpc', 'not_configured');
        },
      },
      budget: { used: async () => 0, limit: () => 100 },
      flags: new MemoryCacheStore(),
    });
    expect(await source.page(ADDRESS)).toEqual({ status: 'unavailable', reason: 'not_configured' });
  });
});
