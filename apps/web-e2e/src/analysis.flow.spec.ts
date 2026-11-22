import { expect, test, type Page } from '@playwright/test';
import { createVerifiedAccount } from './support/auth';
import {
  API_ORIGIN,
  MINTS,
  PROD_ORIGIN,
  expectVerdict,
  exhaustAnonymousQuota,
  publishAnalysis,
  randomMint,
  tokenField,
  useFreshIp,
  verdictStatus,
} from './support/analysis';
import { openPage } from './support/pages';

/**
 * Analyse de token de bout en bout (PROMPT.md §4.1, §9 ; docs/ARCHITECTURE.md §9) : app de dev (4200,
 * proxy /api) et build de production (4310, /t/<mint> servi par l'API), API réelle en mode fixtures.
 */
/**
 * Copie de `EXTERNAL_LINK_HOSTS` (@raijin/shared-contracts, sources.ts) : web-e2e n'a pas de tag Nx
 * et ne peut donc importer aucune lib (frontières de modules). À tenir synchronisée.
 */
const EXTERNAL_LINK_HOSTS = ['dexscreener.com', 'geckoterminal.com', 'jup.ag', 'rugcheck.xyz', 'solscan.io', 'explorer.solana.com', 'pump.fun', 'birdeye.so'];
const DISCLAIMER = 'Information en lecture seule, pas un conseil en investissement.';
const QUOTA_MESSAGE = 'Tu as atteint ton quota d’analyses du jour. Il se renouvelle à minuit (UTC).';
const MINT_INVALID = 'Adresse non reconnue. Colle une adresse de token Solana ou un lien DexScreener, pump.fun, Solscan ou Birdeye.';

test.describe.configure({ timeout: 60_000 });
test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  await useFreshIp(page);
});

async function analyze(page: Page, input: string): Promise<void> {
  await tokenField(page).fill(input);
  await page.getByRole('button', { name: 'Analyser', exact: true }).click();
}

const checkButton = (page: Page, label: string) => page.getByRole('button', { name: new RegExp(`^${label}`) });
const checkStatus = (page: Page, label: string) => checkButton(page, label).locator('[data-status]');

test.describe('analyse par adresse et par lien', () => {
  test('adresse brute (BONK) : Prudence, résultat partiel signalé, nom non fiable, mention légale', async ({ page }) => {
    await openPage(page, '/analyse');
    await expect(page.getByText('Il te reste 3 analyses sur 3 aujourd’hui.')).toBeVisible();
    await analyze(page, MINTS.bonk);
    await expectVerdict(page, 'Prudence');
    await expect(page).toHaveURL(`/analyse/${MINTS.bonk}`);
    await expect(page.locator('[data-degraded]')).toContainText('Résultat partiel : 3 contrôles n’ont pas pu être vérifiés');
    await expect(page.locator('[data-token-name]')).toHaveText('Bonk');
    const untrusted = page.locator('span[title^="Nom et symbole déclarés par le créateur"]');
    await expect(untrusted).toBeVisible();
    await expect(untrusted).toContainText('non fiable');
    await expect(page.locator('[data-disclaimer]')).toHaveText(DISCLAIMER);
    await expect(page.locator('[data-disclaimer]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Les 9 contrôles' })).toBeVisible();
    await expect(page.locator('rj-check-item')).toHaveCount(9);
    for (const label of ['Concentration des holders', 'Métadonnées modifiables', 'Historique du créateur']) {
      await expect(checkStatus(page, label), label).toHaveText('Indisponible');
    }
    await expect(page.getByText('Il te reste 2 analyses sur 3 aujourd’hui.')).toBeVisible();
    await expect(page).toHaveTitle(/^Prudence · Bonk/);
  });

  for (const { source, url, mint, label } of [
    { source: 'DexScreener (paire)', url: `https://dexscreener.com/solana/${MINTS.bonkPair}`, mint: MINTS.bonk, label: 'lien DexScreener' },
    { source: 'pump.fun', url: `https://pump.fun/coin/${MINTS.pump}`, mint: MINTS.pump, label: 'lien pump.fun' },
    { source: 'Solscan', url: `https://solscan.io/token/${MINTS.usdc}`, mint: MINTS.usdc, label: 'lien Solscan' },
  ]) {
    test(`lien ${source} : adresse extraite, aperçu, analyse du mint`, async ({ page }) => {
      await openPage(page, '/analyse');
      await tokenField(page).fill(url);
      await expect(page.locator('[data-preview]')).toContainText(`Adresse reconnue dans le ${label} :`);
      await page.getByRole('button', { name: 'Analyser', exact: true }).click();
      await expectVerdict(page, 'Prudence');
      await expect(page).toHaveURL(`/analyse/${mint}`);
      await expect(page.getByRole('button', { name: 'Copier l’adresse' })).toBeVisible();
      await expect(page.getByText(`Adresse du token : ${mint}`)).toBeAttached();
    });
  }
});

