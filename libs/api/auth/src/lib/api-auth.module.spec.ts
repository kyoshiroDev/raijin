import { Test } from '@nestjs/testing';
import { ApiAuthModule } from './api-auth.module';

describe('ApiAuthModule', () => {
  it('se compile dans un module de test Nest', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiAuthModule] }).compile();
    expect(moduleRef.get(ApiAuthModule)).toBeInstanceOf(ApiAuthModule);
    await moduleRef.close();
  });
});
