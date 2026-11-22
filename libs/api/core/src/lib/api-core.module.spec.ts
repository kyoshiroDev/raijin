import { Test } from '@nestjs/testing';
import { ApiCoreModule } from './api-core.module';

describe('ApiCoreModule', () => {
  it('se compile dans un module de test Nest', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiCoreModule] }).compile();
    expect(moduleRef.get(ApiCoreModule)).toBeInstanceOf(ApiCoreModule);
    await moduleRef.close();
  });
});
