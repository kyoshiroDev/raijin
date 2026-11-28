import { DynamicModule, Module } from '@nestjs/common';
import { AdminUsersModule, ApiAdminModule } from '@raijin/api-admin';
import { ApiAlertsModule } from '@raijin/api-alerts';
import { ApiAnalysisModule } from '@raijin/api-analysis';
import { ApiAuthModule } from '@raijin/api-auth';
import { ApiBillingModule, BillingAccountCloser, type BillingConfig } from '@raijin/api-billing';
import { ApiCoreModule, type AppConfig } from '@raijin/api-core';
import { ApiPrismaModule } from '@raijin/api-prisma';
import { ApiTrialModule, TrialLifecycleService } from '@raijin/api-trial';
import { ApiUsersModule } from '@raijin/api-users';
import { ApiWalletModule } from '@raijin/api-wallet';
import { HealthController } from './health.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, billing: BillingConfig): DynamicModule {
    // Une seule instance du module d'abonnement, partagée avec la suppression de compte (clôture Stripe).
    const billingModule = ApiBillingModule.forRoot(billing, {
      imports: [ApiTrialModule],
      trialConversion: TrialLifecycleService,
      testRoutes: config.jobs.testTrigger && !config.isProduction,
    });
    return {
      module: AppModule,
      imports: [
        ApiCoreModule.forRoot(config),
        ApiPrismaModule,
        ApiAuthModule,
        ApiUsersModule.forRoot({ imports: [billingModule], billingCloser: BillingAccountCloser }),
        ApiAnalysisModule,
        ApiAlertsModule,
        ApiTrialModule,
        ApiWalletModule,
        billingModule,
        ApiAdminModule.forRoot({ imports: [billingModule, AdminUsersModule] }),
      ],
      controllers: [HealthController],
    };
  }
}
