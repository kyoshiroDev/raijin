import { DEFAULT_SOLANA_DATA_CONFIG, SolanaDataService, TokenNotFoundError, UpstreamError } from '@raijin/api-solana';
import { createFixtureFetch, loadAllFixtures } from '@raijin/api-solana/testing';
import { testConfig } from '@raijin/api-core';
import { analysisResultSchema } from '@raijin/shared-contracts';
import { join } from 'node:path';
import type { AnalysisRepository } from '../analysis/analysis.repository';
import { AnalysisService } from '../analysis/analysis.service';
import { DefaultRiskEngine } from '../analysis/risk-engine.provider';
import { SystemClock, TokenUnanalyzableError, UpstreamUnavailableError } from '../ports/facts-collector';
import type { QuotaService } from '../quota/quota.service';
import { MemoryKeyValueStore } from '../store/key-value-store';
import { CONSUME_CREDITS_SCRIPT, CONSUME_LANE_CREDITS_SCRIPT, RedisCreditBudget, SolanaCacheStore } from './redis-ports';
import { SolanaFactsCollector } from './solana-facts-collector';

const FIXTURES = loadAllFixtures(join(__dirname, '../../../../solana/src/fixtures'));
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BONK_PAIR = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';
const MINT_ACTIVE = 'BL7yQWfMeLesszudGL6TqnfWbieFMDTT1TFXzQWBazTi';
const HONEYPOT = '3Ss6A75uZG9cSRt4feyhcmJVGT38USeygDfwi1tBGQVa';
const MISSING = 'Y3Pg4fGfK1jz4exHgF2duMUhZvjAa1FdBuJYMsyZfWD';

function collector(): SolanaFactsCollector {
  return new SolanaFactsCollector(
    new SolanaDataService({ heliusApiKey: null, fetch: createFixtureFetch(FIXTURES, DEFAULT_SOLANA_DATA_CONFIG).fetch }),
  );
}

function service(): AnalysisService {
  const policy = { kind: 'analysis', subject: 'anonymous', userId: null, ipHash: 'h', plan: null, limit: 3 };
  const quota = {
    resolvePolicy: async () => policy,
    reserve: async () => ({ policy, day: 'd', counted: true, used: 1, seenKey: null }),
    settleFailure: jest.fn(async () => undefined),
    info: async () => ({ kind: 'analysis', subject: 'anonymous', plan: null, limit: 3, used: 1, remaining: 2, resetsAt: '2026-11-23T00:00:00.000Z' }),
  };
  const repository = { save: async () => undefined, findLatest: async () => null, recordEvent: async () => undefined };
  return new AnalysisService(
    collector(),
    new DefaultRiskEngine(),
    new MemoryKeyValueStore(),
    quota as unknown as QuotaService,
    repository as unknown as AnalysisRepository,
    new SystemClock(),
    testConfig(),
  );
}

