/**
 * Briques de sécurité partagées par l'API Raijin et l'API du banc (docs/ARCHITECTURE.md §17.1) :
 * argon2id, TOTP, codes de secours, secret-box. Lib vide jusqu'à l'extraction de
 * `libs/api/auth/src/lib/admin-security` et `services/password.service.ts` (phase 8 bis, T3).
 * Aucun secret en dur : clés et paramètres sont passés par l'appelant.
 */
export const SERVER_SECURITY_SCOPE = 'server-security' as const;
