import { Injectable, inject } from '@angular/core';
import { type AuthSession } from '@raijin/shared-contracts';
import { Observable, finalize, shareReplay, tap } from 'rxjs';
import { AuthApi } from './auth-api';
import { AuthStore } from './auth.store';

/**
 * Rafraîchissement de session (`POST /auth/refresh`, refresh opaque en cookie httpOnly).
 * Une seule requête à la fois : les 401 concurrents attendent la même réponse (file),
 * puis sont rejoués. En cas d'échec, la session locale est oubliée.
 */
@Injectable({ providedIn: 'root' })
export class SessionRefresher {
  private readonly api = inject(AuthApi);
  private readonly store = inject(AuthStore);
  private inFlight: Observable<AuthSession> | null = null;

  refresh(): Observable<AuthSession> {
    if (!this.inFlight) {
      this.inFlight = this.api.refresh().pipe(
        tap({
          next: (session) => this.store.applySession(session),
          error: () => this.store.clear(),
        }),
        finalize(() => (this.inFlight = null)),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.inFlight;
  }
}
