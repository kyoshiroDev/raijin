import { chromium, expect as baseExpect, request as playwrightRequest, test, type APIRequestContext, type Page } from '@playwright/test';
import { workspaceRoot } from '@nx/devkit';
import { join } from 'node:path';
import { APP_ORIGIN, createVerifiedAccount, loginViaApi, registerViaApi } from './support/auth';
import { MINTS, PROD_ORIGIN, expectVerdict, useFreshIp } from './support/analysis';
import { openDialogSettled, openPage, shellTabBar } from './support/pages';
import {
  WATCH_MINTS,
  api,
  fixtureStep,
  followViaApi,
  mailsFor,
  pushOutbox,
  purgeMintWatches,
  runJob,
  seedAnalysis,
  startTrial,
  waitForMailHtml,
} from './support/watch';

/**
 * Suivis, alertes, préférences et push de bout en bout (PROMPT.md §9, docs/ARCHITECTURE.md §11), API réelle
 * en mode fixtures : passes déclenchées par `internal/jobs/:name/run`, scénarios en séquence avancés par
 * `internal/fixtures/:scenario`. Les étapes partagent l'état des scénarios (global à l'API) : fichier en série.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const expect = baseExpect.configure({ timeout: 15_000 });
const SHOTS = join(workspaceRoot, 'docs', 'screenshots', 'phase-4');
const ALERT_SUBJECT = /alerte/i;
const SCENARIOS = ['watch-mint-reactivated', 'watch-lp-removed', 'watch-holder-sold'] as const;

interface Account {
  email: string;
  password: string;
}

let free: Account;
let pro: Account;
let freeApi: APIRequestContext;
let proApi: APIRequestContext;
let internal: APIRequestContext;
const alertIds: Record<string, string> = {};

async function apiContext(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: APP_ORIGIN });
}

async function login(page: Page, account: Account): Promise<void> {
  await useFreshIp(page);
  await loginViaApi(page.context().request, account.email, account.password);
}

async function fillLogin(page: Page, account: Account) {
  await page.getByLabel('Adresse e-mail').fill(account.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

const followButton = (page: Page) => page.locator('[data-follow]');
/** Cartes de suivi (< 1280 px) : enfants directs de la liste (chaque carte contient sa propre liste). */
const watchCards = (page: Page) => page.locator('ul[aria-label="Tokens suivis"] > li');
const alertItems = (page: Page) => page.locator('ul[aria-label="Alertes"] > li');

test.beforeAll(async () => {
  for (const mint of Object.values(WATCH_MINTS)) await purgeMintWatches(mint);
  internal = await apiContext();
  for (const scenario of SCENARIOS) await fixtureStep(internal, scenario, 0);
  freeApi = await apiContext();
  proApi = await apiContext();
  free = await createVerifiedAccount(freeApi, 'suivi-gratuit');
  pro = await createVerifiedAccount(proApi, 'suivi-pro');
  await startTrial(pro.email);
});

test.afterAll(async () => {
  for (const scenario of SCENARIOS) await fixtureStep(internal, scenario, 0).catch(() => undefined);
  for (const mint of Object.values(WATCH_MINTS)) await purgeMintWatches(mint).catch(() => undefined);
  await Promise.all([freeApi?.dispose(), proApi?.dispose(), internal?.dispose()]);
});

test('visiteur : « Suivre » mène à la connexion puis revient sur l’analyse, et le token est suivi', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useFreshIp(page);
  await page.goto(`/analyse/${MINTS.bonk}`);
  await expectVerdict(page, 'Prudence');
  await followButton(page).click();
  await expect(page).toHaveURL(new RegExp(`/compte/connexion\\?redirect=%2Fanalyse%2F${MINTS.bonk}$`));
  await fillLogin(page, free);
  await expect(page).toHaveURL(new RegExp(`/analyse/${MINTS.bonk}$`));
  await expectVerdict(page, 'Prudence');
  await expect(followButton(page)).toHaveAttribute('aria-pressed', 'false');
  await followButton(page).click();
  await expect(followButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(followButton(page)).toHaveText('Suivi');
  await expect(page.getByText('Raijin suit ce token')).toBeVisible();
});

