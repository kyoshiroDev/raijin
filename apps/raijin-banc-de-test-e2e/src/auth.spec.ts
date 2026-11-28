import { expect, test } from '@playwright/test';
import { FRONT_ORIGIN, OWNER_EMAIL, OWNER_PASSWORD, apiLogin, fillLogin, readOwnerState } from './support/bench';

/** Parcours sans session enregistrée (le projet « chromium » charge celle de auth.setup.ts sinon). */
test.describe('auth du banc (sans session)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('toute route de données répond 401 sans session, y compris avec un cookie de Raijin', async ({ request }) => {
    for (const path of ['/api/auth/session', '/api/tokens', '/api/shadow/comparison', '/api/events', '/api/status']) {
      const response = await request.get(`${FRONT_ORIGIN}${path}`, { failOnStatusCode: false });
      expect(response.status(), path).toBe(401);
    }
    // Un cookie de l'API Raijin (même nom de jeton admin) ne vaut rien côté banc.
    const forged = await request.get(`${FRONT_ORIGIN}/api/tokens`, {
      headers: { Cookie: 'rj_at=eyJhbGciOiJIUzI1NiJ9.e30.x; rj_rt=abc; rj_csrf=abc' },
      failOnStatusCode: false,
    });
    expect(forged.status()).toBe(401);
  });

  test('refus sans second facteur : bouton inactif, API en 400, code faux en 401 générique', async ({ page, request }) => {
    await page.goto('/login');
    await page.getByLabel('E-mail').fill(OWNER_EMAIL);
    await page.getByLabel('Mot de passe', { exact: true }).fill(OWNER_PASSWORD);
    await expect(page.getByRole('button', { name: 'Se connecter' })).toBeDisabled();

    const withoutCode = await apiLogin(request, { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(withoutCode.status()).toBe(400);
    expect(withoutCode.headers()['set-cookie'] ?? '').not.toContain('rjb_session=');

    // Un seul code faux (verrouillage global à 5 échecs en 15 min) : message générique, aucun cookie de session.
    await page.locator('#code').fill('000000');
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.context().cookies()).some((cookie) => cookie.name === 'rjb_session')).toBe(false);
  });

  test('connexion par code de secours (usage unique) puis déconnexion : session révoquée côté API', async ({ page, request }) => {
    const owner = readOwnerState();
    const [recovery = ''] = owner.recoveryCodes;
    expect(recovery).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    await page.goto('/login');
    await page.getByRole('button', { name: 'Utiliser un code de secours' }).click();
    await expect(page.getByLabel('Code de secours')).toBeVisible();
    await fillLogin(page, recovery);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page).not.toHaveURL(/\/login/);

    const session = (await page.context().cookies()).find((cookie) => cookie.name === 'rjb_session');
    expect(session).toBeDefined();
    const cookieHeader = `rjb_session=${session?.value}`;
    expect((await request.get(`${FRONT_ORIGIN}/api/auth/session`, { headers: { Cookie: cookieHeader } })).status()).toBe(200);

    // Le même code de secours est refusé une seconde fois.
    const replay = await apiLogin(request, { email: OWNER_EMAIL, password: OWNER_PASSWORD, recovery_code: recovery });
    expect(replay.status()).toBe(401);

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login$/);
    const after = await request.get(`${FRONT_ORIGIN}/api/auth/session`, { headers: { Cookie: cookieHeader }, failOnStatusCode: false });
    expect(after.status()).toBe(401);
  });
});
