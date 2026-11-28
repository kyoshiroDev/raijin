import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ADMIN_ERROR_MESSAGES,
  AUTH_ERROR_MESSAGES as AUTH_MESSAGES,
  type AdminErrorCode,
  type ApiErrorCode,
  type AuthErrorCode,
} from '@raijin/shared-contracts';

/** Messages français par défaut des codes génériques. */
export const GENERIC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  VALIDATION_ERROR: 'Certaines informations sont invalides.',
  UNAUTHORIZED: 'Connecte-toi pour continuer.',
  FORBIDDEN: 'Accès refusé.',
  NOT_FOUND: 'Ressource introuvable.',
  CONFLICT: 'Cette action est en conflit avec l’état actuel.',
  RATE_LIMITED: 'Trop de requêtes. Réessaie dans un instant.',
  QUOTA_EXCEEDED: 'Quota atteint.',
  UPSTREAM_UNAVAILABLE: 'Un service externe est indisponible. Réessaie plus tard.',
  INTERNAL_ERROR: 'Une erreur est survenue. Réessaie plus tard.',
  MAINTENANCE: 'Raijin est en maintenance. Reviens dans quelques minutes.',
};

/** Messages des contrats : authentification et espace admin (dont `ACCOUNT_SUSPENDED`). */
const CONTRACT_MESSAGES: Readonly<Record<string, string>> = { ...AUTH_MESSAGES, ...ADMIN_ERROR_MESSAGES };

export function defaultMessage(code: ApiErrorCode): string {
  return CONTRACT_MESSAGES[code] ?? GENERIC_ERROR_MESSAGES[code] ?? GENERIC_ERROR_MESSAGES['INTERNAL_ERROR'] ?? 'Erreur.';
}

/** Erreur métier de l'API : rendue telle quelle au format `{code, message}` par le filtre global. */
export class ApiException extends HttpException {
  constructor(
    public readonly code: ApiErrorCode,
    status: HttpStatus,
    message: string = defaultMessage(code),
  ) {
    super({ code, message }, status);
  }

  /** Erreur d'authentification avec le message neutre des contrats. */
  static auth(code: AuthErrorCode, status: HttpStatus): ApiException {
    const message = AUTH_MESSAGES[code];
    return new ApiException(code, status, message);
  }

  /** Erreur de l'espace admin (ou `ACCOUNT_SUSPENDED`) avec le message des contrats. */
  static admin(code: AdminErrorCode, status: HttpStatus): ApiException {
    const message = ADMIN_ERROR_MESSAGES[code];
    return new ApiException(code, status, message);
  }
}
