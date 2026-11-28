import { expect, test, type Locator, type Page } from '@playwright/test';
import { workspaceRoot } from '@nx/devkit';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ORIGIN, registerViaApi } from './support/auth';
import { plain } from './support/billing';
import { mailsFor, waitForMailHtml } from './support/watch';

/**
 * Paiement Stripe en MODE TEST de bout en bout (relecture finale, tour 5, point 3), contre l'API locale lancée avec
 * `BILLING_PROVIDER=stripe` (clés sk_test du compte de test) et un relais `stripe listen` vers
 * `/api/v1/billing/webhook`. Ignoré par défaut : lancé seulement avec `STRIPE_E2E=1` et la configuration dédiée
 * `apps/web-e2e/playwright.stripe.config.mts` (aucun serveur démarré par Playwright).
 * Carte de test publiée par Stripe (4242…), identité factice : aucun vrai paiement, aucune donnée personnelle.
 */
const SHOTS = join(workspaceRoot, 'docs', 'screenshots', 'stripe-test');
const TEST_CARD = '4242424242424242';
const DECLINE_AFTER_ATTACH_CARD = '4000000000000341';

const proCard = (page: Page) => page.locator('rj-card[data-plan="PRO"]');
const planStatus = (page: Page) => page.locator('[data-plan-status]');
const checkoutButton = (page: Page) => proCard(page).locator('[data-checkout]');

test.skip(!process.env['STRIPE_E2E'], 'Stripe mode test réel : STRIPE_E2E=1 requis');
test.describe.configure({ timeout: 240_000 });

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

async function openSubscription(page: Page): Promise<void> {
  await page.goto(`${APP_ORIGIN}/abonnement`);
  await expect(page.locator('main h1')).toHaveText('Abonnement');
  await expect(proCard(page).locator('[data-price]')).not.toBeEmpty({ timeout: 20_000 });
}

/**
 * Premier élément visible correspondant à `selector` dans la page ou l'un de ses cadres : le Checkout hébergé
 * place ses champs dans des iframes (Payment Element), imbriquées selon la version de Stripe.
 */
async function inFrames(page: Page, selector: string, timeoutMs = 30_000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const candidate = frame.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`Élément « ${selector} » introuvable dans le Checkout Stripe (${page.frames().length} cadres) :\n${await describeInputs(page)}`);
}

/** Champs présents dans tous les cadres (diagnostic d'un changement d'interface de Stripe). */
async function describeInputs(page: Page): Promise<string> {
  const lines: string[] = [];
  for (const frame of page.frames()) {
    const fields = await frame
      .locator('input, select, button, [role="button"], [role="radio"]')
      .evaluateAll((els) => els.map((el) => `${el.tagName.toLowerCase()} name=${el.getAttribute('name')} id=${el.id} ac=${el.getAttribute('autocomplete')} aria=${el.getAttribute('aria-label')} text=${(el.textContent ?? '').trim().slice(0, 30)}`))
      .catch(() => [] as string[]);
    if (fields.length) lines.push(`[${frame.url().slice(0, 80)}]`, ...fields.map((f) => `  ${f}`));
  }
  return lines.join('\n');
}

async function fillIfPresent(page: Page, selector: string, value: string): Promise<void> {
  const field = await inFrames(page, selector, 3_000).catch(() => null);
  if (field) await field.fill(value);
}

/** Saisie dans le Checkout hébergé de Stripe (mode test). */
async function payOnStripeCheckout(page: Page, card: string): Promise<void> {
  await expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 30_000 });
  await expect(page.getByText(/Environnement de test|mode test|test mode|sandbox/i).first()).toBeVisible({ timeout: 30_000 });
  // Moyen de paiement « Carte bancaire » (liste repliée quand plusieurs moyens sont activés).
  const cardChoice = await inFrames(page, '[role="button"]:has-text("Carte bancaire"), button:has-text("Carte bancaire"), [data-testid="card-accordion-item-button"]', 10_000).catch(() => null);
  if (cardChoice) await cardChoice.click();
  await (await inFrames(page, 'input[name="number"], #cardNumber, input[autocomplete="cc-number"]')).fill(card);
  await (await inFrames(page, 'input[name="expiry"], #cardExpiry, input[autocomplete="cc-exp"]')).fill('12 / 34');
  await (await inFrames(page, 'input[name="cvc"], #cardCvc, input[autocomplete="cc-csc"]')).fill('123');
  await fillIfPresent(page, '#billingName, input[name="name"], input[name="billingName"], input[autocomplete="cc-name"], input[autocomplete="name"]', 'Test Raijin');
  const country = await inFrames(page, 'select[name="country"], #billingCountry, select[autocomplete="country"]', 3_000).catch(() => null);
  if (country) await country.selectOption('FR');
  await fillIfPresent(page, 'input[name="postalCode"], #billingPostalCode, input[autocomplete="postal-code"]', '75001');
  // Link (enregistrement des coordonnées chez Stripe) : jamais activé.
  const link = await inFrames(page, '#enableStripePass, input[type="checkbox"][name*="link" i], input[type="checkbox"][name*="save" i]', 2_000).catch(() => null);
  if (link && (await link.isChecked().catch(() => false))) await link.uncheck();
}

async function submitCheckout(page: Page): Promise<void> {
  await (await inFrames(page, 'button:has-text("Payer et s’abonner"), button:has-text("S’abonner"), [data-testid="hosted-payment-submit-button"], button.SubmitButton')).click();
}

