import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { Injector, inject, makeEnvironmentProviders, provideAppInitializer, type EnvironmentProviders } from '@angular/core';
import { adminSessionInterceptor } from './admin/security/admin-session.interceptor';
import { AttributionTracker } from './auth/attribution';
import { AuthStore } from './auth/auth.store';
import { AUTH_INTERCEPTORS } from './http/interceptors';
import { maintenanceInterceptor } from './http/maintenance';
import { runAfterFirstRoute } from './util/idle';

/**
 * Client HTTP de l'app (fetch, cookies vers l'API, CSRF, refresh automatique) et démarrage de
 * l'auth. Au démarrage, seul le relevé synchrone de l'URL d'arrivée (attribution) est fait ; la
 * validation de l'attribution et la récupération de la session (qui charge les contrats d'auth)
 * partent **après le premier rendu de la route**, à l'inactivité du navigateur
 * (docs/ARCHITECTURE.md §10.2) : elles ne concurrencent pas l'élément LCP. Les gardes de route
 * attendent `AuthStore.whenReady()`, qui lance la session tout de suite si besoin.
 * `adminSessionInterceptor` ne regarde que les routes `admin/*` (403 de session admin, sans refresh).
 */
export function provideRaijinAuth(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideHttpClient(withFetch(), withInterceptors([maintenanceInterceptor, adminSessionInterceptor, ...AUTH_INTERCEPTORS])),
    provideAppInitializer(() => {
      const attribution = inject(AttributionTracker);
      // Store d'auth (et client HTTP) créés plus tard, à l'inactivité : rien de plus au démarrage.
      const injector = inject(Injector);
      const landing = attribution.snapshot();
      runAfterFirstRoute(() => {
        void injector.get(AuthStore).whenReady();
        void attribution.commit(landing);
      });
    }),
  ]);
}
