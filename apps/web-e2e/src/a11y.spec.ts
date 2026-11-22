import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { MINTS, expectVerdict, useFreshIp } from './support/analysis';
import { loginViaApi } from './support/auth';
import { PAGES, openDialogSettled, openEntry, openPage, seededAccount, sharedVerifiedAccount } from './support/pages';
import { WALLETS, scanButton, walletField, walletTrialAccount } from './support/wallet';
import { SHELLLESS_PAGES } from './support/admin-pages';

/** Règles WCAG 2.0/2.1/2.2 A et AA + bonnes pratiques axe. */
/**
 * axe met 10 à 14 s sur /_design (page longue, deux aperçus de sidebar) et davantage sur une machine
 * chargée : délai porté à 90 s pour tout le fichier, au lieu des 30 s par défaut.
 */
test.describe.configure({ timeout: 90_000 });

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

// Phase 6 bis : 9 écrans admin, écrans 2FA et landing (bannière de consentement affichée).
for (const entry of [...PAGES, ...SHELLLESS_PAGES]) {
  const { name } = entry;
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    test(`axe ${name} ${viewport.width}px : zéro violation`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openEntry(page, entry);
      expect(await axe(page)).toEqual([]);
    });
  }
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`axe analyse : accordéon déplié et « En savoir plus » ouvert ${viewport.width}px : zéro violation`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await useFreshIp(page);
    await openPage(page, `/analyse/${MINTS.honeypot}`);
    await expectVerdict(page, 'Danger');
    await page.getByRole('button', { name: /^Revente possible/ }).click();
    await expect(page.getByRole('region', { name: /Revente possible/ })).toBeVisible();
    expect(await axe(page), 'accordéon déplié').toEqual([]);
    await page.getByRole('button', { name: 'En savoir plus : Revente possible' }).click();
    await openDialogSettled(page);
    expect(await axe(page), 'bottom sheet ouverte').toEqual([]);
  });
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
      await openDialogSettled(page);
      expect(await axe(page)).toEqual([]);
    });
  }
}