test('e-mail non confirmé : « Suivre » ouvre la bottom sheet de confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useFreshIp(page);
  const { email, password } = await registerViaApi(page.context().request, 'suivi-non-confirme');
  await loginViaApi(page.context().request, email, password);
  await page.goto(`/analyse/${MINTS.usdc}`);
  await expectVerdict(page, 'Prudence');
  await followButton(page).click();
  const dialog = await openDialogSettled(page);
  await expect(dialog).toHaveAccessibleName('Confirme ton adresse e-mail');
  await expect(dialog.getByRole('link', { name: 'Confirmer l’adresse' })).toHaveAttribute('href', '/compte/verifier-email');
  await expect(followButton(page)).toHaveAttribute('aria-pressed', 'false');
});

test('limite Gratuit (3 suivis actifs) : le 4e « Suivre » ouvre la bottom sheet de limite', async ({ page }) => {
  for (const mint of [MINTS.usdc, MINTS.pyusd]) {
    const res = await followViaApi(freeApi, mint);
    expect(res.status, `suivi ${mint} : ${JSON.stringify(res.body)}`).toBe(201);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, free);
  await page.goto(`/analyse/${MINTS.honeypot}`);
  await expectVerdict(page, 'Danger');
  await followButton(page).click();
  const dialog = await openDialogSettled(page);
  await expect(dialog).toHaveAccessibleName('Limite de suivis atteinte');
  await expect(dialog).toContainText('3');
  await dialog.getByRole('link', { name: 'Gérer mes suivis' }).click();
  await expect(page).toHaveURL(/\/suivis$/);
  await expect(page.locator('[data-watch-count]')).toHaveText('3 / 3');
});

test('Suivis : compteur, pause et reprise, limite à la reprise, retrait avec confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, free);
  await openPage(page, '/suivis');
  await expect(page.locator('[data-watch-count]')).toHaveText('3 / 3');
  await expect(watchCards(page)).toHaveCount(3);
  await expect(page.locator('[data-plan-limit]')).toContainText('Limite atteinte');

  const pause = page.getByRole('button', { name: /^Mettre en pause le suivi de / }).first();
  await pause.click();
  await expect(page.getByText('Suivi mis en pause.')).toBeVisible();
  await expect(page.locator('[data-watch-count]')).toHaveText('2 / 3');
  await expect(page.locator('[data-paused]')).toHaveCount(1);

  // Une place libérée par la pause est prise par un autre suivi : la reprise est refusée (bottom sheet).
  const extra = await followViaApi(freeApi, MINTS.honeypot);
  expect(extra.status, JSON.stringify(extra.body)).toBe(201);
  await page.reload();
  await expect(page.locator('[data-watch-count]')).toHaveText('3 / 3');
  await page.getByRole('button', { name: /^Reprendre le suivi de / }).click();
  const limit = await openDialogSettled(page);
  await expect(limit).toHaveAccessibleName('Limite de suivis atteinte');
  await limit.getByRole('button', { name: 'J’ai compris' }).click();
  await expect(limit).toBeHidden();

  // Retrait (avec confirmation) de deux suivis actifs, puis reprise du suivi en pause.
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: /^Retirer le suivi de / }).first().click();
    const sheet = await openDialogSettled(page);
    await expect(sheet).toHaveAccessibleName('Retirer ce suivi ?');
    await sheet.getByRole('button', { name: 'Retirer le suivi' }).click();
    await expect(sheet).toBeHidden();
  }
  await expect(watchCards(page)).toHaveCount(2);
  await page.getByRole('button', { name: /^Reprendre le suivi de / }).click();
  await expect(page.getByText('Suivi repris')).toBeVisible();
  await expect(page.locator('[data-watch-count]')).toHaveText('2 / 3');
  await expect(page.locator('[data-paused]')).toHaveCount(0);
});

