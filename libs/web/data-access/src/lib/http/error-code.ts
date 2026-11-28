import { HttpErrorResponse } from '@angular/common/http';
import { type ApiErrorCode } from '@raijin/shared-contracts';

/**
 * Code `{code}` brut d'une réponse d'erreur, sans validation Zod (utilisé par les intercepteurs,
 * chargés au démarrage). Les écrans passent par `toClientError`, qui valide le format complet.
 */
export function rawErrorCode(error: unknown): string | null {
  if (!(error instanceof HttpErrorResponse)) return null;
  const body: unknown = error.error;
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function hasErrorCode(error: unknown, ...codes: readonly ApiErrorCode[]): boolean {
  const code = rawErrorCode(error);
  return code !== null && (codes as readonly string[]).includes(code);
}

/** En-tête CSRF (valeur de `CSRF_HEADER` des contrats, vérifiée par un test). */
export const CSRF_HEADER_NAME = 'X-CSRF-Token';
