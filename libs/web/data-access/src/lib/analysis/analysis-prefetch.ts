import { Injectable, inject } from '@angular/core';
import { Observable, shareReplay } from 'rxjs';
import { AnalysisApi } from './analysis-api';

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

  start(input: string): void {
    const response = this.api.analyze({ input }).pipe(shareReplay({ bufferSize: 1, refCount: false }));
    // Abonnement immédiat : la requête part maintenant ; l'erreur sera relue par l'écran.
    response.subscribe({ error: () => undefined });
    this.pending = { input, startedAt: Date.now(), response };
  }

  /** Requête de démarrage pour cette saisie, remise une seule fois ; sinon `null`. */
  take(input: string): Observable<unknown> | null {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.input !== input || Date.now() - pending.startedAt > MAX_AGE_MS) return null;
    return pending.response;
  }
}
