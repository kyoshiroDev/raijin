import { Test } from '@nestjs/testing';
import { ApiCoreModule, testConfig } from '@raijin/api-core';
import { ApiPrismaModule } from '@raijin/api-prisma';
import { ApiAlertsModule } from './api-alerts.module';
import { DisabledJobQueue, JobQueue } from './jobs/job-queue';
import { WatchesService } from './watches/watches.service';

describe('ApiAlertsModule', () => {
  it('se compile avec le socle ; jobs désactivés en test (aucun Redis)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiCoreModule.forRoot(testConfig()), ApiPrismaModule, ApiAlertsModule] }).compile();
    expect(moduleRef.get(JobQueue)).toBeInstanceOf(DisabledJobQueue);
    expect(moduleRef.get(WatchesService)).toBeInstanceOf(WatchesService);
  });
});
