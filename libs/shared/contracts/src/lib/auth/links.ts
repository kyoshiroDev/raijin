/**
 * Pages de l'app ouvertes par les liens des e-mails d'auth. L'API construit
 * `${APP_URL}${chemin}?token=<jeton>` ; le front lit `token` et appelle la route API correspondante.
 */
export const AUTH_EMAIL_LINK_PATHS = {
  /** → POST /api/v1/auth/verify-email */
  verifyEmail: '/compte/verifier-email',
  /** → POST /api/v1/auth/password/reset */
  resetPassword: '/compte/reinitialiser-mot-de-passe',
  /** → POST /api/v1/auth/magic-link/verify */
  magicLink: '/compte/lien-magique',
  /** Page de connexion (e-mail « compte existant »). */
  login: '/compte/connexion',
  /** Demande de réinitialisation (e-mails « compte existant » et « mot de passe changé »). */
  forgotPassword: '/compte/mot-de-passe-oublie',
} as const;

/** Nom du paramètre de requête qui porte le jeton dans les liens e-mail. */
export const AUTH_EMAIL_TOKEN_PARAM = 'token';
