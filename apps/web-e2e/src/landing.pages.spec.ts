import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { APP_ORIGIN } from './support/auth';
import { MINTS } from './support/analysis';
import { LANDING_GUIDES, LANDING_ORIGIN, LANDING_ROUTES, consentBanner, ga4Events, interceptGoogle, presetConsent } from './support/landing';

/**
 * Landing Astro de bout en bout (phase 7, PROMPT.md §4.5 et §9, docs/ARCHITECTURE.md §15) sur le build de test servi par
 * scripts/serve-landing.mjs (`/x` → `x.html`). Les vérifications statiques du build (title, description, canonical, OG,
 * JSON-LD, sitemap, prix, liens, budgets) sont dans apps/landing/src/dist.spec.ts : ici, le comportement dans le
 * navigateur (chargement sans erreur, navigation, îlots, événements GA4 selon le consentement, reduced-motion).
 * Google est intercepté (rien ne sort) ; l'app n'est jamais chargée : toute navigation vers `APP_ORIGIN` est servie par
 * une page vide et seule son URL est vérifiée.
 */

const ANALYSE_ERRORS = {
  empty: "Colle l'adresse d'un token Solana ou un lien DexScreener, pump.fun, Solscan ou Birdeye.",
  invalid: "Ce n'est pas une adresse de token Solana valide. Vérifie qu'elle est complète (32 à 44 caractères).",
};
const DISCLAIMER = /Ce n'est pas un conseil en investissement\./;

/** Navigations vers l'app : servies par une page vide, URL relevées dans l'ordre. */
async function stubApp(context: BrowserContext): Promise<string[]> {
  const urls: string[] = [];
  await context.route(
    (url) => url.origin === new URL(APP_ORIGIN).origin,
    (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>App (e2e)</title><h1>App</h1>' });
    },
  );
  return urls;
}

/** Erreurs de la page : exceptions, `console.error`, requêtes de la landing en échec (≥ 400). */
function collectErrors(page: Page, expectedStatus = 200): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`exception : ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // La 404 est servie avec le statut 404 : Chromium le journalise pour le document lui-même.
    if (expectedStatus === 404 && /status of 404/.test(message.text())) return;
    errors.push(`console : ${message.text()}`);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== LANDING_ORIGIN || response.status() < 400) return;
    if (response.request().resourceType() === 'document' && response.status() === expectedStatus) return;
    errors.push(`HTTP ${response.status()} ${url.pathname}`);
  });
  return errors;
}

/** Ouvre une page de la landing (consentement déjà refusé : bannière masquée) et attend son script. */
async function openLanding(page: Page, path: string, consent: 'granted' | 'denied' | null = 'denied'): Promise<void> {
  await interceptGoogle(page);
  if (consent) await presetConsent(page, consent);
  await page.goto(`${LANDING_ORIGIN}${path}`);
  await expect(page.locator('main h1')).toBeVisible();
  // Le script de la page a tourné : « Gérer les cookies » est masqué sans JS.
  await expect(page.getByRole('button', { name: 'Gérer les cookies' })).toBeVisible();
}

/** Première URL relevée (le test a déjà vérifié qu'il y en a une). */
function first(urls: readonly string[]): string {
  return urls[0] ?? '';
}

const heroForm = (page: Page) => page.getByRole('form', { name: 'Analyser un token Solana' });
const heroInput = (page: Page) => heroForm(page).getByLabel('Adresse du token ou lien');

test.describe('landing : chaque page se charge sans erreur', () => {
  for (const route of LANDING_ROUTES) {
    const status = route.status ?? 200;
    test(`${route.slug} (${route.path})`, async ({ page }) => {
      const errors = collectErrors(page, status);
      await interceptGoogle(page);
      await presetConsent(page, 'denied');
      const response = await page.goto(`${LANDING_ORIGIN}${route.path}`);
      expect(response?.status(), 'statut HTTP').toBe(status);
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
      await expect(page.locator('h1'), 'un seul h1').toHaveCount(1);
      await expect(page.locator('main h1')).toHaveText(route.heading);
      await expect(page.getByRole('button', { name: 'Gérer les cookies' }), 'script de la page exécuté').toBeVisible();
      await page.waitForLoadState('load');
      // Mention légale dans le pied de page de chaque page.
      await expect(page.locator('footer [data-disclaimer]')).toHaveText(DISCLAIMER);
      await expect(page.locator('footer [data-disclaimer]')).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  for (const route of LANDING_ROUTES.filter((r) => r.breadcrumb)) {
    test(`${route.slug} : fil d’Ariane (Accueil → page courante)`, async ({ page }) => {
      await openLanding(page, route.path);
      const crumbs = page.getByRole('navigation', { name: "Fil d'Ariane" });
      await expect(crumbs.getByRole('link', { name: 'Accueil' })).toHaveAttribute('href', '/');
      await expect(crumbs.locator('[aria-current="page"]')).toHaveCount(1);
    });
  }

  for (const route of LANDING_ROUTES.filter((r) => r.legal)) {
    test(`${route.slug} : identité de l'éditeur affichée (seul le médiateur des CGU reste « À compléter »)`, async ({ page }) => {
      await openLanding(page, route.path);
      await expect(page.locator('main')).toContainText('Grégory Tahir EI');
      await expect(page.locator('main')).toContainText('contact@raijinshield.com');
      const todo = page.locator('main [data-legal-todo]');
      expect(await todo.count(), 'champs légaux « À compléter »').toBe(route.slug === 'cgu' ? 1 : 0);
    });
  }

  test('tarifs : mention légale aussi dans la page, pas seulement le pied de page', async ({ page }) => {
    await openLanding(page, '/tarifs');
    await expect(page.locator('main [data-disclaimer]')).toHaveText(DISCLAIMER);
    await expect(page.locator('main [data-disclaimer]')).toBeVisible();
  });
});

