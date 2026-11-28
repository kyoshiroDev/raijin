import { Test } from '@nestjs/testing';
import { ApiCoreModule, testConfig } from '@raijin/api-core';
import { ApiPrismaModule, PrismaService } from '@raijin/api-prisma';
import { loadSolanaDataConfig, MemoryCacheStore, type SolanaDataConfig } from '@raijin/api-solana';
import { join } from 'node:path';
import { ApiAnalysisModule, createAnalysisRedis, solanaDataOptions } from './api-analysis.module';
import { AnalysisService } from './analysis/analysis.service';
import { FactsCollector } from './ports/facts-collector';
import { RedisCreditBudget, SolanaCacheStore } from './solana/redis-ports';
import { SolanaFactsCollector } from './solana/solana-facts-collector';
import { MemoryKeyValueStore } from './store/key-value-store';

const FIXTURES_DIR = join(__dirname, '../../../solana/src/fixtures');

describe('ApiAnalysisModule', () => {
  it('se compile avec le socle (Prisma simulé) et branche le vrai collecteur Solana', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ApiCoreModule.forRoot(testConfig({ ANALYSIS_FIXTURES: '1', ANALYSIS_FIXTURES_DIR: FIXTURES_DIR })), ApiPrismaModule, ApiAnalysisModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    expect(moduleRef.get(AnalysisService)).toBeInstanceOf(AnalysisService);
    expect(moduleRef.get(FactsCollector)).toBeInstanceOf(SolanaFactsCollector);
    await moduleRef.close();
  });

  it('fixtures : rejeu sans clé Helius ni cache partagé ; sinon caches et budget Helius dans Redis', () => {
    const store = new MemoryKeyValueStore();
    const fixtures = solanaDataOptions(testConfig({ ANALYSIS_FIXTURES: '1', ANALYSIS_FIXTURES_DIR: FIXTURES_DIR }), store, null);
    expect(fixtures.heliusApiKey).toBeNull();
    expect(fixtures.fetch).toBeDefined();
    expect(fixtures.cache).toBeInstanceOf(MemoryCacheStore);
    // Mode fixtures seulement : une tentative, délai court, aucun débit limité.
    const fixtureConfig = fixtures.config as SolanaDataConfig;
    expect(fixtureConfig.maxAttempts).toBe(1);
    expect(fixtureConfig.limits.solana_rpc).toMatchObject({ ratePerSecond: 1_000, timeoutMs: 500 });
    const real = solanaDataOptions(testConfig(), store, null);
    expect(real.fetch).toBeUndefined();
    const fromEnv = loadSolanaDataConfig(process.env).config;
    expect((real.config as SolanaDataConfig).maxAttempts).toBe(fromEnv.maxAttempts);
    expect((real.config as SolanaDataConfig).limits.solana_rpc).toEqual(fromEnv.limits.solana_rpc);
    expect(real.cache).toBeInstanceOf(SolanaCacheStore);
    expect(real.creditBudget).toBeInstanceOf(RedisCreditBudget);
  });

  it('sans REDIS_URL : pas de connexion ; avec : client ioredis', () => {
    expect(createAnalysisRedis(testConfig())).toBeNull();
    const redis = createAnalysisRedis(testConfig({ REDIS_URL: 'redis://127.0.0.1:1' }));
    expect(redis).not.toBeNull();
    redis?.disconnect();
  });
});
