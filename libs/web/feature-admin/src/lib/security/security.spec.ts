import { TestBed } from '@angular/core/testing';
import {
  ADMIN_NOT_FOUND_URL,
  AdminSessionStore,
  fakeAdminEnrollment,
  fakeAdminNotEnrolled,
  fakeAdminNotVerified,
  fakeAdminRecoveryCodes,
  fakeAdminSecurityStatus,
} from '@raijin/web-data-access';
import { API, STATUS, flush, navigate, settle, setupAdmin, text } from '../testing/harness';
import { groupSecret } from './enrollment.page';
import { recoveryCodesText } from './recovery-codes-list';
import { normalizeRecovery } from './verify.page';

afterEach(() => TestBed.inject(AdminSessionStore).clear());

function input(root: HTMLElement | null, selector: string): HTMLInputElement {
  const element = root?.querySelector<HTMLInputElement>(selector);
  if (!element) throw new Error(`champ absent : ${selector}`);
  return element;
}

function type(element: HTMLInputElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event('input'));
}

describe('gardes de l’espace admin', () => {
  it('admin non enrôlé : écran d’activation', async () => {
    const { harness, ctrl, router } = await setupAdmin();
    const done = navigate(router, '/admin/trafic');
    await settle();
    ctrl.expectOne(STATUS).flush(fakeAdminNotEnrolled());
    await settle();
    // L'écran d'activation relit le statut puis démarre l'enrôlement.
    ctrl.expectOne(STATUS).flush(fakeAdminNotEnrolled());
    await done;
    await flush(harness);
    ctrl.expectOne(`${API}/admin/security/enrollment`).flush(fakeAdminEnrollment());
    await flush(harness);
    expect(router.url).toBe('/admin/securite/activation');
    expect(text(harness)).toContain('Active la double authentification');
  });

  it('session non vérifiée : saisie du code avec retour', async () => {
    const { harness, ctrl, router } = await setupAdmin();
    const done = navigate(router, '/admin/sante');
    await settle();
    ctrl.expectOne(STATUS).flush(fakeAdminNotVerified());
    await settle();
    ctrl.expectOne(STATUS).flush(fakeAdminNotVerified());
    await done;
    await flush(harness);
    expect(router.url).toBe('/admin/securite/code?retour=%2Fadmin%2Fsante');
    expect(text(harness)).toContain('Confirme que c’est bien toi');
  });

  it('404 du serveur : page 404 standard, l’URL ne change pas d’espace', async () => {
    const { ctrl, router } = await setupAdmin();
    const done = navigate(router, '/admin');
    await settle();
    ctrl.expectOne(STATUS).flush({ code: 'NOT_FOUND', message: '' }, { status: 404, statusText: 'Not Found' });
    expect(await done).toBe(false);
    await settle();
    // Navigation vers une URL sans route, sans toucher la barre d'adresse (`skipLocationChange`).
    expect(router.lastSuccessfulNavigation()?.finalUrl?.toString()).toBe(ADMIN_NOT_FOUND_URL);
  });

  it('session vérifiée : la coque et ses 9 écrans s’affichent', { timeout: 15_000 }, async () => {
    const { harness, ctrl, router } = await setupAdmin();
    // Écran de la coque sans dépendance aux pages de données (admin-analytics).
    const done = navigate(router, '/admin/double-authentification');
    await settle();
    ctrl.expectOne(STATUS).flush(fakeAdminSecurityStatus());
    await done;
    await flush(harness);
    const links = Array.from(harness.routeNativeElement?.querySelectorAll('a[href^="/admin"]') ?? []).map((a) => a.textContent?.trim());
    for (const label of ['Vue d’ensemble', 'Trafic', 'SEO', 'Acquisition', 'Revenus', 'Essais', 'Utilisateurs', 'Produit', 'Santé']) {
      expect(links).toContain(label);
    }
    expect(harness.routeNativeElement?.querySelector('[aria-current="page"]')?.textContent).toContain('Double authentification');
    expect(text(harness)).toContain('Quitter l’admin');
    // Nom accessible des liens d'accueil : contient le texte visible (« Raijin SHIELD », « Admin »).
    const home = Array.from(harness.routeNativeElement?.querySelectorAll<HTMLAnchorElement>('a[href="/admin"][aria-label]') ?? []);
    expect(home.length).toBeGreaterThan(0);
    for (const link of home) {
      const name = (link.getAttribute('aria-label') ?? '').toLowerCase();
      expect(name).toContain('raijin shield');
      expect(name).toContain('admin');
    }
  });
});

