import { expect, type Page } from '@playwright/test';
import { loginViaApi } from './auth';
import { ADMIN_SCREENS, fillEnrollmentPassword, loginVerifiedAdmin, sharedAdmin, typeTotp } from './admin';
import { LANDING_ORIGIN, consentBanner, interceptGoogle } from './landing';
import { type PageEntry } from './pages';

/**
 * Écrans sans la coque de l'app (phase 6 bis) pour les suites responsive, axe et captures :
 * - `admin` : coque admin (barre latérale ≥ 1024 px, barre du haut + pastilles en dessous) ;
 * - `none` : écrans de sécurité admin (colonne centrée) et landing Astro (aucune barre de navigation).
 */
export interface ShelllessEntry extends PageEntry {
  nav: 'admin' | 'none';
  /** Capture pleine page (écrans longs). */
  fullPage?: boolean;
}

/** Écran admin chargé : plus de squelette ni de zone `aria-busy`, aucun état d'erreur. */
export async function adminScreenReady(page: Page): Promise<void> {
  await expect(page.locator('rj-admin-shell [aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('rj-admin-shell rj-error-state')).toHaveCount(0);
}

/** Réponse simulée de la confirmation d'enrôlement : 10 codes de secours au format du contrat. */
function fakeEnrollmentConfirmation() {
  const now = new Date();
  const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  return {
    status: {
      enrolled: true,
      verified: true,
      idleExpiresAt: later(30),
      absoluteExpiresAt: later(8 * 60),
      idleTimeoutSeconds: 1800,
      recoveryCodesRemaining: 10,
    },
    recoveryCodes: {
      codes: ['ABCDE-FGH23', 'JKLMN-PQR45', 'STUVW-XYZ67', 'BCDEF-GHJ23', 'KLMNP-QRS45', 'TUVWX-YZA67', 'CDEFG-HJK23', 'LMNPQ-RST45', 'UVWXY-ZAB67', 'DEFGH-JKL23'],
      generatedAt: now.toISOString(),
    },
  };
}

/** Les 9 écrans, admin enrôlé et session admin vérifiée (API réelle, Google simulé). */
export const ADMIN_PAGES: readonly ShelllessEntry[] = ADMIN_SCREENS.map((screen) => ({
  name: `admin-${screen.slug}`,
  shot: `admin-ecran-${screen.slug}`,
  path: screen.path,
  heading: screen.title,
  nav: 'admin' as const,
  fullPage: true,
  prepare: async (page: Page) => {
    await loginVerifiedAdmin(page);
  },
  act: adminScreenReady,
}));

/** Écrans de la double authentification (hors coque). */
export const ADMIN_2FA_PAGES: readonly ShelllessEntry[] = [
  {
    name: 'admin-2fa-activation',
    path: '/admin/securite/activation',
    heading: 'Active la double authentification',
    nav: 'none',
    prepare: async (page) => {
      const admin = await sharedAdmin('pending');
      await loginViaApi(page.context().request, admin.email, admin.password);
    },
    act: async (page) => {
      await expect(page.getByRole('img', { name: 'QR code à scanner avec ton application d’authentification' })).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    name: 'admin-2fa-code',
    path: '/admin/securite/code',
    heading: 'Confirme que c’est bien toi',
    nav: 'none',
    prepare: async (page) => {
      const admin = await sharedAdmin('enrolled');
      await loginViaApi(page.context().request, admin.email, admin.password);
    },
    act: async (page) => {
      await expect(page.getByLabel('Code à 6 chiffres')).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    // Codes de secours tels qu'affichés juste après l'activation : seule la confirmation est simulée (les vrais
    // codes ne s'affichent qu'une fois par compte ; le parcours réel est dans admin.flow.spec.ts).
    name: 'admin-2fa-codes-de-secours',
    path: '/admin/securite/activation',
    heading: 'Range tes codes de secours',
    nav: 'none',
    prepare: async (page) => {
      const admin = await sharedAdmin('pending');
      await loginViaApi(page.context().request, admin.email, admin.password);
      await page.context().route('**/api/v1/admin/security/enrollment/confirm', (route) => route.fulfill({ status: 200, json: fakeEnrollmentConfirmation() }));
    },
    act: async (page) => {
      await expect(page.getByRole('img', { name: 'QR code à scanner avec ton application d’authentification' })).toBeVisible({ timeout: 15_000 });
      await fillEnrollmentPassword(page, (await sharedAdmin('pending')).password);
      await typeTotp(page, '123456');
      await expect(page.getByRole('list', { name: 'Codes de secours' }).getByRole('listitem')).toHaveCount(10, { timeout: 15_000 });
    },
  },
];

/** Landing (build de test, identifiant GA4 factice) : accueil avec la bannière de consentement. */
export const LANDING_PAGES: readonly ShelllessEntry[] = [
  {
    name: 'landing-accueil',
    shot: 'landing-accueil-banniere',
    path: `${LANDING_ORIGIN}/`,
    heading: 'Vérifie avant de signer.',
    nav: 'none',
    prepare: async (page) => {
      await interceptGoogle(page);
    },
    act: async (page) => {
      await expect(consentBanner(page)).toBeVisible();
    },
  },
];

export const SHELLLESS_PAGES: readonly ShelllessEntry[] = [...ADMIN_PAGES, ...ADMIN_2FA_PAGES, ...LANDING_PAGES];
