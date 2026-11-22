import { expect, test, type Page } from '@playwright/test';
import { APP_ORIGIN, PASSWORD, uniqueFreeEmail } from './support/auth';
import { loginVerifiedAdmin, sql } from './support/admin';
import { ATTRIBUTION_COOKIE, CONSENT_COOKIE, LANDING_GA4_ID, LANDING_ORIGIN, consentBanner, interceptGoogle } from './support/landing';
import { api } from './support/watch';

/**
 * Landing : consentement CNIL, GA4 et attribution (phase 6 bis, docs/ANALYTICS.md, PROMPT.md §4.6), sur le build Astro
 * de test (identifiant GA4 factice, liens vers l'app de test). Requêtes Google interceptées (jamais envoyées) et
 * comptées : aucune avant l'accord, aucune après un refus ; `gtag.js` seulement après « Tout accepter ».
 */

const GTAG = `https://www.googletagmanager.com/gtag/js?id=${LANDING_GA4_ID}`;

async function openLanding(page: Page, query = ''): Promise<string[]> {
  const google = await interceptGoogle(page);
  await page.goto(`${LANDING_ORIGIN}/${query}`);
  await expect(page.locator('main h1')).toHaveText('Vérifie avant de signer.');
  await bootDone(page);
  return google;
}

/**
 * Script de la landing exécuté : il affiche « Gérer les cookies » (masqué sans JS). Le chargement de GA4, s'il doit
 * avoir lieu, est décidé dans ce même passage synchrone ; `load` attend en plus les ressources de la page.
 */
async function bootDone(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Gérer les cookies' })).toBeVisible();
  await page.waitForLoadState('load');
}

async function cookieValue(page: Page, name: string): Promise<string | undefined> {
  return (await page.context().cookies(LANDING_ORIGIN)).find((cookie) => cookie.name === name)?.value;
}

const gtagLoaded = (page: Page) => page.evaluate(() => typeof (window as unknown as { gtag?: unknown }).gtag === 'function');

test.describe('landing : consentement', () => {
  test('première visite : bannière affichée, aucune requête Google ni cookie avant le choix', async ({ page }) => {
    const google = await openLanding(page);
    const banner = consentBanner(page);
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Tout refuser' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Tout accepter' })).toBeVisible();
    // Aucune case précochée dans le panneau « Personnaliser ».
    await banner.getByRole('button', { name: 'Personnaliser' }).click();
    await expect(banner.getByRole('switch', { name: /Mesure d.audience/ })).not.toBeChecked();
    expect(google, 'requêtes Google avant le choix').toEqual([]);
    expect(await gtagLoaded(page)).toBe(false);
    const names = (await page.context().cookies()).map((cookie) => cookie.name);
    expect(names.filter((name) => name === CONSENT_COOKIE || name === ATTRIBUTION_COOKIE || name.startsWith('_ga'))).toEqual([]);
  });

  test('« Tout refuser » : aucune requête Google, choix mémorisé au rechargement', async ({ page }) => {
    const google = await openLanding(page);
    await consentBanner(page).getByRole('button', { name: 'Tout refuser' }).click();
    await expect(consentBanner(page)).toBeHidden();
    expect(await cookieValue(page, CONSENT_COOKIE)).toMatch(/^v1\.denied\.\d{4}-\d{2}-\d{2}$/);
    await page.reload();
    await bootDone(page);
    await expect(consentBanner(page), 'choix mémorisé : bannière non réaffichée').toBeHidden();
    expect(google, 'requêtes Google après refus').toEqual([]);
    expect(await gtagLoaded(page)).toBe(false);
  });

  test('« Tout accepter » : gtag.js chargé, Consent Mode accordé à la mesure seule, choix mémorisé', async ({ page }) => {
    const google = await openLanding(page);
    expect(google).toEqual([]);
    await consentBanner(page).getByRole('button', { name: 'Tout accepter' }).click();
    await expect(consentBanner(page)).toBeHidden();
    await expect.poll(() => google.includes(GTAG), { message: `requête ${GTAG}` }).toBe(true);
    expect(await gtagLoaded(page)).toBe(true);
    const consent = await page.evaluate(() =>
      ((window as unknown as { dataLayer?: ArrayLike<unknown>[] }).dataLayer ?? [])
        .map((entry) => Array.from(entry))
        .filter((entry) => entry[0] === 'consent'),
    );
    expect(consent[0]).toEqual(['consent', 'default', expect.objectContaining({ analytics_storage: 'denied', ad_storage: 'denied' })]);
    expect(consent).toContainEqual(['consent', 'update', { analytics_storage: 'granted' }]);
    expect(await cookieValue(page, CONSENT_COOKIE)).toMatch(/^v1\.granted\.\d{4}-\d{2}-\d{2}$/);

    // Visite suivante : pas de bannière, GA4 chargé d'emblée.
    google.length = 0;
    await page.reload();
    await expect(consentBanner(page)).toBeHidden();
    await expect.poll(() => google.includes(GTAG)).toBe(true);
  });

  test('« Gérer les cookies » rouvre la bannière ; personnaliser puis retirer l’accord', async ({ page }) => {
    const google = await openLanding(page);
    await consentBanner(page).getByRole('button', { name: 'Tout refuser' }).click();
    const manage = page.getByRole('button', { name: 'Gérer les cookies' });
    await expect(manage).toBeVisible();
    await manage.click();
    const banner = consentBanner(page);
    await expect(banner).toBeVisible();
    await expect(banner).toBeFocused();

    await banner.getByRole('button', { name: 'Personnaliser' }).click();
    await banner.getByRole('switch', { name: /Mesure d.audience/ }).check();
    await banner.getByRole('button', { name: 'Enregistrer mes choix' }).click();
    await expect(banner).toBeHidden();
    await expect(manage, 'focus rendu au bouton d’origine').toBeFocused();
    await expect.poll(() => google.includes(GTAG)).toBe(true);
    expect(await cookieValue(page, CONSENT_COOKIE)).toMatch(/^v1\.granted\./);

    // Retrait : GA4 désactivé, plus aucun cookie _ga.
    await manage.click();
    await banner.getByRole('button', { name: 'Tout refuser' }).click();
    expect(await cookieValue(page, CONSENT_COOKIE)).toMatch(/^v1\.denied\./);
    expect(await page.evaluate((id) => (window as unknown as Record<string, unknown>)[`ga-disable-${id}`], LANDING_GA4_ID)).toBe(true);
    expect((await page.context().cookies(LANDING_ORIGIN)).filter((cookie) => cookie.name.startsWith('_ga'))).toEqual([]);
  });
});

