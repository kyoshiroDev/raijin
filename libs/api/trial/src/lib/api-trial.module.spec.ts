import { Test } from '@nestjs/testing';
import { JobRegistry } from '@raijin/api-alerts';
import { ApiCoreModule, testConfig } from '@raijin/api-core';
import { ApiPrismaModule } from '@raijin/api-prisma';
import { ApiTrialModule } from './api-trial.module';
import { TrialLifecycleService } from './trial-lifecycle.service';

describe('ApiTrialModule', () => {
  it('se compile avec le socle et déclare ses jobs (trial-tick, trial-email)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiCoreModule.forRoot(testConfig()), ApiPrismaModule, ApiTrialModule] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(TrialLifecycleService)).toBeInstanceOf(TrialLifecycleService);
    const registry = moduleRef.get(JobRegistry, { strict: false });
    expect(registry.get('trial-tick')?.queue).toBe('maintenance');
    expect(registry.get('trial-email')?.queue).toBe('notify');
    await moduleRef.close();
  });
});
