import { STATIC_PAGES, type StaticPageKey } from './pages';
import type { Crumb } from './seo';

export const HOME_CRUMB: Crumb = { name: 'Accueil', path: '/' };

/** Fil d'Ariane d'une page statique de premier niveau. */
export function pageCrumbs(key: StaticPageKey): Crumb[] {
  const page = STATIC_PAGES[key];
  return [HOME_CRUMB, { name: page.heading, path: page.path }];
}