test.describe('landing : navigation', () => {
  test('desktop : navigation principale de l’en-tête, page courante marquée', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openLanding(page, '/');
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(nav).toBeVisible();
    await expect(page.locator('details.menu-mobile'), 'menu mobile masqué dès 1024 px').toBeHidden();
    for (const [label, heading] of [
      ['Comment ça marche', 'Comment ça marche'],
      ['Tarifs', 'Tarifs'],
      ['Guides', 'Guides'],
      ['FAQ', 'Questions fréquentes'],
    ] as const) {
      await nav.getByRole('link', { name: label, exact: true }).click();
      await expect(page.locator('main h1')).toHaveText(heading);
      await expect(page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('link', { name: label, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
    await page.getByRole('link', { name: 'Raijin Shield, accueil' }).click();
    await expect(page.locator('main h1')).toHaveText('Vérifie avant de signer.');
  });

  test('mobile : menu <details> ouvert au clavier, liens utilisables, fermé par un second appui', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLanding(page, '/');
    await expect(page.getByRole('navigation', { name: 'Navigation principale' }), 'navigation en ligne masquée sous 1024 px').toBeHidden();
    const summary = page.locator('details.menu-mobile > summary');
    const menu = page.getByRole('navigation', { name: 'Menu', exact: true });
    await expect(summary).toBeVisible();
    await expect(menu).toBeHidden();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Connexion' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await summary.click();
    await menu.getByRole('link', { name: 'Tarifs', exact: true }).click();
    await expect(page).toHaveURL(`${LANDING_ORIGIN}/tarifs`);
    await expect(page.locator('main h1')).toHaveText('Tarifs');
    await expect(menu, 'menu refermé sur la nouvelle page').toBeHidden();
  });

  test('pied de page : pages et informations légales', async ({ page }) => {
    await openLanding(page, '/');
    const footer = page.locator('footer');
    for (const [nav, label, heading] of [
      ['Informations légales', 'Mentions légales', 'Mentions légales'],
      ['Informations légales', 'CGU et CGV', "Conditions générales d'utilisation et de vente"],
      ['Informations légales', 'Confidentialité', 'Politique de confidentialité'],
      ['Pages', 'FAQ', 'Questions fréquentes'],
      ['Pages', 'Guides', 'Guides'],
    ] as const) {
      await footer.getByRole('navigation', { name: nav }).getByRole('link', { name: label, exact: true }).click();
      await expect(page.locator('main h1')).toHaveText(heading);
    }
  });

  test('fil d’Ariane d’un guide : Accueil › Guides › guide', async ({ page }) => {
    const guide = LANDING_GUIDES[0];
    await openLanding(page, `/guides/${guide.slug}`);
    const crumbs = page.getByRole('navigation', { name: "Fil d'Ariane" });
    await expect(crumbs.getByRole('listitem')).toHaveText(['Accueil', /Guides/, new RegExp(guide.title)]);
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText(guide.title);
    await crumbs.getByRole('link', { name: 'Guides' }).click();
    await expect(page).toHaveURL(`${LANDING_ORIGIN}/guides`);
    await expect(page.locator('main h1')).toHaveText('Guides');
    await page.getByRole('navigation', { name: "Fil d'Ariane" }).getByRole('link', { name: 'Accueil' }).click();
    await expect(page.locator('main h1')).toHaveText('Vérifie avant de signer.');
  });

  test('guides : l’index liste les 3 guides, chaque guide renvoie vers les deux autres', async ({ page }) => {
    await openLanding(page, '/guides');
    for (const guide of LANDING_GUIDES) {
      await expect(page.locator(`main a[href="/guides/${guide.slug}"]`).first()).toBeVisible();
    }
    for (const guide of LANDING_GUIDES) {
      await page.goto(`${LANDING_ORIGIN}/guides/${guide.slug}`);
      const related = page.getByRole('navigation', { name: 'À lire aussi' });
      const others = LANDING_GUIDES.filter((other) => other.slug !== guide.slug);
      for (const other of others) {
        await expect(related.locator(`a[href="/guides/${other.slug}"]`)).toContainText(other.title);
      }
      // Lien croisé dans le corps de l'article.
      expect(await page.locator('article .prose a[href^="/guides/"]').count(), `liens internes dans ${guide.slug}`).toBeGreaterThan(0);
    }
    // Navigation réelle d'un guide à l'autre.
    await page.goto(`${LANDING_ORIGIN}/guides/${LANDING_GUIDES[0].slug}`);
    await page.getByRole('navigation', { name: 'À lire aussi' }).locator(`a[href="/guides/${LANDING_GUIDES[1].slug}"]`).click();
    await expect(page.locator('main h1')).toHaveText(LANDING_GUIDES[1].heading);
  });

  test('404 : liens de retour vers l’accueil et les guides', async ({ page }) => {
    await openLanding(page, '/nimporte-quoi');
    await expect(page.locator('main h1')).toHaveText('Page introuvable');
    await page.locator('main a[href="/guides"]').first().click();
    await expect(page.locator('main h1')).toHaveText('Guides');
  });
});

test.describe('landing : champ d’analyse du hero', () => {
  test('adresse valide → /analyse/<mint> de l’app, attribution conservée (utm, rj_ref, rj_lp)', async ({ page }) => {
    const appUrls = await stubApp(page.context());
    await interceptGoogle(page);
    await presetConsent(page, 'denied');
    await page.goto(`${LANDING_ORIGIN}/?utm_source=e2e-hero&utm_medium=social&utm_campaign=lancement`, { referer: 'https://x.com/raijin' });
    await expect(page.getByRole('button', { name: 'Gérer les cookies' })).toBeVisible();
    await heroInput(page).fill(`  ${MINTS.bonk}  `);
    await heroForm(page).getByRole('button', { name: 'Analyser' }).click();
    await expect.poll(() => appUrls.length, { message: 'navigation vers l’app' }).toBeGreaterThan(0);
    const target = new URL(first(appUrls));
    expect(target.origin).toBe(new URL(APP_ORIGIN).origin);
    expect(target.pathname).toBe(`/analyse/${MINTS.bonk}`);
    expect(Object.fromEntries(target.searchParams)).toEqual(
      expect.objectContaining({ utm_source: 'e2e-hero', utm_medium: 'social', utm_campaign: 'lancement', rj_lp: '/' }),
    );
    expect(target.searchParams.get('rj_ref') ?? '').toMatch(/^https:\/\/x\.com/);
    expect(target.searchParams.has('mint'), 'pas de mint en paramètre (chemin uniquement)').toBe(false);
  });

  test('lien DexScreener → adresse extraite, même destination', async ({ page }) => {
    const appUrls = await stubApp(page.context());
    await openLanding(page, '/');
    await heroInput(page).fill(`https://dexscreener.com/solana/${MINTS.bonk}`);
    await heroInput(page).press('Enter');
    await expect.poll(() => appUrls.length).toBeGreaterThan(0);
    expect(new URL(first(appUrls)).pathname).toMatch(/^\/analyse\/[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  test('saisie invalide ou vide → erreur inline accessible, aucune navigation', async ({ page }) => {
    const appUrls = await stubApp(page.context());
    await openLanding(page, '/');
    const input = heroInput(page);
    const error = heroForm(page).getByRole('alert');

    await heroForm(page).getByRole('button', { name: 'Analyser' }).click();
    await expect(error).toHaveText(ANALYSE_ERRORS.empty);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toBeFocused();

    await input.fill('pas-une-adresse-0OIl');
    await expect(input, 'erreur effacée à la saisie').not.toHaveAttribute('aria-invalid', 'true');
    await input.press('Enter');
    await expect(error).toHaveText(ANALYSE_ERRORS.invalid);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    // L'erreur est annoncée par la description du champ.
    await expect(input).toHaveAttribute('aria-describedby', /(^|\s)hero-error(\s|$)/);
    await expect(error).toHaveAttribute('id', 'hero-error');
    await expect(input).toHaveAccessibleDescription(new RegExp(ANALYSE_ERRORS.invalid.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // La navigation aurait eu lieu dans le même gestionnaire que l'affichage de l'erreur.
    expect(appUrls, 'aucune navigation vers l’app').toEqual([]);
    expect(page.url()).toBe(`${LANDING_ORIGIN}/`);
  });

  test('bouton Coller : lit le presse-papiers (permission accordée) et remplit le champ', async ({ browser }) => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    try {
      const page = await context.newPage();
      await openLanding(page, '/');
      await page.evaluate((mint) => navigator.clipboard.writeText(`  ${mint}\n`), MINTS.bonk);
      const paste = heroForm(page).getByRole('button', { name: 'Coller' });
      await expect(paste).toBeVisible();
      await paste.click();
      await expect(heroInput(page)).toHaveValue(MINTS.bonk);
      await expect(heroForm(page).getByRole('alert')).toHaveText('');

      // Contenu invalide collé : erreur inline immédiate.
      await page.evaluate(() => navigator.clipboard.writeText('bonjour'));
      await paste.click();
      await expect(heroForm(page).getByRole('alert')).toHaveText(ANALYSE_ERRORS.invalid);
    } finally {
      await context.close();
    }
  });

  test('sans JavaScript : formulaire GET vers /analyse?mint= de l’app, démo visible', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const appUrls = await stubApp(context);
      const page = await context.newPage();
      await interceptGoogle(page);
      await page.goto(`${LANDING_ORIGIN}/`);
      await expect(page.locator('main h1')).toHaveText('Vérifie avant de signer.');
      await expect(heroForm(page).getByRole('button', { name: 'Coller' }), 'Coller masqué sans JS').toBeHidden();
      await expect(page.getByRole('button', { name: 'Lancer la démonstration' }), 'démo : bouton masqué sans JS').toBeHidden();
      await expect(page.locator('[data-demo-result]'), 'démo : résultat visible sans JS').toBeVisible();
      await heroInput(page).fill(MINTS.bonk);
      await heroForm(page).getByRole('button', { name: 'Analyser' }).click();
      await expect.poll(() => appUrls.length).toBeGreaterThan(0);
      const target = new URL(first(appUrls));
      expect(target.origin).toBe(new URL(APP_ORIGIN).origin);
      expect(target.pathname).toBe('/analyse');
      expect(target.searchParams.get('mint')).toBe(MINTS.bonk);
    } finally {
      await context.close();
    }
  });
});

test.describe('landing : démonstration et événements GA4', () => {
  test('démo : résultat masqué puis révélé, verdict Prudence ; aucun événement sans consentement', async ({ page }) => {
    await openLanding(page, '/', 'denied');
    const demo = page.locator('[data-demo]');
    await expect(demo).toHaveAttribute('data-demo', 'idle');
    await page.getByRole('button', { name: 'Lancer la démonstration' }).click();
    await expect(demo).toHaveAttribute('data-demo', 'done');
    await expect(page.locator('[data-demo-result]')).toBeFocused();
    await expect(page.locator('[data-demo-result]')).toContainText('Prudence');
    await expect(page.locator('[data-demo-result] li')).toHaveCount(9);
    expect(await ga4Events(page), 'aucun événement sans consentement').toEqual([]);
    expect(await page.evaluate(() => typeof (window as unknown as { gtag?: unknown }).gtag), 'GA4 non chargé').toBe('undefined');
  });

  test('démo avec consentement : analyse_demo_resultat { verdict: warn } envoyé une fois', async ({ page }) => {
    await openLanding(page, '/', 'granted');
    await expect(consentBanner(page)).toBeHidden();
    await page.getByRole('button', { name: 'Lancer la démonstration' }).click();
    await expect
      .poll(async () => (await ga4Events(page)).filter((event) => event.name === 'analyse_demo_resultat'))
      .toEqual([{ name: 'analyse_demo_resultat', params: { verdict: 'warn' } }]);
  });

  test('analyse lancée depuis le hero avec consentement : analyse_demo_lancee, sans mint', async ({ page }) => {
    await stubApp(page.context());
    await openLanding(page, '/', 'granted');
    // La navigation remplace la page : on relève dataLayer au moment de l'appel à gtag.
    await page.evaluate(() => {
      const w = window as unknown as { gtag: (...args: unknown[]) => void; __events: unknown[][] };
      w.__events = [];
      const original = w.gtag;
      w.gtag = (...args: unknown[]) => {
        w.__events.push(args);
        sessionStorage.setItem('e2e-events', JSON.stringify(w.__events));
        original(...args);
      };
    });
    await heroInput(page).fill(MINTS.bonk);
    await heroForm(page).getByRole('button', { name: 'Analyser' }).click();
    await page.waitForURL(new RegExp(`^${APP_ORIGIN}/analyse/`));
    await page.goBack();
    await expect(page.locator('main h1')).toHaveText('Vérifie avant de signer.');
    const events = JSON.parse(await page.evaluate(() => String(sessionStorage.getItem('e2e-events')))) as unknown[][];
    const launched = events.filter((args) => args[0] === 'event' && args[1] === 'analyse_demo_lancee');
    expect(launched).toHaveLength(1);
    expect(JSON.stringify(events), 'aucun mint transmis à GA4').not.toContain(MINTS.bonk);
  });

  test('FAQ ouvrable au clavier ; faq_ouverte { faq_id } à l’ouverture seulement, et seulement avec consentement', async ({ page }) => {
    await openLanding(page, '/faq', 'granted');
    const first = page.locator('main details[data-faq-id]').first();
    const id = await first.getAttribute('data-faq-id');
    await first.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(first).toHaveAttribute('open', '');
    await expect(first.locator('p')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(first).not.toHaveAttribute('open', '');
    // Espace ouvre aussi un <summary>.
    await page.keyboard.press(' ');
    await expect(first).toHaveAttribute('open', '');
    await expect
      .poll(async () => (await ga4Events(page)).filter((event) => event.name === 'faq_ouverte'))
      .toEqual([
        { name: 'faq_ouverte', params: { faq_id: id } },
        { name: 'faq_ouverte', params: { faq_id: id } },
      ]);

    // Sans consentement : la FAQ s'ouvre, rien n'est envoyé.
    await page.context().clearCookies();
    await openLanding(page, '/faq', 'denied');
    await page.locator('main details[data-faq-id] summary').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('main details[data-faq-id]').first()).toHaveAttribute('open', '');
    expect(await ga4Events(page)).toEqual([]);
  });

  test('tarifs avec consentement : voir_tarifs à l’affichage ; clic CTA d’essai : cta_essai_clic { emplacement }', async ({ page }) => {
    await stubApp(page.context());
    await openLanding(page, '/tarifs', 'granted');
    await expect.poll(async () => (await ga4Events(page)).map((event) => event.name)).toContain('voir_tarifs');
    const cta = page.locator('main [data-track="cta_essai_clic"]').first();
    const placement = await cta.getAttribute('data-track-emplacement');
    await cta.evaluate((element) => element.addEventListener('click', (event) => event.preventDefault()));
    await cta.click();
    await expect
      .poll(async () => (await ga4Events(page)).filter((event) => event.name === 'cta_essai_clic'))
      .toEqual([{ name: 'cta_essai_clic', params: { emplacement: placement } }]);
  });
});

test.describe('landing : Rai et mouvement réduit', () => {
  const raiAnimation = (page: Page) =>
    page.locator('main .rai-animated').first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { name: style.animationName, duration: style.animationDuration };
    });

  test('respiration de 3 s par défaut', async ({ page }) => {
    await openLanding(page, '/');
    expect(await raiAnimation(page)).toEqual({ name: 'rai-breathe', duration: '3s' });
  });

  test('respiration désactivée avec prefers-reduced-motion', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await openLanding(page, '/');
      expect((await raiAnimation(page)).name).toBe('none');
    } finally {
      await context.close();
    }
  });

  test('Rai de 160 px au-dessus du titre sous 768 px, à côté au-delà', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLanding(page, '/');
    const rai = page.locator('main .rai-animated').first();
    const title = page.locator('main h1');
    const mobile = { rai: await rai.boundingBox(), title: await title.boundingBox() };
    // Taille de mise en page (offsetWidth : sans la mise à l'échelle de la respiration).
    expect(await rai.evaluate((element) => (element as HTMLElement).offsetWidth), 'Rai de 160 px').toBe(160);
    expect((mobile.rai?.y ?? 0) + (mobile.rai?.height ?? 0), 'Rai au-dessus du titre').toBeLessThanOrEqual((mobile.title?.y ?? 0) + 1);

    await page.setViewportSize({ width: 1280, height: 800 });
    const desktop = { rai: await rai.boundingBox(), title: await title.boundingBox() };
    expect(desktop.rai?.x ?? 0, 'Rai à droite du titre').toBeGreaterThanOrEqual((desktop.title?.x ?? 0) + (desktop.title?.width ?? 0) - 1);
  });
});
