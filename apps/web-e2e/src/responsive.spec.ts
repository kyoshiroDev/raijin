import { expect, test, type Page } from '@playwright/test';
import {
  DESKTOP_MIN,
  LANDSCAPES,
  MIN_TARGET,
  PAGES,
  openEntry,
  VIEWPORTS,
  findSmallTargets,
  findTruncatedWithoutTitle,
  horizontalOverflow,
  openPage,
  shellSidebar,
  shellTabBar,
} from './support/pages';
import { SHELLLESS_PAGES } from './support/admin-pages';
import { adminSidebar, adminTopBar } from './support/admin';

/**
 * PROMPT.md §3 et §9.2 : pour chaque page et chaque largeur, pas de scroll horizontal,
 * cibles ≥ 44 px sous 1024 px, barre d'onglets < 1024 / sidebar ≥ 1024, pas de texte tronqué sans title.
 */
for (const entry of PAGES) {
  const { name } = entry;
  test.describe(`responsive ${name}`, () => {
    for (const viewport of VIEWPORTS.filter((v) => v.width < DESKTOP_MIN)) {
      test(`${viewport.width}px (mobile, tablette)`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openEntry(page, entry);
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
        await openEntry(page, entry);
        expect(await horizontalOverflow(page), 'pas de scroll horizontal').toBeLessThanOrEqual(0);
        await expect(shellSidebar(page), 'sidebar visible dès 1024 px').toBeVisible();
        await expect(shellTabBar(page), 'barre d’onglets masquée dès 1024 px').toBeHidden();
        expect(await findTruncatedWithoutTitle(page), 'texte tronqué sans title').toEqual([]);
      });
    }

    for (const viewport of LANDSCAPES) {
      test(`paysage ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openEntry(page, entry);
        expect(await horizontalOverflow(page), 'pas de scroll horizontal en paysage').toBeLessThanOrEqual(0);
        await expect(shellTabBar(page)).toBeVisible();
        expect(await findSmallTargets(page, MIN_TARGET), 'cibles interactives ≥ 44 px').toEqual([]);
        // La barre d'onglets fixe ne doit pas masquer tout le contenu : le titre (ou l'élément ciblé) reste visible.
        await expect(page.locator(entry.landmark ?? 'main h1').first()).toBeInViewport();
      });
    }
  });
}

/**
 * Phase 6 bis : écrans sans la coque de l'app (9 écrans admin, 2FA, landing). Mêmes règles (pas de scroll horizontal,
 * cibles ≥ 44 px sous 1024 px, pas de texte tronqué sans title) ; navigation propre à l'admin : barre latérale dès
 * 1024 px, barre du haut (menu + pastilles des écrans) en dessous. Écrans 2FA et landing : aucune barre de l'app.
 */
/** Navigation attendue selon la largeur (choisie hors du test : aucune condition dans son corps). */
async function noAdminNav(): Promise<void> {
  // Écrans 2FA et landing : aucune navigation propre.
}
async function adminDesktopNav(page: Page): Promise<void> {
  await expect(adminSidebar(page), 'barre latérale admin dès 1024 px').toBeVisible();
  await expect(adminTopBar(page), 'barre du haut admin masquée dès 1024 px').toBeHidden();
}
async function adminMobileNav(page: Page): Promise<void> {
  await expect(adminTopBar(page), 'barre du haut admin sous 1024 px').toBeVisible();
  await expect(adminSidebar(page), 'barre latérale admin masquée sous 1024 px').toBeHidden();
  await expect(adminTopBar(page).getByRole('button', { name: 'Menu' })).toBeVisible();
}

for (const entry of SHELLLESS_PAGES) {
  test.describe(`responsive ${entry.name}`, () => {
    for (const viewport of VIEWPORTS.filter((v) => v.width < DESKTOP_MIN)) {
      const navCheck = entry.nav === 'admin' ? adminMobileNav : noAdminNav;
      test(`${viewport.width}px (mobile, tablette)`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openEntry(page, entry);
        expect(await horizontalOverflow(page), 'pas de scroll horizontal').toBeLessThanOrEqual(0);
        expect(await findSmallTargets(page, MIN_TARGET), 'cibles interactives ≥ 44 px').toEqual([]);
        expect(await findTruncatedWithoutTitle(page), 'texte tronqué sans title').toEqual([]);
        await expect(shellTabBar(page), 'pas de barre d’onglets de l’app').toHaveCount(0);
        await navCheck(page);
      });
    }

    for (const viewport of VIEWPORTS.filter((v) => v.width >= DESKTOP_MIN)) {
      const navCheck = entry.nav === 'admin' ? adminDesktopNav : noAdminNav;
      test(`${viewport.width}px (desktop)`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openEntry(page, entry);
        expect(await horizontalOverflow(page), 'pas de scroll horizontal').toBeLessThanOrEqual(0);
        expect(await findTruncatedWithoutTitle(page), 'texte tronqué sans title').toEqual([]);
        await expect(shellSidebar(page), 'pas de sidebar de l’app').toHaveCount(0);
        await navCheck(page);
      });
    }

    for (const viewport of LANDSCAPES) {
      const navCheck = entry.nav === 'admin' ? adminMobileNav : noAdminNav;
      test(`paysage ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openEntry(page, entry);
        expect(await horizontalOverflow(page), 'pas de scroll horizontal en paysage').toBeLessThanOrEqual(0);
        expect(await findSmallTargets(page, MIN_TARGET), 'cibles interactives ≥ 44 px').toEqual([]);
        await expect(page.locator(entry.landmark ?? 'main h1').first()).toBeInViewport();
        await navCheck(page);
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
