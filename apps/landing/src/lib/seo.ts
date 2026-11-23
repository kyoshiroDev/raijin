/**
 * SEO technique de la landing (docs/ARCHITECTURE.md §15.6) : URL canoniques, JSON-LD échappé, données structurées.
 * Fonctions pures, utilisées au build (pages, sitemap, images OG) et par les tests.
 */

/** Origine publique de la landing (identique à `site` dans astro.config.mjs). */
export const SITE_URL = 'https://raijinshield.com';
/** Nom officiel de la marque (BRAND.md) : titres, Open Graph, JSON-LD. */
export const BRAND_NAME = 'Raijin Shield';
export const SITE_LOCALE = 'fr_FR';

/**
 * Chemin canonique : `build.format: 'file'` produit `/tarifs.html` et `/index.html` ; on publie `/tarifs` et `/`.
 * Retire `.html`, un `/index` final, la barre finale, la requête et l'ancre.
 */
export function canonicalPath(pathname: string): string {
  let path = pathname.split(/[?#]/)[0] ?? '';
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  path = path.replace(/\.html$/, '');
  path = path.replace(/\/index$/, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

/** URL absolue canonique (canonical, og:url, sitemap, BreadcrumbList). */
export function canonicalUrl(pathname: string): string {
  const path = canonicalPath(pathname);
  return path === '/' ? `${SITE_URL}/` : `${SITE_URL}${path}`;
}

/** URL absolue de l'image Open Graph générée au build (`/og/<slug>.png`). */
export function ogImageUrl(slug: string): string {
  return `${SITE_URL}/og/${slug}.png`;
}

/**
 * JSON-LD sérialisé pour `<script type="application/ld+json">` : `<`, `>`, `&` et les séparateurs de ligne
 * Unicode sont échappés, si bien qu'aucune donnée ne peut fermer la balise ni être interprétée comme du HTML.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

type JsonLd = Record<string, unknown>;

export function organizationLd(): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: BRAND_NAME,
    url: `${SITE_URL}/`,
    logo: `${SITE_URL}/icon-512.png`,
  };
}

export interface OfferInput {
  readonly name: string;
  readonly priceCents: number;
  readonly currency: string;
}

export function softwareApplicationLd(description: string, offers: readonly OfferInput[]): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: BRAND_NAME,
    description,
    url: `${SITE_URL}/`,
    applicationCategory: 'SecurityApplication',
    operatingSystem: 'Web, iOS, Android',
    inLanguage: 'fr',
    publisher: { '@id': `${SITE_URL}/#organization` },
    offers: offers.map((offer) => ({
      '@type': 'Offer',
      name: offer.name,
      price: (offer.priceCents / 100).toFixed(2),
      priceCurrency: offer.currency,
      url: `${SITE_URL}/tarifs`,
    })),
  };
}

export interface FaqItem {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
}

export function faqPageLd(items: readonly FaqItem[]): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

export interface Crumb {
  readonly name: string;
  readonly path: string;
}

export function breadcrumbLd(crumbs: readonly Crumb[]): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: canonicalUrl(crumb.path),
    })),
  };
}

export interface ArticleInput {
  readonly title: string;
  readonly description: string;
  readonly path: string;
  readonly image: string;
  readonly publishedAt: Date;
  readonly updatedAt: Date;
}

export function articleLd(article: ArticleInput): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.description,
    image: article.image,
    inLanguage: 'fr',
    datePublished: article.publishedAt.toISOString(),
    dateModified: article.updatedAt.toISOString(),
    mainEntityOfPage: canonicalUrl(article.path),
    author: { '@id': `${SITE_URL}/#organization` },
    publisher: { '@id': `${SITE_URL}/#organization` },
  };
}
