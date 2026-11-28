import * as z from './zod';
import { ADMIN_ERROR_CODES } from './admin/errors';
import { ANALYSIS_ERROR_CODES } from './analysis/errors';
import { BILLING_ERROR_CODES } from './billing/errors';
import { WALLET_ERROR_CODES } from './wallet/errors';
import { WATCH_ERROR_CODES } from './watch/errors';

/** Codes d'erreur génériques de l'API (`/api/v1`). */
export const GENERIC_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
  /** Maintenance programmée (`MAINTENANCE_MODE=1`) : 503 sur toutes les routes sauf `health` ; le front affiche la page de maintenance. */
  'MAINTENANCE',
] as const;

/**
 * Codes d'erreur propres à l'authentification. Volontairement peu bavards : aucun code ne révèle
 * si un e-mail possède un compte (pas d'énumération), un jeton invalide ou expiré donne le même code.
 */
export const AUTH_ERROR_CODES = [
  /**
   * E-mail ou mot de passe incorrect, ou trop de tentatives (verrouillage temporaire) : une seule
   * réponse pour ne révéler ni l'existence du compte ni son verrouillage.
   */
  'AUTH_INVALID_CREDENTIALS',
  /** Action réservée à un e-mail vérifié. */
  'AUTH_EMAIL_NOT_VERIFIED',
  /** Jeton de vérification, de réinitialisation ou de lien magique invalide, expiré ou déjà utilisé. */
  'AUTH_TOKEN_INVALID',
  /** Session absente, expirée ou révoquée (refresh réutilisé compris) : reconnexion nécessaire. */
  'AUTH_SESSION_EXPIRED',
  /** En-tête `X-CSRF-Token` absent ou différent du cookie CSRF. */
  'AUTH_CSRF_INVALID',
  /** Mot de passe refusé (règles de longueur, ou identique à l'e-mail). */
  'AUTH_PASSWORD_REJECTED',
  /** Réservé : l'API ne le renvoie plus (verrouillage couvert par AUTH_INVALID_CREDENTIALS). */
  'AUTH_ACCOUNT_LOCKED',
] as const;

/** Codes d'erreur standard de l'API : génériques + authentification + analyse + suivis/alertes/push + scan de wallet + abonnement/essai + admin. */
export const apiErrorCodeSchema = z.enum([
  ...GENERIC_ERROR_CODES,
  ...AUTH_ERROR_CODES,
  ...ANALYSIS_ERROR_CODES,
  ...WATCH_ERROR_CODES,
  ...WALLET_ERROR_CODES,
  ...BILLING_ERROR_CODES,
  ...ADMIN_ERROR_CODES,
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const authErrorCodeSchema = z.enum(AUTH_ERROR_CODES);
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;

/** Format d'erreur unique renvoyé par l'API, sans stack trace en production. */
export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Messages français par défaut des erreurs d'auth (affichés par le front, ton neutre). */
export const AUTH_ERROR_MESSAGES: Readonly<Record<AuthErrorCode, string>> = {
  AUTH_INVALID_CREDENTIALS:
    'E-mail ou mot de passe incorrect. Après plusieurs essais, patiente quelques minutes avant de réessayer.',
  AUTH_EMAIL_NOT_VERIFIED: 'Confirme d’abord ton adresse e-mail.',
  AUTH_TOKEN_INVALID: 'Ce lien n’est plus valide. Demande-en un nouveau.',
  AUTH_SESSION_EXPIRED: 'Ta session a expiré. Reconnecte-toi.',
  AUTH_CSRF_INVALID: 'La requête a été refusée. Recharge la page et réessaie.',
  AUTH_PASSWORD_REJECTED: 'Ce mot de passe ne respecte pas les règles.',
  AUTH_ACCOUNT_LOCKED: 'Trop de tentatives. Réessaie dans quelques minutes.',
};