test('préférences Gratuit : push expliqué sans bouton, e-mail et résumé hebdomadaire enregistrés', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, free);
  await openPage(page, '/compte');
  const push = page.getByRole('switch', { name: 'Notifications push' });
  await expect(push).toBeDisabled();
  await expect(page.locator('[data-pref="pushAlerts"]')).toContainText('Les notifications push font partie du plan Pro');
  await expect(page.getByRole('button', { name: 'Activer sur cet appareil' })).toHaveCount(0);
  await expect(page.locator('[data-push-upgrade]').getByRole('link', { name: 'Voir l’offre Pro' })).toHaveAttribute('href', '/abonnement');

  const email = page.getByRole('switch', { name: 'Alertes par e-mail' });
  const digest = page.getByRole('switch', { name: 'Résumé hebdomadaire' });
  await expect(email).toHaveAttribute('aria-checked', 'true');
  await expect(digest).toHaveAttribute('aria-checked', 'false');
  // Clavier : Espace sur l'interrupteur focalisé.
  await digest.focus();
  await page.keyboard.press('Space');
  await expect(digest).toHaveAttribute('aria-checked', 'true');
  await email.click();
  await expect(email).toHaveAttribute('aria-checked', 'false');
  await expect(email).not.toHaveAttribute('aria-busy', 'true');
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Résumé hebdomadaire' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('switch', { name: 'Alertes par e-mail' })).toHaveAttribute('aria-checked', 'false');
  // Rétablit les alertes par e-mail (vérifiées plus loin dans Mailpit) ; Entrée sur l'interrupteur.
  await page.getByRole('switch', { name: 'Alertes par e-mail' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('switch', { name: 'Alertes par e-mail' })).toHaveAttribute('aria-checked', 'true');
  // Interface optimiste : l'enregistrement est vérifié côté API.
  await expect
    .poll(async () => (await api(freeApi, 'GET', '/notifications/settings')).body['preferences'])
    // `trialEmails` (phase 6) : préférence des e-mails de l'essai, active par défaut, non modifiée ici.
    .toEqual({ emailAlerts: true, pushAlerts: true, weeklyDigest: true, trialEmails: true });
  expect((await api(freeApi, 'GET', '/notifications/settings')).body['pushAllowed']).toBe(false);
});

test('préférences essai Pro (build de production, service worker) : bouton push, permission accordée, appareil abonné', async () => {
  // Le « headless shell » de Chromium répond toujours `Notification.permission === 'denied'`, même
  // après grantPermissions : ce test lance le Chromium complet en mode headless (canal `chromium`).
  const browser = await chromium.launch({ channel: 'chromium' });
  const context = await browser.newContext({ baseURL: PROD_ORIGIN, viewport: { width: 390, height: 844 } });
  try {
    await context.grantPermissions(['notifications'], { origin: PROD_ORIGIN });
    // Aucun navigateur headless (Chromium ou Chrome) n'obtient d'abonnement du service push
    // (« Registration failed - permission denied ») : seul `PushManager.subscribe` est simulé, avec un
    // endpoint FCM factice ; SwPush, la permission, l'API (`POST push/subscriptions`) et l'écran sont réels.
    await context.addInitScript(() => {
      const fake = {
        endpoint: `https://fcm.googleapis.com/fcm/send/e2e-navigateur-${Math.random().toString(36).slice(2)}`,
        expirationTime: null,
        options: { userVisibleOnly: true },
        getKey: () => null,
        unsubscribe: () => Promise.resolve(true),
        toJSON() {
          return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'a'.repeat(22) } };
        },
      };
      let current: typeof fake | null = null;
      PushManager.prototype.subscribe = function () {
        current = fake;
        return Promise.resolve(fake as unknown as PushSubscription);
      };
      PushManager.prototype.getSubscription = function () {
        return Promise.resolve(current as unknown as PushSubscription | null);
      };
    });
    const page = await context.newPage();
    // Session posée sur l'origine du build de production (cookies de 127.0.0.1:4310).
    const csrf = await context.request.get(`${PROD_ORIGIN}/api/v1/auth/csrf`);
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const res = await context.request.post(`${PROD_ORIGIN}/api/v1/auth/login`, {
      data: { email: pro.email, password: pro.password },
      headers: { Origin: PROD_ORIGIN, 'X-CSRF-Token': csrfToken },
    });
    expect(res.status(), await res.text()).toBe(200);
    await page.goto('/compte');
    await expect(page.locator('main h1').first()).toHaveText('Compte');
    const push = page.getByRole('switch', { name: 'Notifications push' });
    await expect(push).toBeEnabled();
    await expect(push).toHaveAttribute('aria-checked', 'true');
    // Le service worker Angular s'enregistre après stabilisation (registerWhenStable:30000).
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)), { timeout: 45_000 }).toBeGreaterThan(0);
    await page.reload();
    const enable = page.getByRole('button', { name: 'Activer sur cet appareil' });
    await expect(enable).toBeVisible();
    await enable.click();
    await expect(page.getByText('Activées sur cet appareil', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('1 appareil reçoit tes notifications.')).toBeVisible();
    const settings = await api(proApi, 'GET', '/notifications/settings');
    expect(settings.body['pushDevices']).toBe(1);
  } finally {
    await context.close();
    await browser.close();
  }
});

