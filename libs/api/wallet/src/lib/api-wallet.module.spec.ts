import { Test } from '@nestjs/testing';
import { join } from 'node:path';
import { ApiCoreModule, testConfig } from '@raijin/api-core';
import { ApiPrismaModule } from '@raijin/api-prisma';
import { ApiWalletModule } from './api-wallet.module';
import { WalletDataSource } from './ports/wallet-data-source';
import { WalletScanService } from './scan/wallet-scan.service';
import { SolanaWalletDataSource } from './solana/solana-wallet-data-source';

describe('ApiWalletModule', () => {
  it('se compile avec le socle ; source Solana réelle hors fixtures', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiCoreModule.forRoot(testConfig()), ApiPrismaModule, ApiWalletModule] }).compile();
    expect(moduleRef.get(WalletScanService)).toBeInstanceOf(WalletScanService);
    expect(moduleRef.get(WalletDataSource)).toBeInstanceOf(SolanaWalletDataSource);
    await moduleRef.close();
  });

  it('mode fixtures (ANALYSIS_FIXTURES=1) : collecte réelle rejouée avec clé Helius factice, sans réseau', async () => {
    const config = testConfig({ ANALYSIS_FIXTURES: '1', ANALYSIS_FIXTURES_DIR: join(__dirname, '..', '..', '..', 'solana', 'src', 'fixtures') });
    const moduleRef = await Test.createTestingModule({ imports: [ApiCoreModule.forRoot(config), ApiPrismaModule, ApiWalletModule] }).compile();
    const source = moduleRef.get(WalletDataSource);
    expect(source).toBeInstanceOf(SolanaWalletDataSource);
    expect(source.heliusConfigured).toBe(true);
    await moduleRef.close();
  });
});