test('Stripe test : inscription → Tarifs → Checkout 4242 → Pro → reçu → portail → résiliation programmée', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const account = await registerViaApi(page.context(), 'stripe', `e2e-stripe-${Date.now().toString(36)}@example.com`);
  const email = account.email;
  // Vérification de l'adresse par le lien reçu dans Mailpit (compte connecté ensuite).
  await page.goto(`${APP_ORIGIN}${account.link}`);
  await expect(page.locator('main')).toContainText(/confirmée|vérifiée|Bienvenue/i, { timeout: 20_000 });

  await openSubscription(page);
  await expect(page.getByText('Mode simulation : aucun paiement réel')).toHaveCount(0);
  await shot(page, '01-tarifs');

  await checkoutButton(page).click();
  await payOnStripeCheckout(page, TEST_CARD);
  await shot(page, '02-checkout');
  await submitCheckout(page);

  await expect(page).toHaveURL(new RegExp(`^${APP_ORIGIN}/abonnement/succes`), { timeout: 90_000 });
  await expect(page.locator('[data-state="confirmed"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('main h1')).toHaveText('Bienvenue dans Raijin Pro');
  await shot(page, '03-retour-pro');

  await openSubscription(page);
  await expect(planStatus(page)).toContainText('Pro, abonnement mensuel', { timeout: 20_000 });
  await expect(planStatus(page).locator('[data-status-detail]')).toContainText('Actif. Prochain renouvellement le');
  await shot(page, '04-abonnement-pro');

  // Reçu de l'app (invoice.paid) ; aucun autre e-mail de paiement en doublon dans Mailpit.
  // Vérification « soft » : un reçu manquant fait échouer le test sans masquer la suite du parcours (portail).
  const receipt = await waitForMailHtml(email, 'Ton reçu Raijin Pro', 60_000).catch((error: Error) => error);
  expect.soft(receipt instanceof Error ? receipt.message : 'reçu présent', 'e-mail de reçu (invoice.paid)').toBe('reçu présent');
  if (!(receipt instanceof Error)) expect.soft(receipt.html).toContain('pas un conseil en investissement');
  expect.soft((await mailsFor(email, /reçu|receipt|facture|invoice/i)).length, 'un seul e-mail de reçu').toBe(1);

  // Customer Portal Stripe (mode test) : résiliation en fin de période.
  await planStatus(page).locator('[data-portal]').click();
  await expect(page).toHaveURL(/^https:\/\/billing\.stripe\.com\//, { timeout: 30_000 });
  const cancelRe = /annuler l.abonnement|cancel subscription/i;
  await page.getByRole('link', { name: cancelRe }).or(page.getByRole('button', { name: cancelRe })).first().click();
  // Page « Vérifier vos modifications », enquête de résiliation (modale « Motif », activée dans le portail), confirmation.
  const done = page.getByText(/sera annulé|will be canceled|annulation le|cancels on|prendra fin|annulé le/i).first();
  const reason = page.getByLabel('Motif');
  const proceed = page.getByRole('button', { name: /continuer vers l.annulation|continue/i });
  const confirm = page.locator('[data-testid="confirm"]');
  let surveyShot = false;
  for (let step = 0; step < 8 && !(await done.isVisible().catch(() => false)); step++) {
    if (await reason.isVisible().catch(() => false)) {
      const values = await reason.locator('option').evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
      if (values[0] && !(await reason.inputValue())) await reason.selectOption(values[0]);
      if (!surveyShot) {
        await shot(page, '05-portail-annulation');
        surveyShot = true;
      }
    }
    if (await proceed.isVisible().catch(() => false)) await proceed.click();
    else if (await confirm.isVisible().catch(() => false)) await confirm.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
  }
  await expect(page.getByText(/sera annulé|will be canceled|annulation le|cancels on|prendra fin/i).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, '06-portail-resilie');
  await page.getByRole('link', { name: /retour|return to/i }).first().click();
  await expect(page).toHaveURL(new RegExp(`^${APP_ORIGIN}/abonnement`), { timeout: 30_000 });
  await expect
    .poll(async () => {
      await openSubscription(page);
      return plain(await planStatus(page).locator('[data-status-detail]').textContent());
    }, { timeout: 60_000, intervals: [2_000, 5_000] })
    .toContain('Résiliation programmée : Pro reste actif jusqu’au');
  await shot(page, '07-resiliation-programmee');
});

test('Stripe test : carte 4000 0000 0000 0341 (refus après rattachement) → paiement refusé, Pro non accordé', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const account = await registerViaApi(page.context(), 'stripe-refus', `e2e-stripe-refus-${Date.now().toString(36)}@example.com`);
  await page.goto(`${APP_ORIGIN}${account.link}`);
  await expect(page.locator('main')).toContainText(/confirmée|vérifiée|Bienvenue/i, { timeout: 20_000 });
  await openSubscription(page);
  await checkoutButton(page).click();
  await payOnStripeCheckout(page, DECLINE_AFTER_ATTACH_CARD);
  await submitCheckout(page);
  // Checkout refuse la carte sur place (le premier paiement échoue) : message d'erreur Stripe, pas de retour vers l'app.
  await expect(await inFrames(page, ':text-matches("carte a été refusée|card was declined", "i")', 60_000)).toBeVisible();
  await shot(page, '08-checkout-refus-390');
});