test('passes sur fixtures en séquence : mint réactivé, verdict dégradé, LP retirée ; aucun doublon au rejeu', async () => {
  const M = WATCH_MINTS.reactivated;
  // Gratuit (e-mail) et essai Pro (push) suivent le mint du scénario « mint réactivé ».
  expect((await followViaApi(freeApi, M)).status).toBe(201);
  expect((await followViaApi(proApi, M)).status).toBe(201);
  // Scénarios LP et holder : mints sans fixtures d'analyse, analyse récente posée en base.
  for (const [mint, symbol] of [
    [WATCH_MINTS.lp, 'DEMOLP'],
    [WATCH_MINTS.holder, 'DEMOHOLD'],
  ] as const) {
    await seedAnalysis(mint, MINTS.bonk, symbol);
    const res = await api(proApi, 'POST', '/watches', { mint });
    expect(res.status, `suivi ${mint} : ${JSON.stringify(res.body)}`).toBe(201);
  }

  // Passes rapides lancées mint par mint : les fixtures d'autorités sont enregistrées pour un lot d'un seul
  // mint (`getMultipleAccounts([[mint]])`) ; un lot de deux mints n'a pas de fixture.
  const fast = async (mint: string) => (await runJob(internal, 'watch-fast', [mint]))[0] as Record<string, number>;

  // Références : première observation de chaque groupe, aucune alerte.
  expect(await fast(M)).toMatchObject({ events: 0, alerts: 0 });
  expect(await fast(WATCH_MINTS.lp)).toMatchObject({ events: 0, alerts: 0 });
  const [full0] = await runJob(internal, 'watch-full', [M]);
  expect(full0).toMatchObject({ events: 0, failures: 0 });
  await runJob(internal, 'watch-holders', [WATCH_MINTS.holder]);

  // Étape 1 : mint réactivé (passe rapide), puis verdict plus grave (passe complète) ; LP : simple swap.
  for (const scenario of SCENARIOS) await fixtureStep(internal, scenario, 1);
  const fast1 = await fast(M);
  const fastLp1 = await fast(WATCH_MINTS.lp);
  expect(fastLp1, 'un swap ne déclenche rien').toMatchObject({ events: 0 });
  expect(fast1['events'], `passe rapide étape 1 : ${JSON.stringify(fast1)}`).toBeGreaterThanOrEqual(1);
  const [full1] = await runJob(internal, 'watch-full', [M]);
  expect(full1, `passe complète étape 1 : ${JSON.stringify(full1)}`).toMatchObject({ failures: 0 });
  const [holders1] = await runJob(internal, 'watch-holders', [WATCH_MINTS.holder]);

  // Étape 2 : retrait de liquidité.
  await fixtureStep(internal, 'watch-lp-removed', 2);
  const fast2 = await fast(WATCH_MINTS.lp);

  // Rejeu : rien de plus.
  expect(await fast(M)).toMatchObject({ events: 0, alerts: 0 });
  expect(await fast(WATCH_MINTS.lp)).toMatchObject({ events: 0, alerts: 0 });
  const [replayFull] = await runJob(internal, 'watch-full', [M]);
  expect(replayFull).toMatchObject({ events: 0 });
  const [replayHolders] = await runJob(internal, 'watch-holders', [WATCH_MINTS.holder]);
  expect(replayHolders).toMatchObject({ events: 0 });

  const list = await api(proApi, 'GET', '/alerts');
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  const items = list.body['items'] as { id: string; type: string; mint: string; severity: string; payload: Record<string, unknown> }[];
  const byType = (type: string) => items.filter((alert) => alert.type === type);
  for (const alert of items) alertIds[alert.type] ??= alert.id;
  const summary = JSON.stringify({ fast1, full1, holders1, fast2, types: items.map((a) => a.type) });
  expect(byType('mint_reactivated'), `mint réactivé : ${summary}`).toHaveLength(1);
  expect(byType('mint_reactivated')[0]).toMatchObject({ mint: M, severity: 'danger' });
  expect(byType('verdict_degraded'), `verdict dégradé : ${summary}`).toHaveLength(1);
  expect(byType('verdict_degraded')[0]?.payload).toMatchObject({ to: 'danger' });
  expect(byType('lp_removed'), `LP retirée : ${summary}`).toHaveLength(1);
  expect(byType('lp_removed')[0]).toMatchObject({ mint: WATCH_MINTS.lp, severity: 'danger' });
  // Aucun doublon, tous types confondus.
  expect(new Set(items.map((a) => `${a.mint}:${a.type}`)).size).toBe(items.length);

  // Push simulé pour l'essai Pro (appareil abonné à l'étape précédente) : lien vers ?alerte=<id>.
  const reactivatedId = alertIds['mint_reactivated'] as string;
  await expect
    .poll(async () => (await pushOutbox(internal)).find((item) => item.payload.notification.data.alertId === reactivatedId)?.payload.notification.data.onActionClick.default.url, {
      timeout: 20_000,
    })
    .toBe(`/alertes?alerte=${reactivatedId}`);
  const outbox = await pushOutbox(internal);
  expect(JSON.stringify(outbox)).not.toContain(pro.email);
  expect(outbox.filter((item) => item.payload.notification.data.alertId === reactivatedId)).toHaveLength(1);
});

