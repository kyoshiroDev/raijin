import { DynamicModule, Global, Inject, Module } from '@nestjs/common';
import type { AppConfig } from './app-config';

/** Jeton d'injection de la configuration validée (`AppConfig`). */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** Raccourci : `constructor(@InjectConfig() private readonly config: AppConfig)`. */
export const InjectConfig = (): ParameterDecorator => Inject(APP_CONFIG);

/** Rend la configuration validée disponible dans toute l'application. */
@Global()
@Module({})
export class ApiConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ApiConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