describe('saisie du code', () => {
  async function openVerify(url = '/admin/securite/code?retour=%2Fadmin%2Ftrafic') {
    const setup = await setupAdmin();
    const done = navigate(setup.router, url);
    await settle();
    setup.ctrl.expectOne(STATUS).flush(fakeAdminNotVerified());
    await done;
    await flush(setup.harness);
    return setup;
  }

  it('champ TOTP : clavier numérique, remplissage automatique du code, 6 chiffres', async () => {
    const { harness } = await openVerify();
    const field = input(harness.routeNativeElement, 'input[name="totp"]');
    expect(field.getAttribute('inputmode')).toBe('numeric');
    expect(field.getAttribute('autocomplete')).toBe('one-time-code');
    type(field, '12 a3-456 7');
    expect(field.value).toBe('123456');
  });

  it('code valide : vérifie et revient à la page demandée', async () => {
    const { harness, ctrl, router } = await openVerify();
    type(input(harness.routeNativeElement, 'input[name="totp"]'), '123456');
    await settle();
    const request = ctrl.expectOne(`${API}/admin/security/verify`);
    expect(request.request.body).toEqual({ method: 'totp', code: '123456' });
    request.flush(fakeAdminSecurityStatus());
    await flush(harness);
    // La coque relit le statut en cache (vérifié) : pas de nouvelle requête.
    expect(router.url).toBe('/admin/trafic');
  });

  it('code faux : message sous le champ, pas de redirection', async () => {
    const { harness, ctrl, router } = await openVerify();
    type(input(harness.routeNativeElement, 'input[name="totp"]'), '000000');
    await settle();
    ctrl
      .expectOne(`${API}/admin/security/verify`)
      .flush({ code: 'ADMIN_2FA_INVALID', message: 'faux' }, { status: 400, statusText: 'Bad Request' });
    await flush(harness);
    expect(text(harness)).toContain('Ce code n’est pas valide');
    expect(router.url).toContain('/admin/securite/code');
  });

  it('bascule vers un code de secours', async () => {
    const { harness, ctrl } = await openVerify();
    const toggle = Array.from(harness.routeNativeElement?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('code de secours'));
    toggle?.click();
    await flush(harness);
    type(input(harness.routeNativeElement, 'input[name="recovery-code"]'), 'abcde fgh23');
    await flush(harness);
    (harness.routeNativeElement?.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await settle();
    expect(ctrl.expectOne(`${API}/admin/security/verify`).request.body).toEqual({ method: 'recovery', code: 'ABCDE-FGH23' });
  });

  it('session expirée : message dédié', async () => {
    const { harness } = await openVerify('/admin/securite/code?retour=%2Fadmin&motif=expiree');
    expect(text(harness)).toContain('Session admin expirée');
  });
});

describe('activation et codes de secours', () => {
  it('confirmation : codes de secours montrés une seule fois', async () => {
    const { harness, ctrl, router } = await setupAdmin();
    const done = navigate(router, '/admin/securite/activation');
    await settle();
    ctrl.expectOne(STATUS).flush(fakeAdminNotEnrolled());
    await done;
    await flush(harness);
    ctrl.expectOne(`${API}/admin/security/enrollment`).flush(fakeAdminEnrollment());
    await flush(harness);
    const root = harness.routeNativeElement;
    expect(root?.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(text(harness)).toContain('Clé secrète : JBSWY3DPEHPK3PXP');

    type(input(root, 'input[name="totp"]'), '654321');
    const password = input(root, 'input[name="current-password"]');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    expect(password.type).toBe('password');
    type(password, 'mot-de-passe-actuel');
    await flush(harness);
    (root?.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await settle();
    const confirm = ctrl.expectOne(`${API}/admin/security/enrollment/confirm`);
    expect(confirm.request.body).toEqual({ code: '654321', currentPassword: 'mot-de-passe-actuel' });
    confirm.flush({ status: fakeAdminSecurityStatus(), recoveryCodes: fakeAdminRecoveryCodes() });
    await flush(harness, 6);
    expect(router.url).toBe('/admin/securite/codes-de-secours');
    expect(text(harness)).toContain('ABCDE-FGH23');

    // Retour sur l'écran : les codes ne sont plus jamais remontrés.
    await router.navigateByUrl('/ailleurs');
    await router.navigateByUrl('/admin/securite/codes-de-secours');
    await flush(harness);
    expect(text(harness)).not.toContain('ABCDE-FGH23');
    expect(text(harness)).toContain('déjà été affichés');
  });

  it('mot de passe refusé : message accessible, code conservé, aucune redirection', async () => {
    const { harness, ctrl, router } = await setupAdmin();
    const done = navigate(router, '/admin/securite/activation');
    await settle();
    ctrl.expectOne(STATUS).flush(fakeAdminNotEnrolled());
    await done;
    await flush(harness);
    ctrl.expectOne(`${API}/admin/security/enrollment`).flush(fakeAdminEnrollment());
    await flush(harness);
    const root = harness.routeNativeElement;
    type(input(root, 'input[name="totp"]'), '654321');
    type(input(root, 'input[name="current-password"]'), 'faux');
    await flush(harness);
    (root?.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await settle();
    ctrl
      .expectOne(`${API}/admin/security/enrollment/confirm`)
      .flush({ code: 'AUTH_INVALID_CREDENTIALS', message: 'refusé' }, { status: 400, statusText: 'Bad Request' });
    await flush(harness);
    const field = input(root, 'input[name="current-password"]');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.value).toBe('');
    expect(root?.querySelector('[role="alert"]')?.textContent).toContain('Mot de passe incorrect');
    expect(input(root, 'input[name="totp"]').value).toBe('654321');
    expect(router.url).toBe('/admin/securite/activation');
  });

  it('formats : clé groupée, code de secours normalisé, fichier texte', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(normalizeRecovery('abcde fgh23')).toBe('ABCDE-FGH23');
    expect(normalizeRecovery('ABCDEFGH23')).toBe('ABCDE-FGH23');
    const file = recoveryCodesText(fakeAdminRecoveryCodes());
    expect(file.split('\n').filter((line) => /^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(line))).toHaveLength(10);
  });
});
