import { DynamicModule, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, errorCode, raijinRedisOptions, type AppConfig } from '@raijin/api-core';
import Redis from 'ioredis';
import { AnalyticsService, REPORT_SOURCES, type ReportSources } from './analytics.service';
import { AnalyticsCache, MemoryAnalyticsCache, RedisAnalyticsCache } from './cache/analytics-cache';
import { ANALYTICS_CONFIG, analyticsConfigFrom, type AnalyticsConfig } from './config/analytics-config';
import { createReportSources } from './reports/sources';

/** Cache Redis des réponses Google (connexion dédiée, échec rapide) ; mémoire sans `REDIS_URL`. */
export function createAnalyticsCache(app: AppConfig): AnalyticsCache {
  if (!app.redisUrl) return new MemoryAnalyticsCache();
  const redis = new Redis(app.redisUrl, raijinRedisOptions());
  const logger = new Logger('AnalyticsRedis');
  let lastWarning = 0;
  redis.on('error', (error: Error) => {
    if (Date.now() - lastWarning > 60_000) {
      lastWarning = Date.now();
      logger.warn(`Redis indisponible (${errorCode(error)})`);
    }
  });
  return new RedisAnalyticsCache(redis);
}

/**
 * Accès Google de l'admin (PROMPT.md §4.7, docs/ARCHITECTURE.md §14.6) : GA4 Data API et Search Console par un compte
 * de service en lecture seule, sans SDK (JWT RS256 `node:crypto` + REST), cache Redis 1 h, simulation déterministe.
 * Ne dépend que d'`api-core` (aucune base). Requiert `ApiCoreModule` (global).
 *
 * `forRoot(config)` : configuration fournie (tests) ; sans argument, elle est dérivée d'`AppConfig.analytics`
 * (`ANALYTICS_PROVIDER=fake` refusé en production par `loadConfig`).
 */
@Module({})
export class ApiAnalyticsModule implements OnApplicationShutdown {
  constructor(@Inject(AnalyticsCache) private readonly cache: AnalyticsCache) {}

  static forRoot(config?: AnalyticsConfig): DynamicModule {
    return {
      module: ApiAnalyticsModule,
      providers: [
        {
          provide: ANALYTICS_CONFIG,
          inject: [APP_CONFIG],
          useFactory: (app: AppConfig) => config ?? analyticsConfigFrom(app.analytics, (message) => new Logger('Analytics').warn(message)),
        },
        { provide: AnalyticsCache, inject: [APP_CONFIG], useFactory: createAnalyticsCache },
        { provide: REPORT_SOURCES, inject: [ANALYTICS_CONFIG], useFactory: (c: AnalyticsConfig) => createReportSources(c) },
        {
          provide: AnalyticsService,
          inject: [ANALYTICS_CONFIG, AnalyticsCache, REPORT_SOURCES],
          useFactory: (c: AnalyticsConfig, cache: AnalyticsCache, sources: ReportSources) => new AnalyticsService(c, cache, sources),
        },
      ],
      exports: [AnalyticsService, ANALYTICS_CONFIG],
    };
  }

  onApplicationShutdown(): void {
    this.cache.close();
  }
}