test('Alertes : badge de non-lues, filtres en bottom sheet (type, état, token), lu / non lu, tout lu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, pro);
  await openPage(page, '/alertes');
  const unread = (await api(proApi, 'GET', '/alerts/unread-count')).body['unread'] as number;
  expect(unread).toBeGreaterThanOrEqual(3);
  const alertsTab = shellTabBar(page).getByRole('link', { name: new RegExp(`^Alertes\\s*, ${unread} non lues$`) });
  await expect(alertsTab).toBeVisible();
  await expect(page.getByRole('button', { name: `Notifications, ${unread} non lues` })).toBeVisible();
  await expect(page.locator('[data-unread-count]')).toHaveText(`${unread} alertes non lues`);
  const list = page.getByRole('list', { name: 'Alertes' });
  await expect(alertItems(page)).toHaveCount(unread);

  // Filtre par type (bottom sheet sous 1024 px), au clavier.
  const trigger = page.getByRole('button', { name: /^Filtres/ });
  await trigger.focus();
  await page.keyboard.press('Enter');
  let sheet = await openDialogSettled(page);
  await expect(sheet).toHaveAccessibleName('Filtres');
  const mintType = sheet.getByRole('checkbox', { name: 'Mint réactivé' });
  await mintType.focus();
  await page.keyboard.press('Space');
  await expect(mintType).toBeChecked();
  await expect(page).toHaveURL(/type=mint_reactivated/);
  await expect(sheet.getByRole('button', { name: 'Voir 1 alerte' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText(/Filtres \(1\)/);
  await expect(alertItems(page)).toHaveCount(1);
  await expect(list).toContainText('Mint réactivé');

  // Marquer lue puis filtre « Non lues » : la liste se vide ; « Lues » : elle revient.
  await list.getByRole('button', { name: /^Marquer lue : / }).click();
  await expect(list.getByRole('button', { name: /^Marquer non lue : / })).toBeVisible();
  await expect(page.locator('[data-unread-count]')).toHaveText(unread - 1 > 1 ? `${unread - 1} alertes non lues` : '1 alerte non lue');
  await trigger.click();
  sheet = await openDialogSettled(page);
  await sheet.getByText('Non lues', { exact: true }).click();
  await expect(page).toHaveURL(/statut=non-lues/);
  await expect(page.getByText('Aucune alerte avec ces filtres')).toBeVisible();
  await sheet.getByText('Lues', { exact: true }).click();
  await expect(page).toHaveURL(/statut=lues/);
  await sheet.getByRole('button', { name: 'Voir 1 alerte' }).click();
  await expect(sheet).toBeHidden();
  await expect(alertItems(page)).toHaveCount(1);
  await list.getByRole('button', { name: /^Marquer non lue : / }).click();
  await expect(list.getByRole('button', { name: /^Marquer lue : / })).toBeVisible();

  // Filtre par token (liste) puis réinitialisation.
  await trigger.click();
  sheet = await openDialogSettled(page);
  await sheet.getByRole('button', { name: 'Réinitialiser' }).click();
  await expect(page).not.toHaveURL(/type=|statut=/);
  await sheet.getByRole('combobox', { name: 'Token' }).selectOption(WATCH_MINTS.lp);
  await expect(page).toHaveURL(new RegExp(`mint=${WATCH_MINTS.lp}`));
  await sheet.getByRole('button', { name: /^Voir 1 alerte/ }).click();
  await expect(alertItems(page)).toHaveCount(1);
  await expect(list).toContainText('Liquidité retirée');

  // Tout marquer comme lu : compteur et badge à zéro.
  await page.goto('/alertes');
  await page.getByRole('button', { name: 'Tout marquer comme lu' }).click();
  await expect(page.getByText('Toutes tes alertes sont marquées comme lues.')).toBeVisible();
  await expect(page.locator('[data-unread-count]')).toHaveText('Tout est lu.');
  await expect(shellTabBar(page).getByRole('link', { name: 'Alertes', exact: true })).toBeVisible();
  expect((await api(proApi, 'GET', '/alerts/unread-count')).body['unread']).toBe(0);
});

test('Alertes : ?alerte=<id> (clic sur une notification) met l’alerte en évidence, focalisée et marquée lue', async ({ page }) => {
  const id = alertIds['lp_removed'] as string;
  expect(id).toBeDefined();
  expect((await api(proApi, 'POST', '/alerts/read', { ids: [id], read: false })).status).toBe(200);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, pro);
  await page.goto(`/alertes?alerte=${id}`);
  const article = page.locator(`article[aria-labelledby="rj-alert-${id}"]`);
  await expect(article).toBeFocused();
  await expect(article).toBeInViewport();
  await expect(article).not.toHaveAttribute('data-unread', 'true');
  await expect.poll(async () => (await api(proApi, 'GET', '/alerts/unread-count')).body['unread']).toBe(0);
  // Panneau de filtres latéral dès 1024 px (pas de bouton « Filtres »).
  await expect(page.getByRole('complementary', { name: 'Filtres' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Filtres/ })).toBeHidden();
});

test('e-mail d’alerte (Mailpit) : Rai en PNG avec alt, lien vers l’analyse, lien des préférences qui défile vers la carte', async ({ page }) => {
  const M = WATCH_MINTS.reactivated;
  // Objet : « Alerte Danger : … » (une alerte) ou « N alertes sur tes tokens suivis (…) » (groupé).
  const mail = await waitForMailHtml(free.email, ALERT_SUBJECT);
  expect(mail.html).toContain('/email/rai-alerte@2x.png');
  expect(mail.html).toContain('alt="Rai, la mascotte de Raijin, en alerte"');
  expect(mail.html).toContain(`/analyse/${M}`);
  expect(mail.html).toContain('/compte?section=notifications');
  expect(mail.html).toContain('pas un conseil en investissement');
  // Sans doublon, même après un rejeu de l'envoi. Les deux alertes du compte (mint réactivé : passe rapide ; verdict
  // dégradé : passe complète) naissent de deux jobs successifs : selon la durée de la passe complète, elles tombent
  // dans la même fenêtre de regroupement (ALERT_EMAIL_BATCH_DELAY_S=1, un e-mail groupé) ou dans deux (deux e-mails).
  // Le test vérifie donc l'absence de doublon (au plus un e-mail par alerte, aucun e-mail de plus après le rejeu),
  // pas un nombre d'e-mails qui dépend de la vitesse du runner.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const before = await mailsFor(free.email, ALERT_SUBJECT);
  expect(before.length, 'au plus un e-mail par alerte (mint réactivé, verdict dégradé)').toBeLessThanOrEqual(2);
  expect(new Set(before.map((m) => m.Subject)).size, 'aucun e-mail en double').toBe(before.length);
  await runJob(internal, 'alert-email');
  // Laisse passer la fenêtre de regroupement avant de recompter.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(await mailsFor(free.email, ALERT_SUBJECT), 'aucun nouvel e-mail après le rejeu de l’envoi').toHaveLength(before.length);

  // Rendu : image de Rai chargée (servie par le front sur APP_URL/email/), captures 390 et 1440.
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(`${APP_ORIGIN}/analyse`);
    await page.setContent(mail.html, { waitUntil: 'load' });
    const rai = page.getByRole('img', { name: 'Rai, la mascotte de Raijin, en alerte' });
    await expect(rai).toBeVisible();
    expect(await rai.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(240);
    await page.screenshot({ path: join(SHOTS, `email-alerte-${width}.png`), fullPage: true });
  }

  // Lien d'analyse et lien des préférences, ouverts sur le serveur de test.
  const links = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));
  const analysis = links.find((href) => href.includes(`/analyse/${M}`));
  const prefs = links.find((href) => href.includes('/compte?section=notifications'));
  expect(analysis, links.join('\n')).toBeDefined();
  expect(prefs, links.join('\n')).toBeDefined();
  expect(new URL(analysis as string).origin).toBe(APP_ORIGIN);

  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, free);
  const url = new URL(prefs as string);
  await page.goto(`${url.pathname}${url.search}`);
  await expect(page.locator('#rj-notifications-title')).toBeFocused();
  await expect(page.locator('#notifications')).toBeInViewport();
});

