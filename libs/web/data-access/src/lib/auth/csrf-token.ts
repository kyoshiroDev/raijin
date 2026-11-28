import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, finalize, map, of, shareReplay, tap } from 'rxjs';
import { API_BASE_URL } from '../config/api-config';
import { SKIP_CSRF, SKIP_SESSION_REFRESH } from '../http/context';

/**
 * Format du jeton CSRF, identique à `csrfTokenSchema` (`@raijin/shared-contracts`, vérifié par le
 * test de ce fichier). Validé sans Zod : la première mutation (ex. `POST analyses` à l'ouverture
 * de `/analyse/<mint>`) n'attend pas le chunk des contrats derrière la réponse de `GET /auth/csrf`.
 */
export const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{32,256}$/;

/** Lit `{ csrfToken }` ; lève une erreur si la réponse n'a pas la forme attendue. */
export function parseCsrfResponse(body: unknown): string {
  const token = typeof body === 'object' && body !== null ? (body as { csrfToken?: unknown }).csrfToken : undefined;
  if (typeof token !== 'string' || !CSRF_TOKEN_PATTERN.test(token)) {
    throw new Error('Réponse CSRF inattendue');
  }
  return token;
}

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
          map(parseCsrfResponse),
          tap((token) => this.value.set(token)),
          finalize(() => (this.inFlight = null)),
          shareReplay({ bufferSize: 1, refCount: false }),
        );
    }
    return this.inFlight;
  }
}
