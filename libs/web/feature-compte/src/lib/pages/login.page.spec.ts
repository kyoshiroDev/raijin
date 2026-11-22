import { CSRF_HEADER } from '@raijin/shared-contracts';
import { fakeSession } from '@raijin/web-data-access';
import { API, query, queryAll, settle, setupFeature, submitForm, type, waitFor } from '../testing/harness';

// Premier chargement des écrans lazy : lent quand la machine compile en parallèle.
vi.setConfig({ testTimeout: 30_000 });

describe('LoginPage', () => {
  it('champs mobiles : 16 px, autocomplete, afficher/masquer le mot de passe', async () => {
    const { harness } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/connexion');
    const email = query<HTMLInputElement>(harness, 'input[name="email"]');
    const password = query<HTMLInputElement>(harness, 'input[name="password"]');
    expect(email?.type).toBe('email');
    expect(email?.getAttribute('autocomplete')).toBe('email');
    expect(email?.className).toContain('text-input');
    expect(password?.getAttribute('autocomplete')).toBe('current-password');
    expect(password?.type).toBe('password');
    const toggle = query<HTMLButtonElement>(harness, 'button[aria-label="Afficher le mot de passe"]');
    toggle?.click();
    await harness.fixture.whenStable();
    expect(password?.type).toBe('text');
    expect(toggle?.getAttribute('aria-label')).toBe('Masquer le mot de passe');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    // Un seul bouton jaune sur l'écran
    expect(queryAll(harness, '.bg-thunder')).toHaveLength(1);
  });

  it('formulaire invalide : erreurs reliées par aria-describedby, aucun appel API', async () => {
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/connexion');
    type(harness, 'Adresse e-mail', 'pas-un-email');
    submitForm(harness);
    await harness.fixture.whenStable();
    const email = query<HTMLInputElement>(harness, 'input[name="email"]');
    expect(email?.getAttribute('aria-invalid')).toBe('true');
    const message = query(harness, `#${email?.getAttribute('aria-describedby')}`);
    expect(message?.textContent).toContain('Adresse e-mail invalide.');
    expect(query(harness, 'input[name="password"]')?.getAttribute('aria-invalid')).toBe('true');
    ctrl.expectNone(`${API}/auth/login`);
  });

  it('identifiants refusés : message neutre annoncé (role=alert)', async () => {
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/connexion');
    type(harness, 'Adresse e-mail', 'kenji@exemple.fr');
    type(harness, 'Mot de passe', 'mauvais');
    submitForm(harness);
    const req = ctrl.expectOne(`${API}/auth/login`);
    expect(req.request.headers.has(CSRF_HEADER)).toBe(true);
    expect(req.request.withCredentials).toBe(true);
    req.flush({ code: 'AUTH_INVALID_CREDENTIALS', message: 'x' }, { status: 401, statusText: 'Unauthorized' });
    await settle();
    await harness.fixture.whenStable();
    expect(query(harness, '[role="alert"]')?.textContent).toContain('E-mail ou mot de passe incorrect.');
    ctrl.expectNone(`${API}/auth/refresh`);
  });

  it('succès : retour vers redirect validé', async () => {
    const { harness, ctrl, router, store } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/connexion?redirect=%2Fsuivis');
    type(harness, 'Adresse e-mail', 'Kenji@Exemple.fr');
    type(harness, 'Mot de passe', 'une phrase assez longue');
    submitForm(harness);
    const req = ctrl.expectOne(`${API}/auth/login`);
    expect(req.request.body).toEqual({ email: 'kenji@exemple.fr', password: 'une phrase assez longue' });
    req.flush(fakeSession());
    await settle();
    await settle();
    expect(store.isAuthenticated()).toBe(true);
    expect(router.url).toBe('/suivis');
  });

  it('anti-redirection ouverte : une URL externe renvoie vers Compte', async () => {
    const { harness, ctrl, router } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/connexion?redirect=https%3A%2F%2Fevil.example');
    type(harness, 'Adresse e-mail', 'kenji@exemple.fr');
    type(harness, 'Mot de passe', 'une phrase assez longue');
    submitForm(harness);
    ctrl.expectOne(`${API}/auth/login`).flush(fakeSession());
    await waitFor(() => router.url === '/compte');
    expect(router.url).toBe('/compte');
    ctrl.match(() => true).forEach((r) => r.flush({}));
  });

  it('les liens gardent un redirect nettoyé', async () => {
    const { harness } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/connexion?redirect=%2F%2Fevil.example');
    const signup = queryAll(harness, 'a').find((a) => a.textContent?.includes('Créer un compte'));
    expect(signup?.getAttribute('href')).toBe('/compte/inscription?redirect=%2Fcompte');
  });
});
