// @vitest-environment jsdom
import { PUBLIC_PLAN_CATALOG } from '@raijin/shared-contracts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER } from './lib/content';
import { STATIC_PAGES } from './lib/pages';
import { formatPrice } from './lib/pricing';
import { canonicalUrl, SITE_URL } from './lib/seo';

/**
 * Vérifications sur le build réel (`dist/apps/landing`, produit par la cible `build`, dont dépend `test`) :
 * SEO de chaque page, JSON-LD, sitemap, liens vers l'app, mention légale, mots interdits, budget JS.
 */
const DIST = resolve(process.cwd(), '../../dist/apps/landing');
const CONTENT = resolve(process.cwd(), 'src');

function walk(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, ext);
    return path.endsWith(ext) ? [path] : [];
  });
}

if (!existsSync(join(DIST, 'index.html'))) {
  throw new Error(`Build introuvable : ${DIST}. Lance d'abord « nx run landing:build ».`);
}

interface Page {
  file: string;
  /** Chemin public (`/tarifs`, `/`). */
  path: string;
  doc: Document;
  html: string;
}

const pages: Page[] = walk(DIST, '.html').map((file) => {
  const html = readFileSync(file, 'utf8');
  const path = `/${relative(DIST, file).replace(/\\/g, '/')}`.replace(/\.html$/, '').replace(/\/index$/, '/');
  return { file, path, html, doc: new DOMParser().parseFromString(html, 'text/html') };
});
const indexable = pages.filter((page) => page.path !== '/404');
const meta = (doc: Document, selector: string) => doc.querySelector(selector)?.getAttribute('content') ?? null;

/** Base de l'app fixée au build : lue sur le formulaire du hero (`{APP_URL}/analyse`). */
const home = pages.find((page) => page.path === '/');
const appBase = (home?.doc.querySelector('form[data-analyse-form]')?.getAttribute('action') ?? '').replace(
  /\/analyse$/,
  '',
);
const APP_PATHS = ['/compte/inscription', '/compte/connexion', '/analyse'];

