import { HttpResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, tap, throwError } from 'rxjs';
import { API_BASE_URL } from '../../config/api-config';
import { isAdminApiUrl } from './admin-paths';
import { AdminSessionStore } from './admin-session.store';

/**
 * Routes `admin/*` uniquement : chaque réponse réussie prolonge le minuteur d'inactivité ; un 403
 * `ADMIN_2FA_ENROLLMENT_REQUIRED | ADMIN_2FA_REQUIRED | ADMIN_SESSION_EXPIRED` verrouille l'espace admin
 * (données effacées, écran de saisie du code avec retour). **Aucun refresh** : ces codes sont en 403, la
 * session de l'app reste valide (docs/ARCHITECTURE.md §14.3). L'erreur est toujours propagée à l'appelant.
 */
export const adminSessionInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isAdminApiUrl(req.url, inject(API_BASE_URL))) return next(req);
  const session = inject(AdminSessionStore);
  return next(req).pipe(
    tap((event) => {
      if (event instanceof HttpResponse) session.touch();
    }),
    catchError((error: unknown) => {
      session.handleError(error);
      return throwError(() => error);
    }),
  );
};
