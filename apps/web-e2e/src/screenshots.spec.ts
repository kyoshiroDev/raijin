import { expect, test, type Page } from '@playwright/test';
import { workspaceRoot } from '@nx/devkit';
import { join } from 'node:path';
import { APP_ORIGIN, MAILPIT_URL, createVerifiedAccount, loginViaApi, registerViaApi, uniqueEmail } from './support/auth';
import { MINTS, PROD_ORIGIN, expectVerdict, publishAnalysis, tokenField, useFreshIp } from './support/analysis';
import { DAY, expireTrial, followFive, nextSendingSlot, plain, subscribeViaApi, trialTick, userRow } from './support/billing';
import { api, followViaApi, runJob, waitForMailHtml, withPg } from './support/watch';
import { ADMIN_2FA_PAGES, ADMIN_PAGES, LANDING_PAGES, SHELLLESS_PAGES } from './support/admin-pages';
import { ANALYSIS_PAGES, BILLING_PAGES, PAGES, VIEWPORTS, WALLET_PAGES, WATCH_PAGES, openDialogSettled, openEntry, openPage, sharedVerifiedAccount, type PageEntry } from './support/pages';

/**
 * PROMPT.md §9.2 : captures de chaque page à 320, 390, 768, 1024 et 1440 px, thème sombre,
 * dans docs/screenshots/<phase>/. Pages de l'app : hauteur d'écran ; /_design : page entière
 * (référence visuelle des composants).
 */
const PHASE = process.env['SCREENSHOT_PHASE'] ?? 'phase-3';
const OUT = join(workspaceRoot, 'docs', 'screenshots', PHASE);
/** `SCREENSHOT_WIDTHS=390,1440` : sous-ensemble des largeurs (machine locale à faible mémoire) ; défaut : les 5. */
const WIDTHS = process.env['SCREENSHOT_WIDTHS']
  ? process.env['SCREENSHOT_WIDTHS'].split(',').map((value) => Number(value.trim()))
  : [320, 390, 768, 1024, 1440];

test.use({ colorScheme: 'dark', reducedMotion: 'reduce' });

/** Phase 1 : coquille et /_design ; phase 2 (et suivantes) : écrans de compte et d'auth. */
/** Phase 3 : écran d'analyse (vide et ses états) et page publique, API réelle en mode fixtures. */
const PHASE3_SHOTS = [{ name: 'analyse-vide', path: '/analyse', heading: 'Analyser un token' }, ...ANALYSIS_PAGES];
/** Phase 4 : suivis (vide, rempli, limite), alertes (liste, filtres, vide), préférences, 404, maintenance. */
/** Phase 5 : scan de wallet (visiteur, Gratuit, saisie, résultats délégations et Danger, vide, phrase refusée, quota). */
/** Phase 6 : abonnement (offres par état, succès, faux Checkout, faux portail), fin d'essai, choix des suivis, bandeau. */
/** Phase 6 bis : 9 écrans admin (API réelle, Google simulé), écrans 2FA, landing avec la bannière de consentement. */
/** Phase 7 : chaque page de la landing (accueil avec la bannière, puis toutes les pages après un refus mémorisé). */
/** Phase 9 : relecture finale, l'app complète (coque, analyse, suivis, wallet, abonnement, admin) + états hors ligne. */
/** Phase 10 : /t statique servi par l'API et e-mails transactionnels (blocs dédiés en fin de fichier). */
const PHASE9_SHOTS: readonly PageEntry[] = [
  ...new Map(
    [...PAGES.filter((p) => p.path !== '/_design'), ...PHASE3_SHOTS, ...WATCH_PAGES, ...WALLET_PAGES, ...BILLING_PAGES, ...ADMIN_PAGES, ...ADMIN_2FA_PAGES].map(
      (entry) => [entry.name, entry] as const,
    ),
  ).values(),
];
const SHOTS: readonly (PageEntry & { fullPage?: boolean })[] =
  PHASE === 'phase-1'
    ? PAGES.filter((p) => !p.path.startsWith('/compte/'))
    : PHASE === 'phase-3'
      ? PHASE3_SHOTS
      : PHASE === 'phase-4'
        ? WATCH_PAGES
        : PHASE === 'phase-5'
          ? WALLET_PAGES
          : PHASE === 'phase-6'
            ? BILLING_PAGES
            : PHASE === 'phase-6bis'
              ? SHELLLESS_PAGES
              : PHASE === 'phase-7'
                ? LANDING_PAGES
                : PHASE === 'phase-9'
                  ? PHASE9_SHOTS
                  : PHASE === 'phase-10'
                    ? []
                    : PAGES.filter((p) => p.path.startsWith('/compte'));
