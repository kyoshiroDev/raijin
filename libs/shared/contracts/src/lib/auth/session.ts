import * as z from '../zod';
import { relativePathSchema } from './common';
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

/**
 * POST /api/v1/auth/magic-link/verify → 200 : session + page de retour demandée lors de l'envoi
 * du lien (`redirectPath` validé à la demande, `null` si aucune). Le lien peut être ouvert dans
 * un autre onglet : le front ne peut pas garder ce chemin en mémoire.
 */
export const magicLinkSessionSchema = authSessionSchema.extend({
  redirectPath: relativePathSchema.nullable(),
});
export type MagicLinkSession = z.infer<typeof magicLinkSessionSchema>;

/**
 * GET /api/v1/auth/session → 200 `SessionState` (phase 3, performance et Best Practices) :
 * - `{ authenticated: true, ...AuthSession }` : session valide ;
 * - `{ authenticated: false }` : **aucun** cookie de session (ni access, ni refresh) : visiteur
 *   anonyme, sans 401 (une erreur réseau dans la console coûte des points Lighthouse) ni tentative
 *   de refresh inutile.
 * Un 401 reste renvoyé quand un cookie de session est présent mais l'access token absent, expiré ou
 * invalide : le front tente alors un refresh (intercepteur), comme avant.
 */
export const anonymousSessionStateSchema = z.object({ authenticated: z.literal(false) });
export const authenticatedSessionStateSchema = authSessionSchema.extend({ authenticated: z.literal(true) });
export const sessionStateSchema = z.discriminatedUnion('authenticated', [
  authenticatedSessionStateSchema,
  anonymousSessionStateSchema,
]);
export type SessionState = z.infer<typeof sessionStateSchema>;
