import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { AlertListResponse, AlertReadFilter, AlertReadRequest, AlertType, AlertUnreadCount } from '@raijin/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../config/api-config';
import { loadContracts } from '../contracts';

/** Filtres de l'historique (valeurs du contrat `alertListQuerySchema`). */
export interface AlertFilters {
  readonly status: AlertReadFilter;
  /** Vide = tous les types. */
  readonly types: readonly AlertType[];
  /** Mint suivi, ou `null` pour tous les tokens. */
  readonly mint: string | null;
}

export const DEFAULT_ALERT_FILTERS: AlertFilters = { status: 'all', types: [], mint: null };

/** Paramètres de `GET alerts` (types séparés par des virgules, curseur opaque renvoyé tel quel). */
export function alertListParams(filters: AlertFilters, cursor: string | null, limit: number): HttpParams {
  let params = new HttpParams().set('limit', String(limit));
  if (filters.status !== 'all') params = params.set('status', filters.status);
  if (filters.types.length > 0) params = params.set('types', filters.types.join(','));
  if (filters.mint) params = params.set('mint', filters.mint);
  if (cursor) params = params.set('cursor', cursor);
  return params;
}

/** Client HTTP des alertes (`/api/v1/alerts`), réponses validées par les contrats. */
@Injectable({ providedIn: 'root' })
export class AlertsApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  async list(filters: AlertFilters, cursor: string | null, limit: number): Promise<AlertListResponse> {
    const [body, contracts] = await Promise.all([
      firstValueFrom(this.http.get(`${this.base}/alerts`, { params: alertListParams(filters, cursor, limit) })),
      loadContracts(),
    ]);
    return contracts.alertListResponseSchema.parse(body);
  }

  async markRead(body: AlertReadRequest): Promise<AlertUnreadCount> {
    const [response, contracts] = await Promise.all([firstValueFrom(this.http.post(`${this.base}/alerts/read`, body)), loadContracts()]);
    return contracts.alertUnreadCountSchema.parse(response);
  }
}
