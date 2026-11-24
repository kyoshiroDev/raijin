import { expect, test, type Page } from '@playwright/test';
import { workspaceRoot } from '@nx/devkit';
import { join } from 'node:path';
import { APP_ORIGIN, PASSWORD, createVerifiedAccount, linkFrom, uniqueEmail, uniqueFreeEmail, waitForMail } from './support/auth';
import { useFreshIp } from './support/analysis';
import { DAY, HOUR, expireTrial, followFive, nextSendingSlot, raiPose, refusalReason, bannerHostReady, settle, trialBanner, trialTick, userRow } from './support/billing';
import { openPage } from './support/pages';
import { api, mailsFor, waitForMailHtml, withPg } from './support/watch';

/**
 * Essai Pro de 7 jours sans carte (phase 6, PROMPT.md §4.4, docs/ARCHITECTURE.md §13) contre l'API réelle :
 * démarrage à la vérification de l'e-mail, bandeau d'essai refermable une fois par jour (horloge du navigateur
 * simulée), adresse jetable → Gratuit avec un message neutre, e-mails J+1 / J-2 / J0 sous horloge simulée
 * (`POST internal/trial/tick`), écran de fin (Rai bravo, récapitulatif), choix des 3 suivis gardés, préférence
 * « E-mails de l'essai ».
 */
const SHOTS = join(workspaceRoot, 'docs', 'screenshots', 'phase-6');
const NEUTRAL_FREE_NOTICE = 'Ton compte est en plan Gratuit. Tu peux passer à Pro quand tu veux.';
const DAY1_SUBJECT = 'Voilà ce que Raijin a vérifié pour toi';
const MINUS2_SUBJECT = 'Ton essai se termine dans 2 jours';
const J0_SUBJECT = 'Tu repasses en Gratuit';
const CLOSE_BANNER = 'Masquer le bandeau jusqu’à demain';

test.describe.configure({ timeout: 120_000 });

/** Inscription et confirmation par l'interface (IP fictive neuve : empreinte d'essai jamais vue). */
async function signUpAndVerify(page: Page, email: string): Promise<void> {
  const since = Date.now() - 1000;
  await page.goto('/compte/inscription');
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Vérifie ta boîte mail' })).toBeVisible({ timeout: 15_000 });
  const link = linkFrom(await waitForMail(email, 'Confirme ton adresse', since), '/compte/verifier-email');
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Adresse confirmée' })).toBeVisible({ timeout: 15_000 });
}

async function captureMail(page: Page, html: string, name: string): Promise<void> {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(`${APP_ORIGIN}/analyse`);
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: join(SHOTS, `email-${name}-${width}.png`), fullPage: true });
  }
}

