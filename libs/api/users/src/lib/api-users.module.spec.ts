import { Test } from '@nestjs/testing';
import { ApiUsersModule } from './api-users.module';

describe('ApiUsersModule', () => {
  it('se compile dans un module de test Nest', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiUsersModule] }).compile();
    expect(moduleRef.get(ApiUsersModule)).toBeInstanceOf(ApiUsersModule);
    await moduleRef.close();
  });
});
