import { Test } from '@nestjs/testing';
import { ApiTrialModule } from './api-trial.module';

describe('ApiTrialModule', () => {
  it('se compile dans un module de test Nest', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiTrialModule] }).compile();
    expect(moduleRef.get(ApiTrialModule)).toBeInstanceOf(ApiTrialModule);
    await moduleRef.close();
  });
});
