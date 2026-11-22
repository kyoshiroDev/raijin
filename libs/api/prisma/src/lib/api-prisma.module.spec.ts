import { Test } from '@nestjs/testing';
import { ApiPrismaModule } from './api-prisma.module';

describe('ApiPrismaModule', () => {
  it('se compile dans un module de test Nest', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiPrismaModule] }).compile();
    expect(moduleRef.get(ApiPrismaModule)).toBeInstanceOf(ApiPrismaModule);
    await moduleRef.close();
  });
});
