import { Injectable, inject } from '@angular/core';
import { type AuthSession } from '@raijin/shared-contracts';
import { Observable, catchError, finalize, map, retry, shareReplay, switchMap, tap, throwError, timer } from 'rxjs';
import { hasErrorCode } from '../http/error-code';
import { AuthApi } from './auth-api';
import { AuthStore } from './auth.store';
import { CsrfToken } from './csrf-token';

/**
 * Rafraîchissement de session (`POST /auth/refresh`, refresh opaque en cookie httpOnly).
 * Une seule requête à la fois : les 401 concurrents attendent la même réponse (file),
 * puis sont rejoués. En cas d'échec, la session locale est oubliée (et le jeton CSRF, lié à la
 * session, effacé : la mutation suivante redemande un jeton anonyme).
 *
 * 409 `CONFLICT` : un autre onglet vient de faire le refresh (fenêtre de 10 s côté API). Sa réponse, qui
 * pose les nouveaux cookies, peut arriver après notre 409 : on ne déconnecte pas, on attend brièvement puis
 * on relit `GET /auth/session` (sans refresh), jusqu'à {@link CONFLICT_ATTEMPTS} fois. Session relue : elle
 * est appliquée (nouveau jeton CSRF compris) et la requête d'origine est rejouée une fois ; émet `null`.
 * Toujours rien après ces essais : session oubliée, comme un refresh refusé.
 */
export const CONFLICT_WAIT_MS = 250;
export const CONFLICT_ATTEMPTS = 5;

@Injectable({ providedIn: 'root' })
export class SessionRefresher {
  private readonly api = inject(AuthApi);
  private readonly store = inject(AuthStore);
  private readonly csrf = inject(CsrfToken);
  private inFlight: Observable<AuthSession | null> | null = null;

  refresh(): Observable<AuthSession | null> {
    if (!this.inFlight) {
      this.inFlight = this.api.refresh().pipe(
        tap((session) => this.store.applySession(session)),
        catchError((error: unknown) => {
          if (hasErrorCode(error, 'CONFLICT')) return this.afterOtherTab(error);
          this.store.clear();
          return throwError(() => error);
        }),
        finalize(() => (this.inFlight = null)),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.inFlight;
  }

  /** Après un 409 : relit la session posée par l'autre onglet (attente courte, quelques essais). */
  private afterOtherTab(error: unknown): Observable<null> {
    this.csrf.clear();
    return timer(CONFLICT_WAIT_MS).pipe(
      switchMap(() => this.api.peekSession()),
      map((state) => {
        if (!state.authenticated) throw error;
        this.store.applySession(state);
        return null;
      }),
      retry({ count: CONFLICT_ATTEMPTS - 1, delay: CONFLICT_WAIT_MS }),
      catchError(() => {
        this.store.clear();
        return throwError(() => error);
      }),
    );
  }
}
