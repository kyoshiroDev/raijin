import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  adminSeoDataSchema,
  adminTrafficDataSchema,
  googleServiceErrorSchema,
  type AdminSeoData,
  type AdminTrafficData,
  type GoogleService,
  type GoogleServiceError,
  type GoogleServiceState,
} from '@raijin/shared-contracts';
import type * as z from 'zod';
import { AnalyticsCache } from './cache/analytics-cache';
import type { AnalyticsConfig } from './config/analytics-config';
import { GoogleApiError } from './google/google-http';
import type { ReportSource, SeoQuery, TrafficQuery } from './reports/report-source';

/** Réponse d'un service Google : `data` présent seulement si `service.status === 'connected'`. */
export interface GoogleResult<T> {
  readonly service: GoogleServiceState;
  readonly data: T | null;
}

/** Sources disponibles (`null` = service non configuré ou clé illisible). */
export interface ReportSources {
  readonly ga4: ReportSource | null;
  readonly searchConsole: ReportSource | null;
}

export const REPORT_SOURCES = Symbol('REPORT_SOURCES');

/** Version des clés de cache : à incrémenter si la forme des données change. */
export const ANALYTICS_CACHE_PREFIX = 'analytics:v1';

type CacheEntry = { readonly ok: true; readonly fetchedAt: string; readonly cachedUntil: string; readonly data: unknown } | { readonly ok: false; readonly error: GoogleServiceError };

/**
 * Lecture des rapports Google de l'admin (docs/ARCHITECTURE.md §14.6) :
 * - sans compte de service ou sans propriété : `not_connected` (jamais de 5xx) ;
 * - JSON du compte de service illisible : `error: auth_failed` ;
 * - sinon, réponse mise en cache 1 h (`ANALYTICS_CACHE_TTL_S`), erreurs gardées 5 min, une seule lecture Google à la
 *   fois par requête identique. Les journaux ne contiennent que le service et le code (jamais le corps de Google).
 */
export class AnalyticsService {
  private readonly logger = new Logger('Analytics');
  private readonly inflight = new Map<string, Promise<GoogleResult<unknown>>>();

  constructor(
    private readonly config: AnalyticsConfig,
    private readonly cache: AnalyticsCache,
    private readonly sources: ReportSources,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** État de configuration d'un service, sans appel à Google. */
  configuredState(service: GoogleService): GoogleServiceState | null {
    const configured = service === 'ga4' ? this.config.ga4PropertyId !== null : this.config.searchConsoleSiteUrl !== null;
    if (this.config.provider === 'none') return { status: 'not_connected' };
    if (this.config.provider === 'fake') return null;
    if (!configured) return { status: 'not_connected' };
    if (this.config.serviceAccountInvalid || !this.config.serviceAccount) return { status: 'error', error: 'auth_failed' };
    return null;
  }

  /** Vrai si le service est branché (réel ou simulé), pour l'état des services de l'écran Santé. */
  isConfigured(service: GoogleService): boolean {
    const state = this.configuredState(service);
    return state === null || state.status === 'error';
  }

  traffic(query: TrafficQuery): Promise<GoogleResult<AdminTrafficData>> {
    return this.read('ga4', this.sources.ga4, query, adminTrafficDataSchema, (source) => source.traffic(query));
  }

  seo(query: SeoQuery): Promise<GoogleResult<AdminSeoData>> {
    return this.read('search_console', this.sources.searchConsole, query, adminSeoDataSchema, (source) => source.seo(query));
  }

  private async read<T>(
    service: GoogleService,
    source: ReportSource | null,
    query: object,
    schema: z.ZodType<T>,
    fetch: (source: ReportSource) => Promise<T>,
  ): Promise<GoogleResult<T>> {
    const state = this.configuredState(service);
    if (state) return { service: state, data: null };
    if (!source) return { service: { status: 'not_connected' }, data: null };
    const key = `${ANALYTICS_CACHE_PREFIX}:${service}:${createHash('sha256').update(JSON.stringify({ query, simulated: source.simulated })).digest('hex')}`;
    const cached = this.fromCache(await this.cache.get(key), schema, source.simulated);
    if (cached) return cached;
    let pending = this.inflight.get(key) as Promise<GoogleResult<T>> | undefined;
    if (!pending) {
      pending = this.fetchAndCache(service, key, source, fetch).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async fetchAndCache<T>(service: GoogleService, key: string, source: ReportSource, fetch: (source: ReportSource) => Promise<T>): Promise<GoogleResult<T>> {
    try {
      const data = await fetch(source);
      const fetchedAt = this.now();
      const cachedUntil = new Date(fetchedAt.getTime() + this.config.cacheTtlS * 1000);
      const entry: CacheEntry = { ok: true, fetchedAt: fetchedAt.toISOString(), cachedUntil: cachedUntil.toISOString(), data };
      await this.cache.set(key, JSON.stringify(entry), this.config.cacheTtlS);
      return { service: { status: 'connected', fetchedAt: entry.fetchedAt, cachedUntil: entry.cachedUntil, simulated: source.simulated }, data };
    } catch (failure) {
      const error: GoogleServiceError = failure instanceof GoogleApiError ? failure.code : 'unavailable';
      const status = failure instanceof GoogleApiError && failure.status !== null ? ` (HTTP ${failure.status})` : '';
      this.logger.warn(`Google ${service} : ${error}${status}`);
      const entry: CacheEntry = { ok: false, error };
      await this.cache.set(key, JSON.stringify(entry), this.config.errorCacheTtlS);
      return { service: { status: 'error', error }, data: null };
    }
  }

  /** Entrée de cache revalidée (Redis n'est pas une source de confiance pour le front). */
  private fromCache<T>(raw: string | null, schema: z.ZodType<T>, simulated: boolean): GoogleResult<T> | null {
    if (!raw) return null;
    try {
      const entry = JSON.parse(raw) as CacheEntry;
      if (entry.ok === false) {
        const error = googleServiceErrorSchema.safeParse(entry.error);
        return error.success ? { service: { status: 'error', error: error.data }, data: null } : null;
      }
      const data = schema.safeParse(entry.data);
      if (!data.success || typeof entry.fetchedAt !== 'string' || typeof entry.cachedUntil !== 'string') return null;
      return { service: { status: 'connected', fetchedAt: entry.fetchedAt, cachedUntil: entry.cachedUntil, simulated }, data: data.data };
    } catch {
      return null;
    }
  }
}