for (const viewport of [
  {
    width: 390,
    height: 844,
    expected: ['Aller au contenu', 'Raijin Shield, accueil', 'Notifications', 'Analyser un token', 'Mes suivis', 'Analyser', 'Suivis', 'Alertes', 'Compte'],
  },
  {
    width: 1440,
    height: 900,
    expected: ['Aller au contenu', 'Raijin Shield, accueil', 'Analyser', 'Suivis', 'Alertes', 'Compte', 'Scan de wallet', 'Replier le menu', 'Notifications'],
  },
]) {
  test(`clavier ${viewport.width}px : Tab parcourt la coquille avec un focus visible`, async ({ page }) => {
    await page.setViewportSize(viewport);
    // Page 404 (publique, deux liens dans le contenu) : sous 1024 px la barre d'onglets suit <main> dans l'ordre
    // du DOM. Depuis la phase 4, /suivis exige une session (un visiteur est renvoyé vers la connexion).
    await openPage(page, '/cette-page-n-existe-pas');
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

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`clavier ${viewport.width}px : formulaire de connexion (ordre, focus visible, Entrée, erreurs)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPage(page, '/compte/connexion');
    const email = page.getByLabel('Adresse e-mail');
    const password = page.getByLabel('Mot de passe', { exact: true });
    await email.focus();
    const expected = [
      'Mot de passe',
      'Afficher le mot de passe',
      'Mot de passe oublié ?',
      'Se connecter',
      'Recevoir un lien de connexion',
      'Créer un compte',
    ];
    const seen: string[] = [];
    for (let i = 0; i < expected.length; i++) {
      await page.keyboard.press('Tab');
      const info = await focusInfo(page);
      expect(info?.visible, `« ${info?.label} » visible au focus`).toBe(true);
      expect(info?.indicator, `« ${info?.label} » a un indicateur de focus`).toBe(true);
      const label = await page.evaluate(() => {
        const el = document.activeElement as HTMLInputElement | null;
        if (!el) return '';
        const byLabel = el.labels?.[0]?.textContent;
        return (el.getAttribute('aria-label') || byLabel || el.textContent || '').trim().replace(/\s+/g, ' ');
      });
      seen.push(label.replace(/\u00a0/g, ' ').replace(/ \*$/, ''));
    }
    expect(seen).toEqual(expected);

    // Entrée sur un formulaire vide : le focus va au premier champ en erreur.
    await email.focus();
    await page.keyboard.press('Enter');
    await expect(email).toBeFocused();
    await expect(email).toHaveAttribute('aria-invalid', 'true');

    // Saisie et envoi au clavier : l'erreur serveur est annoncée (role=alert).
    await page.keyboard.type('inconnu-clavier@exemple.fr');
    await page.keyboard.press('Tab');
    await expect(password).toBeFocused();
    await page.keyboard.type('mauvais mot de passe clavier');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('E-mail ou mot de passe incorrect.', { timeout: 15_000 });
  });

  test(`clavier ${viewport.width}px : bottom sheet de suppression du compte (focus piégé, Échap, retour)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { email, password } = await sharedVerifiedAccount();
    await loginViaApi(page.context().request, email, password);
    await openPage(page, '/compte');
    const trigger = page.getByRole('button', { name: 'Supprimer le compte' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Supprimer ton compte' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `Tab n°${i + 1} reste dans le panneau`).toBe(true);
      const info = await focusInfo(page);
      expect(info?.indicator, `« ${info?.label} » a un indicateur de focus`).toBe(true);
    }
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `Shift+Tab n°${i + 1} reste dans le panneau`).toBe(true);
    }
    // Le champ caché `username` (gestionnaires de mots de passe) n'est jamais focalisable.
    expect(await dialog.locator('input[name="username"]').evaluate((el) => el === document.activeElement)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test(`axe bottom sheet suppression du compte ${viewport.width}px : zéro violation`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { email, password } = await sharedVerifiedAccount();
    await loginViaApi(page.context().request, email, password);
    await openPage(page, '/compte');
    await page.getByRole('button', { name: 'Supprimer le compte' }).click();
    await openDialogSettled(page);
    expect(await axe(page)).toEqual([]);
  });
}

/**
 * Comme `focusInfo`, pour les contrôles natifs masqués visuellement (`sr-only`, boutons radio et cases des
 * filtres) : la cible visible et l'indicateur de focus sont portés par le `<label>` qui les englobe.
 */
function controlFocusInfo(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return null;
    const own = active.getBoundingClientRect();
    const el = own.width <= 1 || own.height <= 1 ? (active.closest('label') ?? active) : active;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    const ring = style.boxShadow !== 'none';
    return {
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      visible: rect.width > 1 && rect.height > 1,
      indicator: outline || ring,
    };
  });
}

