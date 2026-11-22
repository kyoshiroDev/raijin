import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { API_BASE_URL } from '../config/api-config';
import { isApiUrl } from './api-url';
import { hasErrorCode } from './error-code';

/** Page affichée quand l'API est en maintenance (docs/ARCHITECTURE.md §11.10). */
export const MAINTENANCE_PATH = '/maintenance';

/** Vrai pour une réponse 503 `MAINTENANCE` de l'API (lecture du code sans Zod). */
export function isMaintenanceError(error: unknown): boolean {
  return error instanceof HttpErrorResponse && error.status === 503 && hasErrorCode(error, 'MAINTENANCE');
}

/**
 * 503 `MAINTENANCE` : l'app affiche `/maintenance` (avec retour vers l'écran demandé), une seule
 * fois. L'erreur est quand même transmise à l'appelant, qui arrête son chargement. Chargé au
 * démarrage : aucun Zod ici, la page de maintenance valide elle-même `redirect` (`safeRedirect`).
 */
export const maintenanceInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isApiUrl(req.url, inject(API_BASE_URL))) return next(req);
  const router = inject(Router);
  return next(req).pipe(
    catchError((error: unknown) => {
      const current = router.url.split(/[?#]/, 1)[0] ?? '';
      if (isMaintenanceError(error) && current !== MAINTENANCE_PATH) {
        void router.navigate([MAINTENANCE_PATH], { queryParams: { redirect: router.url } });
      }
      return throwError(() => error);
    }),
  );
};
