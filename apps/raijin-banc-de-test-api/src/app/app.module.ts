import { DynamicModule, Module } from '@nestjs/common';
import { BenchCollectModule } from '@raijin/bench-collect';
import { BenchCoreModule, type BenchConfig } from '@raijin/bench-core';
import { BenchQualityModule } from '@raijin/bench-quality';
import { BenchTradingModule } from '@raijin/bench-trading';

/** Version affichée par `GET /api/status`. */
export const BENCH_API_VERSION = '0.0.1';

/**
 * Module racine de l'API du banc : app fine, le métier vit dans `libs/bench/*` (docs/ARCHITECTURE.md §17).
 * Modules métier portés (T7) : `bench-collect`, `bench-trading`, `bench-quality` ; chacun enregistre ses jobs dans
 * `BenchJobRegistry` (seuls les jobs enregistrés sont planifiés).
 */
@Module({})
export class AppModule {
  static forRoot(config: BenchConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [BenchCoreModule.forRoot({ config, version: BENCH_API_VERSION }), BenchCollectModule, BenchTradingModule, BenchQualityModule],
    };
  }
}