test('404 : page introuvable avec Rai et retour vers l’analyse', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/cette-page-n-existe-pas');
  await expect(page.getByRole('heading', { level: 1, name: 'Cette page n’existe pas' })).toBeVisible();
  await expect(page).toHaveTitle('Page introuvable — Raijin');
  await expect(page.getByText('Erreur 404')).toBeVisible();
  await page.getByRole('link', { name: 'Analyser un token' }).click();
  await expect(page).toHaveURL(/\/analyse$/);
});

test('maintenance : 503 MAINTENANCE de l’API → /maintenance, « Réessayer » revient sur l’écran demandé', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, free);
  let maintenance = true;
  await page.route('**/api/v1/watches*', (route) =>
    maintenance
      ? route.fulfill({ status: 503, json: { code: 'MAINTENANCE', message: 'Raijin est en maintenance. Réessaie dans quelques minutes.' } })
      : route.continue(),
  );
  await page.goto('/suivis');
  await expect(page).toHaveURL(/\/maintenance/);
  await expect(page.getByRole('heading', { level: 1, name: 'Raijin fait une courte pause' })).toBeVisible();
  await expect(page).toHaveTitle('Maintenance — Raijin');
  maintenance = false;
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(page).toHaveURL(/\/suivis$/);
  await expect(page.locator('main h1').first()).toHaveText('Suivis');
});

