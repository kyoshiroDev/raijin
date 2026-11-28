import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, from, of, shareReplay, switchMap, throwError } from 'rxjs';
import { AnalysisApi, unwrapAnalysis } from './analysis-api';

/** Réponse brute de `POST analyses` envoyé par `analyse-prefetch.js` (statut HTTP et corps JSON). */
export interface EarlyAnalysis {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Erreurs métier reprises telles quelles (même réponse qu'une nouvelle requête). Les autres échecs (401 à
 * rafraîchir, 403 CSRF, 503 maintenance, 5xx, réseau) repassent par une requête normale et ses intercepteurs.
 */
const ADOPTED_ERROR_STATUSES: readonly number[] = [400, 404, 422, 429];
const ADOPTED_URL = '/api/v1/analyses';

/** `GET analyses/:mint/latest` : seul le 404 `ANALYSIS_NOT_FOUND` (réponse métier) est repris tel quel. */
const ADOPTED_LATEST_ERROR_STATUSES: readonly number[] = [404];

/** Raison du rejet de `analyse-prefetch.js` : seul `network` (POST parti sans réponse) interdit le renvoi. */
function earlyFailure(reason: unknown): 'network' | null {
  return reason instanceof Error && reason.message === 'network' ? 'network' : null;
}

/** Au-delà, une requête de démarrage non réclamée est abandonnée (l'écran en relancera une). */
const MAX_AGE_MS = 30_000;

/**
 * `POST analyses` lancé au démarrage de l'app sur `/analyse/<mint>` (avant la création de l'écran),
 * puis **réclamé une seule fois** par `AnalysisStore.analyze()` pour la même saisie : une seule
 * requête, donc un seul décompte de quota, la même que l'écran aurait envoyée à son ouverture.
 * Une saisie différente, un réessai ou une seconde analyse repartent sur une requête normale.
 */
@Injectable({ providedIn: 'root' })
export class AnalysisPrefetch {
  private readonly api = inject(AnalysisApi);
  private pending: { input: string; startedAt: number; response: Observable<unknown> } | null = null;
  private pendingLatest: { mint: string; startedAt: number; response: Observable<unknown> } | null = null;

  start(input: string): void {
    const response = this.api.analyze({ input }).pipe(shareReplay({ bufferSize: 1, refCount: false }));
    // Abonnement immédiat : la requête part maintenant ; l'erreur sera relue par l'écran.
    response.subscribe({ error: () => undefined });
    this.pending = { input, startedAt: Date.now(), response };
  }

  /**
   * Reprend le `POST analyses` lancé avant Angular par `analyse-prefetch.js` : réponse 2xx (ou erreur métier)
   * remise à l’écran ; autre échec, une requête normale part aussitôt à la place (intercepteurs compris).
   */
  adopt(input: string, startedAt: number, early: Promise<EarlyAnalysis>): void {
    const response = from(early.then((result): EarlyAnalysis | 'network' | null => result, earlyFailure)).pipe(
      switchMap((result) => {
        // POST parti sans réponse : le serveur a pu le traiter (quota compté). Aucun renvoi automatique :
        // erreur réseau affichée, « Réessayer » reste à l'initiative de l'utilisateur.
        if (result === 'network') return throwError(() => new HttpErrorResponse({ status: 0, url: ADOPTED_URL }));
        // CSRF en échec : le POST n'est jamais parti, requête normale.
        if (result === null) return this.api.analyze({ input });
        if (result.status >= 200 && result.status < 300) return of(result.body);
        if (ADOPTED_ERROR_STATUSES.includes(result.status)) {
          return throwError(() => new HttpErrorResponse({ status: result.status, error: result.body, url: ADOPTED_URL }));
        }
        return this.api.analyze({ input });
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    response.subscribe({ error: () => undefined });
    this.pending = { input, startedAt, response };
  }

  /**
   * Reprend le `GET analyses/:mint/latest` lancé avant Angular sur `/t/<mint>` (page publique) : corps 2xx
   * (déballé comme `AnalysisApi.latest`) ou 404 métier remis à l'écran ; autre échec, requête normale aussitôt.
   */
  adoptLatest(mint: string, startedAt: number, early: Promise<EarlyAnalysis>): void {
    const response = from(early.then((result): EarlyAnalysis | null => result, () => null)).pipe(
      switchMap((result) => {
        if (result === null) return this.api.latest(mint);
        if (result.status >= 200 && result.status < 300) return of(unwrapAnalysis(result.body));
        if (ADOPTED_LATEST_ERROR_STATUSES.includes(result.status)) {
          return throwError(
            () => new HttpErrorResponse({ status: result.status, error: result.body, url: `${ADOPTED_URL}/${mint}/latest` }),
          );
        }
        return this.api.latest(mint);
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    response.subscribe({ error: () => undefined });
    this.pendingLatest = { mint, startedAt, response };
  }

  /** Lecture de démarrage de la page publique pour ce mint, remise une seule fois ; sinon `null`. */
  takeLatest(mint: string): Observable<unknown> | null {
    const pending = this.pendingLatest;
    this.pendingLatest = null;
    if (!pending || pending.mint !== mint || Date.now() - pending.startedAt > MAX_AGE_MS) return null;
    return pending.response;
  }

  /** Requête de démarrage pour cette saisie, remise une seule fois ; sinon `null`. */
  take(input: string): Observable<unknown> | null {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.input !== input || Date.now() - pending.startedAt > MAX_AGE_MS) return null;
    return pending.response;
  }
}
