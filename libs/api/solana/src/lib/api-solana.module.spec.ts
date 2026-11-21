import { Test } from '@nestjs/testing';
import { ApiSolanaModule } from './api-solana.module';

describe('ApiSolanaModule', () => {
  it('se compile dans un module de test Nest', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiSolanaModule] }).compile();
    expect(moduleRef.get(ApiSolanaModule)).toBeInstanceOf(ApiSolanaModule);
    await moduleRef.close();
  });
});
