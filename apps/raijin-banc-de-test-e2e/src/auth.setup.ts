import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_DIR, SCREENSHOT_DIR, STORAGE_STATE_FILE, fillLogin, freshTotp, readOwnerState } from './support/bench';

test('connexion mot de passe + TOTP : session ouverte, cookies httpOnly du banc', async ({ page, context }) => {
  mkdirSync(E2E_DIR, { recursive: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const owner = readOwnerState();

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Se connecter' })).toBeDisabled();
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'connexion-1280.png'), fullPage: true });

  const { code } = await freshTotp(owner.secretBase32, owner.enrolledStep);
  await fillLogin(page, code);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === 'rjb_session');
  expect(session, 'cookie de session du banc').toBeDefined();
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Strict');
  expect(cookies.some((cookie) => cookie.name.startsWith('rj_'))).toBe(false);
  // Rien de la session en stockage web (jeton httpOnly uniquement).
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain(session?.value ?? '<absent>');

  await context.storageState({ path: STORAGE_STATE_FILE });
});
