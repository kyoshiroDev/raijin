import { z } from 'zod';
import { publicUserSchema } from './user';

/** En-tête envoyé par le front sur chaque mutation (POST, PUT, PATCH, DELETE). */
export const CSRF_HEADER = 'X-CSRF-Token';

/** Jeton CSRF (double-submit signé) : base64url. */
export const csrfTokenSchema = z.string().regex(/^[A-Za-z0-9_.-]{32,256}$/);

/** GET /api/v1/auth/csrf → 200 (pose aussi le cookie CSRF). Appelé au démarrage du front. */
export const csrfResponseSchema = z.object({ csrfToken: csrfTokenSchema });
export type CsrfResponse = z.infer<typeof csrfResponseSchema>;

/**
 * Réponse de session (login, lien magique, vérification d'e-mail, refresh, GET /auth/session).
 * Les jetons eux-mêmes ne sont jamais dans le corps : uniquement en cookies httpOnly.
 * Le front garde `csrfToken` en mémoire (signal), jamais dans le stockage du navigateur.
 */
export const authSessionSchema = z.object({
  user: publicUserSchema,
  /** Expiration de l'access token : le front rafraîchit (POST /auth/refresh) un peu avant. */
  accessTokenExpiresAt: z.iso.datetime(),
  csrfToken: csrfTokenSchema,
});
export type AuthSession = z.infer<typeof authSessionSchema>;
