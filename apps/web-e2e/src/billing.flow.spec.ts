import { expect, test, type Page } from '@playwright/test';
import { workspaceRoot } from '@nx/devkit';
import { join } from 'node:path';
import { APP_ORIGIN, createVerifiedAccount } from './support/auth';
import { useFreshIp } from './support/analysis';
import { forceBillingMode, formatPrice, plain, plansFromApi, raiPose, savingsPercent, trialBanner, userRow } from './support/billing';
import { openPage } from './support/pages';
import { waitForMailHtml } from './support/watch';

/**
 * Abonnement (phase 6, PROMPT.md §4.4 et §9, docs/ARCHITECTURE.md §13) contre l'API réelle en simulation
 * (`BILLING_PROVIDER=fake`) : offres et prix venus de l'API, essai → faux Checkout → succès → Pro → reçu →
 * faux portail → résiliation en fin de période ; paiement refusé (past_due) ; redirection de paiement vers un
 * hôte non autorisé refusée ; paiement indisponible (`BILLING_NOT_CONFIGURED`).
 */
const SHOTS = join(workspaceRoot, 'docs', 'screenshots', 'phase-6');
const NEUTRAL_FREE_NOTICE = 'Ton compte est en plan Gratuit. Tu peux passer à Pro quand tu veux.';
const UNAVAILABLE = 'L’abonnement n’est pas encore disponible. Réessaie un peu plus tard.';
const REDIRECT_REFUSED = 'Raijin n’a pas pu ouvrir la page de paiement. Réessaie dans un instant.';

const proCard = (page: Page) => page.locator('rj-card[data-plan="PRO"]');
const freeCard = (page: Page) => page.locator('rj-card[data-plan="FREE"]');
const planStatus = (page: Page) => page.locator('[data-plan-status]');
const checkoutButton = (page: Page) => proCard(page).locator('[data-checkout]');
const interval = (page: Page, label: 'Mensuel' | 'Annuel') => page.getByRole('radio', { name: new RegExp(`^${label}`) });
/** Choix de la périodicité comme un utilisateur : clic sur l'étiquette (la case radio native est masquée visuellement). */
const chooseInterval = (page: Page, label: 'Mensuel' | 'Annuel') => interval(page, label).locator('xpath=..').click();

async function openSubscription(page: Page): Promise<void> {
  await openPage(page, '/abonnement');
  await expect(page.locator('main h1')).toHaveText('Abonnement');
  await expect(proCard(page).locator('[data-price]')).not.toBeEmpty({ timeout: 15_000 });
}

/** Rendu HTML d'un e-mail Mailpit, captures claires à 390 et 1440 px. */
async function captureMail(page: Page, html: string, name: string): Promise<void> {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(`${APP_ORIGIN}/analyse`);
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: join(SHOTS, `email-${name}-${width}.png`), fullPage: true });
  }
}

test.describe.configure({ timeout: 90_000 });

test('visiteur : prix fr-FR venus de l’API, bascule Mensuel / Annuel, offre d’essai, mode simulé, mention légale', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useFreshIp(page);
  const plans = await plansFromApi(page.request);
  expect(plans.mode).toBe('simulation');
  const { monthly, yearly } = plans.pro;
  await openSubscription(page);

  await expect(page.getByText('Mode simulation : aucun paiement réel')).toBeVisible();
  await expect(page.locator('[data-trial-offer]')).toHaveText(`Essaie Pro gratuitement pendant ${plans.trial.days} jours. Sans carte bancaire.`);
  await expect.poll(async () => plain(await freeCard(page).locator('.text-metric').textContent())).toBe(plain(formatPrice(0, monthly.currency)));

  // Mensuel par défaut.
  await expect(interval(page, 'Mensuel')).toBeChecked();
  await expect.poll(async () => plain(await proCard(page).locator('[data-price]').textContent())).toBe(plain(formatPrice(monthly.amountCents, monthly.currency)));
  await expect(proCard(page)).toContainText('/ mois');
  await expect(proCard(page).locator('[data-price-detail]')).toHaveText('Payé chaque mois, sans engagement.');

  // Annuel : prix annuel, équivalent mensuel et économie calculés depuis les centimes de l'API.
  const savings = savingsPercent(monthly.amountCents, yearly.amountCents);
  expect(savings).toBeGreaterThan(0);
  await expect.poll(async () => plain(await interval(page, 'Annuel').locator('xpath=..').textContent())).toContain(`−${savings} %`);
  await chooseInterval(page, 'Annuel');
  await expect(interval(page, 'Annuel')).toBeChecked();
  await expect.poll(async () => plain(await proCard(page).locator('[data-price]').textContent())).toBe(plain(formatPrice(yearly.amountCents, yearly.currency)));
  await expect(proCard(page)).toContainText('/ an');
  await expect.poll(async () => plain(await proCard(page).locator('[data-price-detail]').textContent())).toBe(
    plain(`Soit ${formatPrice(Math.round(yearly.amountCents / 12), yearly.currency)} par mois, payé une fois par an.`),
  );

  // Visiteur : création de compte (l'essai démarre à la confirmation de l'e-mail), mention légale.
  const signup = checkoutButton(page);
  await expect(signup).toHaveText('Créer un compte');
  await expect(signup).toHaveAttribute('href', '/compte/inscription?redirect=%2Fabonnement');
  await expect(page.locator('[data-disclaimer]')).toContainText('Ce n’est pas un conseil en investissement');
  await expect(page.locator('[data-plan-status]')).toHaveCount(0);

  // Les prix ne sont pas écrits en dur : une autre réponse de l'API change l'affichage.
  await page.route('**/api/v1/billing/plans', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as typeof plans;
    await route.fulfill({ response, json: { ...body, pro: { ...body.pro, monthly: { ...body.pro.monthly, amountCents: 1290 } } } });
  });
  await openSubscription(page);
  await expect.poll(async () => plain(await proCard(page).locator('[data-price]').textContent())).toBe(plain(formatPrice(1290, monthly.currency)));
});

