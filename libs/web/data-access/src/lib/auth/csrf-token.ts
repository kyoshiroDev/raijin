import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, finalize, from, map, of, shareReplay, switchMap, tap } from 'rxjs';
import { loadContracts } from '../contracts';
import { API_BASE_URL } from '../config/api-config';
import { SKIP_CSRF, SKIP_SESSION_REFRESH } from '../http/context';

/**
 * Jeton CSRF (double-submit signé, docs/ARCHITECTURE.md §8.5), gardé **en mémoire** uniquement :
 * jamais dans localStorage, sessionStorage ni un cookie lisible. Perdu au rechargement, il est
 * redemandé à la première mutation (`GET /auth/csrf`) ou renvoyé par la réponse de session.
 */
@Injectable({ providedIn: 'root' })
export class CsrfToken {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly value = signal<string | null>(null);
  private inFlight: Observable<string> | null = null;

  readonly token = this.value.asReadonly();

  set(token: string): void {
    this.value.set(token);
  }

  clear(): void {
    this.value.set(null);
  }

  /** Jeton courant, ou un nouveau jeton demandé à l'API (une seule requête pour les appels concurrents). */
  ensure(): Observable<string> {
    const current = this.value();
    return current ? of(current) : this.fetch();
  }

  /** Demande un nouveau jeton (après un refus `AUTH_CSRF_INVALID`). */
  fetch(): Observable<string> {
    if (!this.inFlight) {
      this.inFlight = this.http
        .get(`${this.base}/auth/csrf`, {
          context: new HttpContext().set(SKIP_CSRF, true).set(SKIP_SESSION_REFRESH, true),
        })
        .pipe(
          switchMap((body) => from(loadContracts()).pipe(map((c) => c.csrfResponseSchema.parse(body).csrfToken))),
          tap((token) => this.value.set(token)),
          finalize(() => (this.inFlight = null)),
          shareReplay({ bufferSize: 1, refCount: false }),
        );
    }
    return this.inFlight;
  }
}