test('inscription → vérification → essai Pro : bandeau « il reste 7 jours », refermable, de retour le lendemain, dernier jour', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useFreshIp(page);
  const email = uniqueEmail('essai-ui');
  await signUpAndVerify(page, email);
  const row = await userRow(email);
  expect(row.trialStatus).toBe('ACTIVE');
  expect((row.trialEndsAt as Date).getTime() - (row.trialStartedAt as Date).getTime()).toBe(7 * DAY);
  expect(await waitForMail(email, 'Bienvenue sur Raijin')).toContain('essai Pro de 7 jours');

  await openPage(page, '/analyse');
  const banner = trialBanner(page);
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner.locator('[data-trial-text]')).toHaveText('Essai Pro : il reste 7 jours');
  await expect(banner.getByRole('link', { name: 'Voir les offres' })).toHaveAttribute('href', '/abonnement');
  // Aucune animation dans le bandeau (sobre, sans compte à rebours).
  expect(await banner.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);

  // Masqué sur les écrans d'abonnement.
  await banner.getByRole('link', { name: 'Voir les offres' }).click();
  await expect(page).toHaveURL(/\/abonnement$/);
  await expect(page.locator('[data-plan-status]')).toContainText('Essai Pro', { timeout: 15_000 });
  await expect(trialBanner(page)).toHaveCount(0);

  // Refermé : reste fermé aujourd'hui, même après rechargement.
  await openPage(page, '/analyse');
  await trialBanner(page).getByRole('button', { name: CLOSE_BANNER }).click();
  await expect(trialBanner(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('main h1').first()).toBeVisible();
  await bannerHostReady(page);
  await expect(trialBanner(page)).toHaveCount(0);

  // Le lendemain (horloge du navigateur avancée d'un jour) : de retour, un jour de moins.
  await page.clock.setFixedTime(new Date(Date.now() + DAY));
  await openPage(page, '/analyse');
  await expect(trialBanner(page).locator('[data-trial-text]')).toHaveText('Essai Pro : il reste 6 jours', { timeout: 15_000 });

  // Dernier jour : « se termine aujourd'hui », lien vers le récapitulatif (écran de fin déjà disponible).
  await page.clock.setFixedTime(new Date((row.trialEndsAt as Date).getTime() - 6 * HOUR));
  await openPage(page, '/analyse');
  const last = trialBanner(page);
  await expect(last.locator('[data-trial-text]')).toHaveText('Essai Pro : se termine aujourd’hui', { timeout: 15_000 });
  await last.getByRole('link', { name: 'Voir mon récapitulatif' }).click();
  await expect(page).toHaveURL(/\/abonnement\/fin-essai$/);
  await expect(page.locator('main h1')).toHaveText('Ton essai Pro se termine aujourd’hui', { timeout: 15_000 });
  await expect(raiPose(page, 'bravo')).toBeVisible();
});

test('adresse jetable : compte Gratuit, message neutre (aucun motif exposé), pas de bandeau', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useFreshIp(page);
  const email = uniqueFreeEmail('essai-jetable');
  await signUpAndVerify(page, email);
  expect(await userRow(email)).toMatchObject({ plan: 'FREE', trialStatus: 'INELIGIBLE', trialStartedAt: null });
  expect(await refusalReason(email)).toBe('disposable_domain');
  const welcome = await waitForMail(email, 'Bienvenue sur Raijin');
  expect(welcome).toContain('Ton compte Gratuit est prêt');
  expect(welcome.toLowerCase()).not.toMatch(/jetable|refus|abus/);

  await openPage(page, '/abonnement');
  await expect(page.locator('[data-plan-status] [data-status-detail]')).toHaveText(NEUTRAL_FREE_NOTICE, { timeout: 15_000 });
  expect((await page.locator('main').textContent())?.toLowerCase()).not.toMatch(/jetable|refus|abus/);
  await openPage(page, '/analyse');
  // Session chargée (quota Gratuit affiché) : aucun bandeau d'essai.
  await expect(page.locator('[data-quota]')).toContainText('sur 5', { timeout: 15_000 });
  await expect(page.locator('rj-trial-banner-host')).toHaveCount(0);
  await expect(trialBanner(page)).toHaveCount(0);
});

test('e-mails J+1 et J-2 (horloge simulée) : une seule fois chacun, « Garder Pro », mention légale ; captures', async ({ page }) => {
  await useFreshIp(page);
  const request = page.context().request;
  const { email } = await createVerifiedAccount(page.context(), 'essai-mails', 'trial');
  const row = await userRow(email);
  const startedAt = row.trialStartedAt as Date;
  const endsAt = row.trialEndsAt as Date;

  const day1 = nextSendingSlot(new Date(startedAt.getTime() + DAY));
  expect(await trialTick(request, day1, row.id)).toMatchObject({ day1: 1, dayMinus2: 0, expired: 0 });
  expect(await trialTick(request, new Date(day1.getTime() + HOUR), row.id)).toMatchObject({ day1: 0 });
  const mail1 = await waitForMailHtml(email, DAY1_SUBJECT);
  expect(mail1.html).toContain('pas un conseil en investissement');

  const minus2 = nextSendingSlot(new Date(endsAt.getTime() - 2 * DAY));
  expect(await trialTick(request, minus2, row.id)).toMatchObject({ dayMinus2: 1, expired: 0 });
  expect(await trialTick(request, new Date(minus2.getTime() + HOUR), row.id)).toMatchObject({ dayMinus2: 0 });
  const mail2 = await waitForMailHtml(email, MINUS2_SUBJECT);
  expect(mail2.html).toContain('Garder Pro');
  expect(mail2.html).toContain('/abonnement');
  expect(mail2.html).toContain('pas un conseil en investissement');

  await settle();
  expect(await mailsFor(email, DAY1_SUBJECT)).toHaveLength(1);
  expect(await mailsFor(email, MINUS2_SUBJECT)).toHaveLength(1);
  await captureMail(page, mail1.html, 'essai-j1');
  await captureMail(page, mail2.html, 'essai-j-2');
});

