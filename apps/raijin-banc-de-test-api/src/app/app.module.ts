import { DynamicModule, Module } from '@nestjs/common';
import { BenchCoreModule, type BenchConfig } from '@raijin/bench-core';

/** Version affichée par `GET /api/status`. */
export const BENCH_API_VERSION = '0.0.1';

/**
 * Module racine de l'API du banc : app fine, le métier vit dans `libs/bench/*` (docs/ARCHITECTURE.md §17).
 * Les modules métier portés (`bench-collect`, `bench-trading`, `bench-quality`, T7) s'ajoutent dans `imports`
 * et enregistrent leurs jobs dans `BenchJobRegistry`.
 */
@Module({})
export class AppModule {
  static forRoot(config: BenchConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [BenchCoreModule.forRoot({ config, version: BENCH_API_VERSION })],
    };
  }
}
