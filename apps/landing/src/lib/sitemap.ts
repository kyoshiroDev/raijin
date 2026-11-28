import { canonicalUrl } from './seo';

export interface SitemapEntry {
  readonly path: string;
  readonly lastmod: Date;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Sitemap XML (protocole sitemaps.org) : URL canoniques uniques, `lastmod` au format AAAA-MM-JJ. */
export function buildSitemap(entries: readonly SitemapEntry[]): string {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const entry of entries) {
    const loc = canonicalUrl(entry.path);
    if (seen.has(loc)) continue;
    seen.add(loc);
    urls.push(`  <url><loc>${escapeXml(loc)}</loc><lastmod>${entry.lastmod.toISOString().slice(0, 10)}</lastmod></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
