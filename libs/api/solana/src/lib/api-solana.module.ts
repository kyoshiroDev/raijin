import { Module, type DynamicModule, type InjectionToken, type ModuleMetadata, type OptionalFactoryDependency } from '@nestjs/common';
import { SolanaDataService, type SolanaDataOptions } from './solana-data.service';

export const SOLANA_DATA_OPTIONS = Symbol('SOLANA_DATA_OPTIONS');

export interface ApiSolanaModuleAsyncOptions {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: Array<InjectionToken | OptionalFactoryDependency>;
  readonly useFactory: (...args: never[]) => SolanaDataOptions | Promise<SolanaDataOptions>;
  /** Module global (une seule file de débit par processus : recommandé). */
  readonly isGlobal?: boolean;
}

/**
 * Module Nest des intégrations Solana. Exporte `SolanaDataService` (une instance par processus :
 * les files de débit et disjoncteurs sont partagés par toutes les analyses).
 *
 *   ApiSolanaModule.forRootAsync({
 *     inject: [AppConfig, RedisCacheStore, RedisCreditBudget],
 *     useFactory: (config, cache, budget) => ({ ...loadSolanaDataConfig(process.env), cache, creditBudget: budget }),
 *   })
 */
@Module({})
export class ApiSolanaModule {
  static forRoot(options: SolanaDataOptions = {}, isGlobal = true): DynamicModule {
    return {
      module: ApiSolanaModule,
      global: isGlobal,
      providers: [
        { provide: SOLANA_DATA_OPTIONS, useValue: options },
        { provide: SolanaDataService, useFactory: (opts: SolanaDataOptions) => new SolanaDataService(opts), inject: [SOLANA_DATA_OPTIONS] },
      ],
      exports: [SolanaDataService],
    };
  }

  static forRootAsync(options: ApiSolanaModuleAsyncOptions): DynamicModule {
    return {
      module: ApiSolanaModule,
      global: options.isGlobal ?? true,
      imports: options.imports ?? [],
      providers: [
        { provide: SOLANA_DATA_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        { provide: SolanaDataService, useFactory: (opts: SolanaDataOptions) => new SolanaDataService(opts), inject: [SOLANA_DATA_OPTIONS] },
      ],
      exports: [SolanaDataService],
    };
  }
}
