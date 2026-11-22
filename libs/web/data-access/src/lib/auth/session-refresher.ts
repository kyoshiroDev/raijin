import { Injectable, inject } from '@angular/core';
import { type AuthSession } from '@raijin/shared-contracts';
import { Observable, catchError, finalize, of, shareReplay, tap, throwError } from 'rxjs';
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
 * 409 `CONFLICT` : un autre onglet vient de faire le refresh (fenêtre de 10 s côté API). Les cookies
 * valides sont déjà posés : on ne déconnecte pas, on oublie seulement le jeton CSRF (lié à l'ancienne
 * session, il sera redemandé) et la requête d'origine est rejouée une fois. Émet alors `null`.
 */
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
          if (hasErrorCode(error, 'CONFLICT')) {
            this.csrf.clear();
            return of(null);
          }
          this.store.clear();
          return throwError(() => error);
        }),
        finalize(() => (this.inFlight = null)),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.inFlight;
  }
}
