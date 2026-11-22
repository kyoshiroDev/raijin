import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { inject, makeEnvironmentProviders, provideAppInitializer, type EnvironmentProviders } from '@angular/core';
import { AttributionTracker } from './auth/attribution';
import { AuthStore } from './auth/auth.store';
import { AUTH_INTERCEPTORS } from './http/interceptors';

/**
 * Client HTTP de l'app (fetch, cookies vers l'API, CSRF, refresh automatique) et démarrage de
 * l'auth : capture de l'attribution, puis récupération de la session **sans bloquer** le premier
 * affichage (les gardes de route attendent `AuthStore.whenReady()`).
 */
export function provideRaijinAuth(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideHttpClient(withFetch(), withInterceptors([...AUTH_INTERCEPTORS])),
    provideAppInitializer(() => {
      void inject(AttributionTracker).capture();
      void inject(AuthStore).init();
    }),
  ]);
}
