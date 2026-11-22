import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { type AnalysisRequest, type AnalysisResponse, type AnalysisResult, type QuotaInfo } from '@raijin/shared-contracts';
import { Observable, from, map, switchMap, type OperatorFunction } from 'rxjs';
import { API_BASE_URL } from '../config/api-config';
import { loadContracts, prefetchContracts, type Contracts } from '../contracts';

function parseWith<T>(pick: (contracts: Contracts) => { parse(value: unknown): T }): OperatorFunction<unknown, T> {
  return switchMap((body) => from(loadContracts()).pipe(map((contracts) => pick(contracts).parse(body))));
}

/**
 * `GET analyses/:mint/latest` renvoie le résultat seul (docs/ARCHITECTURE.md §9.2). Si l'API
 * l'enveloppe comme `POST analyses` (`{ analysis }`), on accepte aussi cette forme.
 */
function unwrapAnalysis(body: unknown): unknown {
  if (typeof body === 'object' && body !== null && 'analysis' in body) {
    return (body as { analysis: unknown }).analysis;
  }
  return body;
}

/**
 * Client HTTP de l'analyse de token (`/api/v1/analyses`). Chaque réponse est validée par son
 * schéma Zod : le nom et le symbole du token y sont nettoyés une seconde fois (défense en
 * profondeur), et une réponse inattendue devient une erreur.
 */
@Injectable({ providedIn: 'root' })
export class AnalysisApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /**
   * POST /analyses : lance (ou relit en cache) l'analyse d'un mint ou d'un lien. Le chunk des
   * contrats (validation de la réponse) est demandé **en même temps** que la requête (et que le
   * jeton CSRF qu'elle attend), jamais en série derrière eux.
   */
  analyze(body: AnalysisRequest): Observable<AnalysisResponse> {
    prefetchContracts();
    return this.http.post(`${this.base}/analyses`, body).pipe(parseWith((c) => c.analysisResponseSchema));
  }

  /** GET /analyses/:mint/latest : dernière analyse publiée (page publique, sans quota). */
  latest(mint: string): Observable<AnalysisResult> {
    prefetchContracts();
    return this.http
      .get(`${this.base}/analyses/${encodeURIComponent(mint)}/latest`)
      .pipe(map(unwrapAnalysis), parseWith((c) => c.analysisResultSchema));
  }

  /** GET /analyses/quota : quota d'analyses restant aujourd'hui. */
  quota(): Observable<QuotaInfo> {
    return this.http.get(`${this.base}/analyses/quota`).pipe(parseWith((c) => c.quotaInfoSchema));
  }
}
