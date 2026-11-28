import { Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { RedisUsageCounterStore } from '@raijin/api-analytics';
import { ApiAuthModule } from '@raijin/api-auth';
import { APP_CONFIG, errorCode, raijinRedisOptions, type AppConfig } from '@raijin/api-core';
import {
  loadSolanaDataConfig,
  MemoryCacheStore,
  resolveSolanaDataConfig,
  SolanaDataService,
  UPSTREAM_IDS,
  type SolanaDataConfig,
  type SolanaDataOptions,
} from '@raijin/api-solana';
import { createFixtureFetch, fixtureSequenceNames, loadAllFixtures, loadFixtureSequence } from '@raijin/api-solana/testing';
import Redis from 'ioredis';
import { join } from 'node:path';
import { AnalysisRepository } from './analysis/analysis.repository';
import { AnalysisService } from './analysis/analysis.service';
import { FixtureScenarios, holderSoldMintFixture } from './fixtures/fixture-scenarios';
import { DefaultRiskEngine, RiskEngine } from './analysis/risk-engine.provider';
import { AnalysisController } from './http/analysis.controller';
import { ShareController } from './http/share.controller';
import { OgImageService } from './og/og-image.service';
import { AnalysisClock, FactsCollector, SystemClock } from './ports/facts-collector';
import { QuotaService } from './quota/quota.service';
import { SharePageService } from './share/share-page.service';
import { RedisCreditBudget, SolanaCacheStore } from './solana/redis-ports';
import { NestSolanaLogger, SolanaFactsCollector } from './solana/solana-facts-collector';
import { KeyValueStore, MemoryKeyValueStore, RedisKeyValueStore } from './store/key-value-store';

/**
 * `SolanaDataService` des passes de suivi. Hors fixtures : la même instance que l'analyse (files de
 * débit et budget partagés). En mode fixtures : une instance avec une clé Helius factice (non secrète)
 * pour rejouer aussi les fixtures Helius (holders), sur les mêmes scénarios en séquence.
 */
export const WATCH_SOLANA_DATA = Symbol('WATCH_SOLANA_DATA');
/** Clé fictive du mode fixtures (aucun appel réseau : le `fetch` rejoue les enregistrements). */
export const FIXTURE_HELIUS_KEY = 'fixture-mode-no-network';

/** Scénarios en séquence du mode fixtures ; `null` hors de ce mode. */
export function createFixtureScenarios(config: AppConfig): FixtureScenarios | null {
  if (!config.analysis.fixtures || config.isProduction) return null;
  const dir = fixturesDir(config);
  const sequences = Object.fromEntries(fixtureSequenceNames(dir).map((name) => [name, loadFixtureSequence(name, dir)]));
  const extra = holderSoldMintFixture(sequences);
  return new FixtureScenarios(sequences, [...loadAllFixtures(dir), ...(extra ? [extra] : [])]);
}

function fixturesDir(config: AppConfig): string {
  return config.analysis.fixturesDir ?? join(process.cwd(), 'libs', 'api', 'solana', 'src', 'fixtures');
}

/** Connexion Redis de l'analyse (cache, verrous, quota, budget Helius) ; `null` sans `REDIS_URL`. */
export const ANALYSIS_REDIS = Symbol('ANALYSIS_REDIS');

export function createAnalysisRedis(config: AppConfig): Redis | null {
  if (!config.redisUrl) return null;
  const redis = new Redis(config.redisUrl, raijinRedisOptions());
  const logger = new Logger('AnalysisRedis');
  let lastWarning = 0;
  redis.on('error', (error: Error) => {
    const now = Date.now();
    if (now - lastWarning > 60_000) {
      lastWarning = now;
      logger.warn(`Redis indisponible (${errorCode(error)})`);
    }
  });
  return redis;
}

/**
 * Budget de crédits Helius par jour UTC, partagé par l'analyse (voie `interactive`), les suivis
 * (voie `watch`, plafond `WATCH_DAILY_CREDIT_BUDGET`) et les scans de wallet (voie `wallet`, plafond
 * `WALLET_DAILY_CREDIT_BUDGET`). Une instance par processus.
 */
export function createCreditBudget(config: AppConfig, redis: Redis | null): RedisCreditBudget {
  const { config: solanaConfig } = loadSolanaDataConfig(process.env);
  return new RedisCreditBudget(redis, solanaConfig.heliusDailyCreditBudget, undefined, config.watch.dailyCreditBudget, config.wallet.dailyCreditBudget);
}

/**
 * Réglages du mode fixtures seulement : réponses locales, donc aucun débit à protéger ; une source
 * sans fixture échoue immédiatement (une tentative, délai court) au lieu d'attendre délais et rejeux.
 */
export function fixtureModeConfig(base: SolanaDataConfig): SolanaDataConfig {
  const limits = Object.fromEntries(UPSTREAM_IDS.map((id) => [id, { ratePerSecond: 1_000, maxQueue: 100, timeoutMs: 500 }]));
  return resolveSolanaDataConfig({ ...base, maxAttempts: 1, backoffBaseMs: 0, limits });
}

/**
 * Options de `SolanaDataService` (une instance par processus : files de débit partagées).
 * `ANALYSIS_FIXTURES=1` (jamais en production) : rejeu des enregistrements de `@raijin/api-solana`,
 * sans clé Helius ni réseau. Sinon : configuration de l'environnement (docs/ENV.md), caches par
 * source et budget de crédits Helius dans Redis.
 */
export function solanaDataOptions(
  config: AppConfig,
  store: KeyValueStore,
  redis: Redis | null,
  creditBudget: RedisCreditBudget = createCreditBudget(config, redis),
  scenarios: FixtureScenarios | null = null,
  heliusOverride: string | null = null,
): SolanaDataOptions {
  const { config: solanaConfig, heliusApiKey } = loadSolanaDataConfig(process.env);
  const logger = new NestSolanaLogger();
  if (config.analysis.fixtures && !config.isProduction) {
    // Rejeu appelé uniquement dans ce mode (import statique imposé par les frontières Nx : une lib ne
    // peut pas être importée à la fois statiquement et à la demande) ; aucun fichier lu sinon.
    const replayConfig = fixtureModeConfig(solanaConfig);
    const source = scenarios ? () => scenarios.current() : loadAllFixtures(fixturesDir(config));
    return {
      config: replayConfig,
      heliusApiKey: heliusOverride,
      fetch: createFixtureFetch(source, replayConfig).fetch,
      cache: new MemoryCacheStore(),
      logger,
    };
  }
  return {
    config: solanaConfig,
    heliusApiKey,
    cache: new SolanaCacheStore(store),
    creditBudget,
    ...(redis ? { usageStore: new RedisUsageCounterStore(redis) } : {}),
    logger,
  };
}

/**
 * Analyse de token : `POST analyses`, `GET analyses/quota`, `GET analyses/:mint/latest`,
 * `GET share/t/:mint`, `GET og/:mint.png`. Requiert `ApiCoreModule` et `ApiPrismaModule` (globaux).
 */
@Module({
  imports: [ApiAuthModule],
  controllers: [AnalysisController, ShareController],
  providers: [
    { provide: AnalysisClock, useClass: SystemClock },
    { provide: RiskEngine, useClass: DefaultRiskEngine },
    { provide: ANALYSIS_REDIS, inject: [APP_CONFIG], useFactory: createAnalysisRedis },
    {
      provide: KeyValueStore,
      inject: [ANALYSIS_REDIS],
      useFactory: (redis: Redis | null): KeyValueStore => (redis ? new RedisKeyValueStore(redis) : new MemoryKeyValueStore()),
    },
    { provide: RedisCreditBudget, inject: [APP_CONFIG, ANALYSIS_REDIS], useFactory: createCreditBudget },
    { provide: FixtureScenarios, inject: [APP_CONFIG], useFactory: createFixtureScenarios },
    {
      provide: SolanaDataService,
      inject: [APP_CONFIG, KeyValueStore, ANALYSIS_REDIS, RedisCreditBudget, FixtureScenarios],
      useFactory: (config: AppConfig, store: KeyValueStore, redis: Redis | null, budget: RedisCreditBudget, scenarios: FixtureScenarios | null) =>
        new SolanaDataService(solanaDataOptions(config, store, redis, budget, scenarios)),
    },
    {
      provide: WATCH_SOLANA_DATA,
      inject: [APP_CONFIG, KeyValueStore, ANALYSIS_REDIS, RedisCreditBudget, FixtureScenarios, SolanaDataService],
      useFactory: (
        config: AppConfig,
        store: KeyValueStore,
        redis: Redis | null,
        budget: RedisCreditBudget,
        scenarios: FixtureScenarios | null,
        shared: SolanaDataService,
      ) => (scenarios ? new SolanaDataService(solanaDataOptions(config, store, redis, budget, scenarios, FIXTURE_HELIUS_KEY)) : shared),
    },
    { provide: FactsCollector, inject: [SolanaDataService], useFactory: (solana: SolanaDataService) => new SolanaFactsCollector(solana) },
    AnalysisRepository,
    AnalysisService,
    QuotaService,
    SharePageService,
    OgImageService,
  ],
  exports: [
    AnalysisService,
    QuotaService,
    FactsCollector,
    KeyValueStore,
    SolanaDataService,
    WATCH_SOLANA_DATA,
    RedisCreditBudget,
    FixtureScenarios,
    ANALYSIS_REDIS,
    AnalysisClock,
  ],
})
export class ApiAnalysisModule implements OnApplicationShutdown {
  constructor(private readonly store: KeyValueStore) {}

  onApplicationShutdown(): void {
    this.store.close();
  }
}
