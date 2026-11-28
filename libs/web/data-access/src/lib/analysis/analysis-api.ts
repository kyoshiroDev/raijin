import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { type AnalysisRequest, type AnalysisResponse, type AnalysisResult, type QuotaInfo } from '@raijin/shared-contracts';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from '../config/api-config';
import { AnalysisValidator } from './analysis-validation';
import { readQuotaInfo } from './quota-shape';

/**
 * `GET analyses/:mint/latest` renvoie le résultat seul (docs/ARCHITECTURE.md §9.2). Si l'API
 * l'enveloppe comme `POST analyses` (`{ analysis }`), on accepte aussi cette forme.
 */
export function unwrapAnalysis(body: unknown): unknown {
  if (typeof body === 'object' && body !== null && 'analysis' in body) {
    return (body as { analysis: unknown }).analysis;
  }
  return body;
}

/**
 * Client HTTP de l'analyse de token (`/api/v1/analyses`). Chaque réponse est validée par son
 * schéma Zod (pour l'analyse : après l'affichage, voir `AnalysisStore`) : le nom et le symbole du token y sont nettoyés une seconde fois (défense en
 * profondeur), et une réponse inattendue devient une erreur.
 */
@Injectable({ providedIn: 'root' })
export class AnalysisApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly validator = inject(AnalysisValidator);

  /**
   * POST /analyses : lance (ou relit en cache) l'analyse d'un mint ou d'un lien. Corps renvoyé
   * **brut** : l'écran l'affiche après un simple contrôle de forme (`readAnalysisResponse`), puis
   * le valide par les contrats à l'inactivité (`validateResponse`). Aucun chunk Zod avant le LCP.
   */
  analyze(body: AnalysisRequest): Observable<unknown> {
    return this.http.post(`${this.base}/analyses`, body);
  }

  /** GET /analyses/:mint/latest : dernière analyse publiée (page publique, sans quota), brute. */
  latest(mint: string): Observable<unknown> {
    return this.http.get(`${this.base}/analyses/${encodeURIComponent(mint)}/latest`).pipe(map(unwrapAnalysis));
  }

  /**
   * Validation complète (contrats, dans un Web Worker si possible : `AnalysisValidator`) : nettoie nom et
   * symbole, rejette l'inattendu.
   */
  validateResponse(body: unknown): Promise<AnalysisResponse> {
    return this.validator.validateResponse(body);
  }

  /** Validation complète d'un résultat seul (page publique), hors du fil principal si possible. */
  validateResult(body: unknown): Promise<AnalysisResult> {
    return this.validator.validateResult(body);
  }

  /** GET /analyses/quota : quota d'analyses restant aujourd'hui (validé sans Zod, voir `readQuotaInfo`). */
  quota(): Observable<QuotaInfo> {
    return this.http.get(`${this.base}/analyses/quota`).pipe(map(readQuotaInfo));
  }
}
