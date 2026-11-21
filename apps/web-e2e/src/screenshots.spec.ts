import { expect, test } from '@playwright/test';
import { workspaceRoot } from '@nx/devkit';
import { join } from 'node:path';
import { PAGES, VIEWPORTS, openPage } from './support/pages';

/**
 * PROMPT.md §9.2 : captures de chaque page à 320, 390, 768, 1024 et 1440 px, thème sombre,
 * dans docs/screenshots/<phase>/. Pages de l'app : hauteur d'écran ; /_design : page entière
 * (référence visuelle des composants).
 */
const PHASE = process.env['SCREENSHOT_PHASE'] ?? 'phase-1';
const OUT = join(workspaceRoot, 'docs', 'screenshots', PHASE);
const WIDTHS = [320, 390, 768, 1024, 1440];

test.use({ colorScheme: 'dark', reducedMotion: 'reduce' });

for (const { name, path } of PAGES) {
  for (const width of WIDTHS) {
    const viewport = VIEWPORTS.find((v) => v.width === width) ?? { width, height: 900 };
    test(`capture ${name} ${width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openPage(page, path);
      await page.screenshot({
        path: join(OUT, `${name}-${width}.png`),
        fullPage: name === 'design',
        animations: 'disabled',
      });
    });
  }
}

for (const [file, button] of [
  ['sheet', 'Ouvrir (modale)'],
  ['panel', 'Ouvrir (panneau)'],
] as const) {
  for (const width of [390, 1440]) {
    const viewport = VIEWPORTS.find((v) => v.width === width) ?? { width, height: 900 };
    test(`capture ${file} ${width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openPage(page, '/_design');
      await page.getByRole('button', { name: button }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, `${file}-${width}.png`), animations: 'disabled' });
    });
  }
}
