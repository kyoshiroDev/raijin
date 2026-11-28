import { expect, test } from '@playwright/test';

test('la racine redirige vers l’écran Analyser', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/analyse$/);
  await expect(page.locator('h1')).toHaveText('Analyser un token');
  await expect(page).toHaveTitle('Analyser — Raijin');
});

test('le manifest PWA est servi', async ({ request }) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.short_name).toBe('Raijin');
  expect(manifest.theme_color).toBe('#07090d');
});
