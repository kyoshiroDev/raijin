/**
 * Garde de chaque contrôleur `admin/*` de cette lib : `AuthGuard` puis `AdminGuard` de `api-auth` (rôle ADMIN relu en
 * base → 404 sinon, 2FA obligatoire, session admin 30 min / 8 h, throttler `admin`, `Cache-Control: no-store`).
 */
export { AdminRoute } from '@raijin/api-auth';
