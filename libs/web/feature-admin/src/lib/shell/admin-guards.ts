import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { ADMIN_PATHS, AdminSessionStore, safeAdminReturn } from '@raijin/web-data-access';

/**
 * Coque admin : statut de la session admin (`GET admin/security/status`, mis en cache).
 * 404 serveur → page 404 standard sans changer l'URL ; 2FA non activée → activation ; code non saisi ou session
 * expirée → saisie du code avec retour. API injoignable : la coque s'affiche et propose de réessayer.
 * Affichage seulement : chaque route `admin/*` est contrôlée par le serveur (`AdminGuard`).
 */
export const adminSessionGuard: CanActivateFn = async (_route, state) => {
  const session = inject(AdminSessionStore);
  const router = inject(Router);
  const result = await session.ensureStatus();
  if (result === 'not_found') {
    session.showNotFound();
    return false;
  }
  if (result !== 'ready') return true;
  if (!session.enrolled()) return router.parseUrl(ADMIN_PATHS.enrollment);
  if (!session.verified()) {
    return router.createUrlTree([ADMIN_PATHS.verify], { queryParams: { retour: safeAdminReturn(state.url) } });
  }
  return true;
};

/** Activation de la 2FA : seulement pour un admin pas encore enrôlé. */
export const enrollmentGuard: CanActivateFn = async () => {
  const session = inject(AdminSessionStore);
  const router = inject(Router);
  const result = await session.ensureStatus(true);
  if (result === 'not_found') {
    session.showNotFound();
    return false;
  }
  if (result !== 'ready' || !session.enrolled()) return true;
  return router.parseUrl(session.verified() ? ADMIN_PATHS.root : ADMIN_PATHS.verify);
};

/** Saisie du code : seulement pour un admin enrôlé dont la session n'est pas (ou plus) vérifiée. */
export const verifyGuard: CanActivateFn = async (route) => {
  const session = inject(AdminSessionStore);
  const router = inject(Router);
  const result = await session.ensureStatus(true);
  if (result === 'not_found') {
    session.showNotFound();
    return false;
  }
  if (result !== 'ready') return true;
  if (!session.enrolled()) return router.parseUrl(ADMIN_PATHS.enrollment);
  if (session.verified()) return router.parseUrl(safeAdminReturn(route.queryParamMap.get('retour')));
  return true;
};
