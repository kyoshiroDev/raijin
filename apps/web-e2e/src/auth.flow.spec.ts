import { expect as baseExpect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  AUTH_COOKIES,
  NEW_PASSWORD,
  PASSWORD,
  createVerifiedAccount,
  linkFrom,
  uniqueEmail,
  waitForMail,
  webStorageDump,
} from './support/auth';

/**
 * Parcours d'auth de bout en bout (PROMPT.md §9, docs/ARCHITECTURE.md §8) : front Angular servi par
 * `web:serve` (proxy /api → 3100) et API NestJS réelle (`api:serve`), Postgres/Redis/Mailpit du
 * projet Compose `raijin-dev` (`pnpm nx run api:dev-infra` avant de lancer la suite).
 */
test.describe.configure({ timeout: 90_000 });

/**
 * argon2id (m = 19 Mio) et l'envoi SMTP rendent les réponses d'auth plus lentes quand 3 workers
 * tournent en parallèle : 15 s au lieu des 5 s par défaut pour les assertions de ce fichier.
 */
const expect = baseExpect.configure({ timeout: 15_000 });

async function fillLogin(page: Page, email: string, password: string) {
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

async function expectAccount(page: Page, email: string) {
  await expect(page).toHaveURL(/\/compte$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Compte' })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
}

async function expectAuthCookiesSafe(context: BrowserContext) {
  const cookies = await context.cookies();
  for (const name of AUTH_COOKIES) {
    const cookie = cookies.find((c) => c.name === name);
    expect(cookie, `cookie ${name} posé`).toBeDefined();
    expect(cookie?.httpOnly, `${name} httpOnly`).toBe(true);
    expect(cookie?.sameSite, `${name} SameSite=Lax`).toBe('Lax');
  }
  expect(cookies.find((c) => c.name === 'rj_rt')?.path, 'refresh limité à /api/v1/auth').toBe('/api/v1/auth');
}

async function expectNoTokenInStorage(page: Page, context: BrowserContext) {
  const dump = (await webStorageDump(page)).join('\n');
  for (const cookie of await context.cookies()) {
    if (cookie.value.length >= 16) expect(dump, `valeur du cookie ${cookie.name} absente du stockage web`).not.toContain(cookie.value);
  }
  expect(dump, 'aucun JWT dans le stockage web').not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  expect(dump.toLowerCase(), 'aucune clé de jeton').not.toMatch(/token|jwt|refresh|csrf/);
}

test('inscription → e-mail Mailpit → vérification → connecté ; déconnexion ; connexion', async ({ page, context }) => {
  const email = uniqueEmail('inscription');
  const since = Date.now() - 1000;
  await page.goto('/compte/inscription');
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Vérifie ta boîte mail' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('status')).toContainText(email);

  const link = linkFrom(await waitForMail(email, 'Confirme ton adresse', since), '/compte/verifier-email');
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Adresse confirmée' })).toBeVisible();
  // Le jeton est retiré de la barre d'adresse après usage.
  await expect(page).not.toHaveURL(/token=/);
  await page.getByRole('link', { name: 'Voir mon compte' }).click();
  await expectAccount(page, email);
  await expect(page.getByText('Confirmée', { exact: true })).toBeVisible();

  await expectAuthCookiesSafe(context);
  await expectNoTokenInStorage(page, context);

  // Déconnexion : retour à la connexion, /compte n'est plus accessible.
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/compte\/connexion/);
  await page.goto('/compte');
  await expect(page).toHaveURL(/\/compte\/connexion\?redirect=%2Fcompte/);
  expect((await context.cookies()).map((c) => c.name)).not.toContain('rj_rt');

  // Connexion par mot de passe.
  await fillLogin(page, email, PASSWORD);
  await expectAccount(page, email);
  await expectAuthCookiesSafe(context);
  await expectNoTokenInStorage(page, context);
});

test('mauvais mot de passe : message d’erreur annoncé, pas de connexion', async ({ browser }) => {
  const setup = await browser.newContext();
  const { email } = await createVerifiedAccount(setup, 'mauvais-mdp');
  await setup.close();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/compte/connexion');
  await fillLogin(page, email, 'ce n’est pas le bon mot de passe');
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('E-mail ou mot de passe incorrect.');
  await expect(page).toHaveURL(/\/compte\/connexion/);
  expect((await context.cookies()).map((c) => c.name)).not.toContain('rj_rt');

  // Compte inexistant : même message (pas d'énumération).
  await page.getByLabel('Adresse e-mail').fill(uniqueEmail('inconnu'));
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('alert')).toContainText('E-mail ou mot de passe incorrect.');
  await context.close();
});