test.describe('landing : attribution jusqu’au compte', () => {
  test('utm_* sur la landing → lien vers l’inscription décoré → inscription dans l’app → attribution stockée', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const source = `e2e-src-${tag}`;
    const campaign = `lancement-${tag}`;
    await interceptGoogle(page);
    await page.goto(`${LANDING_ORIGIN}/?utm_source=${source}&utm_medium=social&utm_campaign=${campaign}`, { referer: 'https://x.com/raijin' });
    await expect(consentBanner(page)).toBeVisible();
    // Sans accord : attribution gardée pour l'onglet seulement (sessionStorage), aucun cookie rj_attr.
    await consentBanner(page).getByRole('button', { name: 'Tout refuser' }).click();
    expect(await cookieValue(page, ATTRIBUTION_COOKIE)).toBeUndefined();

    const cta = page.getByRole('link', { name: 'Essayer Raijin' });
    await expect(cta).toHaveAttribute('href', new RegExp(`utm_source=${source}`));
    const href = new URL(String(await cta.getAttribute('href')));
    expect(href.origin, 'lien vers l’app de test (APP_URL)').toBe(new URL(APP_ORIGIN).origin);
    expect(Object.fromEntries(href.searchParams)).toEqual(
      expect.objectContaining({ utm_source: source, utm_medium: 'social', utm_campaign: campaign, rj_lp: '/' }),
    );
    expect(href.searchParams.get('rj_ref') ?? '').toMatch(/^https:\/\/x\.com/);
    // L'inscription de l'app est /compte/inscription (libs/web/feature-compte) : le lien doit y mener directement.
    expect.soft(href.pathname, 'le lien « Essayer Raijin » mène à l’écran d’inscription de l’app').toBe('/compte/inscription');

    await cta.click();
    await expect(page).toHaveURL(new RegExp(`^${APP_ORIGIN}`));
    await expect(page.locator('main h1').first()).toBeVisible();
    // Même onglet : l'attribution relevée au démarrage de l'app (sessionStorage) est conservée ; si le lien mène
    // ailleurs (assertion souple ci-dessus), la suite du parcours reste testée.
    await page.goto('/compte/inscription');
    await expect(page.locator('main h1').first()).toHaveText('Créer ton compte');
    const email = uniqueFreeEmail('attribution');
    await page.getByLabel('Adresse e-mail').fill(email);
    await page.getByLabel('Mot de passe', { exact: true }).fill(PASSWORD);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Créer mon compte' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Vérifie ta boîte mail' })).toBeVisible({ timeout: 15_000 });

    const [user] = await sql<{ id: string; utmSource: string | null; utmMedium: string | null; utmCampaign: string | null; landingPath: string | null; referrer: string | null }>(
      `SELECT "id", "utmSource", "utmMedium", "utmCampaign", "landingPath", "referrer" FROM "User" WHERE "email" = $1`,
      [email],
    );
    expect(user).toMatchObject({ utmSource: source, utmMedium: 'social', utmCampaign: campaign, landingPath: '/' });
    expect(user?.referrer ?? '').toMatch(/^https:\/\/x\.com/);

    // Fiche admin du compte : attribution visible par l'API admin (session admin vérifiée).
    const adminContext = await browser.newContext({ baseURL: APP_ORIGIN });
    try {
      const adminPage = await adminContext.newPage();
      await loginVerifiedAdmin(adminPage);
      const detail = await api(adminContext.request, 'GET', `/admin/users/${user?.id ?? ''}`);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(detail.body['attribution']).toMatchObject({ utmSource: source, utmCampaign: campaign, landingPath: '/' });
    } finally {
      await adminContext.close();
    }
  });
});