/** Résultats d'analyse et listes : page entière. */
const FULL_PAGE = new Set(['design', 'analyse-danger', 'analyse-prudence', 'analyse-partiel', 'public-prudence', 'suivis-rempli', 'suivis-limite', 'alertes-liste', 'wallet-delegations', 'wallet-danger', 'abonnement-visiteur', 'abonnement-gratuit', 'abonnement-essai', 'abonnement-pro', 'abonnement-retard', 'abonnement-resilie', 'abonnement-indisponible', 'fin-essai', 'choix-suivis']);

for (const entry of SHOTS) {
  const { name } = entry;
  for (const width of WIDTHS) {
    const viewport = VIEWPORTS.find((v) => v.width === width) ?? { width, height: 900 };
    test(`capture ${name} ${width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openEntry(page, entry);
      const png = await page.screenshot({
        path: join(OUT, `${entry.shot ?? name}-${width}.png`),
        fullPage: FULL_PAGE.has(name) || entry.fullPage === true,
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

/**
 * Phase 9 : bandeau « Tu es hors ligne » (coque, chargé `@defer (on idle)`), seul puis avec l'état d'erreur
 * `NETWORK_ERROR` d'une analyse lancée hors ligne. Le réseau est coupé après le chargement de l'écran
 * (`setOffline` émet l'événement `offline` suivi par le bandeau).
 */
const OFFLINE_STATES: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: 'hors-ligne-analyse',
    open: async (page) => {
      await openEntry(page, { name: 'analyse', path: '/analyse', heading: 'Analyser un token' });
      await page.context().setOffline(true);
      await expect(page.locator('[data-offline]')).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    name: 'hors-ligne-erreur',
    open: async (page) => {
      await openEntry(page, { name: 'analyse', path: '/analyse', heading: 'Analyser un token' });
      await page.context().setOffline(true);
      await expect(page.locator('[data-offline]')).toBeVisible({ timeout: 15_000 });
      await tokenField(page).fill(MINTS.bonk);
      await tokenField(page).press('Enter');
      await expect(page.getByRole('heading', { name: 'Raijin ne répond pas' })).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    name: 'hors-ligne-suivis',
    open: async (page) => {
      await openEntry(page, { name: 'suivis', path: '/suivis', heading: 'Suivis', auth: true });
      await page.context().setOffline(true);
      await expect(page.locator('[data-offline]')).toBeVisible({ timeout: 15_000 });
    },
  },
];

const EXTRA_STATES =
  PHASE === 'phase-9' ? [...OFFLINE_STATES, ...ANALYSIS_STATES, ...STATES] : PHASE === 'phase-3' ? ANALYSIS_STATES : PHASE === 'phase-2' ? STATES : [];

for (const { name, open } of EXTRA_STATES) {
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

/**
 * Phase 10 (relecture finale, tour 2) : `/t/<mint>` tel que servi par l'API (verdict statique injecté, §10.7,
 * Angular pas encore démarré : aucune interaction avant la capture), et chaque e-mail transactionnel en thème
 * clair (rendu HTML Mailpit), aux 5 largeurs. Aucun e-mail ne doit montrer d'ancien prix (9,90 € / 99 €).
 */
if (PHASE === 'phase-10') {
  for (const width of WIDTHS) {
    const viewport = VIEWPORTS.find((v) => v.width === width) ?? { width, height: 900 };
    test(`capture public-statique ${width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await publishAnalysis(page.context().request, MINTS.bonk);
      await page.goto(`${PROD_ORIGIN}/t/${MINTS.bonk}`);
      await expect(page.locator('rj-root > main[data-rj-static="t"]')).toBeVisible();
      await expect(page.locator('rj-app-shell')).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const png = await page.screenshot({ path: join(OUT, `public-statique-${width}.png`), fullPage: true, animations: 'disabled' });
      expect(png.byteLength).toBeGreaterThan(1000);
      // Le premier geste de l'utilisateur n'a pas eu lieu : la capture montre bien le rendu statique.
      await expect(page.locator('rj-app-shell')).toHaveCount(0);
    });
  }

  test.describe('e-mails', () => {
    test.describe.configure({ timeout: 180_000 });
    const OLD_PRICES = /9,90|99\s?€|99,00/;
    const ALERT_SUBJECT = /^Alerte |alertes? sur tes tokens suivis/;

    async function shoot(page: Page, html: string, name: string): Promise<void> {
      expect(plain(html), `ancien prix dans l'e-mail ${name}`).not.toMatch(OLD_PRICES);
      for (const width of WIDTHS) {
        const viewport = VIEWPORTS.find((v) => v.width === width) ?? { width, height: 900 };
        await page.setViewportSize(viewport);
        // Images de l'e-mail servies par le front (APP_URL/email/) : même origine que la page.
        await page.goto(`${APP_ORIGIN}/analyse`);
        await page.setContent(html, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        expect(plain(await page.locator('body').textContent()), `ancien prix affiché dans ${name}`).not.toMatch(OLD_PRICES);
        await page.screenshot({ path: join(OUT, `email-${name}-${width}.png`), fullPage: true });
      }
    }

    /** Dernier e-mail Mailpit (tous destinataires) dont l'objet correspond : alertes produites par watch.flow.spec.ts. */
    async function latestMail(subject: RegExp): Promise<string> {
      const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=500`);
      const { messages } = (await res.json()) as { messages: { ID: string; Subject: string }[] };
      const found = messages.find((m) => subject.test(m.Subject));
      expect(found, `aucun e-mail « ${String(subject)} » dans Mailpit : lancer d'abord watch.flow.spec.ts`).toBeDefined();
      return ((await (await fetch(`${MAILPIT_URL}/api/v1/message/${found?.ID}`)).json()) as { HTML: string }).HTML;
    }

    test('capture e-mails de compte : vérification, bienvenue, réinitialisation, lien magique', async ({ page }) => {
      await useFreshIp(page);
      const request = page.context().request;
      const { email } = await createVerifiedAccount(page.context(), 'capture-mails', 'trial');
      await shoot(page, (await waitForMailHtml(email, 'Confirme ton adresse')).html, 'verification');
      await shoot(page, (await waitForMailHtml(email, 'Bienvenue sur Raijin')).html, 'bienvenue');
      expect((await api(request, 'POST', '/auth/password/forgot', { email })).status).toBe(202);
      await shoot(page, (await waitForMailHtml(email, 'Réinitialise ton mot de passe')).html, 'reinitialisation');
      expect((await api(request, 'POST', '/auth/magic-link', { email })).status).toBe(202);
      await shoot(page, (await waitForMailHtml(email, 'Ton lien de connexion Raijin')).html, 'lien-magique');
    });

    test('capture e-mails de l’essai : J+1, J-2, J0', async ({ page }) => {
      await useFreshIp(page);
      const request = page.context().request;
      const { email } = await createVerifiedAccount(page.context(), 'capture-essai', 'trial');
      const row = await userRow(email);
      await followFive(request);
      expect(await trialTick(request, nextSendingSlot(new Date((row.trialStartedAt as Date).getTime() + DAY)), row.id)).toMatchObject({ day1: 1 });
      await shoot(page, (await waitForMailHtml(email, 'Voilà ce que Raijin a vérifié pour toi')).html, 'essai-j1');
      expect(await trialTick(request, nextSendingSlot(new Date((row.trialEndsAt as Date).getTime() - 2 * DAY)), row.id)).toMatchObject({ dayMinus2: 1 });
      await shoot(page, (await waitForMailHtml(email, 'Ton essai se termine dans 2 jours')).html, 'essai-j-2');
      expect(await expireTrial(request, email)).toMatchObject({ expired: 1 });
      await shoot(page, (await waitForMailHtml(email, 'Tu repasses en Gratuit')).html, 'essai-j0');
    });

    test('capture e-mails de paiement : reçu, échec', async ({ page }) => {
      await useFreshIp(page);
      const paid = await createVerifiedAccount(page.context(), 'capture-recu');
      await subscribeViaApi(page.context().request, 'paid');
      const receipt = await waitForMailHtml(paid.email, 'Ton reçu Raijin Pro');
      expect(plain(receipt.html)).toContain('14,90');
      await shoot(page, receipt.html, 'recu');
      await page.context().clearCookies();
      const failed = await createVerifiedAccount(page.context(), 'capture-echec');
      await subscribeViaApi(page.context().request, 'payment_failed', 'year');
      await shoot(page, (await waitForMailHtml(failed.email, 'Ton paiement Raijin Pro n’est pas passé')).html, 'echec-paiement');
    });

    test('capture e-mails de suivi : alerte, résumé hebdomadaire', async ({ page }) => {
      await shoot(page, await latestMail(ALERT_SUBJECT), 'alerte');
      await useFreshIp(page);
      const request = page.context().request;
      const { email } = await createVerifiedAccount(page.context(), 'capture-hebdo');
      expect((await followViaApi(request, MINTS.bonk)).status).toBe(201);
      await withPg((pg) => pg.query(`UPDATE "User" SET "notifyWeeklyDigest" = true, "weeklyDigestSentAt" = NULL WHERE "email" = $1`, [email]));
      await runJob(request, 'weekly-digest');
      await shoot(page, (await waitForMailHtml(email, 'Ton résumé Raijin de la semaine')).html, 'resume-hebdo');
    });
  });
}
