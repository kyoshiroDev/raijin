import { inject } from '@angular/core';
import { Router, type CanActivateFn, type UrlTree } from '@angular/router';
import { AuthStore } from './auth.store';
import { safeRedirect } from './redirect';

/** Chemins des écrans d'auth (feature-compte), partagés par les gardes. */
export const AUTH_ROUTES = {
  login: '/compte/connexion',
  account: '/compte',
  verifyEmail: '/compte/verifier-email',
} as const;

function loginTree(router: Router, url: string): UrlTree {
  return router.createUrlTree([AUTH_ROUTES.login], { queryParams: { redirect: safeRedirect(url) } });
}

/**
 * Écran réservé aux connectés : sinon, connexion avec retour à l'écran demandé.
 * Si l'API ne répond pas (`error`), l'écran s'affiche et propose de réessayer.
 */
export const authGuard: CanActivateFn = async (_route, state) => {
  const store = inject(AuthStore);
  const router = inject(Router);
  await store.whenReady();
  if (store.isAuthenticated() || store.status() === 'error') return true;
  return loginTree(router, state.url);
};

/** Écran réservé aux visiteurs (connexion, inscription…) : un connecté repart vers `redirect` ou Compte. */
export const guestGuard: CanActivateFn = async (route) => {
  const store = inject(AuthStore);
  const router = inject(Router);
  await store.whenReady();
  if (!store.isAuthenticated()) return true;
  return router.parseUrl(safeRedirect(route.queryParamMap.get('redirect')));
};

/** Écran réservé aux e-mails vérifiés : sinon, écran « Vérifie ta boîte ». */
export const verifiedEmailGuard: CanActivateFn = async (_route, state) => {
  const store = inject(AuthStore);
  const router = inject(Router);
  await store.whenReady();
  if (!store.isAuthenticated()) return loginTree(router, state.url);
  if (store.emailVerified()) return true;
  return router.createUrlTree([AUTH_ROUTES.verifyEmail]);
};
