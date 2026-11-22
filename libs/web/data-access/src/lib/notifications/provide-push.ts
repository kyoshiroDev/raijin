import { makeEnvironmentProviders, type EnvironmentProviders } from '@angular/core';
import { provideServiceWorker } from '@angular/service-worker';
import { PushService } from './push.service';
import { NGSW_SCRIPT } from './service-worker';

/**
 * `SwPush` et `PushService` pour une route chargée à la demande (écran Compte). L'enregistrement
 * reste celui de `provideServiceWorkerRegistration` : l'initialiseur d'Angular ne s'exécute pas
 * dans l'injecteur d'une route, il n'y a donc jamais de double enregistrement.
 */
export function providePushNotifications(enabled: boolean, script = NGSW_SCRIPT): EnvironmentProviders {
  return makeEnvironmentProviders([provideServiceWorker(script, { enabled }), PushService]);
}
