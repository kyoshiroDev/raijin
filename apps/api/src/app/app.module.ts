import { DynamicModule, Module } from '@nestjs/common';
import { ApiAlertsModule } from '@raijin/api-alerts';
import { ApiAnalysisModule } from '@raijin/api-analysis';
import { ApiAuthModule } from '@raijin/api-auth';
import { ApiBillingModule, type BillingConfig } from '@raijin/api-billing';
import { ApiCoreModule, type AppConfig } from '@raijin/api-core';
import { ApiPrismaModule } from '@raijin/api-prisma';
import { ApiTrialModule, TrialLifecycleService } from '@raijin/api-trial';
import { ApiUsersModule } from '@raijin/api-users';
import { ApiWalletModule } from '@raijin/api-wallet';
import { HealthController } from './health.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, billing: BillingConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ApiCoreModule.forRoot(config), ApiPrismaModule, ApiAuthModule, ApiUsersModule, ApiAnalysisModule, ApiAlertsModule, ApiTrialModule, ApiWalletModule, ApiBillingModule.forRoot(billing, { imports: [ApiTrialModule], trialConversion: TrialLifecycleService })],
      controllers: [HealthController],
    };
  }
}
