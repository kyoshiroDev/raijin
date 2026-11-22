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
