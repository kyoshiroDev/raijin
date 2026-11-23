import { describe, expect, it } from 'vitest';
import { buildSitemap } from './sitemap';

describe('sitemap', () => {
  it('liste des URL canoniques uniques avec lastmod', () => {
    const xml = buildSitemap([
      { path: '/', lastmod: new Date('2026-11-23T10:00:00Z') },
      { path: '/tarifs', lastmod: new Date('2026-11-20T00:00:00Z') },
      { path: '/tarifs.html', lastmod: new Date('2026-11-20T00:00:00Z') },
    ]);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<url><loc>https://raijinshield.com/</loc><lastmod>2026-11-23</lastmod></url>');
    expect(xml.match(/<loc>https:\/\/raijinshield.com\/tarifs<\/loc>/g)).toHaveLength(1);
    expect(xml).not.toContain('.html');
  });
});
