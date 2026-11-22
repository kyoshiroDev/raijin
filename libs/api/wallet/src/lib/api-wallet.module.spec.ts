import { Test } from '@nestjs/testing';
import { ApiWalletModule } from './api-wallet.module';

describe('ApiWalletModule', () => {
  it('se compile (squelette de la phase 5)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiWalletModule] }).compile();
    expect(moduleRef.get(ApiWalletModule)).toBeInstanceOf(ApiWalletModule);
    await moduleRef.close();
  });
});
