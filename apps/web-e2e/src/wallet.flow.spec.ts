import { expect as baseExpect, test, type Page } from '@playwright/test';
import { useFreshIp } from './support/analysis';
import { createVerifiedAccount, PASSWORD, webStorageDump } from './support/auth';
import { openPage } from './support/pages';
import { api, startTrial } from './support/watch';
import {
  FAKE_SEED,
  REVOKE_GUIDE_URLS,
  T22_DELEGATE,
  WALLETS,
  WALLET_MESSAGES,
  WALLET_MINTS,
  expectAddressNotStored,
  scanButton,
  scanWallet,
  scanWalletResult,
  setWalletScansUsed,
  trialAccountIn,
  walletField,
} from './support/wallet';

/**
 * Scan de wallet de bout en bout (PROMPT.md §4.3, §9 ; docs/ARCHITECTURE.md §12) : app de dev (4200, proxy /api),
 * API réelle en mode fixtures (wallets synthétiques de libs/api/solana). Lecture seule : aucune connexion de wallet.
 */
const expect = baseExpect.configure({ timeout: 15_000 });

test.describe.configure({ timeout: 90_000 });
test.use({ viewport: { width: 390, height: 844 } });

/** Requêtes émises par la page (pour vérifier qu'aucune URL ne porte l'adresse). */
function recordUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (req) => urls.push(req.url()));
  return urls;
}

const disclaimer = (page: Page) => page.locator('[data-disclaimer]');

test.beforeEach(async ({ page }) => {
  await useFreshIp(page);
});

test('visiteur : explication du scan, connexion puis retour sur /wallet', async ({ page, browser }) => {
  const setup = await browser.newContext();
  const { email } = await createVerifiedAccount(setup, 'wallet-retour');
  await setup.close();
  await startTrial(email);

  await openPage(page, '/wallet');
  const card = page.locator('[data-access="signed-out"]');
  await expect(card.getByRole('heading', { name: 'Le scan de wallet fait partie de Raijin Pro' })).toBeVisible();
  await expect(card.locator('[data-features] li')).toHaveCount(3);
  await expect(page.locator('[data-read-only]')).toContainText('Lecture seule.');
  await expect(disclaimer(page)).toContainText(WALLET_MESSAGES.disclaimer);
  await expect(card.getByRole('link', { name: 'Créer un compte' })).toHaveAttribute('href', '/compte/inscription?redirect=%2Fwallet');
  await expect(walletField(page)).toHaveCount(0);

  await card.getByRole('link', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/compte\/connexion\?redirect=%2Fwallet$/);
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/wallet$/);
  await expect(walletField(page)).toBeVisible();
  await expect(page.locator('[data-quota]')).toHaveText(/Il te reste 10\sscans sur 10 aujourd’hui\./);
});

test('Gratuit : écran du plan Pro, l’API répond 403 WALLET_SCAN_PLAN_REQUIRED', async ({ page, context }) => {
  await createVerifiedAccount(context, 'wallet-gratuit');
  await openPage(page, '/wallet');
  const card = page.locator('[data-access="plan"]');
  await expect(card.getByRole('heading', { name: 'Le scan de wallet fait partie du plan Pro' })).toBeVisible();
  // Phase 6 : l'offre Pro se prend sur la page Abonnement (et non plus depuis le compte).
  await expect(card.locator('[data-plan-text]')).toContainText('Tu peux l’activer depuis la page Abonnement');
  await expect(card.getByRole('link', { name: 'Voir l’offre Pro' })).toHaveAttribute('href', '/abonnement');
  await expect(walletField(page)).toHaveCount(0);
  await expect(disclaimer(page)).toContainText(WALLET_MESSAGES.disclaimer);

  const quota = await api(context.request, 'GET', '/wallet-scans/quota');
  expect(quota).toEqual({ status: 200, body: { allowed: false, quota: null } });
  const res = await api(context.request, 'POST', '/wallet-scans', { address: WALLETS.danger });
  expect(res.status).toBe(403);
  expect(res.body['code']).toBe('WALLET_SCAN_PLAN_REQUIRED');
});