test('maintenance-static.html (page d’erreur du proxy) : sans JavaScript, styles et Rai chargés', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    const failed: string[] = [];
    page.on('response', (res) => {
      if (res.status() >= 400) failed.push(`${res.status()} ${res.url()}`);
    });
    const res = await page.goto(`${PROD_ORIGIN}/maintenance-static.html`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Raijin fait une courte pause' })).toBeVisible();
    await expect(page.locator('script')).toHaveCount(0);
    expect(await page.evaluate(() => (document.querySelector('main img') as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    // Feuille de styles chargée : fond du thème Nuit (--color-base) et bouton ≥ 44 px.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(7, 9, 13)');
    const button = page.getByRole('link', { name: 'Réessayer' });
    await expect(button).toHaveAttribute('href', '/analyse');
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(failed).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
});

/**
 * Placé en dernier (fichier en série : un échec ne bloque pas les autres étapes). Le scénario
 * `watch-holder-sold` est rejoué dans l'étape des passes (références à l'étape 0, vente à l'étape 1).
 */
test('passe holders sur fixtures en séquence : « gros holder vendeur » détecté (holder_sold)', async () => {
  const list = await api(proApi, 'GET', `/alerts?mint=${WATCH_MINTS.holder}`);
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  const types = (list.body['items'] as { type: string }[]).map((alert) => alert.type);
  expect(types, 'alerte holder_sold pour le mint du scénario watch-holder-sold').toEqual(['holder_sold']);
});
