import { expect, test } from '@playwright/test';
import {
  DESKTOP_MIN,
  LANDSCAPES,
  MIN_TARGET,
  PAGES,
  VIEWPORTS,
  findSmallTargets,
  findTruncatedWithoutTitle,
  horizontalOverflow,
  openPage,
  shellSidebar,
  shellTabBar,
} from './support/pages';

/**
 * PROMPT.md §3 et §9.2 : pour chaque page et chaque largeur, pas de scroll horizontal,
 * cibles ≥ 44 px sous 1024 px, barre d'onglets < 1024 / sidebar ≥ 1024, pas de texte tronqué sans title.
 */
for (const { name, path } of PAGES) {
  test.describe(`responsive ${name}`, () => {
    for (const viewport of VIEWPORTS.filter((v) => v.width < DESKTOP_MIN)) {
      test(`${viewport.width}px (mobile, tablette)`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openPage(page, path);
        expect(await horizontalOverflow(page), 'pas de scroll horizontal').toBeLessThanOrEqual(0);
        await expect(shellTabBar(page), 'barre d’onglets visible sous 1024 px').toBeVisible();
        await expect(shellSidebar(page), 'sidebar masquée sous 1024 px').toBeHidden();
        expect(await findSmallTargets(page, MIN_TARGET), 'cibles interactives ≥ 44 px').toEqual([]);
        expect(await findTruncatedWithoutTitle(page), 'texte tronqué sans title').toEqual([]);
      });
    }

    for (const viewport of VIEWPORTS.filter((v) => v.width >= DESKTOP_MIN)) {
      test(`${viewport.width}px (desktop)`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openPage(page, path);
        expect(await horizontalOverflow(page), 'pas de scroll horizontal').toBeLessThanOrEqual(0);
        await expect(shellSidebar(page), 'sidebar visible dès 1024 px').toBeVisible();
        await expect(shellTabBar(page), 'barre d’onglets masquée dès 1024 px').toBeHidden();
        expect(await findTruncatedWithoutTitle(page), 'texte tronqué sans title').toEqual([]);
      });
    }

    for (const viewport of LANDSCAPES) {
      test(`paysage ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openPage(page, path);
        expect(await horizontalOverflow(page), 'pas de scroll horizontal en paysage').toBeLessThanOrEqual(0);
        await expect(shellTabBar(page)).toBeVisible();
        expect(await findSmallTargets(page, MIN_TARGET), 'cibles interactives ≥ 44 px').toEqual([]);
        // La barre d'onglets fixe ne doit pas masquer tout le contenu : le titre reste visible.
        await expect(page.locator('main h1').first()).toBeInViewport();
      });
    }
  });
}

test('sidebar repliable à 72 px et dépliée à 240 px', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPage(page, '/analyse');
  const aside = shellSidebar(page);
  await expect.poll(async () => (await aside.boundingBox())?.width).toBe(240);
  await page.getByRole('button', { name: 'Replier le menu' }).click();
  await expect.poll(async () => (await aside.boundingBox())?.width).toBe(72);
  // Repliée, chaque entrée garde une cible ≥ 44 px et un title.
  for (const link of await aside.locator('nav a').all()) {
    const box = await link.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TARGET);
    await expect(link).toHaveAttribute('title', /.+/);
  }
  await page.getByRole('button', { name: 'Déplier le menu' }).click();
  await expect.poll(async () => (await aside.boundingBox())?.width).toBe(240);
});

test('la barre d’onglets affiche 4 entrées maximum avec des cibles de 48 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, '/analyse');
  const links = shellTabBar(page).locator('a');
  await expect(links).toHaveCount(4);
  await expect(links).toHaveText(['Analyser', 'Suivis', 'Alertes', 'Compte']);
  for (const link of await links.all()) {
    expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(48);
  }
  await expect(links.first()).toHaveAttribute('aria-current', 'page');
});
