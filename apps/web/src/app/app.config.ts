import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideRaijinAuth, provideStartupPrefetch } from '@raijin/web-data-access';
import { appRoutes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(appRoutes, withComponentInputBinding()),
    provideRaijinAuth(),
    // Pages d'arrivée par mint : `/analyse/<mint>` envoie `POST analyses` (jeton CSRF), et les deux
    // valident une analyse (contrats) dès l'ouverture. Demandés au démarrage, en parallèle.
    provideStartupPrefetch({
      csrf: [/^\/analyse\/[^/]+\/?$/],
      analyze: /^\/analyse\/([^/?#]+)\/?$/,
      contracts: [/^\/(analyse|t)\/[^/]+\/?$/],
    }),
  ],
};
