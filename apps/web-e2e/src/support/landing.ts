import { type Page, type Request } from '@playwright/test';

/**
 * Landing Astro de test (phase 6 bis, docs/ANALYTICS.md) : build avec l'identifiant GA4 factice `G-E2ETEST01` et
 * `APP_URL` = l'app de test, servi par apps/web-e2e/scripts/serve-landing.mjs (webServer de playwright.config.mts).
 */
export const LANDING_ORIGIN = process.env['LANDING_ORIGIN'] ?? 'http://localhost:4330';
export const LANDING_GA4_ID = 'G-E2ETEST01';

/** Cookies de la landing (miroir de `CONSENT_COOKIE_NAME` / `ATTRIBUTION_COOKIE_NAME`, contrats `analytics/ga4.ts`). */
export const CONSENT_COOKIE = 'rj_consent';
export const ATTRIBUTION_COOKIE = 'rj_attr';

/** Hôtes Google qu'aucune page ne doit contacter avant l'accord (scripts, collecte, polices). */
const GOOGLE_HOST = /(^|\.)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

export function isGoogleRequest(request: Request): boolean {
  try {
    return GOOGLE_HOST.test(new URL(request.url()).hostname);
  } catch {
    return false;
  }
}

/**
 * Intercepte toute requête vers Google : rien ne sort de la machine (CI hors ligne), `gtag.js` est remplacé par un
 * script vide. Renvoie la liste (vivante) des URL demandées, dans l'ordre.
 */
export async function interceptGoogle(page: Page): Promise<string[]> {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (isGoogleRequest(request)) seen.push(request.url());
  });
  await page.context().route(
    (url) => GOOGLE_HOST.test(url.hostname),
    (route) =>
      route.request().resourceType() === 'script'
        ? route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* gtag.js simulé (e2e) */' })
        : route.fulfill({ status: 204, body: '' }),
  );
  return seen;
}

export const consentBanner = (page: Page) => page.getByRole('dialog', { name: /^Cookies et mesure d.audience$/ });

/** Pages de la landing (phase 7, docs/ARCHITECTURE.md §15.5) : chemin servi sans `.html`, titre `h1` attendu. */
export interface LandingRoute {
  /** Identifiant court (noms de tests et de captures). */
  slug: string;
  path: string;
  heading: string;
  /** Statut HTTP attendu (la 404 est servie avec 404). */
  status?: number;
  /** Page avec un fil d'Ariane visible (pages internes). */
  breadcrumb?: boolean;
  /** Page légale : champs « À compléter » visibles. */
  legal?: boolean;
}

export const LANDING_GUIDES = [
  { slug: 'rug-pull-solana', heading: 'Comment repérer un rug pull sur Solana avant de signer', title: 'Comment repérer un rug pull sur Solana' },
  { slug: 'mint-authority', heading: "Mint authority et freeze authority : ce qu'elles permettent sur Solana", title: "Mint authority : c'est quoi ?" },
  { slug: 'honeypot-solana', heading: "Honeypot sur Solana : comment détecter un token qu'on ne peut pas revendre", title: 'Honeypot : comment le détecter' },
] as const;

export const LANDING_ROUTES: readonly LandingRoute[] = [
  { slug: 'accueil', path: '/', heading: 'Vérifie avant de signer.' },
  { slug: 'tarifs', path: '/tarifs', heading: 'Tarifs', breadcrumb: true },
  { slug: 'comment-ca-marche', path: '/comment-ca-marche', heading: 'Comment ça marche', breadcrumb: true },
  { slug: 'faq', path: '/faq', heading: 'Questions fréquentes', breadcrumb: true },
  { slug: 'guides', path: '/guides', heading: 'Guides', breadcrumb: true },
  ...LANDING_GUIDES.map((guide) => ({ slug: `guide-${guide.slug}`, path: `/guides/${guide.slug}`, heading: guide.heading, breadcrumb: true })),
  { slug: 'mentions-legales', path: '/mentions-legales', heading: 'Mentions légales', breadcrumb: true, legal: true },
  { slug: 'cgu', path: '/cgu', heading: "Conditions générales d'utilisation et de vente", breadcrumb: true, legal: true },
  { slug: 'confidentialite', path: '/confidentialite', heading: 'Politique de confidentialité', breadcrumb: true, legal: true },
  { slug: '404', path: '/page-qui-n-existe-pas', heading: 'Page introuvable', status: 404 },
];

/**
 * Choix de consentement posé avant la visite (cookie `rj_consent` au format `v1.<choix>.<date>`) : bannière masquée ;
 * `granted` charge GA4 (script Google intercepté par `interceptGoogle`).
 */
export async function presetConsent(page: Page, choice: 'granted' | 'denied'): Promise<void> {
  await page.context().addCookies([
    { name: CONSENT_COOKIE, value: `v1.${choice}.${new Date().toISOString().slice(0, 10)}`, url: LANDING_ORIGIN, sameSite: 'Lax' },
  ]);
}

/** Événements GA4 poussés par `gtag('event', …)` dans `dataLayer` (gtag.js simulé : rien n'est envoyé). */
export function ga4Events(page: Page): Promise<{ name: string; params: Record<string, unknown> }[]> {
  return page.evaluate(() =>
    ((window as unknown as { dataLayer?: ArrayLike<unknown>[] }).dataLayer ?? [])
      .map((entry) => Array.from(entry))
      .filter((entry) => entry[0] === 'event')
      .map((entry) => ({ name: String(entry[1]), params: (entry[2] ?? {}) as Record<string, unknown> })),
  );
}
