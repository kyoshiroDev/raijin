import { HttpResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Injector, inject } from '@angular/core';
import { catchError, tap, throwError } from 'rxjs';
import { API_BASE_URL } from '../../config/api-config';
import { isAdminApiUrl } from './admin-paths';
import { AdminSessionLink, type AdminSessionHandle } from './admin-session-link';

/**
 * Routes `admin/*` uniquement : chaque réponse réussie prolonge le minuteur d'inactivité ; un 403
 * `ADMIN_2FA_ENROLLMENT_REQUIRED | ADMIN_2FA_REQUIRED | ADMIN_SESSION_EXPIRED` verrouille l'espace admin
 * (données effacées, écran de saisie du code avec retour). **Aucun refresh** : ces codes sont en 403, la
 * session de l'app reste valide (docs/ARCHITECTURE.md §14.3). L'erreur est toujours propagée à l'appelant.
 *
 * `AdminSessionStore` n'est pas importé statiquement (G1, §10.6) : il est déjà créé par l'espace admin
 * (inscrit dans `AdminSessionLink`) ; sinon, il est chargé par import dynamique à la première réponse admin.
 * La requête n'attend jamais ce chargement.
 */
export const adminSessionInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isAdminApiUrl(req.url, inject(API_BASE_URL))) return next(req);
  const link = inject(AdminSessionLink);
  const injector = inject(Injector);
  const withSession = (run: (session: AdminSessionHandle) => void): void => {
    if (link.current) {
      run(link.current);
      return;
    }
    void import('./admin-session.store').then((m) => run(injector.get(m.AdminSessionStore)));
  };
  return next(req).pipe(
    tap((event) => {
      if (event instanceof HttpResponse) withSession((session) => session.touch());
    }),
    catchError((error: unknown) => {
      withSession((session) => session.handleError(error));
      return throwError(() => error);
    }),
  );
};
