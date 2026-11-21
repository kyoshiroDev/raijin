import { expect, type Page } from '@playwright/test';

/** Pages testées (routes de l'app + page de référence visuelle, servie uniquement en dev). */
export const PAGES = [
  { name: 'analyse', path: '/analyse', heading: 'Analyser' },
  { name: 'suivis', path: '/suivis', heading: 'Suivis' },
  { name: 'alertes', path: '/alertes', heading: null },
  { name: 'compte', path: '/compte', heading: 'Compte' },
  { name: 'wallet', path: '/wallet', heading: 'Scan de wallet' },
  { name: 'design', path: '/_design', heading: 'Design — Raijin' },
] as const;

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
      const rect = el.getBoundingClientRect();
      // Masqué visuellement (sr-only : 1 px, clip) ou hors rendu.
      if (rect.width <= 1 || rect.height <= 1) continue;
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
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
