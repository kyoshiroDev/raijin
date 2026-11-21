import { Test } from '@nestjs/testing';
import { ApiAlertsModule } from './api-alerts.module';

describe('ApiAlertsModule', () => {
  it('se compile dans un module de test Nest', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiAlertsModule] }).compile();
    expect(moduleRef.get(ApiAlertsModule)).toBeInstanceOf(ApiAlertsModule);
    await moduleRef.close();
  });
});
