import type { APIRoute } from 'astro';
import { getGuides, guidePath } from '../lib/collections';
import { LEGAL_UPDATED_AT } from '../lib/content';
import { STATIC_PAGES } from '../lib/pages';
import { buildSitemap, type SitemapEntry } from '../lib/sitemap';

/** `sitemap.xml` statique (docs/ARCHITECTURE.md §15.6) : pages indexables + guides, URL canoniques sans `.html`. */
export const GET: APIRoute = async () => {
  const guides = await getGuides();
  const latestGuide = guides.reduce((max, guide) => Math.max(max, guide.data.updatedAt.getTime()), 0);
  const legal = new Set<string>([STATIC_PAGES.mentionsLegales.path, STATIC_PAGES.cgu.path, STATIC_PAGES.confidentialite.path]);
  const entries: SitemapEntry[] = Object.values(STATIC_PAGES)
    .filter((page) => page.indexable)
    .map((page) => ({
      path: page.path,
      lastmod: legal.has(page.path) ? LEGAL_UPDATED_AT : new Date(Math.max(latestGuide, LEGAL_UPDATED_AT.getTime())),
    }));
  for (const guide of guides) entries.push({ path: guidePath(guide.id), lastmod: guide.data.updatedAt });
  return new Response(buildSitemap(entries), { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
