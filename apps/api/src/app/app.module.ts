import { DynamicModule, Module } from '@nestjs/common';
import { ApiAnalysisModule } from '@raijin/api-analysis';
import { ApiAuthModule } from '@raijin/api-auth';
import { ApiCoreModule, type AppConfig } from '@raijin/api-core';
import { ApiPrismaModule } from '@raijin/api-prisma';
import { ApiUsersModule } from '@raijin/api-users';
import { HealthController } from './health.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ApiCoreModule.forRoot(config), ApiPrismaModule, ApiAuthModule, ApiUsersModule, ApiAnalysisModule],
      controllers: [HealthController],
    };
  }
}