describe('intégration @raijin/api-solana (fixtures enregistrées, aucun réseau)', () => {
  it('BONK : résultat contractuel, sources citées par la collecte, cache 300 s sans clé Helius', async () => {
    const analyses = service();
    const { response } = await analyses.analyze(BONK, { kind: 'anonymous', ip: '203.0.113.1' });
    expect(analysisResultSchema.safeParse(response.analysis).success).toBe(true);
    expect(response.analysis.mint).toBe(BONK);
    expect(response.analysis.checks.every((check) => check.sources.length > 0)).toBe(true);
    expect(analyses.cacheTtlMs).toBe(300_000);
  }, 30_000);

  it('lien DexScreener d’une paire : résolu vers BONK', async () => {
    const { response } = await service().analyze(`https://dexscreener.com/solana/${BONK_PAIR}`, { kind: 'anonymous', ip: null });
    expect(response.analysis.mint).toBe(BONK);
  }, 30_000);

  it('mint actif et honeypot : Danger', async () => {
    const analyses = service();
    expect((await analyses.analyze(MINT_ACTIVE, { kind: 'anonymous', ip: null })).response.analysis.verdict).toBe('danger');
    expect((await analyses.analyze(HONEYPOT, { kind: 'anonymous', ip: null })).response.analysis.verdict).toBe('danger');
  }, 30_000);

  it('mint inexistant : TokenNotFoundError → TOKEN_NOT_FOUND', async () => {
    await expect(collector().collectFacts(MISSING, { profile: 'full' })).resolves.toBeNull();
    await expect(service().analyze(MISSING, { kind: 'anonymous', ip: null })).rejects.toMatchObject({ code: 'TOKEN_NOT_FOUND' });
    expect(new TokenNotFoundError().code).toBe('TOKEN_NOT_FOUND');
  }, 30_000);

  it('lecture du mint impossible (UpstreamError) : UpstreamUnavailableError, autre erreur relancée', async () => {
    const solana = new SolanaDataService({ heliusApiKey: null, fetch: createFixtureFetch(FIXTURES, DEFAULT_SOLANA_DATA_CONFIG).fetch });
    const adapter = new SolanaFactsCollector(solana);
    jest.spyOn(solana, 'collectFacts').mockRejectedValueOnce(new UpstreamError('solana_rpc', 'timeout'));
    await expect(adapter.collectFacts(BONK, { profile: 'full' })).rejects.toBeInstanceOf(UpstreamUnavailableError);
    jest.spyOn(solana, 'collectFacts').mockRejectedValueOnce(new Error('bug'));
    await expect(adapter.collectFacts(BONK, { profile: 'full' })).rejects.toThrow('bug');
  }, 30_000);

  it('compte hors normes (code TOKEN_UNANALYZABLE de la lib) : TokenUnanalyzableError du port', async () => {
    const solana = new SolanaDataService({ heliusApiKey: null, fetch: createFixtureFetch(FIXTURES, DEFAULT_SOLANA_DATA_CONFIG).fetch });
    const adapter = new SolanaFactsCollector(solana);
    const unanalyzable = Object.assign(new Error('Token non analysable.'), { code: 'TOKEN_UNANALYZABLE' });
    jest.spyOn(solana, 'collectFacts').mockRejectedValueOnce(unanalyzable);
    await expect(adapter.collectFacts(BONK, { profile: 'full' })).rejects.toBeInstanceOf(TokenUnanalyzableError);
  }, 30_000);

  it('adresse inconnue des fixtures : pas une paire', async () => {
    await expect(collector().resolveMint(BONK)).resolves.toBeNull();
    expect(collector().heliusConfigured).toBe(false);
  }, 30_000);
});

