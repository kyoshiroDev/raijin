import { DOCUMENT } from '@angular/common';
import { ApplicationRef, inject, makeEnvironmentProviders, provideAppInitializer, type EnvironmentProviders } from '@angular/core';
import { runWhenIdle } from '../util/idle';

/** Script du service worker Angular (généré par le build de production, `ngsw-config.json`). */
export const NGSW_SCRIPT = 'ngsw-worker.js';

/** Délai maximal avant l'enregistrement si l'app n'est jamais stable (même valeur que `registerWhenStable:30000`). */
export const SW_REGISTER_TIMEOUT_MS = 30_000;

/**
 * Enregistre `ngsw-worker.js` (cache de la coquille, réception et clic des notifications push)
 * **sans** charger le code client de `@angular/service-worker` au démarrage : même stratégie que
 * `registerWhenStable:30000` (app stable, ou 30 s au plus), puis inactivité du navigateur. Le
 * message `INITIALIZE` au changement de contrôleur reprend celui d'Angular. `SwPush` n'est fourni
 * que sur les écrans qui en ont besoin (`providePushNotifications`, docs/ARCHITECTURE.md §11.7).
 * Fichier chargé au démarrage : aucun import de Zod ni de `@angular/service-worker` ici.
 */
export function provideServiceWorkerRegistration(enabled: boolean, script = NGSW_SCRIPT): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => {
      const view = inject(DOCUMENT).defaultView;
      const container = view?.navigator.serviceWorker;
      if (!enabled || !view || !container) return;
      const appRef = inject(ApplicationRef);
      container.addEventListener('controllerchange', () => container.controller?.postMessage({ action: 'INITIALIZE' }));
      const timeout = new Promise<void>((resolve) => view.setTimeout(resolve, SW_REGISTER_TIMEOUT_MS));
      void Promise.race([appRef.whenStable(), timeout]).then(() =>
        runWhenIdle(() => {
          container.register(script, { scope: './' }).catch(() => undefined);
        }, view),
      );
    }),
  ]);
}
