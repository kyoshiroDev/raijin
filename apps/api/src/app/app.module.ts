import { DynamicModule, Module } from '@nestjs/common';
import { ApiAlertsModule } from '@raijin/api-alerts';
import { ApiAnalysisModule } from '@raijin/api-analysis';
import { ApiAuthModule } from '@raijin/api-auth';
import { ApiCoreModule, type AppConfig } from '@raijin/api-core';
import { ApiPrismaModule } from '@raijin/api-prisma';
import { ApiUsersModule } from '@raijin/api-users';
import { ApiWalletModule } from '@raijin/api-wallet';
import { HealthController } from './health.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ApiCoreModule.forRoot(config), ApiPrismaModule, ApiAuthModule, ApiUsersModule, ApiAnalysisModule, ApiAlertsModule, ApiWalletModule],
      controllers: [HealthController],
    };
  }
}