test.describe('essai Pro', () => {
  test('wallet à délégations : section en tête, « Tout le solde », compte vide, guides officiels ; adresse jamais conservée', async ({ page, context }) => {
    const urls = recordUrls(page);
    await trialAccountIn(context, 'wallet-delegations');
    await openPage(page, '/wallet');
    await scanWalletResult(page, WALLETS.delegation);

    // Délégations actives en tête du résultat, avant le résumé et les tokens.
    const order = await page.locator('[data-result]').evaluate((el) => Array.from(el.children).map((c) => c.tagName.toLowerCase()));
    expect(order[0]).toBe('rj-wallet-delegations');
    expect(order.indexOf('rj-wallet-summary')).toBeGreaterThan(0);
    const section = page.locator('[data-delegations]');
    await expect(section.getByRole('heading', { level: 2 })).toHaveText(/Délégations actives\s*\(3\)/);
    const rows = section.locator('[data-delegation]');
    await expect(rows).toHaveCount(3);
    await expect(section.locator('[data-full-balance]')).toHaveCount(2);
    await expect(rows.nth(0).locator('[data-full-balance]')).toHaveText('Tout le solde');
    await expect(section.getByText('Compte vide : le délégué pourra agir dès que ce compte sera réalimenté.')).toBeVisible();
    await expect(section.getByText('Le délégué peut déplacer tout le solde de ce compte sans te redemander ton accord.')).toBeVisible();
    // Délégation Token-2022 partielle : montant délégué (10) ≠ solde (40), pas de « Tout le solde ».
    const t22 = rows.filter({ has: page.locator(`[title="${T22_DELEGATE}"]`) });
    await expect(t22).toHaveCount(1);
    await expect(t22.locator('[data-full-balance]')).toHaveCount(0);
    await expect(t22.locator('[data-delegated-amount]')).toHaveText(/10\sPYUSD/);
    await expect(page.locator('[data-delegation-count]')).toHaveText(/3/);

    // Guides de révocation : uniquement la liste blanche, nouvel onglet sûr, aucun bouton de révocation.
    const links = section.locator('[data-revoke-link]');
    await expect(links).toHaveCount(REVOKE_GUIDE_URLS.length);
    const hrefs = await links.evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    expect([...hrefs].sort()).toEqual([...REVOKE_GUIDE_URLS].sort());
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    await expect(section.getByRole('heading', { name: 'Phantom' })).toBeVisible();
    await expect(section.getByRole('heading', { name: 'Solflare' })).toBeVisible();
    await expect(page.getByRole('button', { name: /révoquer/i })).toHaveCount(0);

    // Tokens : verdict icône + mot, « Délégation active » sur les deux.
    const cards = page.locator('[data-tokens] > li');
    await expect(cards).toHaveCount(2);
    await expect(cards.getByText('Délégation active')).toHaveCount(2);
    await expect(page.locator('[data-token-count]')).toHaveText('2');
    await expect(disclaimer(page)).toContainText(WALLET_MESSAGES.disclaimer);

    // RGPD (§12.8) : l'adresse n'est ni dans l'URL, ni dans le stockage, ni dans une URL de requête.
    await expectAddressNotStored(page, WALLETS.delegation);
    expect(urls.filter((u) => u.includes(WALLETS.delegation))).toEqual([]);
    for (const value of [WALLETS.delegation, T22_DELEGATE]) {
      expect(await page.evaluate((v) => document.cookie.includes(v), value)).toBe(false);
    }
  });

  test('approbation maximale (u64) : montant « Illimité » (réponse réelle modifiée)', async ({ page, context }) => {
    await trialAccountIn(context, 'wallet-illimite');
    // Les fixtures de l'API n'ont pas d'approbation u64 max : la réponse réelle est relayée avec un montant maximal.
    await page.route('**/api/v1/wallet-scans', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      const json = (await response.json()) as { scan: { delegations: { mint: string; delegatedAmount: unknown }[] } };
      const target = json.scan.delegations.find((d) => d.mint === WALLET_MINTS.safe);
      if (target) target.delegatedAmount = { raw: '18446744073709551615', decimals: 6, ui: '18446744073709.551615' };
      return route.fulfill({ response, json });
    });
    await openPage(page, '/wallet');
    await scanWalletResult(page, WALLETS.delegation);
    const amount = page.locator('[data-delegated-amount]', { hasText: 'Illimité' });
    await expect(amount).toHaveCount(1);
    await expect(amount).toHaveAttribute('title', /montant maximal/);
  });

  test('wallet Danger : verdicts icône + mot, contrôle rapide (6/9), lien vers l’analyse, poussière et NFT au résumé', async ({ page, context }) => {
    await trialAccountIn(context, 'wallet-danger');
    await openPage(page, '/wallet');
    await scanWalletResult(page, WALLETS.danger);

    await expect(page.locator('[data-delegations]')).toHaveCount(0);
    const verdicts = page.locator('[data-verdicts]');
    await expect(verdicts.locator('[data-verdict-count="danger"]')).toContainText('Danger');
    await expect(verdicts.locator('[data-verdict-count="danger"]')).toContainText('1');
    await expect(verdicts.locator('[data-verdict-count="safe"]')).toContainText('Sain');
    await expect(verdicts.locator('[data-verdict-count="danger"] svg, [data-verdict-count="danger"] rj-icon').first()).toBeAttached();
    const others = page.locator('[data-others]');
    await expect(others).toContainText(/1\spoussière non analysée/);
    await expect(others).toContainText(/1\sNFT ignoré/);

    const cards = page.locator('[data-tokens] > li');
    await expect(cards).toHaveCount(3);
    const danger = cards.filter({ has: page.locator(`a[href="/analyse/${WALLETS.token}"]`) });
    const badge = danger.locator('rj-verdict-badge');
    await expect(badge).toHaveAccessibleName('Verdict : Danger');
    await expect(badge).toContainText('Danger');
    await expect(badge.locator('svg')).toHaveCount(1);
    await expect(danger.locator('[data-coverage]')).toHaveText(/Contrôle rapide \(6\/9\)|Analyse complète \(\d\/9\)/);
    const safe = cards.filter({ has: page.locator(`a[href="/analyse/${WALLET_MINTS.safe}"]`) });
    await expect(safe.locator('rj-verdict-badge')).toHaveAccessibleName('Verdict : Sain');
    await expect(safe.locator('[data-coverage]')).toHaveText(/Contrôle rapide \(6\/9\)/);
    await expect(safe.locator('[data-token-name]')).toHaveText('Raijin Fixture Safe');
    const dust = cards.filter({ has: page.locator(`a[href="/analyse/${WALLETS.usdc}"]`) });
    await expect(dust.locator('[data-status]')).toHaveText(/Non analysé/);
    await expect(dust).toContainText('poussière');
    await expect(page.getByText('Contrôle rapide : 6 contrôles sur 9.', { exact: false })).toBeVisible();
    await expect(disclaimer(page)).toContainText(WALLET_MESSAGES.disclaimer);
    await expectAddressNotStored(page, WALLETS.danger);

    // Lien « Voir l’analyse complète » → /analyse/<mint>.
    await danger.locator('[data-analysis-link]').click();
    await expect(page).toHaveURL(new RegExp(`/analyse/${WALLETS.token}$`));
    await expect(page.getByRole('status', { name: /^Verdict : / })).toHaveAccessibleName('Verdict : Danger', { timeout: 20_000 });
  });

  test('wallet vide (Rai bravo), trop gros (WALLET_TOO_LARGE), adresse de token (« Analyser ce token »), programme (WALLET_INVALID)', async ({ page, context }) => {
    await trialAccountIn(context, 'wallet-etats');
    await openPage(page, '/wallet');

    await scanWallet(page, WALLETS.empty);
    await expect(page.getByRole('heading', { name: 'Aucun token dans ce wallet' })).toBeVisible();
    await expect(page.locator('img[src*="rai-bravo"]')).toBeVisible();

    await scanWallet(page, WALLETS.tooLarge);
    await expect(page.getByRole('heading', { name: 'Wallet trop volumineux pour un scan' })).toBeVisible();
    await expect(page.getByText(WALLET_MESSAGES.tooLarge)).toBeVisible();

    await scanWallet(page, WALLETS.token);
    const card = page.locator('[data-error="WALLET_IS_TOKEN"]');
    await expect(card.getByRole('heading', { name: 'C’est l’adresse d’un token' })).toBeVisible();
    await expect(card).toContainText(WALLET_MESSAGES.isToken);
    await expect(card.getByRole('link', { name: 'Analyser ce token' })).toHaveAttribute('href', `/analyse/${WALLETS.token}`);
    await expectAddressNotStored(page, WALLETS.token);

    // Programme inconnu des contrats : refusé par l'API (400 WALLET_INVALID), message sous le champ.
    await scanWallet(page, WALLETS.programOnChain);
    await expect(page.getByText(WALLET_MESSAGES.apiInvalid)).toBeVisible();
    await expect(walletField(page)).toHaveAttribute('aria-invalid', 'true');
  });

  test('saisie : phrase de récupération collée refusée, mint et programme connus, adresse invalide (sans appel réseau)', async ({ page, context }) => {
    await trialAccountIn(context, 'wallet-saisie');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const scans: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/wallet-scans')) scans.push(req.url());
    });
    await openPage(page, '/wallet');
    await expect(walletField(page)).toBeVisible();

    // Bouton « Coller » : la phrase de récupération est refusée dès le collage.
    await page.evaluate((seed) => navigator.clipboard.writeText(seed), FAKE_SEED);
    await page.getByRole('button', { name: 'Coller dans le champ Adresse publique du wallet' }).click();
    await expect(page.getByText(WALLET_MESSAGES.seed)).toBeVisible();
    await expect(walletField(page), 'phrase effacée immédiatement').toHaveValue('');
    await expect(walletField(page)).toHaveAttribute('aria-invalid', 'true');
    expect((await webStorageDump(page)).join('\n'), 'phrase absente du stockage').not.toContain('abandon');
    // Tapée au clavier : effacée aussi dès qu'elle compte 12 mots.
    await walletField(page).fill(FAKE_SEED);
    await expect(walletField(page)).toHaveValue('');
    await expect(page.getByText(WALLET_MESSAGES.seed)).toBeVisible();
    await scanButton(page).click();
    await expect(walletField(page)).toBeFocused();

    await walletField(page).fill(WALLETS.usdc);
    await expect(page.getByText(WALLET_MESSAGES.mint)).toBeVisible();
    await expect(page.locator('[data-analyse-token]')).toHaveAttribute('href', `/analyse/${WALLETS.usdc}`);

    await walletField(page).fill(WALLETS.program);
    await expect(page.getByText(WALLET_MESSAGES.program)).toBeVisible();

    await walletField(page).fill('pas-une-adresse-0OIl');
    await walletField(page).blur();
    await expect(page.getByText(WALLET_MESSAGES.invalid)).toBeVisible();
    await scanButton(page).click();

    // Adresse valide collée : aperçu tronqué, plus d'erreur.
    await page.evaluate((address) => navigator.clipboard.writeText(address), WALLETS.danger);
    await page.getByRole('button', { name: 'Coller dans le champ Adresse publique du wallet' }).click();
    await expect(page.locator('[data-preview]')).toContainText('Adresse reconnue');
    await expect(page.getByText(WALLET_MESSAGES.invalid)).toHaveCount(0);
    expect(scans, 'aucun scan envoyé pour une saisie refusée').toEqual([]);
  });

  test('quota de l’essai (10 par jour) : 429 affiché, dernier scan, bouton désactivé, 429 de l’API', async ({ page, context }) => {
    const { email } = await trialAccountIn(context, 'wallet-quota');
    await setWalletScansUsed(email, 9);
    await openPage(page, '/wallet');
    await expect(page.locator('[data-quota]')).toHaveText(/Il te reste 1\sscan sur 10 aujourd’hui\./);

    // Compteur épuisé entre-temps (autre onglet) : l'API répond 429, l'écran l'explique.
    await setWalletScansUsed(email, 10);
    await scanWallet(page, WALLETS.delegation);
    await expect(page.getByRole('heading', { name: 'Scans du jour utilisés' })).toBeVisible();
    await expect(page.getByText(WALLET_MESSAGES.quota)).toBeVisible();

    // Dernier scan disponible : wallet vide, puis plus aucun scan.
    await setWalletScansUsed(email, 9);
    await openPage(page, '/wallet');
    await scanWallet(page, WALLETS.empty);
    await expect(page.getByRole('heading', { name: 'Aucun token dans ce wallet' })).toBeVisible();
    await expect(page.locator('[data-quota]')).toHaveText('Plus de scan disponible aujourd’hui : le compteur repart à minuit (UTC).');
    await expect(scanButton(page)).toBeDisabled();

    const res = await api(context.request, 'POST', '/wallet-scans', { address: WALLETS.danger });
    expect(res.status).toBe(429);
    expect(res.body['code']).toBe('WALLET_SCAN_QUOTA_EXCEEDED');
    await openPage(page, '/wallet');
    await expect(page.getByRole('heading', { name: 'Scans du jour utilisés' })).toBeVisible();
    await expect(scanButton(page)).toBeDisabled();
  });

  test('quitter /wallet puis revenir : résultat et adresse effacés', async ({ page, context }) => {
    await trialAccountIn(context, 'wallet-sortie');
    await openPage(page, '/wallet');
    await scanWalletResult(page, WALLETS.danger);
    await expectAddressNotStored(page, WALLETS.danger);

    // Navigation interne (barre d'onglets), puis retour arrière : l'écran repart de zéro.
    await page.locator('rj-app-shell > rj-tab-bar > nav').getByRole('link', { name: 'Analyser' }).click();
    await expect(page).toHaveURL(/\/analyse$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/wallet$/);
    await expect(walletField(page)).toBeVisible();
    await expect(walletField(page)).toHaveValue('');
    await expect(page.locator('[data-result]')).toHaveCount(0);
    await expect(page.getByText('Raijin Fixture Safe')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Ce que Raijin vérifie' })).toBeVisible();
    expect(await page.content()).not.toContain(WALLETS.danger);
    await expectAddressNotStored(page, WALLETS.danger);
  });
});
