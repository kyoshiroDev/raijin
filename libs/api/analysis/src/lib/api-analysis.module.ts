import { Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ApiAuthModule } from '@raijin/api-auth';
import { APP_CONFIG, errorCode, type AppConfig } from '@raijin/api-core';
import {
  loadSolanaDataConfig,
  MemoryCacheStore,
  resolveSolanaDataConfig,
  SolanaDataService,
  UPSTREAM_IDS,
  type SolanaDataConfig,
  type SolanaDataOptions,
} from '@raijin/api-solana';
import { createFixtureFetch, loadAllFixtures } from '@raijin/api-solana/testing';
import Redis from 'ioredis';
import { join } from 'node:path';
import { AnalysisRepository } from './analysis/analysis.repository';
import { AnalysisService } from './analysis/analysis.service';
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

/** Connexion Redis de l'analyse (cache, verrous, quota, budget Helius) ; `null` sans `REDIS_URL`. */
export const ANALYSIS_REDIS = Symbol('ANALYSIS_REDIS');

export function createAnalysisRedis(config: AppConfig): Redis | null {
  if (!config.redisUrl) return null;
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 });
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
export function solanaDataOptions(config: AppConfig, store: KeyValueStore, redis: Redis | null): SolanaDataOptions {
  const { config: solanaConfig, heliusApiKey } = loadSolanaDataConfig(process.env);
  const logger = new NestSolanaLogger();
  if (config.analysis.fixtures && !config.isProduction) {
    const dir = config.analysis.fixturesDir ?? join(process.cwd(), 'libs', 'api', 'solana', 'src', 'fixtures');
    // Rejeu appelé uniquement dans ce mode (import statique imposé par les frontières Nx : une lib ne
    // peut pas être importée à la fois statiquement et à la demande) ; aucun fichier lu sinon.
    const replayConfig = fixtureModeConfig(solanaConfig);
    return {
      config: replayConfig,
      heliusApiKey: null,
      fetch: createFixtureFetch(loadAllFixtures(dir), replayConfig).fetch,
      cache: new MemoryCacheStore(),
      logger,
    };
  }
  return {
    config: solanaConfig,
    heliusApiKey,
    cache: new SolanaCacheStore(store),
    creditBudget: new RedisCreditBudget(redis, solanaConfig.heliusDailyCreditBudget),
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
    {
      provide: SolanaDataService,
      inject: [APP_CONFIG, KeyValueStore, ANALYSIS_REDIS],
      useFactory: (config: AppConfig, store: KeyValueStore, redis: Redis | null) =>
        new SolanaDataService(solanaDataOptions(config, store, redis)),
    },
    { provide: FactsCollector, inject: [SolanaDataService], useFactory: (solana: SolanaDataService) => new SolanaFactsCollector(solana) },
    AnalysisRepository,
    AnalysisService,
    QuotaService,
    SharePageService,
    OgImageService,
  ],
  exports: [AnalysisService, QuotaService, KeyValueStore, SolanaDataService],
})
export class ApiAnalysisModule implements OnApplicationShutdown {
  constructor(private readonly store: KeyValueStore) {}

  onApplicationShutdown(): void {
    this.store.close();
  }
}
