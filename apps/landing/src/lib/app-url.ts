// Module virtuel d'Astro (variables publiques du build), inconnu de la règle des frontières Nx.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { APP_URL } from 'astro:env/server';
import { buildAnalyseUrl, normalizeAppBase } from './app-links';
import { assertAllowedAppUrl } from './app-url-policy';

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

/** Base de l'app fixée au build (`APP_URL`), sans barre finale. */
export function appBase(): string {
  return normalizeAppBase(assertAllowedAppUrl(APP_URL ?? 'https://app.raijinshield.com'));
}

/**
 * URL absolue d'une page de l'app, calculée au build depuis `APP_URL`.
 * À poser sur un `<a data-app-link>` : le script de la landing y ajoute `utm_*`, `rj_ref`, `rj_lp`.
 */
export function appHref(route: AppRoute): string {
  return `${appBase()}${route}`;
}

/**
 * URL de l'analyse d'un token dans l'app (`/analyse/<mint>`), mint validé puis encodé ; une adresse invalide
 * renvoie vers le champ d'analyse de l'app.
 */
export function appAnalyseHref(mint: string): string {
  return buildAnalyseUrl(appBase(), mint) ?? appHref(APP_ROUTES.analyse);
}
