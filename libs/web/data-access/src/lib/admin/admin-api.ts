import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  AcquisitionDimension,
  AdminAcquisition,
  AdminHealth,
  AdminOverview,
  AdminPeriod,
  AdminProduct,
  AdminRevenue,
  AdminSeo,
  AdminTraffic,
  AdminTrials,
  AdminUserActionRequest,
  AdminUserActionResult,
  AdminUserDetail,
  AdminUserPage,
  AdminUserStatus,
  Plan,
  SeoWindow,
  TrialStatus,
} from '@raijin/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../config/api-config';
import { loadContracts } from '../contracts';

/** Période d'un écran : prédéfinie (`period`) ou personnalisée (`from` / `to`, jours UTC inclus). */
export interface AdminRangeParams {
  readonly period?: AdminPeriod;
  readonly from?: string;
  readonly to?: string;
}

/** Filtres de la liste des utilisateurs (écran 7). */
export interface AdminUserListParams {
  readonly q?: string;
  readonly plan?: Plan;
  readonly trialStatus?: TrialStatus;
  readonly status?: AdminUserStatus;
  readonly source?: string;
  readonly signupFrom?: string;
  readonly signupTo?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

function params(values: object): HttpParams {
  let out = new HttpParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    out = out.set(key, String(value));
  }
  return out;
}

/**
 * Client HTTP des écrans de l'espace admin (`/api/v1/admin/*`, docs/ARCHITECTURE.md §14). Chaque réponse est
 * validée par les contrats (textes Google, UTM et symboles bornés). Un compte non admin reçoit 404 ; une session admin
 * expirée, 403 `ADMIN_*` (géré par l'intercepteur admin).
 */
@Injectable({ providedIn: 'root' })
export class AdminApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  private async get<T>(path: string, query: object, parse: (contracts: Awaited<ReturnType<typeof loadContracts>>, body: unknown) => T): Promise<T> {
    const [body, contracts] = await Promise.all([firstValueFrom(this.http.get(`${this.base}/admin/${path}`, { params: params(query) })), loadContracts()]);
    return parse(contracts, body);
  }

  overview(range: AdminRangeParams): Promise<AdminOverview> {
    return this.get('overview', range, (c, body) => c.adminOverviewSchema.parse(body));
  }

  traffic(range: AdminRangeParams): Promise<AdminTraffic> {
    return this.get('traffic', range, (c, body) => c.adminTrafficSchema.parse(body));
  }

  seo(window: SeoWindow): Promise<AdminSeo> {
    return this.get('seo', { window }, (c, body) => c.adminSeoSchema.parse(body));
  }

  acquisition(range: AdminRangeParams, dimension: AcquisitionDimension): Promise<AdminAcquisition> {
    return this.get('acquisition', { ...range, dimension }, (c, body) => c.adminAcquisitionSchema.parse(body));
  }

  revenue(range: AdminRangeParams): Promise<AdminRevenue> {
    return this.get('revenue', range, (c, body) => c.adminRevenueSchema.parse(body));
  }

  trials(): Promise<AdminTrials> {
    return this.get('trials', {}, (c, body) => c.adminTrialsSchema.parse(body));
  }

  product(range: AdminRangeParams): Promise<AdminProduct> {
    return this.get('product', range, (c, body) => c.adminProductSchema.parse(body));
  }

  health(): Promise<AdminHealth> {
    return this.get('health', {}, (c, body) => c.adminHealthSchema.parse(body));
  }

  /** Liste et recherche (une recherche `q` est auditée côté API : HMAC du texte, jamais le texte). */
  users(query: AdminUserListParams): Promise<AdminUserPage> {
    return this.get('users', query, (c, body) => c.adminUserPageSchema.parse(body));
  }

  /** Fiche (consultation auditée). */
  user(id: string): Promise<AdminUserDetail> {
    return this.get(`users/${encodeURIComponent(id)}`, {}, (c, body) => c.adminUserDetailSchema.parse(body));
  }

  /** Action confirmée (motif, e-mail recopié, code TOTP selon l'action ; CSRF par l'intercepteur). */
  async userAction(id: string, action: AdminUserActionRequest): Promise<AdminUserActionResult> {
    const [body, contracts] = await Promise.all([
      firstValueFrom(this.http.post(`${this.base}/admin/users/${encodeURIComponent(id)}/actions`, action)),
      loadContracts(),
    ]);
    return contracts.adminUserActionResultSchema.parse(body);
  }
}
