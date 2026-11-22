import { expect, request, type Page } from '@playwright/test';
import { APP_ORIGIN, PASSWORD, createVerifiedAccount, loginViaApi, uniqueEmail } from './auth';

export interface PageEntry {
  name: string;
  path: string;
  /** Titre `h1` attendu (null : pas de titre stable). */
  heading: string | null;
  /** Écran de compte connecté : un compte vérifié est créé (API réelle) puis connecté avant l'ouverture. */
  auth?: boolean;
  /** Action à jouer après l'ouverture pour atteindre l'état testé (ex. « vérifie ta boîte »). */
  act?: (page: Page) => Promise<void>;
}

/** Jeton factice bien formé : l'écran de réinitialisation n'interroge l'API qu'à l'envoi du formulaire. */
const FAKE_TOKEN = 'a'.repeat(43);

/** Pages testées (routes de l'app + page de référence visuelle, servie uniquement en dev). */
export const PAGES: readonly PageEntry[] = [
  { name: 'analyse', path: '/analyse', heading: 'Analyser' },
  { name: 'suivis', path: '/suivis', heading: 'Suivis' },
  { name: 'alertes', path: '/alertes', heading: null },
  { name: 'compte', path: '/compte', heading: 'Compte', auth: true },
  { name: 'wallet', path: '/wallet', heading: 'Scan de wallet' },
  { name: 'design', path: '/_design', heading: 'Design — Raijin' },
  // Écrans d'auth (phase 2), visiteur non connecté.
  { name: 'connexion', path: '/compte/connexion', heading: 'Connexion' },
  { name: 'inscription', path: '/compte/inscription', heading: 'Créer ton compte' },
  {
    name: 'inscription-envoyee',
    path: '/compte/inscription',
    heading: 'Vérifie ta boîte mail',
    act: async (page) => {
      await page.getByLabel('Adresse e-mail').fill(uniqueEmail('responsive'));
      await page.getByLabel('Mot de passe', { exact: true }).fill(PASSWORD);
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Créer mon compte' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Vérifie ta boîte mail' })).toBeVisible({ timeout: 15_000 });
    },
  },
  { name: 'verifier-email', path: '/compte/verifier-email', heading: 'Vérifie ta boîte mail' },
  { name: 'mot-de-passe-oublie', path: '/compte/mot-de-passe-oublie', heading: 'Mot de passe oublié' },
  { name: 'reinitialiser', path: `/compte/reinitialiser-mot-de-passe?token=${FAKE_TOKEN}`, heading: 'Nouveau mot de passe' },
  { name: 'lien-magique', path: '/compte/lien-magique', heading: 'Connexion sans mot de passe' },
];

let sharedAccount: Promise<{ email: string; password: string }> | undefined;

/** Compte vérifié partagé par les tests d'un même worker (créé une fois via l'API réelle et Mailpit). */
export function sharedVerifiedAccount(): Promise<{ email: string; password: string }> {
  sharedAccount ??= (async () => {
    const api = await request.newContext({ baseURL: APP_ORIGIN });
    try {
      return await createVerifiedAccount(api, 'partage');
    } finally {
      await api.dispose();
    }
  })();
  return sharedAccount;
}

/** Ouvre l'écran d'une entrée de `PAGES` dans l'état testé (connexion préalable, action). */
export async function openEntry(page: Page, entry: PageEntry): Promise<void> {
  if (entry.auth) {
    const { email, password } = await sharedVerifiedAccount();
    await loginViaApi(page.context().request, email, password);
  }
  await openPage(page, entry.path);
  if (entry.act) await entry.act(page);
  if (entry.heading) await expect(page.locator('main h1').first()).toHaveText(entry.heading);
}

/** Largeurs imposées par PROMPT.md §3, avec une hauteur réaliste en portrait. */
export const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

/** Paysage mobile (iPhone 12-15 et petit écran 320). */
export const LANDSCAPES = [
  { width: 844, height: 390 },
  { width: 568, height: 320 },
] as const;

/** Seuil de la navigation desktop (sidebar) et cible tactile minimale. */
export const DESKTOP_MIN = 1024;
export const MIN_TARGET = 44;

/** Ouvre une page et attend le rendu Angular, les polices et la fin des animations d'entrée. */
export async function openPage(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('main h1').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Coquille réelle (et non les aperçus `mode="inline"` de /_design). */
export const shellTabBar = (page: Page) => page.locator('rj-app-shell > rj-tab-bar > nav');
export const shellSidebar = (page: Page) => page.locator('rj-app-shell > rj-sidebar > aside');

export interface TargetIssue {
  label: string;
  width: number;
  height: number;
}

/**
 * Cibles interactives visibles plus petites que `min` px dans une dimension.
 * Exclut les éléments visuellement masqués (lien d'évitement `sr-only`) et le conteneur `main`
 * (tabindex=-1, cible du lien d'évitement, non interactif).
 */
export function findSmallTargets(page: Page, min: number): Promise<TargetIssue[]> {
  return page.evaluate((minSize) => {
    const selector =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="link"], [role="switch"], [role="checkbox"], [tabindex]:not([tabindex="-1"])';
    const issues: { label: string; width: number; height: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      let rect: { width: number; height: number } = el.getBoundingClientRect();
      // Masqué visuellement (sr-only : 1 px, clip) ou hors rendu.
      if (rect.width <= 1 || rect.height <= 1) continue;
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      // Case à cocher / bouton radio : le <label> qui l'englobe active aussi le contrôle,
      // il fait partie de la cible (WCAG 2.5.5 / 2.5.8). Seul le label englobant est retenu.
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        const wrapping = Array.from(el.labels ?? []).find((label) => label.contains(el));
        if (wrapping) rect = wrapping.getBoundingClientRect();
      }
      if (rect.width < minSize - 0.5 || rect.height < minSize - 0.5) {
        const text = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        const id = el.id ? `#${el.id}` : '';
        issues.push({
          label: `<${el.tagName.toLowerCase()}${id}> « ${text} »`,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        });
      }
    }
    return issues;
  }, min);
}

/**
 * Textes visuellement tronqués (ellipsis ou line-clamp qui déborde) sans `title`
 * sur l'élément ou un ancêtre. Les éléments `sr-only` sont ignorés.
 */
export function findTruncatedWithoutTitle(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      const ellipsis = style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1;
      const clamp =
        style.getPropertyValue('-webkit-line-clamp') !== 'none' &&
        style.getPropertyValue('-webkit-line-clamp') !== '' &&
        el.scrollHeight > el.clientHeight + 1;
      if (!ellipsis && !clamp) continue;
      if (el.closest('[title]')) continue;
      out.push(`<${el.tagName.toLowerCase()} class="${el.className}"> « ${(el.textContent || '').trim().slice(0, 60)} »`);
    }
    return out;
  });
}

/** Attend la fin des animations (entrée de la bottom sheet) dans le dialogue ouvert. */
export async function openDialogSettled(page: Page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        // Les animations infinies (skeletons, éclair) ne se terminent jamais : ignorées.
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ).then(() => undefined),
  );
  return dialog;
}

/** `scrollWidth - innerWidth` : > 0 signifie un scroll horizontal (PROMPT.md §3). */
export function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}
