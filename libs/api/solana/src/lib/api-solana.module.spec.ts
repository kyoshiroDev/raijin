import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiSolanaModule, SOLANA_DATA_OPTIONS } from './api-solana.module';
import { SolanaDataService } from './solana-data.service';

@Injectable()
class FakeConfig {
  readonly heliusApiKey = null;
}

@Module({ providers: [FakeConfig], exports: [FakeConfig] })
class FakeConfigModule {}

describe('ApiSolanaModule', () => {
  it('forRoot : fournit SolanaDataService (sans clé Helius)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiSolanaModule.forRoot({ config: { collectDeadlineMs: 5_000 } })] }).compile();
    const service = moduleRef.get(SolanaDataService);
    expect(service).toBeInstanceOf(SolanaDataService);
    expect(service.heliusConfigured).toBe(false);
    expect(service.config.collectDeadlineMs).toBe(5_000);
    await moduleRef.close();
  });

  it('forRootAsync : options issues d’une fabrique injectée', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ApiSolanaModule.forRootAsync({
          imports: [FakeConfigModule],
          inject: [FakeConfig],
          useFactory: (config: FakeConfig) => ({ heliusApiKey: config.heliusApiKey, config: { sellTestAmountUsd: 50 } }),
        }),
      ],
    }).compile();
    expect(moduleRef.get(SolanaDataService).config.sellTestAmountUsd).toBe(50);
    expect(moduleRef.get(SOLANA_DATA_OPTIONS)).toMatchObject({ heliusApiKey: null });
    await moduleRef.close();
  });
});
