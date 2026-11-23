// Module virtuel d'Astro (variables publiques du build), inconnu de la règle des frontières Nx.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { APP_URL } from 'astro:env/server';

/**
 * Routes de l'app visées par la landing (apps/web/src/app/app.routes.ts, contrats `auth/links.ts`) : liste fermée,
 * une route inexistante est refusée par `astro check`.
 */
export const APP_ROUTES = {
  inscription: '/compte/inscription',
  connexion: '/compte/connexion',
  analyse: '/analyse',
} as const;
export type AppRoute = (typeof APP_ROUTES)[keyof typeof APP_ROUTES];

/**
 * URL absolue d'une page de l'app, calculée au build depuis `APP_URL`.
 * À poser sur un `<a data-app-link>` : le script de la landing y ajoute `utm_*`, `rj_ref`, `rj_lp`.
 */
export function appHref(route: AppRoute): string {
  const base = (APP_URL ?? 'https://app.raijinshield.com').replace(/\/+$/, '');
  return `${base}${route}`;
}
