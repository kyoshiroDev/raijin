import { DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { BenchPrismaModule } from '@raijin/bench-prisma';
import { createBenchSolana } from '@raijin/bench-solana';
import { PushSender, WebPushSender } from '@raijin/server-push';
import { BenchAuthController } from './auth/auth.controller';
import { BenchAuthService } from './auth/auth.service';
import { BenchAuthStore, PrismaBenchAuthStore } from './auth/auth.store';
import { BenchCookies } from './auth/cookies';
import { BenchCsrfGuard, BenchCsrfService } from './auth/csrf';
import { BenchSessionGuard } from './auth/session.guard';
import type { BenchConfig } from './config/bench-config';
import { BENCH_CLOCK, BENCH_CONFIG, BENCH_SOLANA, BENCH_VERSION, SYSTEM_BENCH_CLOCK, type BenchClock } from './config/tokens';
import { benchThrottlerOptions, BenchThrottlerGuard } from './http/bench-throttler';
import { BenchJobLock, RedisBenchJobLock } from './jobs/job-lock';
import { BenchJobRegistry } from './jobs/job-registry';
import { BenchJobRunner } from './jobs/job-runner.service';
import { BenchJobRunsController } from './jobs/job-runs.controller';
import { JobRunStore, PrismaJobRunStore } from './jobs/job-runs.store';
import { BenchJobScheduler } from './jobs/job-scheduler.service';
import { BenchModeService } from './mode/bench-mode.service';
import { BenchMailSender, BenchNotifier, NullBenchMailSender } from './mode/bench-notifier';
import { BenchRedis } from './redis/bench-redis';
import { BenchEventBus } from './sse/event-bus';
import { BenchEventsController } from './sse/events.controller';
import { BenchHealthController, BenchStatusController } from './status/status.controller';
import { BenchStatusService } from './status/status.service';

export interface BenchCoreOptions {
  /** Configuration validée par `loadBenchConfig` (au démarrage de l'application). */
  readonly config: BenchConfig;
  readonly version: string;
  readonly clock?: BenchClock;
}

const solanaLogger = new Logger('BenchSolana');

/**
 * Socle de l'API du banc (docs/ARCHITECTURE.md §17) : configuration, base `raijin_bench`, Redis préfixé,
 * auth du propriétaire (session + CSRF + limites), jobs BullMQ + `job_runs`, SSE, statut, mode ombre et
 * notifications. Global : les modules métier (T7) injectent `BenchJobRegistry`, `BenchEventBus`,
 * `BenchNotifier`, `BenchModeService`, `BENCH_SOLANA`, `BenchPrismaService` sans réimporter.
 *
 * Gardes globales, dans l'ordre : limites (par IP) → session (401) → CSRF des écritures (403).
 */
@Global()
@Module({})
export class BenchCoreModule {
  static forRoot(options: BenchCoreOptions): DynamicModule {
    const { config } = options;
    return {
      module: BenchCoreModule,
      imports: [
        BenchPrismaModule.forRoot({ databaseUrl: config.databaseUrl }),
        ThrottlerModule.forRootAsync({ useFactory: () => benchThrottlerOptions(config) }),
      ],
      controllers: [BenchHealthController, BenchStatusController, BenchAuthController, BenchEventsController, BenchJobRunsController],
      providers: [
        { provide: BENCH_CONFIG, useValue: config },
        { provide: BENCH_VERSION, useValue: options.version },
        { provide: BENCH_CLOCK, useValue: options.clock ?? SYSTEM_BENCH_CLOCK },
        BenchRedis,
        {
          provide: BENCH_SOLANA,
          inject: [BenchRedis],
          useFactory: (redis: BenchRedis) =>
            createBenchSolana({
              env: config.solanaEnv,
              redis: redis.plain,
              logger: { debug: () => undefined, warn: (event) => solanaLogger.warn(event) },
            }),
        },
        { provide: BenchAuthStore, useClass: PrismaBenchAuthStore },
        { provide: JobRunStore, useClass: PrismaJobRunStore },
        { provide: BenchJobLock, useClass: RedisBenchJobLock },
        { provide: PushSender, useFactory: () => new WebPushSender(config.vapid) },
        { provide: BenchMailSender, useClass: NullBenchMailSender },
        BenchCookies,
        BenchCsrfService,
        BenchAuthService,
        BenchModeService,
        BenchNotifier,
        BenchEventBus,
        BenchJobRegistry,
        BenchJobRunner,
        BenchJobScheduler,
        BenchStatusService,
        { provide: APP_GUARD, useClass: BenchThrottlerGuard },
        { provide: APP_GUARD, useClass: BenchSessionGuard },
        { provide: APP_GUARD, useClass: BenchCsrfGuard },
      ],
      exports: [
        BENCH_CONFIG,
        BENCH_CLOCK,
        BENCH_SOLANA,
        BenchRedis,
        BenchModeService,
        BenchNotifier,
        BenchEventBus,
        BenchJobRegistry,
        BenchJobRunner,
        BenchJobScheduler,
        JobRunStore,
        BenchStatusService,
        PushSender,
        BenchMailSender,
      ],
    };
  }
}
