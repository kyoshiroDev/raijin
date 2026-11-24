import { Inject, Module } from '@nestjs/common';
import { BENCH_SOLANA, BenchRedis } from '@raijin/bench-core';
import type { BenchSolana } from '@raijin/bench-solana';
import type { RiskFacts } from '@raijin/shared-contracts';
import { BenchMarketReader, MarketReader } from './market-reader';
import { BenchQualityJobs, FactsSource } from './quality-jobs';
import { QualityReportCache, QualityReportService, createQualityReportCache } from './quality-report';
import { QualityStore, SqlQualityStore } from './quality-store';
import { BenchQualityController } from './quality.controllers';

/** Faits du moteur par `api-solana` (budget Helius du banc, verdicts prioritaires sur wallet-study). */
export class SolanaFactsSource extends FactsSource {
  constructor(@Inject(BENCH_SOLANA) private readonly solana: BenchSolana) {
    super();
  }

  async collect(mint: string): Promise<RiskFacts | null> {
    const collected = await this.solana.service.collectFacts(mint, { profile: 'full' });
    return collected.facts;
  }
}

/**
 * Mesure des verdicts et entretien (ARCHITECTURE §16) : `verdict-follow-up`, `verdict-aggregate`, `retention-purge`,
 * `storage-check`, `GET /api/verdicts/quality` (précalculé la nuit), `GET /api/shadow/comparison`.
 */
@Module({
  controllers: [BenchQualityController],
  providers: [
    { provide: QualityStore, useClass: SqlQualityStore },
    { provide: FactsSource, useClass: SolanaFactsSource },
    { provide: MarketReader, inject: [BENCH_SOLANA], useFactory: (solana: BenchSolana) => new BenchMarketReader(solana.service) },
    { provide: QualityReportCache, inject: [BenchRedis], useFactory: createQualityReportCache },
    QualityReportService,
    BenchQualityJobs,
  ],
  exports: [BenchQualityJobs],
})
export class BenchQualityModule {}
