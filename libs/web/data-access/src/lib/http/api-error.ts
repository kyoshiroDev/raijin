import { HttpErrorResponse } from '@angular/common/http';
import {
  ANALYSIS_ERROR_MESSAGES,
  AUTH_ERROR_MESSAGES,
  WATCH_ERROR_MESSAGES,
  apiErrorSchema,
  authErrorCodeSchema,
  type ApiErrorCode,
} from '@raijin/shared-contracts';

/** Code d'erreur côté front : codes de l'API, plus l'absence de réseau. */
export type ClientErrorCode = ApiErrorCode | 'NETWORK_ERROR';

/** Erreur affichable : un code stable (logique) et un message français (affichage). */
export interface ClientError {
  readonly code: ClientErrorCode;
  readonly message: string;
  readonly status: number;
}

/**
 * Messages des codes génériques. Le message renvoyé par l'API n'est jamais affiché tel quel :
 * le texte reste maîtrisé par le front (ton de la charte, aucune fuite technique).
 */
export const GENERIC_ERROR_MESSAGES: Readonly<Record<Exclude<ClientErrorCode, keyof typeof AUTH_ERROR_MESSAGES>, string>> = {
  NETWORK_ERROR: 'Raijin ne répond pas. Vérifie ta connexion puis réessaie.',
  VALIDATION_ERROR: 'Certaines informations ne sont pas valides. Vérifie le formulaire.',
  UNAUTHORIZED: 'Connecte-toi pour continuer.',
  FORBIDDEN: 'Tu n’as pas accès à cette action.',
  NOT_FOUND: 'Cette ressource est introuvable.',
  CONFLICT: 'Cette action n’est plus possible dans l’état actuel.',
  RATE_LIMITED: 'Trop de demandes d’un coup. Patiente une minute puis réessaie.',
  QUOTA_EXCEEDED: 'Tu as atteint la limite de ton plan pour aujourd’hui.',
  UPSTREAM_UNAVAILABLE: 'Un service source est indisponible. Réessaie dans un instant.',
  INTERNAL_ERROR: 'Une erreur est survenue de notre côté. Réessaie dans un instant.',
  MAINTENANCE: 'Raijin est en maintenance pour quelques minutes. Réessaie un peu plus tard.',
  MINT_INVALID: ANALYSIS_ERROR_MESSAGES.MINT_INVALID,
  TOKEN_NOT_FOUND: ANALYSIS_ERROR_MESSAGES.TOKEN_NOT_FOUND,
  TOKEN_UNANALYZABLE: ANALYSIS_ERROR_MESSAGES.TOKEN_UNANALYZABLE,
  ANALYSIS_NOT_FOUND: ANALYSIS_ERROR_MESSAGES.ANALYSIS_NOT_FOUND,
  ...WATCH_ERROR_MESSAGES,
};

const ERROR_MESSAGES: Readonly<Record<ClientErrorCode, string>> = {
  ...GENERIC_ERROR_MESSAGES,
  ...AUTH_ERROR_MESSAGES,
};

/** Code par défaut quand le corps de la réponse ne respecte pas le format `{code, message}`. */
function codeFromStatus(status: number): ClientErrorCode {
  if (status === 0) return 'NETWORK_ERROR';
  if (status === 400 || status === 422) return 'VALIDATION_ERROR';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 502 || status === 503 || status === 504) return 'UPSTREAM_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

/** Lit le code `{code, message}` d'une réponse d'erreur, sinon `null`. */
export function apiErrorCode(error: unknown): ApiErrorCode | null {
  if (!(error instanceof HttpErrorResponse)) return null;
  const parsed = apiErrorSchema.safeParse(error.error);
  return parsed.success ? parsed.data.code : null;
}

/** Vrai si l'erreur porte un code d'authentification précis. */
export function isAuthErrorCode(error: unknown, code: ApiErrorCode): boolean {
  return apiErrorCode(error) === code;
}

/** Transforme n'importe quelle erreur (HTTP, réseau, inattendue) en erreur affichable. */
export function toClientError(error: unknown): ClientError {
  if (error instanceof HttpErrorResponse) {
    const code = apiErrorCode(error) ?? codeFromStatus(error.status);
    return { code, message: ERROR_MESSAGES[code], status: error.status };
  }
  return { code: 'INTERNAL_ERROR', message: ERROR_MESSAGES.INTERNAL_ERROR, status: 0 };
}

/** Vrai pour un code d'erreur propre à l'authentification. */
export function isAuthError(code: ClientErrorCode): boolean {
  return authErrorCodeSchema.safeParse(code).success;
}