test('mot de passe oublié → e-mail → réinitialisation → ancienne session révoquée', async ({ browser }) => {
  // Session A : connectée avec l'ancien mot de passe.
  const contextA = await browser.newContext();
  const { email } = await createVerifiedAccount(contextA, 'reset');
  const pageA = await contextA.newPage();
  await pageA.goto('/compte');
  await expectAccount(pageA, email);

  // Appareil B : demande de réinitialisation.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  const since = Date.now() - 1000;
  await pageB.goto('/compte/connexion');
  await pageB.getByRole('link', { name: /Mot de passe oublié/ }).click();
  await expect(pageB).toHaveURL(/\/compte\/mot-de-passe-oublie/);
  await pageB.getByLabel('Adresse e-mail').fill(email);
  await pageB.getByRole('button', { name: 'Envoyer le lien' }).click();
  await expect(pageB.getByRole('heading', { level: 1, name: 'Vérifie ta boîte mail' })).toBeVisible();

  const link = linkFrom(await waitForMail(email, 'Réinitialise', since), '/compte/reinitialiser-mot-de-passe');
  await pageB.goto(link);
  await expect(pageB).not.toHaveURL(/token=/);
  await pageB.getByLabel('Nouveau mot de passe').fill(NEW_PASSWORD);
  await pageB.getByRole('button', { name: 'Enregistrer le mot de passe' }).click();
  await expect(pageB.getByRole('heading', { name: 'Mot de passe modifié' })).toBeVisible();
  await waitForMail(email, 'mot de passe a changé', since);

  // Session A révoquée : au rechargement, retour à la connexion.
  await pageA.reload();
  await expect(pageA).toHaveURL(/\/compte\/connexion/);

  // L'ancien mot de passe est refusé, le nouveau fonctionne.
  await pageB.getByRole('link', { name: 'Se connecter' }).click();
  await fillLogin(pageB, email, PASSWORD);
  await expect(pageB.getByRole('alert')).toContainText('E-mail ou mot de passe incorrect.');
  await pageB.getByLabel('Mot de passe', { exact: true }).fill(NEW_PASSWORD);
  await pageB.getByRole('button', { name: 'Se connecter' }).click();
  await expectAccount(pageB, email);

  // Le lien de réinitialisation ne sert qu'une fois.
  await pageB.goto(link);
  await pageB.getByLabel('Nouveau mot de passe').fill('troisieme phrase de passe');
  await pageB.getByRole('button', { name: 'Enregistrer le mot de passe' }).click();
  await expect(pageB.getByRole('heading', { name: 'Lien expiré ou déjà utilisé' })).toBeVisible();
  await contextA.close();
  await contextB.close();
});

