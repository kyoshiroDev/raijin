import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { FIXTURE_TOKENS, SCREENSHOT_DIR, expectNoHorizontalScroll, smallTargets } from './support/bench';

const WIDTHS = [375, 768, 1280] as const;
const PAGES = [
  { name: 'connexion', path: '/login', anonymous: true, ready: (page: Page) => page.getByRole('button', { name: 'Se connecter' }) },
  { name: 'opportunites', path: '/', anonymous: false, ready: (page: Page) => page.getByText(FIXTURE_TOKENS[0].symbol, { exact: true }).first() },
  { name: 'comparaison', path: '/comparaison', anonymous: false, ready: (page: Page) => page.locator('[data-acceptance]') },
  { name: 'justesse', path: '/justesse', anonymous: false, ready: (page: Page) => page.getByRole('heading', { level: 1 }).first() },
] as const;

async function open(page: Page, entry: (typeof PAGES)[number]): Promise<void> {
  await page.goto(entry.path);
  if (entry.path === '/comparaison') await page.locator('[data-window="snapshot"]').click();
  await expect(entry.ready(page)).toBeVisible();
}

for (const entry of PAGES) {
  test.describe(`${entry.name}`, () => {
    if (entry.anonymous) test.use({ storageState: { cookies: [], origins: [] } });

    for (const width of WIDTHS) {
      test(`${width} px : pas de défilement horizontal, cibles ≥ 44 px, capture`, async ({ page }) => {
        await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
        await open(page, entry);
        // Capture d'abord : la preuve visuelle reste disponible même quand une assertion échoue.
        await page.screenshot({ path: join(SCREENSHOT_DIR, `${entry.name}-${width}.png`), fullPage: true });
        await expectNoHorizontalScroll(page);
        expect(await smallTargets(page), 'cibles < 44 px').toEqual([]);
      });
    }

    test('axe : aucune violation sérieuse ou critique (375 et 1280 px)', async ({ page }) => {
      for (const width of [375, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await open(page, entry);
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
        const serious = results.violations
          .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
          .map((violation) => `${violation.id} (${violation.impact}) : ${violation.nodes.map((node) => node.target.join(' ')).slice(0, 5).join(' | ')}`);
        expect(serious, `${entry.name} à ${width} px`).toEqual([]);
      }
    });
  });
}
