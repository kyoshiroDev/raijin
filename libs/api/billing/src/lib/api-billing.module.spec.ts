import { Test } from '@nestjs/testing';
import { ApiBillingModule } from './api-billing.module';

describe('ApiBillingModule', () => {
  it('se compile dans un module de test Nest', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiBillingModule] }).compile();
    expect(moduleRef.get(ApiBillingModule)).toBeInstanceOf(ApiBillingModule);
    await moduleRef.close();
  });
});