test('Gratuit (adresse jetable, sans essai) : plan Gratuit, message neutre, pas d’offre d’essai, « Passer à Pro » disponible', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useFreshIp(page);
  await createVerifiedAccount(page.context(), 'abo-gratuit');
  await openSubscription(page);
  await expect(planStatus(page)).toContainText('Gratuit');
  await expect(planStatus(page).locator('[data-status-detail]')).toHaveText(NEUTRAL_FREE_NOTICE);
  await expect(freeCard(page)).toContainText('Ton plan actuel');
  await expect(page.locator('[data-trial-offer]')).toHaveCount(0);
  await expect(checkoutButton(page)).toHaveText(/Passer à Pro/);
  await expect(checkoutButton(page)).toBeEnabled();
  await expect(planStatus(page).locator('[data-portal]')).toHaveCount(0);
});

test('essai Pro → « Passer à Pro » → faux Checkout → succès (Rai bravo) → Pro, reçu Mailpit → faux portail → résiliation en fin de période', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useFreshIp(page);
  const { email } = await createVerifiedAccount(page.context(), 'abo-parcours', 'trial');
  const plans = await plansFromApi(page.request);
  await openSubscription(page);
  await expect(planStatus(page)).toContainText('Essai Pro');
  await expect(proCard(page)).toContainText('Essai en cours');

  // Checkout simulé : page de l'app (même origine), mode simulé visible, aucun champ de carte.
  await checkoutButton(page).click();
  await expect(page).toHaveURL(/\/abonnement\/simulation\?session=cs_fake_[A-Za-z0-9]{16,64}$/);
  await expect(page.locator('main h1')).toHaveText('Paiement simulé');
  await expect(page.getByText('Mode simulation : aucun paiement réel')).toBeVisible();
  await expect(page.locator('main input, main iframe, main select, main textarea')).toHaveCount(0);
  await expect(page.locator('main')).toContainText('Aucune carte n’est demandée');
  // Le retour de Checkout n'accorde rien : l'essai est toujours en cours tant que le paiement n'est pas simulé.
  expect((await userRow(email)).trialStatus).toBe('ACTIVE');

  await page.locator('[data-simulate-paid]').click();
  await expect(page).toHaveURL(/\/abonnement\/succes/);
  await expect(page.locator('[data-state="confirmed"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('main h1')).toHaveText('Bienvenue dans Raijin Pro');
  await expect(raiPose(page, 'bravo')).toBeVisible();
  await expect(page.locator('[data-state="confirmed"]')).toContainText('Ton abonnement mensuel est actif.');
  expect(await userRow(email)).toMatchObject({ plan: 'PRO', trialStatus: 'ENDED' });

  // Abonnement : Pro mensuel actif, plus de bouton Checkout, bandeau d'essai disparu.
  await page.getByRole('link', { name: 'Voir mon abonnement' }).click();
  await expect(page).toHaveURL(/\/abonnement$/);
  await expect(planStatus(page)).toContainText('Pro, abonnement mensuel', { timeout: 15_000 });
  await expect(planStatus(page).locator('[data-status-detail]')).toContainText('Actif. Prochain renouvellement le');
  await expect(checkoutButton(page)).toHaveCount(0);
  await expect(proCard(page)).toContainText('Ton plan actuel');

  // Faux portail : résiliation en fin de période.
  await planStatus(page).locator('[data-portal]').click();
  await expect(page).toHaveURL(/\/abonnement\/simulation-portail$/);
  await expect(page.locator('main h1')).toHaveText('Portail simulé');
  await page.locator('[data-action="cancel_at_period_end"]').click();
  await expect(page.getByText('Résiliation programmée (simulation).')).toBeVisible();
  await expect(page.locator('[data-action="resume"]')).toBeVisible();
  await page.getByRole('link', { name: 'Retour à Raijin' }).click();
  await expect(page).toHaveURL(/\/abonnement$/);
  await expect(planStatus(page).locator('[data-status-detail]')).toContainText('Résiliation programmée : Pro reste actif jusqu’au', { timeout: 15_000 });
  await expect(planStatus(page)).toContainText('Pro, abonnement mensuel');

  await openPage(page, '/analyse');
  await expect(trialBanner(page)).toHaveCount(0);

  // Reçu (invoice.paid) : montant lu chez Stripe (ici le faux Stripe), mention légale.
  const receipt = await waitForMailHtml(email, 'Ton reçu Raijin Pro');
  expect(plain(receipt.html)).toContain(plain(formatPrice(plans.pro.monthly.amountCents, plans.pro.monthly.currency)));
  expect(receipt.html).toContain('pas un conseil en investissement');
  await captureMail(page, receipt.html, 'recu');
});

test('Checkout annulé (toast neutre), puis paiement refusé simulé : past_due expliqué, Pro conservé, e-mail d’échec', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useFreshIp(page);
  const { email } = await createVerifiedAccount(page.context(), 'abo-refus');
  await openSubscription(page);

  await checkoutButton(page).click();
  await expect(page).toHaveURL(/\/abonnement\/simulation\?session=/);
  await page.locator('[data-simulate-cancel]').click();
  await expect(page.getByText('Paiement annulé : rien n’a été débité.')).toBeVisible();
  await expect(page).toHaveURL(/\/abonnement$/);
  await expect(planStatus(page)).toContainText('Gratuit');

  await chooseInterval(page, 'Annuel');
  await checkoutButton(page).click();
  await expect(page).toHaveURL(/\/abonnement\/simulation\?session=/);
  await page.locator('[data-simulate-failed]').click();
  await expect(page).toHaveURL(/\/abonnement$/);
  await expect(page.getByText('Refus de paiement simulé.', { exact: false })).toBeVisible();
  await expect(planStatus(page)).toContainText('Pro, abonnement annuel', { timeout: 15_000 });
  await expect(page.locator('[data-payment-issue]')).toContainText('Le dernier paiement n’a pas abouti. Pro reste actif pendant que Stripe réessaie');
  expect((await userRow(email)).plan).toBe('PRO');

  const failed = await waitForMailHtml(email, 'Ton paiement Raijin Pro n’est pas passé');
  expect(failed.html).toContain('/abonnement');
  expect(failed.html).toContain('pas un conseil en investissement');
  await captureMail(page, failed.html, 'echec-paiement');
});

