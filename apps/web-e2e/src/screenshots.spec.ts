import { expect, test, type Page } from '@playwright/test';
import { workspaceRoot } from '@nx/devkit';
import { join } from 'node:path';
import { loginViaApi, registerViaApi, uniqueEmail } from './support/auth';
import { MINTS, expectVerdict, tokenField, useFreshIp } from './support/analysis';
import { ANALYSIS_PAGES, PAGES, VIEWPORTS, WALLET_PAGES, WATCH_PAGES, openDialogSettled, openEntry, openPage, sharedVerifiedAccount } from './support/pages';

/**
 * PROMPT.md §9.2 : captures de chaque page à 320, 390, 768, 1024 et 1440 px, thème sombre,
 * dans docs/screenshots/<phase>/. Pages de l'app : hauteur d'écran ; /_design : page entière
 * (référence visuelle des composants).
 */
const PHASE = process.env['SCREENSHOT_PHASE'] ?? 'phase-3';
const OUT = join(workspaceRoot, 'docs', 'screenshots', PHASE);
const WIDTHS = [320, 390, 768, 1024, 1440];

test.use({ colorScheme: 'dark', reducedMotion: 'reduce' });

/** Phase 1 : coquille et /_design ; phase 2 (et suivantes) : écrans de compte et d'auth. */
/** Phase 3 : écran d'analyse (vide et ses états) et page publique, API réelle en mode fixtures. */
const PHASE3_SHOTS = [{ name: 'analyse-vide', path: '/analyse', heading: 'Analyser un token' }, ...ANALYSIS_PAGES];
/** Phase 4 : suivis (vide, rempli, limite), alertes (liste, filtres, vide), préférences, 404, maintenance. */
/** Phase 5 : scan de wallet (visiteur, Gratuit, saisie, résultats délégations et Danger, vide, phrase refusée, quota). */
const SHOTS =
  PHASE === 'phase-1'
    ? PAGES.filter((p) => !p.path.startsWith('/compte/'))
    : PHASE === 'phase-3'
      ? PHASE3_SHOTS
      : PHASE === 'phase-4'
        ? WATCH_PAGES
        : PHASE === 'phase-5'
          ? WALLET_PAGES
          : PAGES.filter((p) => p.path.startsWith('/compte'));
/** Résultats d'analyse et listes : page entière. */
const FULL_PAGE = new Set(['design', 'analyse-danger', 'analyse-prudence', 'analyse-partiel', 'public-prudence', 'suivis-rempli', 'suivis-limite', 'alertes-liste', 'wallet-delegations', 'wallet-danger']);

for (const entry of SHOTS) {
  const { name } = entry;
  for (const width of WIDTHS) {
    const viewport = VIEWPORTS.find((v) => v.width === width) ?? { width, height: 900 };
    test(`capture ${name} ${width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openEntry(page, entry);
      const png = await page.screenshot({
        path: join(OUT, `${entry.shot ?? name}-${width}.png`),
        fullPage: FULL_PAGE.has(name),
        animations: 'disabled',
      });
      expect(png.byteLength).toBeGreaterThan(1000);
    });
  }
}

for (const [file, button] of PHASE === 'phase-1'
  ? ([
      ['sheet', 'Ouvrir (modale)'],
      ['panel', 'Ouvrir (panneau)'],
    ] as const)
  : []) {
  for (const width of [390, 1440]) {
    const viewport = VIEWPORTS.find((v) => v.width === width) ?? { width, height: 900 };
    test(`capture ${file} ${width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openPage(page, '/_design');
      await page.getByRole('button', { name: button }).click();
      await openDialogSettled(page);
      const png = await page.screenshot({ path: join(OUT, `${file}-${width}.png`), animations: 'disabled' });
      expect(png.byteLength).toBeGreaterThan(1000);
    });
  }
}

