import {
  ApplicationConfig,
  isDevMode,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideRaijinAuth, provideServiceWorkerRegistration, provideStartupPrefetch } from '@raijin/web-data-access';
import { appRoutes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(appRoutes, withComponentInputBinding()),
    provideRaijinAuth(),
    // `/analyse/<mint>` : jeton CSRF et `POST analyses` partent au démarrage (requête réclamée par
    // l'écran). Pas de préchargement des contrats : le verdict s'affiche avant la validation Zod.
    provideStartupPrefetch({
      csrf: [/^\/analyse\/[^/]+\/?$/],
      analyze: /^\/analyse\/([^/?#]+)\/?$/,
    }),
    // Service worker Angular (cache de la coquille, push) : enregistré une fois l'app stable (30 s
    // au plus), jamais avant le premier rendu ; SwPush arrive avec l'écran Compte (§11.7).
    provideServiceWorkerRegistration(!isDevMode()),
  ],
};