test('clavier 390px : bottom sheet des filtres d’alertes (focus piégé, cases et boutons radio, Échap, retour)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { email, password } = await seededAccount('alertes');
  await loginViaApi(page.context().request, email, password);
  await openPage(page, '/alertes');
  await expect(page.locator('ul[aria-label="Alertes"] > li').first()).toBeVisible({ timeout: 15_000 });
  const trigger = page.getByRole('button', { name: /^Filtres/ });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Filtres' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `Tab n°${i + 1} reste dans le panneau`).toBe(true);
    const info = await controlFocusInfo(page);
    expect(info?.visible, `« ${info?.label} » visible au focus`).toBe(true);
    expect(info?.indicator, `« ${info?.label} » a un indicateur de focus`).toBe(true);
  }
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `Shift+Tab n°${i + 1} reste dans le panneau`).toBe(true);
  }
  // Boutons radio de l'état : flèches ; case de type : Espace. Les filtres passent dans l'URL.
  await dialog.getByRole('radio', { name: 'Toutes' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('radio', { name: 'Non lues' })).toBeChecked();
  await expect(page).toHaveURL(/statut=non-lues/);
  const lp = dialog.getByRole('checkbox', { name: 'Liquidité retirée' });
  await lp.focus();
  await page.keyboard.press('Space');
  await expect(lp).toBeChecked();
  await expect(page).toHaveURL(/type=lp_removed/);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText(/Filtres \(2\)/);
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`clavier ${viewport.width}px : interrupteurs des préférences (Tab, focus visible, Espace et Entrée)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { email, password } = await seededAccount('pro');
    await loginViaApi(page.context().request, email, password);
    await openPage(page, '/compte?section=notifications');
    await expect(page.locator('#rj-notifications-title')).toBeFocused({ timeout: 15_000 });
    // Phase 6 : « E-mails de l’essai » entre le résumé hebdomadaire et le push.
    const expected = ['Alertes par e-mail', 'Résumé hebdomadaire', 'E-mails de l’essai', 'Notifications push'];
    for (const name of expected) {
      await page.keyboard.press('Tab');
      const sw = page.getByRole('switch', { name });
      const active = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el ? `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}> « ${(el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)} »` : 'aucun';
      });
      await expect(sw, `élément focalisé : ${active}`).toBeFocused();
      const info = await focusInfo(page);
      expect(info?.indicator, `« ${name} » a un indicateur de focus`).toBe(true);
    }
    const digest = page.getByRole('switch', { name: 'Résumé hebdomadaire' });
    const before = await digest.getAttribute('aria-checked');
    await digest.focus();
    await page.keyboard.press('Space');
    await expect(digest).not.toHaveAttribute('aria-checked', before ?? '');
    await expect(digest).not.toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Enter');
    await expect(digest).toHaveAttribute('aria-checked', before ?? '');
    await expect(digest).not.toHaveAttribute('aria-busy', 'true');
  });
}


/** Description de l'élément focalisé (nom accessible ou texte). */
function activeLabel(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null;
    if (!el || el === document.body) return '';
    return (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.textContent || '').trim().replace(/\s+/g, ' ');
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`clavier ${viewport.width}px : formulaire du scan de wallet et boutons de copie (Tab, focus visible, Entrée, Espace)`, async ({ page, context }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { email, password } = await walletTrialAccount();
    await loginViaApi(context.request, email, password);
    await openPage(page, '/wallet');
    const field = walletField(page);
    await expect(field).toBeVisible({ timeout: 15_000 });

    // Champ → « Coller » → « Scanner », focus visible à chaque étape.
    await field.focus();
    await page.keyboard.type(WALLETS.delegation);
    for (const expected of ['Coller dans le champ Adresse publique du wallet', 'Scanner']) {
      await page.keyboard.press('Tab');
      expect(await activeLabel(page)).toBe(expected);
      const info = await focusInfo(page);
      expect(info?.visible, `« ${expected} » visible au focus`).toBe(true);
      expect(info?.indicator, `« ${expected} » a un indicateur de focus`).toBe(true);
    }
    // Entrée depuis le champ envoie le formulaire.
    await field.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-delegation]')).toHaveCount(3, { timeout: 30_000 });
    await expect(scanButton(page)).toBeEnabled();

    // Boutons de copie atteints au clavier depuis le bouton « Scanner » (ordre du DOM, avant tout autre contenu du résultat).
    const copyButtons = page.locator('[data-delegations] rj-address-chip button');
    await expect(copyButtons).toHaveCount(3);
    await scanButton(page).focus();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await copyButtons.first().evaluate((el) => el === document.activeElement);
    }
    expect(reached, 'premier bouton « Copier l’adresse » atteint au clavier').toBe(true);
    const info = await focusInfo(page);
    expect(info?.visible).toBe(true);
    expect(info?.indicator, 'bouton de copie : indicateur de focus').toBe(true);
    const firstDelegate = await page.locator('[data-delegations] rj-address-chip').first().locator('[title]').first().getAttribute('title');
    await page.keyboard.press('Enter');
    await expect(copyButtons.first()).toHaveText(/Copié/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(firstDelegate);

    // Bouton suivant à l'Espace.
    let next = false;
    for (let i = 0; i < 10 && !next; i++) {
      await page.keyboard.press('Tab');
      next = await copyButtons.nth(1).evaluate((el) => el === document.activeElement);
    }
    expect(next, 'deuxième bouton « Copier l’adresse » atteint au clavier').toBe(true);
    const secondDelegate = await page.locator('[data-delegations] rj-address-chip').nth(1).locator('[title]').first().getAttribute('title');
    await page.keyboard.press('Space');
    await expect(copyButtons.nth(1)).toHaveText(/Copié/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secondDelegate);
  });
}