/** États d'auth obtenus avec l'API réelle (erreurs, bottom sheets du compte, liens invalides). */
const STATES: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: 'connexion-erreurs',
    open: async (page) => {
      await openPage(page, '/compte/connexion');
      await page.getByLabel('Adresse e-mail').fill(uniqueEmail('capture'));
      await page.getByLabel('Mot de passe', { exact: true }).fill('mauvais mot de passe');
      await page.getByRole('button', { name: 'Se connecter' }).click();
      await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    name: 'inscription-validation',
    open: async (page) => {
      await openPage(page, '/compte/inscription');
      await page.getByLabel('Adresse e-mail').fill('kenji@');
      await page.getByLabel('Mot de passe', { exact: true }).fill('court');
      await page.getByRole('button', { name: 'Créer mon compte' }).click();
    },
  },
  {
    name: 'reinitialiser-invalide',
    open: async (page) => {
      await openPage(page, '/compte/reinitialiser-mot-de-passe');
      await expect(page.getByRole('heading', { name: 'Lien expiré ou déjà utilisé' })).toBeVisible();
    },
  },
  {
    name: 'lien-magique-echec',
    open: async (page) => {
      await page.goto(`/compte/lien-magique?token=${'b'.repeat(43)}`);
      await expect(page.getByRole('heading', { name: 'Connexion impossible' })).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    name: 'email-verifie',
    open: async (page) => {
      const { link } = await registerViaApi(page.context().request, 'capture-verif');
      await page.goto(link);
      await expect(page.getByRole('heading', { name: 'Adresse confirmée' })).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    name: 'compte-mot-de-passe',
    open: async (page) => {
      const { email, password } = await sharedVerifiedAccount();
      await loginViaApi(page.context().request, email, password);
      await openPage(page, '/compte');
      await page.getByRole('button', { name: 'Changer le mot de passe' }).click();
      await openDialogSettled(page);
    },
  },
  {
    name: 'compte-suppression',
    open: async (page) => {
      const { email, password } = await sharedVerifiedAccount();
      await loginViaApi(page.context().request, email, password);
      await openPage(page, '/compte');
      await page.getByRole('button', { name: 'Supprimer le compte' }).click();
      const dialog = await openDialogSettled(page);
      await dialog.getByLabel('Ton mot de passe, pour confirmer').fill('mon mot de passe');
    },
  },
];

/** États de l'écran d'analyse obtenus par interaction (phase 3). */
const ANALYSIS_STATES: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: 'analyse-lien',
    open: async (page) => {
      await useFreshIp(page);
      await openPage(page, '/analyse');
      await tokenField(page).fill(`https://dexscreener.com/solana/${MINTS.bonkPair}`);
      await expect(page.locator('[data-preview]')).toContainText('lien DexScreener');
    },
  },
  {
    name: 'analyse-aide',
    open: async (page) => {
      await useFreshIp(page);
      await openPage(page, `/analyse/${MINTS.mintActive}`);
      await expectVerdict(page, 'Danger');
      await page.getByRole('button', { name: /^Autorité de mint/ }).click();
      await page.getByRole('button', { name: 'En savoir plus : Autorité de mint' }).click();
      await openDialogSettled(page);
    },
  },
];

if (PHASE === 'phase-3') {
  for (const { name, open } of ANALYSIS_STATES) {
    for (const width of WIDTHS) {
      const viewport = VIEWPORTS.find((v) => v.width === width) ?? { width, height: 900 };
      test(`capture ${name} ${width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await open(page);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const png = await page.screenshot({ path: join(OUT, `${name}-${width}.png`), animations: 'disabled' });
        expect(png.byteLength).toBeGreaterThan(1000);
      });
    }
  }
}

if (PHASE === 'phase-2') {
  for (const { name, open } of STATES) {
    for (const width of WIDTHS) {
      const viewport = VIEWPORTS.find((v) => v.width === width) ?? { width, height: 900 };
      test(`capture ${name} ${width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await open(page);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const png = await page.screenshot({ path: join(OUT, `${name}-${width}.png`), animations: 'disabled' });
        expect(png.byteLength).toBeGreaterThan(1000);
      });
    }
  }
}
