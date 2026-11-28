import {
  DynamicModule,
  Global,
  Module,
  type FactoryProvider,
} from '@nestjs/common';
import {
  BENCH_PRISMA_OPTIONS,
  type BenchPrismaOptions,
} from './bench-prisma.options';
import { BenchPrismaService } from './bench-prisma.service';
import { BenchSqlService } from './bench-sql.executor';

/**
 * Accès à `raijin_bench` (global) : importé une fois par `apps/raijin-banc-de-test-api`, qui fournit
 * l'URL depuis sa configuration validée (aucune lecture d'environnement ici).
 */
@Global()
@Module({})
export class BenchPrismaModule {
  static forRoot(options: BenchPrismaOptions): DynamicModule {
    return {
      module: BenchPrismaModule,
      providers: [
        { provide: BENCH_PRISMA_OPTIONS, useValue: options },
        BenchPrismaService,
        BenchSqlService,
      ],
      exports: [BenchPrismaService, BenchSqlService],
    };
  }

  static forRootAsync(
    options: Pick<
      FactoryProvider<BenchPrismaOptions>,
      'useFactory' | 'inject'
    > & { imports?: DynamicModule['imports'] },
  ): DynamicModule {
    return {
      module: BenchPrismaModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: BENCH_PRISMA_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        BenchPrismaService,
        BenchSqlService,
      ],
      exports: [BenchPrismaService, BenchSqlService],
    };
  }
}
