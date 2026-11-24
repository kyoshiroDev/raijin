import {
  type ApplicationConfig,
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { AuthStore } from './core/auth/auth-store';
import { AppUpdate } from './core/pwa/app-update';
import { NotificationClicks } from './core/pwa/notification-clicks';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    // Créé au démarrage : la session du banc (GET /api/auth/session) est lue avant la première garde de route,
    // et le renvoi vers /login sur 401 est branché. Ne pas attendre ici.
    provideAppInitializer(() => {
      inject(AuthStore);
    }),
    provideRouter(routes, withComponentInputBinding()),
    // Fichiers statiques seulement : ngsw-config.json n'a aucun dataGroup, les appels /api ne sont jamais mis en cache.
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
    // Started at bootstrap so a notification click is routed even before any page is opened,
    // and the « Nouvelle version » toast can appear on any screen.
    provideAppInitializer(() => {
      inject(NotificationClicks);
      inject(AppUpdate);
    }),
  ],
};
