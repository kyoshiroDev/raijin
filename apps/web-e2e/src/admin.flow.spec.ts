import { expect, request, test, type Page } from '@playwright/test';
import { APP_ORIGIN, createVerifiedAccount, loginViaApi } from './support/auth';
import {
  ADMIN_LABELS,
  ADMIN_SCREENS,
  TotpClock,
  adminNav,
  adminSidebar,
  fillEnrollmentPassword,
  ageAdminSession,
  newAdminAccount,
  sql,
  typeTotp,
} from './support/admin';
import { adminScreenReady } from './support/admin-pages';
import { api } from './support/watch';

/**
 * Espace admin de bout en bout (phase 6 bis, PROMPT.md §4.7, docs/ARCHITECTURE.md §14), API réelle :
 * visiteur → connexion ; compte non admin → page 404 standard à la même URL ; admin promu par la CLI → activation de la
 * 2FA dans l'interface (QR, clé manuelle, codes de secours montrés une fois) → 9 écrans (KPI, graphiques avec tableau,
 * Google simulé ou « Non connecté », décalage Search Console) → utilisateurs (recherche, fiche, Pro offert audité,
 * suspension effective) → expiration de la session admin (code redemandé, session de l'app conservée) → code de
 * secours à usage unique.
 */

const DESKTOP = { width: 1440, height: 900 };