/** Mots et symboles interdits par la charte (BRAND.md, PROMPT.md §2). */
const FORBIDDEN = [/\bx10\b/i, /\bmoon\b/i, /\bgems?\b/i, /achète/i, /opportunité/i, /signal d['’]achat/i, /🚀/u, /💰/u];

function visibleText(doc: Document): string {
  const clone = doc.body.cloneNode(true) as HTMLElement;
  for (const script of clone.querySelectorAll('script, style')) script.remove();
  return clone.textContent ?? '';
}

describe('build : pages et SEO', () => {
  it('produit toutes les pages attendues', () => {
    const paths = pages.map((page) => page.path).sort();
    for (const page of Object.values(STATIC_PAGES)) expect(paths).toContain(page.path);
    expect(paths.filter((path) => path.startsWith('/guides/')).length).toBeGreaterThanOrEqual(3);
  });

  it.each(pages.map((page) => [page.path, page] as const))('%s : lang, h1 unique, title, description, OG', (_, page) => {
    const { doc } = page;
    expect(doc.documentElement.lang).toBe('fr');
    expect(doc.querySelectorAll('h1')).toHaveLength(1);
    expect(doc.querySelectorAll('main')).toHaveLength(1);
    const title = doc.title;
    const description = meta(doc, 'meta[name="description"]') ?? '';
    expect(title.length).toBeGreaterThanOrEqual(20);
    expect(title.length).toBeLessThanOrEqual(70);
    expect(title).toContain('Raijin Shield');
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(meta(doc, 'meta[property="og:title"]')).toBe(title);
    expect(meta(doc, 'meta[property="og:site_name"]')).toBe('Raijin Shield');
    expect(meta(doc, 'meta[name="twitter:card"]')).toBe('summary_large_image');
    const image = meta(doc, 'meta[property="og:image"]') ?? '';
    expect(image.startsWith(`${SITE_URL}/og/`)).toBe(true);
    const png = join(DIST, image.slice(SITE_URL.length));
    expect(existsSync(png)).toBe(true);
    expect(statSync(png).size).toBeLessThanOrEqual(150_000);
  });

  it('title et description sont uniques', () => {
    const titles = indexable.map((page) => page.doc.title);
    const descriptions = indexable.map((page) => meta(page.doc, 'meta[name="description"]'));
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('canonical et og:url sans .html ni /index ; 404 en noindex', () => {
    for (const page of indexable) {
      const canonical = page.doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
      expect(canonical, page.path).toBe(canonicalUrl(page.path));
      expect(canonical).not.toMatch(/\.html$|\/index$/);
      expect(meta(page.doc, 'meta[property="og:url"]')).toBe(canonical);
    }
    const notFound = pages.find((page) => page.path === '/404') as Page;
    expect(meta(notFound.doc, 'meta[name="robots"]')).toContain('noindex');
    expect(notFound.doc.querySelector('link[rel="canonical"]')).toBeNull();
  });

  it('le title de l’accueil est celui de la charte', () => {
    expect(home?.doc.title).toBe('Raijin Shield — le bouclier anti-rug des memecoins Solana');
    expect(home?.doc.querySelector('h1')?.textContent?.trim()).toBe('Vérifie avant de signer.');
  });
});

describe('build : JSON-LD', () => {
  function jsonLd(page: Page): Record<string, unknown>[] {
    return [...page.doc.querySelectorAll('script[type="application/ld+json"]')].map((script) => {
      const text = script.textContent ?? '';
      expect(text).not.toMatch(/<\/?script/i);
      return JSON.parse(text) as Record<string, unknown>;
    });
  }
  const types = (page: Page) => jsonLd(page).map((data) => data['@type']);

  it('est du JSON valide, avec contexte schema.org, sur chaque page', () => {
    for (const page of pages) {
      for (const data of jsonLd(page)) expect(data['@context']).toBe('https://schema.org');
    }
  });

  it('porte les bons types par page', () => {
    const byPath = (path: string) => pages.find((page) => page.path === path) as Page;
    expect(types(byPath('/'))).toEqual(expect.arrayContaining(['Organization', 'SoftwareApplication', 'FAQPage']));
    expect(types(byPath('/faq'))).toEqual(expect.arrayContaining(['FAQPage', 'BreadcrumbList']));
    expect(types(byPath('/tarifs'))).toContain('BreadcrumbList');
    for (const guide of pages.filter((page) => page.path.startsWith('/guides/'))) {
      expect(types(guide)).toEqual(expect.arrayContaining(['Article', 'BreadcrumbList']));
    }
  });

  it('les offres du SoftwareApplication suivent le catalogue', () => {
    const app = jsonLd(home as Page).find((data) => data['@type'] === 'SoftwareApplication') as { offers: { price: string }[] };
    expect(app.offers.map((offer) => offer.price)).toEqual([
      '0.00',
      (PUBLIC_PLAN_CATALOG.pro.monthly.amountCents / 100).toFixed(2),
      (PUBLIC_PLAN_CATALOG.pro.yearly.amountCents / 100).toFixed(2),
    ]);
  });
});

describe('build : sitemap et robots', () => {
  it('le sitemap liste exactement les pages indexables', () => {
    const xml = readFileSync(join(DIST, 'sitemap.xml'), 'utf8');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]).sort();
    expect(locs).toEqual(indexable.map((page) => canonicalUrl(page.path)).sort());
  });

  it('robots.txt déclare le sitemap', () => {
    expect(readFileSync(join(DIST, 'robots.txt'), 'utf8')).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
  });
});

describe('build : liens', () => {
  it('les liens vers l’app visent seulement les routes existantes et portent data-app-link', () => {
    expect(appBase).toMatch(/^https?:\/\//);
    for (const page of pages) {
      for (const link of page.doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const href = link.getAttribute('href') ?? '';
        if (!href.startsWith(appBase)) continue;
        expect(APP_PATHS, `${page.path} → ${href}`).toContain(href.slice(appBase.length));
        expect(link.hasAttribute('data-app-link'), `${page.path} → ${href}`).toBe(true);
      }
    }
  });

  it('les liens internes mènent à des pages du build', () => {
    const known = new Set(pages.map((page) => page.path));
    for (const page of pages) {
      for (const link of page.doc.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')) {
        const path = (link.getAttribute('href') ?? '').split('#')[0] ?? '';
        expect(known.has(path), `${page.path} → ${path}`).toBe(true);
      }
    }
  });

  it('chaque guide renvoie vers au moins un autre guide', () => {
    for (const guide of pages.filter((page) => page.path.startsWith('/guides/'))) {
      const others = [...guide.doc.querySelectorAll('a[href^="/guides/"]')]
        .map((link) => link.getAttribute('href'))
        .filter((href) => href !== guide.path);
      expect(others.length, guide.path).toBeGreaterThan(0);
    }
  });
});

describe('build : contenu', () => {
  it('la mention légale figure dans le pied de page de chaque page et dans le contenu de la page Tarifs', () => {
    for (const page of pages) {
      expect(page.doc.querySelector('footer [data-disclaimer]')?.textContent?.trim(), page.path).toBe(DISCLAIMER);
    }
    const tarifs = pages.find((page) => page.path === '/tarifs') as Page;
    expect(tarifs.doc.querySelector('main [data-disclaimer]')?.textContent?.trim()).toBe(DISCLAIMER);
  });

  it('les prix affichés sur l’accueil et les tarifs sont ceux du catalogue', () => {
    const { monthly, yearly } = PUBLIC_PLAN_CATALOG.pro;
    for (const path of ['/', '/tarifs']) {
      const doc = (pages.find((page) => page.path === path) as Page).doc;
      expect(doc.querySelector('[data-price="pro-monthly"]')?.textContent).toBe(formatPrice(monthly.amountCents, monthly.currency));
      expect(doc.querySelector('[data-price="pro-yearly"]')?.textContent).toBe(formatPrice(yearly.amountCents, yearly.currency));
      expect(visibleText(doc)).toContain('Essaie Pro gratuitement pendant 7 jours. Sans carte bancaire.');
    }
  });

  it('les pages légales affichent « À compléter » au lieu d’une identité', () => {
    for (const path of ['/mentions-legales', '/cgu', '/confidentialite']) {
      const doc = (pages.find((page) => page.path === path) as Page).doc;
      expect(doc.querySelectorAll('[data-legal-todo]').length, path).toBeGreaterThan(0);
    }
    const privacy = visibleText((pages.find((page) => page.path === '/confidentialite') as Page).doc);
    for (const word of ['rj_consent', 'rj_attr', '_ga', 'sessionStorage', 'Stripe', 'Resend', 'Helius', 'CNIL']) {
      expect(privacy).toContain(word);
    }
  });

  it('aucun mot interdit dans les pages ni dans les contenus sources', () => {
    const sources = [...walk(join(CONTENT, 'content'), '.md'), ...walk(join(CONTENT, 'content'), '.json')];
    const texts = [
      ...pages.map((page) => [page.path, visibleText(page.doc)] as const),
      ...sources.map((file) => [file, readFileSync(file, 'utf8')] as const),
    ];
    for (const [where, text] of texts) {
      for (const word of FORBIDDEN) expect(text, `${where} : ${word}`).not.toMatch(word);
    }
  });
});

describe('build : performance et sécurité', () => {
  it('les liens externes portent rel="noopener noreferrer"', () => {
    for (const page of pages) {
      for (const link of page.doc.querySelectorAll<HTMLAnchorElement>('a[href^="http"]')) {
        const href = link.getAttribute('href') ?? '';
        if (href.startsWith(appBase) || href.startsWith(SITE_URL)) continue;
        const rel = (link.getAttribute('rel') ?? '').split(/\s+/);
        expect(rel, `${page.path} → ${href}`).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
      }
    }
  });

  it('aucun style en ligne (CSP style-src self)', () => {
    for (const page of pages) {
      expect(page.doc.querySelectorAll('style'), page.path).toHaveLength(0);
      expect(page.doc.querySelectorAll('[style]'), page.path).toHaveLength(0);
    }
  });

  it('chaque tableau est dans une région défilante focalisable et nommée', () => {
    for (const page of pages) {
      for (const table of page.doc.querySelectorAll('table')) {
        const region = table.parentElement;
        expect(region?.getAttribute('role'), page.path).toBe('region');
        expect(region?.getAttribute('tabindex'), page.path).toBe('0');
        expect(region?.getAttribute('aria-label')?.length ?? 0, page.path).toBeGreaterThan(3);
      }
    }
  });


  it('aucun script inline exécutable ni script Google dans le HTML', () => {
    for (const page of pages) {
      for (const script of page.doc.querySelectorAll('script')) {
        const type = script.getAttribute('type');
        if (type === 'application/ld+json') continue;
        expect(script.getAttribute('src'), page.path).toMatch(/^\/_astro\/[\w.-]+\.js$/);
        expect(script.textContent?.trim()).toBe('');
      }
      expect(page.html).not.toMatch(/googletagmanager|google-analytics|fonts\.googleapis/);
    }
  });

  it('JS ≤ 12 ko gzip par page, accueil ≤ 200 ko au total', () => {
    const gz = (path: string) => gzipSync(readFileSync(join(DIST, path))).length;
    const imported = (path: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(path)) return seen;
      seen.add(path);
      const code = readFileSync(join(DIST, path), 'utf8');
      for (const match of code.matchAll(/from\s*"\.\/([\w.-]+\.js)"|import\s*"\.\/([\w.-]+\.js)"/g)) {
        imported(`/_astro/${match[1] ?? match[2]}`, seen);
      }
      return seen;
    };
    for (const page of pages) {
      const scripts = new Set<string>();
      for (const script of page.doc.querySelectorAll('script[src]')) {
        for (const file of imported(script.getAttribute('src') ?? '')) scripts.add(file);
      }
      const js = [...scripts].reduce((sum, file) => sum + gz(file), 0);
      expect(js, page.path).toBeLessThanOrEqual(12 * 1024);
      if (page.path === '/') {
        const css = [...page.doc.querySelectorAll('link[rel="stylesheet"]')].reduce(
          (sum, link) => sum + gz(link.getAttribute('href') ?? ''),
          0,
        );
        const fonts = [...page.doc.querySelectorAll('link[rel="preload"][as="font"]')].reduce(
          (sum, link) => sum + statSync(join(DIST, link.getAttribute('href') ?? '')).size,
          0,
        );
        expect(gzipSync(page.html).length + css + js + fonts).toBeLessThanOrEqual(200 * 1024);
      }
    }
  });
});
