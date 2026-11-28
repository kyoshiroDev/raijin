import { expect, test, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';
import { FIXTURE_TOKENS, SCREENSHOT_DIR } from './support/bench';

/**
 * PROMPT.md §9.2 : captures de chaque écran du banc aux largeurs de référence (320, 390, 768, 1024, 1440 px),
 * thème sombre, page entière, dans docs/screenshots/phase-8bis/. `SCREENSHOT_WIDTHS=390,1440` : sous-ensemble.
 * Session de auth.setup.ts ; données des fixtures de global-setup (support/db.ts).
 */
const WIDTHS = process.env['SCREENSHOT_WIDTHS']
  ? process.env['SCREENSHOT_WIDTHS'].split(',').map((value) => Number(value.trim()))
  : [320, 390, 768, 1024, 1440];

const noop = async (): Promise<void> => undefined;
const h1 = (page: Page) => page.getByRole('heading', { level: 1 }).first();

const SCREENS: readonly { name: string; path: string; anonymous?: boolean; ready: (page: Page) => Locator; prepare?: (page: Page) => Promise<void> }[] = [
  { name: 'connexion', path: '/login', anonymous: true, ready: (page) => page.getByRole('button', { name: 'Se connecter' }) },
  { name: 'opportunites', path: '/', ready: (page) => page.getByText(FIXTURE_TOKENS[0].symbol, { exact: true }).first() },
  { name: 'token', path: `/token/${FIXTURE_TOKENS[0].mint}`, ready: (page) => page.getByText(FIXTURE_TOKENS[0].symbol).first() },
  { name: 'alertes', path: '/alerts', ready: h1 },
  { name: 'portefeuille', path: '/portfolio', ready: h1 },
  { name: 'performance', path: '/performance', ready: h1 },
  { name: 'laboratoire', path: '/performance/lab', ready: h1 },
  { name: 'justesse', path: '/justesse', ready: h1 },
  {
    name: 'comparaison',
    path: '/comparaison',
    ready: (page) => page.locator('[data-acceptance]'),
    prepare: (page) => page.locator('[data-window="snapshot"]').click(),
  },
  { name: 'reglages', path: '/settings', ready: h1 },
  { name: 'compte', path: '/account', ready: h1 },
];

test.use({ colorScheme: 'dark', reducedMotion: 'reduce' });

for (const screen of SCREENS) {
  test.describe(`capture ${screen.name}`, () => {
    if (screen.anonymous) test.use({ storageState: { cookies: [], origins: [] } });
    for (const width of WIDTHS) {
      test(`${width} px`, async ({ page }) => {
        await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
        await page.goto(screen.path);
        await expect(h1(page)).toBeVisible();
        await (screen.prepare ?? noop)(page);
        await expect(screen.ready(page)).toBeVisible();
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const png = await page.screenshot({ path: join(SCREENSHOT_DIR, `${screen.name}-${width}.png`), fullPage: true, animations: 'disabled' });
        expect(png.byteLength).toBeGreaterThan(1000);
      });
    }
  });
}