describe('ports Redis de @raijin/api-solana', () => {
  it('SolanaCacheStore : préfixe et TTL en millisecondes', async () => {
    const store = new MemoryKeyValueStore();
    const set = jest.spyOn(store, 'set');
    const cache = new SolanaCacheStore(store);
    await cache.set('age:x', '1', 60);
    expect(set).toHaveBeenCalledWith('solana:age:x', '1', 60_000);
    await expect(cache.get('age:x')).resolves.toBe('1');
  });

  it('RedisCreditBudget : script atomique (INCRBY, EXPIRE, annulation au-delà du budget)', async () => {
    let used = 0;
    const redis = {
      eval: jest.fn(async (script: string, _n: number, key: string, credits: string, limit: string) => {
        expect(script).toBe(CONSUME_CREDITS_SCRIPT);
        expect(key).toMatch(/^helius:credits:\d{4}-\d{2}-\d{2}$/);
        used += Number(credits);
        if (used > Number(limit)) {
          used -= Number(credits);
          return 0;
        }
        return 1;
      }),
    };
    const budget = new RedisCreditBudget(redis as unknown as ConstructorParameters<typeof RedisCreditBudget>[0], 15);
    await expect(budget.tryConsume(10)).resolves.toBe(true);
    await expect(budget.tryConsume(10)).resolves.toBe(false);
    await expect(budget.tryConsume(5)).resolves.toBe(true);
    expect(CONSUME_CREDITS_SCRIPT).toContain("redis.call('DECRBY', KEYS[1], ARGV[1])");
  });

  it('RedisCreditBudget : voie watch → deux compteurs (global + voie) dans un seul script, lecture de l’usage', async () => {
    const redis = {
      eval: jest.fn(async (...args: unknown[]) => (args.length > 0 ? 1 : 0)),
      get: jest.fn(async (key: string) => (key.startsWith('helius:credits:watch:') ? '42' : '100')),
    };
    const budget = new RedisCreditBudget(redis as unknown as ConstructorParameters<typeof RedisCreditBudget>[0], 22_000, undefined, 12_000);
    await expect(budget.tryConsume(3, 'watch')).resolves.toBe(true);
    const [script, keys, globalKey, laneKey, credits, globalLimit, laneLimit] = redis.eval.mock.calls[0] ?? [];
    expect(script).toBe(CONSUME_LANE_CREDITS_SCRIPT);
    expect(keys).toBe(2);
    expect(globalKey).toMatch(/^helius:credits:\d{4}-\d{2}-\d{2}$/);
    expect(laneKey).toMatch(/^helius:credits:watch:\d{4}-\d{2}-\d{2}$/);
    expect([credits, globalLimit, laneLimit]).toEqual(['3', '22000', '12000']);
    await expect(budget.used('watch')).resolves.toBe(42);
    await expect(budget.used('interactive')).resolves.toBe(100);
    expect(budget.limit('watch')).toBe(12_000);
    expect(CONSUME_LANE_CREDITS_SCRIPT).toContain("redis.call('DECRBY', KEYS[2], ARGV[1])");
  });

  it('RedisCreditBudget : voie watch en mémoire plafonnée à part', async () => {
    const budget = new RedisCreditBudget(null, 10, undefined, 4);
    await expect(budget.tryConsume(4, 'watch')).resolves.toBe(true);
    await expect(budget.tryConsume(1, 'watch')).resolves.toBe(false);
    await expect(budget.tryConsume(6, 'interactive')).resolves.toBe(true);
    await expect(budget.tryConsume(1, 'interactive')).resolves.toBe(false);
    await expect(budget.used('watch')).resolves.toBe(0);
  });

  it('RedisCreditBudget : voie wallet → compteur helius:credits:wallet:<jour> plafonné à part', async () => {
    const redis = {
      eval: jest.fn(async () => 1),
      get: jest.fn(async (key: string) => (key.startsWith('helius:credits:wallet:') ? '7' : '0')),
    };
    const budget = new RedisCreditBudget(redis as unknown as ConstructorParameters<typeof RedisCreditBudget>[0], 22_000, undefined, 12_000, 3_000);
    await expect(budget.tryConsume(54, 'wallet')).resolves.toBe(true);
    const [script, keys, , laneKey, credits, globalLimit, laneLimit] = (redis.eval.mock.calls[0] ?? []) as unknown[];
    expect(script).toBe(CONSUME_LANE_CREDITS_SCRIPT);
    expect(keys).toBe(2);
    expect(laneKey).toMatch(/^helius:credits:wallet:\d{4}-\d{2}-\d{2}$/);
    expect([credits, globalLimit, laneLimit]).toEqual(['54', '22000', '3000']);
    await expect(budget.used('wallet')).resolves.toBe(7);
    expect(budget.limit('wallet')).toBe(3_000);

    const memory = new RedisCreditBudget(null, 10, undefined, 10, 3);
    await expect(memory.tryConsume(3, 'wallet')).resolves.toBe(true);
    await expect(memory.tryConsume(1, 'wallet')).resolves.toBe(false);
    await expect(memory.tryConsume(7, 'interactive')).resolves.toBe(true);
  });

  it('RedisCreditBudget : Redis en panne ou absent → budget mémoire', async () => {
    const failing = new RedisCreditBudget({ eval: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')), get: jest.fn() }, 10);
    await expect(failing.tryConsume(10)).resolves.toBe(true);
    await expect(failing.tryConsume(1)).resolves.toBe(false);
    await expect(new RedisCreditBudget(null, 1).tryConsume(1)).resolves.toBe(true);
  });
});
