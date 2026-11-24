import { Module } from '@nestjs/common';
import { BenchTradingJobs } from './trading-jobs';
import { BenchLabController, BenchPaperController, BenchPerformanceController } from './trading.controllers';

/**
 * Simulation du banc (docs/BENCH.md §2, §5) : jobs `paper-engine`, `backtest-run`, `backtest-nightly` et endpoints
 * des 8 ex-RPC du front (paper, performance, laboratoire). SIMULATION UNIQUEMENT, aucun ordre réel.
 */
@Module({
  controllers: [BenchPaperController, BenchPerformanceController, BenchLabController],
  providers: [BenchTradingJobs],
  exports: [BenchTradingJobs],
})
export class BenchTradingModule {}
