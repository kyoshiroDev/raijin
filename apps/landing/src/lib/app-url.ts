// Module virtuel d'Astro (variables publiques du build), inconnu de la règle des frontières Nx.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { APP_URL } from 'astro:env/server';

/**
 * URL absolue d'une page de l'app (`/inscription`, `/analyse`…), calculée au build depuis `APP_URL`.
 * À poser sur un `<a data-app-link>` : le script de la landing y ajoute `utm_*`, `rj_ref`, `rj_lp`.
 */
export function appHref(path: `/${string}`): string {
  const base = (APP_URL ?? 'https://app.raijinshield.com').replace(/\/+$/, '');
  return `${base}${path}`;
}
