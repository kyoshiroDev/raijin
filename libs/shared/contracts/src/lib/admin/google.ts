import * as z from '../zod';

/**
 * État des services Google lus par l'admin (`libs/api/analytics`, compte de service en lecture seule).
 * Sans `GOOGLE_SERVICE_ACCOUNT_JSON` (ou sans `GA4_PROPERTY_ID` / `SEARCH_CONSOLE_SITE_URL`) : `not_connected`,
 * jamais d'erreur 5xx ; le front affiche « Non connecté » et le lien vers `docs/DEPLOY.md`.
 */
export const GOOGLE_SERVICES = ['ga4', 'search_console'] as const;
export const googleServiceSchema = z.enum(GOOGLE_SERVICES);
export type GoogleService = z.infer<typeof googleServiceSchema>;

export const GOOGLE_SERVICE_LABELS: Readonly<Record<GoogleService, string>> = {
  ga4: 'Google Analytics 4',
  search_console: 'Google Search Console',
};

/** Erreurs Google (codes internes, jamais le message brut de Google qui peut contenir des identifiants). */
export const GOOGLE_SERVICE_ERRORS = [
  /** JSON du compte de service illisible ou clé refusée par Google. */
  'auth_failed',
  /** Le compte de service n'a pas l'accès lecteur à la propriété GA4 ou Search Console. */
  'permission_denied',
  /** Quota de l'API Google atteint. */
  'quota_exceeded',
  /** Google injoignable ou délai dépassé. */
  'unavailable',
] as const;
export const googleServiceErrorSchema = z.enum(GOOGLE_SERVICE_ERRORS);
export type GoogleServiceError = z.infer<typeof googleServiceErrorSchema>;

export const GOOGLE_SERVICE_ERROR_MESSAGES: Readonly<Record<GoogleServiceError, string>> = {
  auth_failed: 'La clé du compte de service est refusée par Google. Vérifie la variable du compte de service.',
  permission_denied: 'Le compte de service n’a pas accès à cette propriété. Ajoute-le en lecteur.',
  quota_exceeded: 'Quota de l’API Google atteint. Les données reviendront plus tard.',
  unavailable: 'Google ne répond pas pour le moment. Réessaie dans quelques minutes.',
};

export const NOT_CONNECTED_LABEL = 'Non connecté';

export const googleServiceStateSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('connected'),
    /** Date de la lecture chez Google (cache Redis d'une heure, `ANALYTICS_CACHE_TTL_S`). */
    fetchedAt: z.iso.datetime(),
    cachedUntil: z.iso.datetime(),
    /** `ANALYTICS_PROVIDER=fake` (dev et tests, refusé en production) : le front affiche « données simulées ». */
    simulated: z.boolean(),
  }),
  z.object({ status: z.literal('not_connected') }),
  z.object({ status: z.literal('error'), error: googleServiceErrorSchema }),
]);
export type GoogleServiceState = z.infer<typeof googleServiceStateSchema>;

/** Réponse d'un écran Google : `data` présent seulement si le service est connecté. */
export function googleReportSchema<T extends z.ZodType, S extends z.ZodRawShape = Record<never, never>>(
  data: T,
  extra?: S,
) {
  return z
    .object({ ...(extra as S), service: googleServiceStateSchema, data: data.nullable() })
    .refine((value) => {
      // Forme générique (champs `extra` en plus) : seules `service` et `data` comptent ici.
      const report = value as unknown as { service: GoogleServiceState; data: unknown };
      return (report.service.status === 'connected') === (report.data !== null);
    }, {
      message: 'Données présentes seulement si le service est connecté.',
    });
}
