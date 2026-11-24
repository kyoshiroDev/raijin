import { HttpException, HttpStatus } from '@nestjs/common';
import type { BenchError, BenchErrorCode } from '@raijin/bench-contracts';

/** Messages génériques (français), volontairement peu bavards sur l'authentification. */
export const BENCH_ERROR_MESSAGES: Readonly<Record<BenchErrorCode, string>> = {
  VALIDATION_ERROR: 'Certaines informations sont invalides.',
  UNAUTHORIZED: 'Accès refusé.',
  NOT_FOUND: 'Ressource introuvable.',
  CONFLICT: 'Conflit avec l’état actuel.',
  RATE_LIMITED: 'Trop de requêtes : réessaie dans un instant.',
  UPSTREAM_UNAVAILABLE: 'Source de données indisponible.',
  INTERNAL_ERROR: 'Erreur interne.',
  AUTH_INVALID_CREDENTIALS: 'Identifiants ou code incorrects.',
  AUTH_SESSION_EXPIRED: 'Session absente ou expirée : reconnecte-toi.',
  AUTH_CSRF_INVALID: 'Requête refusée (jeton CSRF).',
  PAPER_REJECTED: 'Ordre refusé.',
  PAPER_BOOK_ARCHIVED: 'Carnet archivé : lecture seule.',
  BENCH_SHADOW_MODE: 'Action désactivée en mode ombre.',
  BACKTEST_ALREADY_QUEUED: 'Un run est déjà en file ou en cours.',
};

/** Erreur de l'API du banc, rendue `{ code, message }` par `BenchExceptionFilter`. */
export class BenchException extends HttpException {
  constructor(
    readonly code: BenchErrorCode,
    status: HttpStatus,
    message: string = BENCH_ERROR_MESSAGES[code],
  ) {
    super({ code, message } satisfies BenchError, status);
  }

  static unauthorized(): BenchException {
    return new BenchException('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
  }

  static invalidCredentials(): BenchException {
    return new BenchException('AUTH_INVALID_CREDENTIALS', HttpStatus.UNAUTHORIZED);
  }

  static csrf(): BenchException {
    return new BenchException('AUTH_CSRF_INVALID', HttpStatus.FORBIDDEN);
  }
}
