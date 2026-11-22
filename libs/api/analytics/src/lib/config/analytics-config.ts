import type { AppConfig } from '@raijin/api-core';
import { parseServiceAccount, type ServiceAccountKey } from '../google/service-account';

/**
 * Configuration de l'accès Google de l'admin (bloc « Google » de docs/ENV.md, docs/ARCHITECTURE.md §14.6), dérivée de
 * `AppConfig.analytics` (validée par `loadConfig` : `ANALYTICS_PROVIDER=fake` y est refusé en production). La clé
 * privée du compte de service ne quitte jamais cet objet et le client OAuth ; aucun message ne cite de valeur.
 */
export interface AnalyticsConfig {
  /**
   * `google` : lecture réelle ; `fake` : données simulées déterministes (dev, e2e ; refusé en production) ;
   * `none` : aucun compte de service → « Non connecté ».
   */
  readonly provider: 'google' | 'fake' | 'none';
  /** Compte de service valide, sinon `null`. */
  readonly serviceAccount: ServiceAccountKey | null;
  /** JSON fourni mais illisible : l'écran affiche `auth_failed` (le démarrage n'est pas bloqué). */
  readonly serviceAccountInvalid: boolean;
  /** Identifiant numérique de la propriété GA4, `null` si absent. */
  readonly ga4PropertyId: string | null;
  /** Propriété Search Console (`sc-domain:exemple.com` ou `https://exemple.com/`), `null` si absente. */
  readonly searchConsoleSiteUrl: string | null;
  /** Cache Redis des réponses Google (s) : 1 h par défaut. */
  readonly cacheTtlS: number;
  /** Cache des erreurs Google (s) : 5 min (pas de martèlement). */
  readonly errorCacheTtlS: number;
}

export const ANALYTICS_CONFIG = Symbol('ANALYTICS_CONFIG');
export const ANALYTICS_ERROR_CACHE_TTL_S = 300;

/** Construit la configuration Google à partir d'`AppConfig.analytics` (le JSON est lu ici, une fois). */
export function analyticsConfigFrom(analytics: AppConfig['analytics'], warn: (message: string) => void = () => undefined): AnalyticsConfig {
  const serviceAccount = analytics.serviceAccountJson ? parseServiceAccount(analytics.serviceAccountJson) : null;
  const serviceAccountInvalid = analytics.serviceAccountJson !== null && serviceAccount === null;
  if (serviceAccountInvalid && analytics.provider === 'google') {
    warn('GOOGLE_SERVICE_ACCOUNT_JSON : JSON du compte de service illisible (l’admin affichera auth_failed).');
  }
  return {
    provider: analytics.provider,
    serviceAccount,
    serviceAccountInvalid,
    ga4PropertyId: analytics.ga4PropertyId,
    searchConsoleSiteUrl: analytics.searchConsoleSiteUrl,
    cacheTtlS: analytics.cacheTtlS,
    errorCacheTtlS: ANALYTICS_ERROR_CACHE_TTL_S,
  };
}
