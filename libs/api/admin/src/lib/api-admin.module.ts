import { DynamicModule, Inject, Module, OnApplicationShutdown, OnModuleInit, type ModuleMetadata } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ApiAlertsModule } from '@raijin/api-alerts';
import { ApiAnalysisModule } from '@raijin/api-analysis';
import { ApiAnalyticsModule } from '@raijin/api-analytics';
import { ApiAuthModule } from '@raijin/api-auth';
import { APP_CONFIG } from '@raijin/api-core';
import { ApiNotificationsModule, Mailer } from '@raijin/api-notifications';
import { SolanaDataService, UpstreamUsageReader } from '@raijin/api-solana';
import { TrialConversionService } from '@raijin/api-trial';
import { AdminAlertsJob } from './alerts/admin-alerts.job';
import { AdminClock } from './common/admin-clock';
import { AdminStore, createAdminStore } from './common/admin-store';
import { HealthService } from './health/health.service';
import { JobHealthReader } from './health/job-health';
import { AdminReportsController } from './http/admin-reports.controller';
import { countMailer, DailyCounters, RequestMetricsInterceptor } from './metrics/daily-counters';
import { MetricsAggregateJob } from './metrics/metrics-aggregate.job';
import { MetricsCalculator } from './metrics/metrics-calculator';
import { MetricsReader } from './metrics/metrics-reader';
import { BusinessReportsService } from './reports/business-reports.service';
import { GoogleReportsService } from './reports/google-reports.service';
import { OverviewService } from './reports/overview.service';
import { AdminUsersModule } from './users/admin-users.module';

export interface ApiAdminModuleOptions {
  /**
   * Modules qui fournissent `BILLING_CONFIG` et `BillingProvider` (l'instance d'`ApiBillingModule.forRoot` de l'app).
   */
  readonly imports?: ModuleMetadata['imports'];
}

/**
 * Espace admin côté API (PROMPT.md §4.7, docs/ARCHITECTURE.md §14) : utilisateurs et audit (`AdminUsersModule`,
 * nestjs-api), écrans statistiques (`admin/overview|traffic|seo|
 * acquisition|revenue|trials|product|health`, tous sous `@AdminRoute()`), agrégats nocturnes `DailyMetric`
 * (`metrics-aggregate`), alertes admin (`admin-alerts`, e-mail + push), compteurs techniques journaliers (requêtes et
 * 5xx de l'API par un intercepteur global, e-mails envoyés / en échec par décoration du `Mailer`).
 * Requiert `ApiCoreModule` et `ApiPrismaModule` (globaux).
 */
@Module({})
export class ApiAdminModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly mailer: Mailer,
    private readonly counters: DailyCounters,
    @Inject(AdminStore) private readonly store: AdminStore,
  ) {}

  static forRoot(options: ApiAdminModuleOptions = {}): DynamicModule {
    return {
      module: ApiAdminModule,
      imports: [ApiAuthModule, ApiAlertsModule, ApiNotificationsModule, ApiAnalysisModule, ApiAnalyticsModule.forRoot(), AdminUsersModule, ...(options.imports ?? [])],
      controllers: [AdminReportsController],
      providers: [
        { provide: AdminStore, inject: [APP_CONFIG], useFactory: createAdminStore },
        { provide: UpstreamUsageReader, inject: [SolanaDataService], useFactory: (solana: SolanaDataService) => solana.usage },
        { provide: APP_INTERCEPTOR, useClass: RequestMetricsInterceptor },
        AdminClock,
        DailyCounters,
        MetricsCalculator,
        MetricsReader,
        MetricsAggregateJob,
        JobHealthReader,
        HealthService,
        AdminAlertsJob,
        OverviewService,
        GoogleReportsService,
        BusinessReportsService,
        TrialConversionService,
      ],
      exports: [MetricsAggregateJob, AdminAlertsJob, DailyCounters],
    };
  }

  /** Compte les e-mails envoyés et en échec sur l'instance partagée du `Mailer`. */
  onModuleInit(): void {
    countMailer(this.mailer, this.counters);
  }

  onApplicationShutdown(): void {
    this.store.close();
  }
}
