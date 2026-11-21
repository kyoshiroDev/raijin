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
    // Eager on purpose: creating the store creates the Supabase client (which starts the
    // reset link's PKCE exchange) and registers the auth listener in the same tick, so the
    // PASSWORD_RECOVERY event is recorded before any lazy route loads. Do not await here.
    provideAppInitializer(() => {
      inject(AuthStore);
    }),
    provideRouter(routes, withComponentInputBinding()),
    // Static files only: ngsw-config.json has no dataGroups, Supabase calls are never cached.
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
