import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { AppConfig } from './config/app-config';
import { ApiConfigModule } from './config/config.module';
import { AuthCookies } from './security/cookies';
import { CsrfGuard, CsrfService, SessionIdResolverRegistry } from './security/csrf';
import { ApiThrottlerGuard, ApiThrottlerModule } from './throttler/throttler';

/**
 * Socle global de l'API : configuration, rate limiting (garde globale), CSRF (garde globale),
 * cookies de session. Importé une seule fois par `apps/api` (`ApiCoreModule.forRoot(config)`).
 */
@Global()
@Module({})
export class ApiCoreModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ApiCoreModule,
      imports: [ApiConfigModule.forRoot(config), ApiThrottlerModule],
      providers: [
        AuthCookies,
        CsrfService,
        SessionIdResolverRegistry,
        // Ordre : rate limiting d'abord, puis CSRF.
        { provide: APP_GUARD, useClass: ApiThrottlerGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
      ],
      // `ApiThrottlerModule` exporté : `ThrottlerStorage` partagé avec les middlewares (espace admin, audit 6 bis n2).
      exports: [ApiConfigModule, ApiThrottlerModule, AuthCookies, CsrfService, SessionIdResolverRegistry],
    };
  }
}
