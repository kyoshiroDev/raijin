import { Module } from '@nestjs/common';
import { ApiAnalysisModule, FIXTURE_HELIUS_KEY, FixtureScenarios, MemoryKeyValueStore, solanaDataOptions } from '@raijin/api-analysis';
import { ApiAuthModule } from '@raijin/api-auth';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { SolanaDataService } from '@raijin/api-solana';
import { WalletAccessService } from './access/wallet-access.service';
import { WalletScanThrottleGuard } from './http/wallet-scan-throttle.guard';
import { WalletScanController } from './http/wallet-scan.controller';
import { WalletDataSource } from './ports/wallet-data-source';
import { DefaultQuickRiskEngine, QuickRiskEngine } from './scan/quick-verdict';
import { WalletRepository } from './scan/wallet.repository';
import { WalletScanService } from './scan/wallet-scan.service';
import { WalletVerdictsService } from './scan/wallet-verdicts.service';
import { SolanaWalletDataSource } from './solana/solana-wallet-data-source';

/**
 * Source du scan : adaptateur de `@raijin/api-solana` (`listWalletHoldings`, `collectFactsLightBatch`,
 * voie `wallet`) sur l'instance partagée (files de débit et budget communs). En mode
 * `ANALYSIS_FIXTURES=1` (jamais en production) : instance **dédiée** avec clé Helius factice, qui
 * rejoue les fixtures de wallets (DAS, holders compris) sans partager disjoncteurs ni caches avec
 * les passes de suivi rejouées (sinon une fixture absente d'un scan ouvrirait leur disjoncteur).
 */
export function createWalletDataSource(config: AppConfig, shared: SolanaDataService, scenarios: FixtureScenarios | null): WalletDataSource {
  const solana =
    config.analysis.fixtures && !config.isProduction
      ? new SolanaDataService(solanaDataOptions(config, new MemoryKeyValueStore(), null, undefined, scenarios, FIXTURE_HELIUS_KEY))
      : shared;
  return new SolanaWalletDataSource(solana, () => (solana.heliusConfigured ? config.wallet.maxTokens : config.wallet.maxTokensNoKey));
}

/**
 * Scan de wallet en lecture seule (PROMPT.md §4.3, docs/ARCHITECTURE.md §12) : `POST wallet-scans`,
 * `GET wallet-scans/quota`. Requiert `ApiCoreModule` et `ApiPrismaModule` (globaux) ; réutilise le
 * stockage Redis, le quota et la collecte de `ApiAnalysisModule`.
 */
@Module({
  imports: [ApiAuthModule, ApiAnalysisModule],
  controllers: [WalletScanController],
  providers: [
    { provide: QuickRiskEngine, useClass: DefaultQuickRiskEngine },
    { provide: WalletDataSource, inject: [APP_CONFIG, SolanaDataService, FixtureScenarios], useFactory: createWalletDataSource },
    WalletAccessService,
    WalletRepository,
    WalletVerdictsService,
    WalletScanService,
    WalletScanThrottleGuard,
  ],
  exports: [WalletScanService, WalletAccessService],
})
export class ApiWalletModule {}
