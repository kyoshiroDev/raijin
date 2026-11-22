import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Watch, WatchListResponse, WatchStatus } from '@raijin/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../config/api-config';
import { loadContracts } from '../contracts';

/**
 * Client HTTP des suivis (`/api/v1/watches`, docs/ARCHITECTURE.md §11.2). Chaque réponse est
 * validée par son schéma Zod (contrats chargés à la demande) : le nom et le symbole du token y
 * sont nettoyés (texte non fiable), une réponse inattendue devient une erreur.
 */
@Injectable({ providedIn: 'root' })
export class WatchesApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  async list(): Promise<WatchListResponse> {
    const [body, contracts] = await Promise.all([firstValueFrom(this.http.get(`${this.base}/watches`)), loadContracts()]);
    return contracts.watchListResponseSchema.parse(body);
  }

  /** `POST watches` : 201 (créé) ou 200 (déjà suivi), même corps. */
  async create(mint: string): Promise<Watch> {
    const [body, contracts] = await Promise.all([firstValueFrom(this.http.post(`${this.base}/watches`, { mint })), loadContracts()]);
    return contracts.watchSchema.parse(body);
  }

  async update(id: string, status: WatchStatus): Promise<Watch> {
    const [body, contracts] = await Promise.all([
      firstValueFrom(this.http.patch(`${this.base}/watches/${encodeURIComponent(id)}`, { status })),
      loadContracts(),
    ]);
    return contracts.watchSchema.parse(body);
  }

  /**
   * `POST watches/keep` : les suivis listés restent actifs, les autres (actifs ou en pause `plan_limit`)
   * passent en pause `plan_limit`. Au plus `limits.maxActiveWatches` identifiants (`WATCH_KEEP_INVALID`).
   */
  async keep(watchIds: readonly string[]): Promise<WatchListResponse> {
    const contracts = await loadContracts();
    const request = contracts.watchKeepRequestSchema.parse({ watchIds });
    const body = await firstValueFrom(this.http.post(`${this.base}/watches/keep`, request));
    return contracts.watchListResponseSchema.parse(body);
  }

  async remove(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${this.base}/watches/${encodeURIComponent(id)}`));
  }
}
