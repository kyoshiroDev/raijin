import { currentPasswordSchema, emailSchema, recoveryCodeSchema, totpCodeSchema } from '@raijin/shared-contracts';
import * as z from './zod';
import { isoDateTimeSchema } from './common';
import { benchModeSchema } from './mode';

/**
 * Authentification privée du banc (docs/ARCHITECTURE.md §17.7). Un seul compte
 * (`BENCH_OWNER_EMAIL`), aucune inscription, aucune réinitialisation par e-mail : le mot de passe
 * (argon2id) et le TOTP sont posés par la CLI du conteneur. Connexion en une étape (mot de passe et
 * code TOTP ensemble) : aucun état « à moitié connecté ».
 *
 * Routes : `POST /api/auth/login` (public, throttlé) → 200 `BenchSession` + cookies ;
 * `GET /api/auth/session` → `BenchSession` (401 sinon) ; `POST /api/auth/logout` (CSRF) → 204.
 */

/**
 * Second facteur : le code TOTP de l'application, **ou** un code de secours à usage unique
 * (`recovery_code`, `ABCDE-FGH23`, remis par la CLI). Exactement l'un des deux.
 */
export const benchLoginRequestSchema = z
  .object({
    email: emailSchema,
    password: currentPasswordSchema,
    totp: totpCodeSchema.optional(),
    recovery_code: recoveryCodeSchema.optional(),
  })
  .strict()
  .refine((value) => (value.totp === undefined) !== (value.recovery_code === undefined), {
    message: 'Code de vérification requis.',
  });
export type BenchLoginRequest = z.infer<typeof benchLoginRequestSchema>;

export const benchSessionSchema = z.object({
  email: emailSchema,
  mode: benchModeSchema,
  /** Fin absolue de la session (pas de prolongation au-delà). */
  expiresAt: isoDateTimeSchema,
});
export type BenchSession = z.infer<typeof benchSessionSchema>;

/** Session courte : 2 h d'inactivité, 12 h au maximum. */
export const BENCH_SESSION_IDLE_SECONDS = 2 * 3600;
export const BENCH_SESSION_MAX_SECONDS = 12 * 3600;

/**
 * Cookies du banc, distincts de ceux de Raijin (`rj_*`) : un cookie Raijin n'est jamais lu par le
 * banc, et les secrets de signature sont distincts. Session httpOnly ; CSRF lisible par le front
 * (double-submit, renvoyé dans `BENCH_CSRF_HEADER`).
 */
export function benchCookieNames(secure: boolean): { readonly session: string; readonly csrf: string } {
  return secure ? { session: '__Host-rjb_session', csrf: '__Host-rjb_csrf' } : { session: 'rjb_session', csrf: 'rjb_csrf' };
}
export const BENCH_CSRF_HEADER = 'X-CSRF-Token';

/** Nombre de codes de secours remis par la CLI (`create-owner`, `reset-2fa`). */
export const BENCH_RECOVERY_CODE_COUNT = 10;