test('fin d’essai (job) : e-mail J0, bandeau de fin → écran Rai bravo + récapitulatif → « Garder Pro » → /abonnement ; « Continuer en Gratuit » → choix des 3 suivis sur 5 → les autres en pause', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useFreshIp(page);
  const request = page.context().request;
  const { email } = await createVerifiedAccount(page.context(), 'essai-fin', 'trial');
  await followFive(request);
  expect(await expireTrial(request, email)).toMatchObject({ expired: 1, pausedWatches: 2, ended: 1 });
  expect(await userRow(email)).toMatchObject({ plan: 'FREE', trialStatus: 'ENDED' });

  const j0 = await waitForMailHtml(email, J0_SUBJECT);
  expect(j0.html).toContain('2 suivis ont été mis en pause');
  expect(j0.html).toContain('pas un conseil en investissement');

  // Bandeau de fin (écran pas encore vu) → récapitulatif.
  await openPage(page, '/analyse');
  const banner = trialBanner(page);
  await expect(banner.locator('[data-trial-text]')).toHaveText('Ton essai Pro est terminé', { timeout: 15_000 });
  await banner.getByRole('link', { name: 'Voir mon récapitulatif' }).click();
  await expect(page).toHaveURL(/\/abonnement\/fin-essai$/);
  await expect(page.locator('main h1')).toHaveText('Ton essai Pro est terminé', { timeout: 15_000 });
  await expect(raiPose(page, 'bravo')).toBeVisible();
  for (const stat of ['analyses', 'alerts', 'danger']) await expect(page.locator(`[data-stat="${stat}"] .text-metric`)).toHaveText(/^\d+$/);
  await expect(page.locator('[data-stat="analyses"] .text-metric')).not.toHaveText('0');
  await expect(page.locator('[data-pause-note]')).toContainText('Tu suis 5 tokens : en Gratuit, 3 restent actifs et les autres sont mis en pause, jamais supprimés.');
  await expect(page.locator('main')).toContainText('Ce qui change en Gratuit');
  await expect(page.locator('main')).toContainText('pas un conseil en investissement');

  // « Garder Pro » mène à l'abonnement (essai terminé, Checkout disponible).
  await page.locator('[data-keep-pro]').click();
  await expect(page).toHaveURL(/\/abonnement$/);
  await expect(page.locator('[data-plan-status] [data-status-detail]')).toHaveText('Ton essai Pro est terminé. Tu peux passer à Pro quand tu veux.', { timeout: 15_000 });
  await expect(page.locator('rj-card[data-plan="PRO"] [data-checkout]')).toBeEnabled();

  // « Continuer en Gratuit » → choix des 3 suivis (3 actifs présélectionnés, limite claire).
  await openPage(page, '/abonnement/fin-essai');
  await page.locator('[data-continue-free]').click();
  await expect(page).toHaveURL(/\/abonnement\/suivis$/);
  await expect(page.locator('main h1')).toHaveText('Choisis tes 3 suivis actifs', { timeout: 15_000 });
  const boxes = page.locator('form [data-watch] input[type="checkbox"]');
  await expect(boxes).toHaveCount(5);
  const counter = page.locator('[data-counter]');
  await expect(counter).toHaveText('3 / 3 sélectionnés');
  await expect(page.locator('[data-limit-note]')).toBeVisible();
  const cards = page.locator('form [data-watch]');
  const states = await cards.evaluateAll((labels) =>
    labels.map((label) => ({ id: label.getAttribute('data-watch') ?? '', checked: (label.querySelector('input') as HTMLInputElement).checked })),
  );
  const unchecked = states.filter((s) => !s.checked);
  const checked = states.filter((s) => s.checked);
  expect(unchecked).toHaveLength(2);
  // Une case non cochée est désactivée tant que la limite est atteinte.
  await expect(page.locator(`[data-watch="${unchecked[0]?.id}"] input`)).toBeDisabled();
  // Échange : on décoche un suivi actif, on garde un suivi en pause.
  await page.locator(`[data-watch="${checked[0]?.id}"] input`).uncheck();
  await expect(counter).toHaveText('2 / 3 sélectionnés');
  await page.locator(`[data-watch="${unchecked[0]?.id}"] input`).check();
  await expect(counter).toHaveText('3 / 3 sélectionnés');
  await page.locator('[data-keep-submit]').click();
  await expect(page.getByText('C’est noté : 3 suivis actifs, 2 en pause.')).toBeVisible();
  await expect(page).toHaveURL(/\/suivis$/);
  await expect(page.locator('[data-watch-count]')).toHaveText('3 / 3', { timeout: 15_000 });

  const list = await api(request, 'GET', '/watches');
  expect(list.body).toMatchObject({ activeCount: 3, pausedCount: 2 });
  const items = list.body['items'] as { id: string; status: string }[];
  expect(items).toHaveLength(5);
  const active = items.filter((item) => item.status === 'active').map((item) => item.id).sort();
  expect(active).toEqual([unchecked[0]?.id, checked[1]?.id, checked[2]?.id].sort());

  // Écran marqué vu : plus de bandeau de fin.
  const seen = await withPg((pg) => pg.query<{ at: Date | null }>(`SELECT "trialEndScreenSeenAt" AS at FROM "User" WHERE "email" = $1`, [email]));
  expect(seen.rows[0]?.at).toBeInstanceOf(Date);
  const endScreenChecked = page.waitForResponse((res) => res.url().endsWith('/api/v1/billing/subscription') && res.ok());
  await openPage(page, '/analyse');
  await bannerHostReady(page);
  expect(((await (await endScreenChecked).json()) as { trial: { endScreenDue: boolean } }).trial.endScreenDue).toBe(false);
  await expect(trialBanner(page)).toHaveCount(0);
  await captureMail(page, j0.html, 'essai-j0');
});