test('redirection de paiement vers un hôte non autorisé : refusée, message neutre, aucune navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useFreshIp(page);
  await createVerifiedAccount(page.context(), 'abo-redirection');
  const outbound: string[] = [];
  page.on('request', (req) => {
    if (!req.url().startsWith(APP_ORIGIN)) outbound.push(req.url());
  });
  for (const evil of ['https://evil.example/pay', 'https://checkout.stripe.com.evil.example/c/pay', 'http://checkout.stripe.com/c/pay']) {
    await page.unroute('**/api/v1/billing/checkout-sessions');
    // Vraie réponse de l'API, URL remplacée : le front ne doit suivre que Stripe (https, hôte exact) ou sa propre origine.
    await page.route('**/api/v1/billing/checkout-sessions', async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({ response, json: { url: evil } });
    });
    await openSubscription(page);
    await checkoutButton(page).click();
    await expect(page.getByText(REDIRECT_REFUSED)).toBeVisible();
    await expect(page).toHaveURL(`${APP_ORIGIN}/abonnement`);
    await expect(checkoutButton(page)).toBeEnabled();
  }
  expect(outbound.filter((url) => url.includes('evil.example') || url.includes('stripe.com')), 'aucune requête vers l’hôte injecté').toEqual([]);
});

test('paiement indisponible (BILLING_NOT_CONFIGURED) : texte neutre, boutons désactivés ; 503 au Checkout expliqué', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useFreshIp(page);
  await createVerifiedAccount(page.context(), 'abo-indisponible');

  // Mode « unavailable » (Stripe sans clés) : aucune action de paiement possible.
  await forceBillingMode(page, 'unavailable');
  await openSubscription(page);
  await expect(page.locator('[data-billing-unavailable]')).toHaveText(UNAVAILABLE);
  await expect(checkoutButton(page)).toBeDisabled();
  await expect(page.getByText('Mode simulation : aucun paiement réel')).toHaveCount(0);
  await page.unroute('**/api/v1/billing/plans');
  await page.unroute('**/api/v1/billing/subscription');

  // Configuration retirée entre l'affichage et le clic : l'API répond 503, le front l'explique sans partir.
  await page.route('**/api/v1/billing/checkout-sessions', (route) =>
    route.fulfill({ status: 503, json: { code: 'BILLING_NOT_CONFIGURED', message: UNAVAILABLE } }),
  );
  await openSubscription(page);
  await checkoutButton(page).click();
  await expect(page.getByText(UNAVAILABLE)).toBeVisible();
  await expect(page).toHaveURL(`${APP_ORIGIN}/abonnement`);
});