test.describe('verdicts Danger', () => {
  test('autorité de mint active : Danger, contrôle « Autorité de mint » en Danger', async ({ page }) => {
    await page.goto(`/analyse/${MINTS.mintActive}`);
    await expectVerdict(page, 'Danger');
    await expect(checkStatus(page, 'Autorité de mint')).toHaveText('Danger');
    await expect(page.locator('[data-explanation]')).not.toBeEmpty();
    await expect(page.locator('[data-token-name]')).toHaveText('Nom non publié');
  });

  test('freeze actif sans route de vente : Danger, résultat complet (pas de mention partielle)', async ({ page }) => {
    await page.goto(`/analyse/${MINTS.honeypot}`);
    await expectVerdict(page, 'Danger');
    await expect(checkStatus(page, 'Autorité de freeze')).toHaveText('Danger');
    await expect(checkStatus(page, 'Revente possible')).toHaveText('Danger');
    await expect(page.locator('[data-degraded]')).toHaveCount(0);
  });
});

test.describe('erreurs', () => {
  test('adresse invalide : message sur le champ, aucun appel à l’API d’analyse', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/v1/analyses')) posts.push(req.url());
    });
    await openPage(page, '/analyse');
    await analyze(page, 'pas-une-adresse-0OIl');
    await expect(page.getByText(MINT_INVALID)).toBeVisible();
    await expect(tokenField(page)).toBeFocused();
    await expect(tokenField(page)).toHaveAttribute('aria-invalid', 'true');
    // Adresse invalide dans l'URL : même message, toujours sans appel.
    await page.goto('/analyse/pasunmint');
    await expect(page.getByText(MINT_INVALID)).toBeVisible();
    expect(posts).toEqual([]);
  });

  test('mint inexistant : TOKEN_NOT_FOUND, quota non consommé', async ({ page }) => {
    await page.goto(`/analyse/${MINTS.missing}`);
    await expect(page.getByRole('heading', { name: 'Aucun token à cette adresse' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Aucun token trouvé à cette adresse sur Solana.')).toBeVisible();
    await expect(page.getByText('Il te reste 3 analyses sur 3 aujourd’hui.')).toBeVisible();
  });
});

test('2e analyse du même token : servie depuis le cache, quota non recompté', async ({ page }) => {
  await page.goto(`/analyse/${MINTS.bonk}`);
  await expectVerdict(page, 'Prudence');
  await expect(page.getByText('Il te reste 2 analyses sur 3 aujourd’hui.')).toBeVisible();
  await page.getByRole('link', { name: 'Analyser' }).first().click();
  await expect(page).toHaveURL('/analyse');
  await analyze(page, MINTS.bonk);
  await expectVerdict(page, 'Prudence');
  await expect(page.getByText(/\(résultat en cache\)/)).toBeVisible();
  await expect(page.getByText('Il te reste 2 analyses sur 3 aujourd’hui.')).toBeVisible();
});

test.describe('quotas', () => {
  test('anonyme : 3 analyses par jour, la 4e affiche le quota atteint, sans urgence', async ({ page }) => {
    await openPage(page, '/analyse');
    for (const [i, mint] of [MINTS.bonk, MINTS.usdc, MINTS.honeypot].entries()) {
      await analyze(page, mint);
      await expect(page).toHaveURL(`/analyse/${mint}`, { timeout: 20_000 });
      await expect(verdictStatus(page)).toBeVisible();
      const left = 2 - i;
      await expect(page.locator('[data-quota]')).toHaveText(
        left > 0 ? `Il te reste ${left} ${left > 1 ? 'analyses' : 'analyse'} sur 3 aujourd’hui.` : 'Plus d’analyse disponible aujourd’hui : le compteur repart à minuit (UTC).',
      );
    }
    await analyze(page, MINTS.mintActive);
    const card = page.getByRole('status').filter({ has: page.getByRole('heading', { name: 'Quota du jour atteint' }) });
    await expect(card).toBeVisible();
    await expect(card).toContainText(QUOTA_MESSAGE);
    await expect(card.getByRole('link', { name: 'Créer un compte gratuit' })).toHaveAttribute('href', '/compte/inscription');
    const text = (await card.innerText()) + (await page.locator('[data-quota]').innerText());
    expect(text, 'aucune formule d’urgence').not.toMatch(/!|vite|dépêche|dernière chance|maintenant|urgent|plus que/i);
  });

  test('utilisateur Gratuit connecté : 5 analyses par jour, puis quota atteint (sans invitation à créer un compte)', async ({ page }) => {
    await createVerifiedAccount(page.context(), 'quota');
    await openPage(page, '/analyse');
    await expect(page.locator('[data-quota]')).toHaveText('Il te reste 5 analyses sur 5 aujourd’hui.');
    for (const mint of [MINTS.bonk, MINTS.usdc, MINTS.pyusd, MINTS.mintActive, MINTS.honeypot]) {
      await analyze(page, mint);
      await expect(page).toHaveURL(`/analyse/${mint}`, { timeout: 20_000 });
      await expect(verdictStatus(page)).toBeVisible();
    }
    await expect(page.locator('[data-quota]')).toHaveText('Plus d’analyse disponible aujourd’hui : le compteur repart à minuit (UTC).');
    await analyze(page, MINTS.pump);
    await expect(page.getByRole('heading', { name: 'Quota du jour atteint' })).toBeVisible();
    await expect(page.getByText(QUOTA_MESSAGE)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Créer un compte gratuit' })).toHaveCount(0);
  });

  test('quota déjà épuisé à l’ouverture d’un lien /analyse/<mint>', async ({ page }) => {
    const ip = await useFreshIp(page);
    await exhaustAnonymousQuota(page, ip);
    await page.goto(`/analyse/${MINTS.pump}`);
    await expect(page.getByRole('heading', { name: 'Quota du jour atteint' })).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('résultat au clavier et actions', () => {
  test('accordéons et bottom sheet « En savoir plus » au clavier', async ({ page }) => {
    await page.goto(`/analyse/${MINTS.honeypot}`);
    await expectVerdict(page, 'Danger');
    const trigger = checkButton(page, 'Autorité de freeze');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panel = page.getByRole('region', { name: /Autorité de freeze/ });
    await expect(panel).toBeVisible();
    await page.keyboard.press(' ');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();

    // Tab jusqu'à « En savoir plus » (liens de sources d'abord), puis ouverture au clavier.
    const learnMore = page.getByRole('button', { name: 'En savoir plus : Autorité de freeze' });
    await expect
      .poll(
        async () => {
          await page.keyboard.press('Tab');
          return learnMore.evaluate((el) => el === document.activeElement);
        },
        { intervals: [50], timeout: 5_000 },
      )
      .toBe(true);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Autorité de freeze' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Ce que c’est');
    await expect(dialog).toContainText('Comment Raijin le vérifie');
    await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(learnMore).toBeFocused();
  });

  test('copier l’adresse et partager (repli : copie du lien public)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // Pas de Web Share API (desktop) : le partage se rabat sur la copie du lien /t/<mint>.
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
      Object.defineProperty(Navigator.prototype, 'canShare', { value: undefined, configurable: true });
    });
    await page.goto(`/analyse/${MINTS.mintActive}`);
    await expectVerdict(page, 'Danger');
    await page.getByRole('button', { name: 'Copier l’adresse' }).click();
    await expect(page.getByRole('button', { name: 'Copié' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MINTS.mintActive);

    await page.getByRole('button', { name: 'Partager' }).click();
    await expect(page.getByText('Lien de l’analyse copié.')).toBeVisible();
    const origin = new URL(page.url()).origin;
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/t/${MINTS.mintActive}`);
    await expect(page.getByRole('button', { name: /Suivre/ })).toBeDisabled();
  });

  test('liens externes : https, liste blanche, rel noopener noreferrer nofollow, nouvel onglet', async ({ page }) => {
    await page.goto(`/analyse/${MINTS.bonk}`);
    await expectVerdict(page, 'Prudence');
    const toggles = page.locator('rj-check-item h3 button');
    for (let i = 0; i < 9; i++) {
      await toggles.nth(i).click();
      await expect(toggles.nth(i)).toHaveAttribute('aria-expanded', 'true');
    }
    await expect(page.locator('rj-check-item [role="region"]')).toHaveCount(9);
    const links = await page.locator('a[href]').evaluateAll((els) =>
      els.map((a) => ({ href: (a as HTMLAnchorElement).href, rel: a.getAttribute('rel') ?? '', target: a.getAttribute('target') ?? '' })),
    );
    const origin = new URL(page.url()).origin;
    const external = links.filter((l) => new URL(l.href).origin !== origin);
    expect(external.length, 'au moins un lien de source').toBeGreaterThan(0);
    for (const link of external) {
      const url = new URL(link.href);
      expect(url.protocol, link.href).toBe('https:');
      expect(
        EXTERNAL_LINK_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)),
        `${url.hostname} dans la liste blanche`,
      ).toBe(true);
      expect(link.rel.split(/\s+/).sort(), link.href).toEqual(['nofollow', 'noopener', 'noreferrer']);
      expect(link.target, link.href).toBe('_blank');
    }
  });

  test('nom de token hostile (HTML, bidi) rendu comme du texte', async ({ page }) => {
    const hostile = '<img src=x onerror="window.__xss=1">Bonk‮';
    await page.route('**/api/v1/analyses', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as { analysis: { token: { name: string | null } } };
      body.analysis.token.name = hostile;
      await route.fulfill({ response, json: body });
    });
    await page.goto(`/analyse/${MINTS.bonk}`);
    await expectVerdict(page, 'Prudence');
    const name = page.locator('[data-token-name]');
    await expect(name).toContainText('<img src=x onerror="window.__xss=1">Bonk');
    await expect(name.locator('img')).toHaveCount(0);
    await expect(page.locator('main img[src="x"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });
});

test.describe('page publique /t/<mint>', () => {
  test('app : dernière analyse publiée, sans quota, actions et mention légale', async ({ page }) => {
    await publishAnalysis(page.context().request, MINTS.bonk);
    await openPage(page, `/t/${MINTS.bonk}`);
    await expect(page.locator('main h1')).toHaveText('Verdict Raijin');
    await expectVerdict(page, 'Prudence');
    await expect(page.getByRole('link', { name: 'Analyser un autre token' })).toHaveAttribute('href', '/analyse');
    await expect(page.getByRole('link', { name: 'Réanalyser ce token' })).toHaveAttribute('href', `/analyse/${MINTS.bonk}`);
    await expect(page.getByRole('button', { name: /Suivre/ })).toHaveCount(0);
    await expect(page.locator('[data-disclaimer]')).toHaveText(DISCLAIMER);
    await expect(page).toHaveTitle(/^Verdict Prudence pour « Bonk » — Raijin Shield$/);
  });

  test('app : token jamais analysé → « Pas encore d’analyse récente »', async ({ page }) => {
    const mint = randomMint();
    await openPage(page, `/t/${mint}`);
    await expect(page.getByRole('heading', { name: 'Pas encore d’analyse récente' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Analyser ce token' })).toHaveAttribute('href', `/analyse/${mint}`);
  });

  test('servie par l’API (build de production) : balises og:*, image OG PNG 1200×630', async ({ request }) => {
    await publishAnalysis(request, MINTS.bonk);
    const res = await request.get(`${PROD_ORIGIN}/t/${MINTS.bonk}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    const html = await res.text();
    const meta = (prop: string) => new RegExp(`<meta property="${prop}" content="([^"]+)"`).exec(html)?.[1];
    expect(meta('og:title')).toBe('Prudence · token DezX…B263 · Raijin Shield');
    expect(meta('og:description')).toContain('pas un conseil en investissement');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
    const image = meta('og:image');
    expect(image).toMatch(new RegExp(`/api/v1/og/${MINTS.bonk}\\.png$`));
    // Le build de l'app est bien celui servi (Angular démarre ensuite normalement).
    expect(html).toMatch(/<script src="main-[A-Za-z0-9_-]+\.js" type="module">/);

    const png = await request.get(`${API_ORIGIN}${new URL(image ?? '').pathname}`);
    expect(png.status()).toBe(200);
    expect(png.headers()['content-type']).toBe('image/png');
    const bytes = await png.body();
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }).toEqual({ width: 1200, height: 630 });
  });

  test('servie par l’API : la CSP de la page ne casse ni les styles ni le démarrage de l’app', async ({ page }) => {
    await publishAnalysis(page.context().request, MINTS.bonk);
    const violations: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) violations.push(msg.text());
    });
    await page.goto(`${PROD_ORIGIN}/t/${MINTS.bonk}`);
    await expect(page.locator('main h1')).toHaveText('Verdict Raijin');
    await expectVerdict(page, 'Prudence');
    // Feuille de style complète appliquée (Beasties la charge en media="print" puis la bascule par un script inline).
    const media = await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((l) => (l as HTMLLinkElement).media || 'all'));
    expect(media, 'feuille de style active (media all)').toEqual(['all']);
    expect(violations, 'aucune violation de CSP').toEqual([]);
    // Coquille stylée : la barre d'onglets mobile est en bas d'écran, pas dans le flux du document.
    const tabBar = page.locator('rj-app-shell > rj-tab-bar > nav');
    await expect(tabBar).toBeVisible();
    expect(await tabBar.evaluate((nav) => getComputedStyle(nav).position)).toBe('fixed');
  });
});
