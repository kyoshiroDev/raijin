import { inject } from '@angular/core';
import { Router, type CanMatchFn } from '@angular/router';
import { AuthStore } from '@raijin/web-data-access';

/**
 * Écran de connexion (miroir de `AUTH_ROUTES.login`, vérifié par le test). Recopié ici : importer les gardes
 * d'auth (`safeRedirect` valide par Zod) chargerait les contrats dans le bundle initial (docs/ARCHITECTURE.md §10).
 */
export const ADMIN_LOGIN_PATH = '/compte/connexion';

/**
 * Entrée de l'espace admin (`/admin`, affichage seulement : le vrai contrôle est fait par l'API sur chaque route
 * `admin/*`). Visiteur → connexion avec retour ; compte connecté sans rôle ADMIN → la route ne correspond pas et
 * la page 404 standard s'affiche (l'espace reste invisible). API injoignable : même 404 standard, le chunk admin
 * n'est téléchargé pour personne tant que le rôle ADMIN n'est pas confirmé.
 * `canMatch` : le chunk admin n'est même pas téléchargé pour un non-admin.
 */
export const adminAreaGuard: CanMatchFn = async (_route, segments) => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  await auth.whenReady();
  // API injoignable : rôle inconnu, le chunk admin n'est pas téléchargé (404 standard, rien ne fuit).
  if (auth.status() === 'error') return false;
  if (!auth.isAuthenticated()) {
    // Chemin reconstruit à partir des segments reconnus par le routeur (toujours interne, sans requête) ;
    // l'écran de connexion le revalide avec `safeRedirect`.
    const redirect = `/${segments.map((segment) => encodeURIComponent(segment.path)).join('/')}`;
    return router.createUrlTree([ADMIN_LOGIN_PATH], { queryParams: { redirect } });
  }
  return auth.user()?.role === 'ADMIN';
};