async function openScreen(page: Page, label: string, path: string, title: string): Promise<void> {
  const url = new RegExp(`${path.replace(/\//g, '\\/')}(\\?.*)?$`);
  // Écran précédent encore en rendu (graphiques Chart.js) sur une machine chargée : clic rejoué jusqu'à la navigation.
  await expect(async () => {
    await adminNav(page).getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(url, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.locator('main h1').first()).toHaveText(title);
  await adminScreenReady(page);
}

/** Ouvre la fiche d'un compte depuis la recherche par e-mail. */
async function openUserDetail(page: Page, email: string) {
  await page.getByLabel('Recherche par e-mail').fill(email);
  await page.getByRole('button', { name: 'Chercher' }).click();
  await page.getByRole('link', { name: email }).click();
  const detail = page.getByRole('dialog', { name: email });
  await expect(detail.getByRole('heading', { name: 'Actions' })).toBeVisible({ timeout: 15_000 });
  return detail;
}

test.describe('espace admin', () => {
  test('visiteur : /admin renvoie vers la connexion, avec retour', async ({ page }) => {
    await page.goto('/admin/utilisateurs');
    await expect(page).toHaveURL(/\/compte\/connexion\?redirect=%2Fadmin%2Futilisateurs$/);
    await expect(page.locator('main h1').first()).toHaveText('Connexion');
  });

  test('compte non admin : page 404 standard à la même URL, aucun appel admin servi', async ({ page }) => {
    await createVerifiedAccount(page.context(), 'non-admin');
    const adminCalls: number[] = [];
    page.on('response', (res) => {
      if (new URL(res.url()).pathname.startsWith('/api/v1/admin/')) adminCalls.push(res.status());
    });
    for (const path of ['/admin', '/admin/utilisateurs', '/admin/securite/activation']) {
      await page.goto(path);
      await expect(page.locator('main h1').first()).toHaveText('Cette page n’existe pas');
      expect(new URL(page.url()).pathname, 'URL conservée').toBe(path);
    }
    // canMatch : le chunk admin n'est pas chargé, aucun appel admin/* n'aboutit.
    expect(adminCalls.filter((status) => status < 400)).toEqual([]);
  });

  test('admin : 2FA, 9 écrans, actions auditées, suspension, expiration et code de secours', async ({ page, browser }) => {
    test.setTimeout(300_000);
    await page.setViewportSize(DESKTOP);
    const admin = await newAdminAccount('parcours-admin');
    await loginViaApi(page.context().request, admin.email, admin.password);
    let clock!: TotpClock;
    let codes: string[] = [];

    await test.step('activation de la 2FA : QR, clé manuelle, code', async () => {
      const enrollment = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/admin/security/enrollment');
      await page.goto('/admin');
      await expect(page).toHaveURL(/\/admin\/securite\/activation$/);
      const started = await enrollment;
      expect(started.status()).toBe(201);
      const secret = String(((await started.json()) as { secret: string }).secret);
      expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
      clock = new TotpClock(secret);
      await expect(page.locator('main h1').first()).toHaveText('Active la double authentification');
      const qr = page.getByRole('img', { name: 'QR code à scanner avec ton application d’authentification' });
      await expect(qr).toBeVisible();
      await expect(qr).toHaveAttribute('src', /^data:image\/svg\+xml/);
      // Clé lisible (groupes de 4) et annoncée en entier aux lecteurs d'écran.
      expect(((await page.locator('p.select-all').textContent()) ?? '').replace(/\s+/g, '')).toBe(secret);
      await expect(page.getByText(`Clé secrète : ${secret}`)).toBeAttached();
      await expect(page.getByRole('button', { name: 'Copier la clé' })).toBeVisible();
      // Un code faux est refusé sans quitter l'écran.
      await fillEnrollmentPassword(page, admin.password);
      await typeTotp(page, '000000');
      await expect(page.getByText(ADMIN_LABELS.invalidCode)).toBeVisible({ timeout: 15_000 });
      await fillEnrollmentPassword(page, admin.password);
      await typeTotp(page, await clock.next());
      await expect(page).toHaveURL(/\/admin\/securite\/codes-de-secours$/, { timeout: 15_000 });
    });

    await test.step('codes de secours montrés une seule fois', async () => {
      await expect(page.locator('main h1').first()).toHaveText('Range tes codes de secours');
      const items = page.getByRole('list', { name: 'Codes de secours' }).locator('li span.font-mono');
      await expect(items).toHaveCount(10);
      codes = (await items.allTextContents()).map((code) => code.trim());
      for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
      expect(new Set(codes).size).toBe(10);
      const open = page.getByRole('button', { name: 'Ouvrir l’espace admin' });
      await expect(open).toBeDisabled();
      await page.getByText('J’ai rangé mes codes en lieu sûr').click();
      await open.click();
      await expect(page).toHaveURL(/\/admin$/);
      await expect(page.locator('main h1').first()).toHaveText('Vue d’ensemble');
      // Rechargement de l'écran des codes : plus jamais affichés.
      await page.goto('/admin/securite/codes-de-secours');
      await expect(page.getByText('Les codes de secours ont déjà été affichés')).toBeVisible();
      await expect(page.getByRole('list', { name: 'Codes de secours' })).toHaveCount(0);
      for (const code of codes) await expect(page.getByText(code)).toHaveCount(0);
      await page.goto('/admin');
      await adminScreenReady(page);
    });

    await test.step('9 écrans : KPI, graphiques avec tableau, Google simulé, décalage Search Console', async () => {
      await expect(adminSidebar(page)).toBeVisible();
      await expect(adminNav(page).getByRole('link')).toHaveText(ADMIN_SCREENS.map((s) => s.label));
      for (const screen of ADMIN_SCREENS) {
        await openScreen(page, screen.label, screen.path, screen.title);
        await expect(adminNav(page).getByRole('link', { name: screen.label, exact: true })).toHaveAttribute('aria-current', 'page');
      }
      await openScreen(page, 'Vue d’ensemble', '/admin', 'Vue d’ensemble');
      expect(await page.locator('rj-kpi-card').count(), 'cartes KPI').toBeGreaterThanOrEqual(4);
      const chart = page.locator('rj-chart').first();
      await expect(chart.locator('canvas[role="img"]')).toHaveAttribute('aria-label', /.+/);
      const toggle = chart.getByRole('button', { name: 'Voir les données' });
      await toggle.click();
      await expect(chart.getByRole('button', { name: 'Masquer les données' })).toHaveAttribute('aria-expanded', 'true');
      await expect(chart.locator('table')).toBeVisible();
      expect(await chart.locator('table tbody tr').count(), 'lignes du tableau alternatif').toBeGreaterThan(0);

      await openScreen(page, 'Trafic', '/admin/trafic', 'Trafic');
      await expect(page.getByText('Données simulées').first()).toBeVisible();
      await openScreen(page, 'SEO', '/admin/seo', 'SEO');
      await expect(page.getByText(/publie ses chiffres avec \d+ jours de décalage environ/)).toBeVisible();
      await expect(page.getByText('Données simulées').first()).toBeVisible();

      // GA4 non relié : réponse réelle (route du contexte : vaut aussi derrière le service worker du build de prod) dont l'état Google est remplacé par `not_connected` (contrat googleReportSchema).
      await page.context().route('**/api/v1/admin/traffic**', async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, service: { status: 'not_connected' }, data: null } });
      });
      await page.goto('/admin/trafic');
      await expect(page.locator('main h1').first()).toHaveText('Trafic');
      await expect(page.getByText(ADMIN_LABELS.notConnected).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Données simulées')).toHaveCount(0);
      await page.context().unroute('**/api/v1/admin/traffic**');
    });

    const ctx = await request.newContext({ baseURL: APP_ORIGIN, extraHTTPHeaders: { 'X-Forwarded-For': `10.252.${Math.floor(Math.random() * 250)}.7` } });
    try {
      await test.step('utilisateurs : recherche, fiche, « Offrir un mois de Pro » confirmé puis audité', async () => {
        const target = await createVerifiedAccount(ctx, 'cible-gift');
        await openScreen(page, 'Utilisateurs', '/admin/utilisateurs', 'Utilisateurs');
        const detail = await openUserDetail(page, target.email);
        await detail.getByRole('button', { name: ADMIN_LABELS.grantProMonth }).click();
        const sheet = page.getByRole('dialog', { name: ADMIN_LABELS.grantProMonth });
        const confirm = sheet.getByRole('button', { name: 'Confirmer' });
        await expect(confirm).toBeDisabled();
        await sheet.getByLabel('Motif (journalisé)').fill('Bêta-testeur e2e');
        await confirm.click();
        await expect(page.getByText(`${ADMIN_LABELS.grantProMonth} : fait et journalisé.`)).toBeVisible({ timeout: 15_000 });
        await expect(sheet).toBeHidden();
        await expect(detail.getByText('Pro (Pro offert)')).toBeVisible();
        await expect(detail.getByText(ADMIN_LABELS.auditProMonth, { exact: true })).toBeVisible();
        await expect(detail.getByText(/motif : Bêta-testeur e2e/)).toBeVisible();
        const audit = await sql<{ actorEmail: string }>(
          `SELECT a."email" AS "actorEmail" FROM "AuditLog" l JOIN "User" a ON a."id" = l."actorId" JOIN "User" t ON t."id" = l."userId"
           WHERE t."email" = $1 AND l."action" = 'admin.pro_month_granted'`,
          [target.email],
        );
        expect(audit.map((row) => row.actorEmail)).toEqual([admin.email]);
        await page.keyboard.press('Escape');
        await expect(detail).toBeHidden();
      });

      await test.step('suspension : e-mail recopié, puis connexion refusée au compte suspendu', async () => {
        const target = await createVerifiedAccount(ctx, 'cible-suspension');
        const detail = await openUserDetail(page, target.email);
        await detail.getByRole('button', { name: ADMIN_LABELS.suspend }).click();
        const sheet = page.getByRole('dialog', { name: ADMIN_LABELS.suspend });
        const confirm = sheet.getByRole('button', { name: 'Confirmer' });
        await sheet.getByLabel('Motif (journalisé)').fill('Abus e2e');
        await sheet.getByLabel('Recopie l’e-mail du compte pour confirmer').fill('autre@exemple.fr');
        await expect(confirm, 'e-mail différent : confirmation impossible').toBeDisabled();
        await sheet.getByLabel('Recopie l’e-mail du compte pour confirmer').fill(target.email);
        await confirm.click();
        await expect(page.getByText(`${ADMIN_LABELS.suspend} : fait et journalisé.`)).toBeVisible({ timeout: 15_000 });
        await expect(detail.getByText(/Compte suspendu depuis le/)).toBeVisible();
        await expect(detail.getByText(ADMIN_LABELS.auditSuspended, { exact: true })).toBeVisible();
        // Sessions du compte coupées.
        expect((await api(ctx, 'GET', '/users/me')).status).toBe(401);
        // Nouvelle connexion dans l'interface : refusée avec le message dédié.
        const other = await browser.newContext({ baseURL: APP_ORIGIN });
        try {
          const visitor = await other.newPage();
          await visitor.goto('/compte/connexion');
          await visitor.getByLabel('Adresse e-mail').fill(target.email);
          await visitor.getByLabel('Mot de passe', { exact: true }).fill(target.password);
          await visitor.getByRole('button', { name: 'Se connecter' }).click();
          await expect(visitor.getByText(ADMIN_LABELS.suspended)).toBeVisible({ timeout: 15_000 });
          await expect(visitor).toHaveURL(/\/compte\/connexion/);
        } finally {
          await other.close();
        }
        await page.keyboard.press('Escape');
        await expect(detail).toBeHidden();
      });
    } finally {
      await ctx.dispose();
    }

    await test.step('inactivité de 30 min : code redemandé, session de l’app conservée', async () => {
      await ageAdminSession(page.context().request, 31);
      await adminNav(page).getByRole('link', { name: 'Produit', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/securite\/code\?/, { timeout: 15_000 });
      await expect(page.locator('main h1').first()).toHaveText('Session admin expirée');
      // 403 ADMIN_SESSION_EXPIRED, jamais 401 : l'utilisateur reste connecté à l'app.
      expect((await api(page.context().request, 'GET', '/users/me')).status).toBe(200);
      await typeTotp(page, await clock.next());
      await expect(page).toHaveURL(/\/admin\/produit$/, { timeout: 15_000 });
      await expect(page.locator('main h1').first()).toHaveText('Produit');
      await adminScreenReady(page);
    });

    await test.step('code de secours : accepté une fois, refusé au second usage', async () => {
      const useRecovery = async (code: string) => {
        await page.getByRole('button', { name: 'Je n’ai pas mon téléphone : utiliser un code de secours' }).click();
        await page.getByLabel('Code de secours').fill(code);
        await page.getByRole('button', { name: 'Ouvrir l’espace admin' }).click();
      };
      await ageAdminSession(page.context().request, 31);
      await adminNav(page).getByRole('link', { name: 'Santé', exact: true }).click();
      await expect(page.locator('main h1').first()).toHaveText('Session admin expirée', { timeout: 15_000 });
      await useRecovery(codes[0] ?? '');
      await expect(page).toHaveURL(/\/admin\/sante$/, { timeout: 15_000 });

      await ageAdminSession(page.context().request, 31);
      await adminNav(page).getByRole('link', { name: 'Essais', exact: true }).click();
      await expect(page.locator('main h1').first()).toHaveText('Session admin expirée', { timeout: 15_000 });
      await useRecovery(codes[0] ?? '');
      await expect(page.getByText(ADMIN_LABELS.invalidCode)).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(/\/admin\/securite\/code/);
      await page.getByLabel('Code de secours').fill(codes[1] ?? '');
      await page.getByRole('button', { name: 'Ouvrir l’espace admin' }).click();
      await expect(page).toHaveURL(/\/admin\/essais$/, { timeout: 15_000 });
      await expect(page.locator('main h1').first()).toHaveText('Essais Pro');
      const used = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM "AuditLog" l JOIN "User" u ON u."id" = l."actorId" WHERE u."email" = $1 AND l."action" = 'admin.recovery_code_used'`,
        [admin.email],
      );
      expect(used[0]?.n).toBe('2');
    });
  });
});
