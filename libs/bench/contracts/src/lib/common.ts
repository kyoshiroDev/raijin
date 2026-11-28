import * as z from './zod';

/**
 * Briques communes des contrats de l'API du banc (`/api`, docs/ARCHITECTURE.md §17).
 * Format des corps : noms de colonnes en `snake_case`, identiques aux tables Supabase portées
 * (le front du banc garde ses parseurs et ses libellés) ; dates ISO 8601 UTC ; `numeric` Postgres
 * sérialisé en `number` fini par l'API (jamais en texte).
 */

/** Préfixe des routes de l'API du banc (Traefik route `/api/` vers `raijin-bench-api`). */
export const BENCH_API_PREFIX = '/api';

export const isoDateTimeSchema = z.iso.datetime({ offset: true });
/** Jour calendaire `AAAA-MM-JJ` (UTC). */
export const isoDaySchema = z.iso.date();

export const finiteNumberSchema = z.number();
export const nonNegativeSchema = z.number().nonnegative();
export const countSchema = z.number().int().nonnegative();
/** Fraction 0–1. */
export const fractionSchema = z.number().min(0).max(1);

/** Identifiant de ligne : `uuid` ou entier `bigint` sérialisé en texte (jamais en number). */
export const rowIdSchema = z.string().regex(/^([0-9a-f-]{36}|\d{1,19})$/i, { message: 'Identifiant invalide.' });

/** Texte venu d'une source externe (nom, symbole, libellé RugCheck) : borné, nettoyé à l'affichage par le front. */
export function externalTextSchema(max: number) {
  return z.string().max(max);
}

/** Codes d'erreur de l'API du banc. Volontairement peu bavards sur l'authentification. */
export const BENCH_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
  /** E-mail, mot de passe ou code TOTP incorrect, ou trop d'essais : une seule réponse. */
  'AUTH_INVALID_CREDENTIALS',
  /** Session absente, expirée, révoquée, ou cookie d'une autre application (Raijin) : reconnexion. */
  'AUTH_SESSION_EXPIRED',
  /** En-tête CSRF absent ou différent du cookie CSRF. */
  'AUTH_CSRF_INVALID',
  /** Ordre de paper trading refusé par les contrôles serveur (statut, solde, carnet). */
  'PAPER_REJECTED',
  /** Carnet archivé : lecture seule (ni annulation ni remise à zéro). */
  'PAPER_BOOK_ARCHIVED',
  /** Action désactivée en mode ombre (notifications, ouverture automatique). */
  'BENCH_SHADOW_MODE',
  /** Un run de backtest est déjà en file ou en cours. */
  'BACKTEST_ALREADY_QUEUED',
] as const;
export const benchErrorCodeSchema = z.enum(BENCH_ERROR_CODES);
export type BenchErrorCode = z.infer<typeof benchErrorCodeSchema>;

/** Format d'erreur unique de l'API du banc (sans stack trace). */
export const benchErrorSchema = z.object({ code: benchErrorCodeSchema, message: z.string().min(1).max(300) });
export type BenchError = z.infer<typeof benchErrorSchema>;

/** Liste simple bornée (`{ items }`), `truncated` vrai quand la limite a été atteinte. */
export function listResponseSchema<T extends z.ZodType>(item: T, max: number) {
  return z.object({ items: z.array(item).max(max), truncated: z.boolean() });
}