test('lien magique : demande → e-mail → connecté', async ({ browser }) => {
  const setup = await browser.newContext();
  const { email } = await createVerifiedAccount(setup, 'magique');
  await setup.close();

  const context = await browser.newContext();
  const page = await context.newPage();
  const since = Date.now() - 1000;
  await page.goto('/compte/connexion');
  await page.getByRole('link', { name: 'Recevoir un lien de connexion' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Connexion sans mot de passe' })).toBeVisible();
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByRole('button', { name: 'Recevoir le lien' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Vérifie ta boîte mail' })).toBeVisible();

  const link = linkFrom(await waitForMail(email, 'lien de connexion', since), '/compte/lien-magique');
  await page.goto(link);
  await expectAccount(page, email);
  await expectAuthCookiesSafe(context);
  await expectNoTokenInStorage(page, context);

  // Usage unique : le même lien, rouvert après déconnexion, est refusé.
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/compte\/connexion/);
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Connexion impossible' })).toBeVisible();
  await context.close();
});

/**
 * Expiration réelle du JWT (aucune falsification de cookie) : l'API de test est lancée avec
 * JWT_ACCESS_TTL=20s (webServer de playwright.config.mts). Le cookie d'access reste présent
 * (il vit aussi longtemps que la session, §8.4) : l'API répond 401 AUTH_SESSION_EXPIRED.
 * Renvoie le refresh token courant, une fois le JWT expiré.
 */
async function loginAndWaitForExpiry(page: Page, context: BrowserContext, prefix: string) {
  const { email } = await createVerifiedAccount(context, prefix);
  const sessionRes = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/session'));
  await page.goto('/compte');
  const session = (await (await sessionRes).json()) as { accessTokenExpiresAt: string };
  await expectAccount(page, email);
  const waitMs = Date.parse(session.accessTokenExpiresAt) - Date.now() + 1500;
  expect(
    waitMs,
    'access token trop long pour ce test : lancer l’API avec JWT_ACCESS_TTL=20s (voir playwright.config.mts)',
  ).toBeLessThan(45_000);
  // Attente de l'heure serveur (expiration du JWT), pas d'un état de l'interface.
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return { email, refreshToken: (await context.cookies()).find((c) => c.name === 'rj_rt')?.value };
}

test('access token expiré : refresh transparent au chargement de l’app', async ({ page, context }) => {
  const { email, refreshToken } = await loginAndWaitForExpiry(page, context, 'refresh-chargement');
  const refresh = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/refresh'));
  await page.reload();
  expect((await refresh).status(), 'POST /auth/refresh au chargement').toBe(200);
  await expectAccount(page, email);
  const after = (await context.cookies()).find((c) => c.name === 'rj_rt')?.value;
  expect(after, 'refresh token renouvelé (rotation)').not.toBe(refreshToken);
  await expectAuthCookiesSafe(context);
  await expectNoTokenInStorage(page, context);
});

test('access token expiré : refresh transparent pendant une action (export)', async ({ page, context }) => {
  await loginAndWaitForExpiry(page, context, 'refresh-action');
  const refresh = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/refresh'), { timeout: 15_000 });
  const download = page.waitForEvent('download', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Exporter' }).click();
  expect((await refresh).status(), 'POST /auth/refresh après le 401 AUTH_SESSION_EXPIRED de l’export').toBe(200);
  await download;
  await expect(page.getByText('Connecte-toi pour continuer.')).toHaveCount(0);
});

test('cookie d’access supprimé : session considérée comme fermée, retour à la connexion', async ({ page, context }) => {
  // Choix documenté (auth.guard.ts, interceptors.ts) : sans cookie d'access, 401 UNAUTHORIZED, pas de refresh.
  const { email } = await createVerifiedAccount(context, 'sans-access');
  await page.goto('/compte');
  await expectAccount(page, email);
  await context.clearCookies({ name: 'rj_at' });
  await page.reload();
  await expect(page).toHaveURL(/\/compte\/connexion\?redirect=%2Fcompte/);
});

test('export des données : fichier JSON contenant le compte', async ({ page, context }) => {
  const { email } = await createVerifiedAccount(context, 'export');
  await page.goto('/compte');
  await expectAccount(page, email);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exporter' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const file = await download.path();
  const data = JSON.parse(await readFile(file, 'utf8')) as unknown;
  expect(JSON.stringify(data)).toContain(email);
  // Aucun secret dans l'export.
  expect(JSON.stringify(data)).not.toMatch(/passwordHash|argon2|tokenHash/i);
});

test('suppression du compte : confirmation par mot de passe, sessions fermées, connexion impossible', async ({ page, context }) => {
  const { email } = await createVerifiedAccount(context, 'suppression');
  await page.goto('/compte');
  await expectAccount(page, email);
  await page.getByRole('button', { name: 'Supprimer le compte' }).click();
  const dialog = page.getByRole('dialog', { name: 'Supprimer ton compte' });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Supprimer définitivement' });
  await expect(confirm).toBeDisabled();

  // Mauvais mot de passe : refus annoncé, compte conservé.
  await dialog.getByLabel('Ton mot de passe, pour confirmer').fill('mot de passe erroné ici');
  await confirm.click();
  const field = dialog.getByLabel('Ton mot de passe, pour confirmer');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(/Mot de passe incorrect/);
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Ton mot de passe, pour confirmer').fill(PASSWORD);
  await confirm.click();
  await expect(page).toHaveURL(/\/analyse/);
  expect((await context.cookies()).map((c) => c.name)).not.toContain('rj_rt');

  await page.goto('/compte/connexion');
  await fillLogin(page, email, PASSWORD);
  await expect(page.getByRole('alert')).toContainText('E-mail ou mot de passe incorrect.');
});

for (const target of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
  test(`redirection après connexion : ?redirect=${target} refusée`, async ({ browser }) => {
    const setup = await browser.newContext();
    const { email } = await createVerifiedAccount(setup, 'redirect');
    await setup.close();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/compte/connexion?redirect=${encodeURIComponent(target)}`);
    await fillLogin(page, email, PASSWORD);
    await expectAccount(page, email);
    expect(new URL(page.url()).host).toBe(new URL(test.info().project.use.baseURL ?? 'http://localhost:4200').host);
    await context.close();
  });
}

test('redirection après connexion : chemin interne accepté', async ({ browser }) => {
  const setup = await browser.newContext();
  const { email } = await createVerifiedAccount(setup, 'redirect-ok');
  await setup.close();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/compte');
  await expect(page).toHaveURL(/redirect=%2Fcompte/);
  await page.goto('/compte/connexion?redirect=%2Fsuivis');
  await fillLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/suivis$/);
  await context.close();
});
