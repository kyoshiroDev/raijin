import { Logger, Module } from '@nestjs/common';
import { AnalysisService, ApiAnalysisModule, WATCH_SOLANA_DATA } from '@raijin/api-analysis';
import { ApiAuthModule } from '@raijin/api-auth';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { ApiNotificationsModule } from '@raijin/api-notifications';
import type { SolanaDataService } from '@raijin/api-solana';
import { ModuleRef } from '@nestjs/core';
import { AlertsService } from './alerts/alerts.service';
import { AlertDeliveryService } from './delivery/alert-delivery.service';
import { WeeklyDigestService } from './digest/weekly-digest.service';
import { AlertsController, NotificationsController, PushController, WatchesController } from './http/controllers';
import { InternalController } from './http/internal.controller';
import { BullJobQueue } from './jobs/bullmq-runtime.service';
import { JobHandlers } from './jobs/job-handlers.service';
import { DisabledJobQueue, JobQueue } from './jobs/job-queue';
import { JobRunService } from './jobs/job-run.service';
import { JobRegistry } from './jobs/job-registry';
import { NotificationSettingsService } from './notifications/notification-settings.service';
import { PlanLimitsService } from './plan/plan-limits.service';
import { PurgeService } from './purge/purge.service';
import { PushSubscriptionsService } from './push/push-subscriptions.service';
import { EventRecorderService } from './watch/event-recorder.service';
import { MintStateService } from './watch/mint-state.service';
import { WatchPlannerService } from './watch/planner.service';
import { WatchPassesService } from './watch/watch-passes.service';
import { WATCH_SOURCES, WatchAnalyzer } from './watch/watch-sources';
import { WatchesService } from './watches/watches.service';

/** BullMQ si les jobs sont activés et Redis configuré ; sinon aucune mise en file (tests, dev sans Redis). */
export function createJobQueue(config: AppConfig, moduleRef: ModuleRef): JobQueue {
  if (config.jobs.enabled && config.redisUrl) return new BullJobQueue(config, moduleRef);
  new Logger('Jobs').warn('Jobs désactivés (JOBS_ENABLED=false ou REDIS_URL absente) : aucune réanalyse ni envoi programmé.');
  return new DisabledJobQueue();
}

/**
 * Suivis, alertes, préférences et push (PROMPT.md §4.2, §4.4 ; docs/ARCHITECTURE.md §11) :
 * routes `watches`, `alerts`, `notifications`, `push`, `internal` (tests), jobs BullMQ (planificateur,
 * passes, envois, résumé hebdomadaire, purges). Requiert `ApiCoreModule` et `ApiPrismaModule` (globaux).
 */
@Module({
  imports: [ApiAuthModule, ApiAnalysisModule, ApiNotificationsModule],
  controllers: [WatchesController, AlertsController, NotificationsController, PushController, InternalController],
  providers: [
    { provide: JobQueue, inject: [APP_CONFIG, ModuleRef], useFactory: createJobQueue },
    { provide: WATCH_SOURCES, inject: [WATCH_SOLANA_DATA], useFactory: (solana: SolanaDataService) => solana },
    { provide: WatchAnalyzer, useExisting: AnalysisService },
    PlanLimitsService,
    MintStateService,
    WatchesService,
    AlertsService,
    NotificationSettingsService,
    PushSubscriptionsService,
    EventRecorderService,
    WatchPassesService,
    WatchPlannerService,
    AlertDeliveryService,
    WeeklyDigestService,
    PurgeService,
    JobRunService,
    JobHandlers,
    JobRegistry,
  ],
  exports: [WatchesService, PlanLimitsService, JobQueue, JobRegistry, JobRunService],
})
export class ApiAlertsModule {}
