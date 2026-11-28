import { Module } from '@nestjs/common';
import { BenchCollectJobs } from './collect-jobs';
import { BenchAlertsController, BenchPushController, BenchTokensController } from './collect.controllers';

/**
 * Collecte du banc (docs/BENCH.md §2) : jobs `scan-tokens`, `enrich-tokens`, `label-outcomes`, `wallet-study-collect`
 * et lectures du front (tokens, alertes, réglages, push). S'appuie sur `BenchCoreModule` (global).
 */
@Module({
  controllers: [BenchTokensController, BenchAlertsController, BenchPushController],
  providers: [BenchCollectJobs],
  exports: [BenchCollectJobs],
})
export class BenchCollectModule {}
