import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PAGES, openPage } from './support/pages';

/** Règles WCAG 2.0/2.1/2.2 A et AA + bonnes pratiques axe. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => `${n.target.join(' ')} — ${n.failureSummary?.replace(/\s+/g, ' ')}`),
  }));
}

/** Description lisible de l'élément focalisé et de son indicateur de focus. */
function focusInfo(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    const ring = style.boxShadow !== 'none';
    return {
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      tag: el.tagName.toLowerCase(),
      visible: rect.width > 1 && rect.height > 1,
      indicator: outline || ring,
    };
  });
}

for (const { name, path } of PAGES) {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    test(`axe ${name} ${viewport.width}px : zéro violation`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openPage(page, path);
      expect(await axe(page)).toEqual([]);
    });
  }
}

for (const [label, button] of [
  ['modale', 'Ouvrir (modale)'],
  ['panneau', 'Ouvrir (panneau)'],
] as const) {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    test(`axe bottom sheet ${label} ouverte ${viewport.width}px : zéro violation`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openPage(page, '/_design');
      await page.getByRole('button', { name: button }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.waitForTimeout(300); // fin de l'animation d'entrée (220 ms)
      expect(await axe(page)).toEqual([]);
    });
  }
}

for (const viewport of [
  { width: 390, height: 844, expected: ['Aller au contenu', 'Raijin Shield, accueil', 'Notifications', 'Analyser', 'Suivis', 'Alertes', 'Compte'] },
  {
    width: 1440,
    height: 900,
    expected: ['Aller au contenu', 'Raijin Shield, accueil', 'Analyser', 'Suivis', 'Alertes', 'Compte', 'Scan de wallet', 'Replier le menu', 'Notifications'],
  },
]) {
  test(`clavier ${viewport.width}px : Tab parcourt la coquille avec un focus visible`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPage(page, '/analyse');
    const seen: string[] = [];
    for (let i = 0; i < viewport.expected.length; i++) {
      await page.keyboard.press('Tab');
      const info = await focusInfo(page);
      expect(info, `élément focalisé après ${i + 1} Tab`).not.toBeNull();
      expect(info?.visible, `« ${info?.label} » visible au focus`).toBe(true);
      expect(info?.indicator, `« ${info?.label} » a un indicateur de focus`).toBe(true);
      seen.push(info?.label ?? '');
    }
    expect(seen).toEqual(viewport.expected);
  });
}

test('clavier : le lien d’évitement envoie le focus sur le contenu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, '/analyse');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('#rj-main')).toBeFocused();
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`bottom sheet ${viewport.width}px : focus piégé, Échap ferme, focus rendu au déclencheur`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPage(page, '/_design');
    const trigger = page.getByRole('button', { name: 'Ouvrir (modale)' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Ajouter aux suivis' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Le focus entre dans le panneau, puis y reste sur 2 tours complets dans les deux sens.
    await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `Tab n°${i + 1} reste dans le panneau`).toBe(true);
      const info = await focusInfo(page);
      expect(info?.indicator, `« ${info?.label} » a un indicateur de focus`).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `Shift+Tab n°${i + 1} reste dans le panneau`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  });
}