test('« E-mails de l’essai » : désactivé → aucun e-mail J+1 ; l’e-mail de fin (J0) part quand même', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useFreshIp(page);
  const request = page.context().request;
  const { email } = await createVerifiedAccount(page.context(), 'essai-pref', 'trial');
  await openPage(page, '/compte?section=notifications');
  const toggle = page.getByRole('switch', { name: 'E-mails de l’essai' });
  await expect(toggle).toBeChecked({ timeout: 15_000 });
  await expect(page.locator('[data-pref="trialEmails"]')).toContainText('L’e-mail de fin d’essai est toujours envoyé.');
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole('switch', { name: 'E-mails de l’essai' })).not.toBeChecked({ timeout: 15_000 });

  const row = await userRow(email);
  const day1 = nextSendingSlot(new Date((row.trialStartedAt as Date).getTime() + DAY));
  expect(await trialTick(request, day1, row.id)).toMatchObject({ day1: 0 });
  const minus2 = nextSendingSlot(new Date((row.trialEndsAt as Date).getTime() - 2 * DAY));
  expect(await trialTick(request, minus2, row.id)).toMatchObject({ dayMinus2: 0 });
  expect(await expireTrial(request, email)).toMatchObject({ expired: 1, ended: 1 });
  await waitForMailHtml(email, J0_SUBJECT);
  await settle();
  expect(await mailsFor(email, DAY1_SUBJECT)).toHaveLength(0);
  expect(await mailsFor(email, MINUS2_SUBJECT)).toHaveLength(0);
});
