import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { CsrfToken } from '../auth/csrf-token';
import { SessionRefresher } from '../auth/session-refresher';
import { API_BASE_URL } from '../config/api-config';
import { CSRF_HEADER_NAME, hasErrorCode } from './error-code';
import { isApiUrl, isMutation } from './api-url';
import { SKIP_CSRF, SKIP_SESSION_REFRESH } from './context';

/** Cookies httpOnly envoyés à l'API Raijin uniquement (jamais vers une autre origine). */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isApiUrl(req.url, inject(API_BASE_URL))) return next(req);
  return next(req.withCredentials ? req : req.clone({ withCredentials: true }));
};

/**
 * En-tête `X-CSRF-Token` sur chaque mutation vers l'API. Sans jeton en mémoire, il est demandé
 * d'abord (`GET /auth/csrf`). Sur un refus `AUTH_CSRF_INVALID`, un nouveau jeton est demandé et
 * la requête rejouée une seule fois.
 */
export const csrfInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isMutation(req.method) || req.context.get(SKIP_CSRF) || !isApiUrl(req.url, inject(API_BASE_URL))) {
    return next(req);
  }
  const csrf = inject(CsrfToken);
  const send = (token: string) => next(req.clone({ setHeaders: { [CSRF_HEADER_NAME]: token } }));
  return csrf.ensure().pipe(
    switchMap((token) =>
      send(token).pipe(
        catchError((error: unknown) => {
          if (!hasErrorCode(error, 'AUTH_CSRF_INVALID')) {
            return throwError(() => error);
          }
          // Rejeu unique : l'erreur du rejeu sort directement (elle n'est pas rattrapée ici).
          return csrf.fetch().pipe(switchMap((fresh) => send(fresh)));
        }),
      ),
    ),
  );
};

/**
 * Rafraîchissement automatique : uniquement sur un 401 `AUTH_SESSION_EXPIRED` (jamais `UNAUTHORIZED`),
 * une seule tentative de `POST /auth/refresh` (partagée entre requêtes concurrentes), puis la
 * requête est rejouée une fois. Jamais pour les appels d'auth eux-mêmes ni pour un mauvais mot de passe.
 */
export const sessionRefreshInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.context.get(SKIP_SESSION_REFRESH) || !isApiUrl(req.url, inject(API_BASE_URL))) {
    return next(req);
  }
  const refresher = inject(SessionRefresher);
  return next(req).pipe(
    catchError((error: unknown) => {
      if (!shouldRefresh(error)) {
        return throwError(() => error);
      }
      // Rejeu unique : un nouveau 401 après refresh sort directement (pas de boucle).
      return refresher.refresh().pipe(
        // Échec du refresh : on renvoie l'erreur d'origine (session expirée), pas celle du refresh.
        catchError(() => throwError(() => error)),
        switchMap(() => next(req)),
      );
    }),
  );
};

function shouldRefresh(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse) || error.status !== 401) return false;
  // `UNAUTHORIZED` = aucun cookie d'access sur une route protégée : rien à rafraîchir pour cette requête.
  // `AUTH_SESSION_EXPIRED` = cookie d'access expiré, invalide ou révoqué, ou cookie de refresh seul
  // (`GET /auth/session`, contrat `SessionState`) : un refresh peut réussir, l'utilisateur reste connecté.
  return hasErrorCode(error, 'AUTH_SESSION_EXPIRED');
}

/**
 * Corps d'erreur JSON reçu en `Blob` (requêtes `responseType: 'blob'`, ex. export des données) :
 * il est lu de façon asynchrone et remplacé par l'objet `{code, message}`, pour que le refresh,
 * le CSRF et `toClientError` voient le même format que pour une requête JSON.
 */
export const blobErrorBodyInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.responseType !== 'blob' || !isApiUrl(req.url, inject(API_BASE_URL))) return next(req);
  return next(req).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || !(error.error instanceof Blob)) {
        return throwError(() => error);
      }
      return from(parseBlobError(error)).pipe(switchMap((parsed) => throwError(() => parsed)));
    }),
  );
};

/** Ne relance jamais : un corps illisible ou non JSON laisse l'erreur d'origine intacte. */
export async function parseBlobError(error: HttpErrorResponse): Promise<HttpErrorResponse> {
  const blob = error.error as Blob;
  try {
    const body: unknown = JSON.parse(await readBlobText(blob));
    if (typeof body !== 'object' || body === null) return error;
    return new HttpErrorResponse({
      error: body,
      headers: error.headers,
      status: error.status,
      statusText: error.statusText,
      url: error.url ?? undefined,
    });
  } catch {
    return error;
  }
}

/** `Blob.text()` quand il existe, sinon `FileReader` (anciens navigateurs, jsdom). */
function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Lecture du corps impossible'));
    reader.readAsText(blob);
  });
}

/**
 * Ordre : cookies, puis refresh (qui rejoue en repassant par le CSRF pour reprendre le nouveau jeton),
 * le décodage des corps d'erreur `Blob` en dernier (au plus près du réseau) pour que tous les
 * intercepteurs au-dessus lisent un code d'erreur.
 */
export const AUTH_INTERCEPTORS: readonly HttpInterceptorFn[] = [
  credentialsInterceptor,
  sessionRefreshInterceptor,
  csrfInterceptor,
  blobErrorBodyInterceptor,
];
