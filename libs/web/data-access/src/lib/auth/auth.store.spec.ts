import { loadContracts } from '../contracts';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AUTH_INTERCEPTORS } from '../http/interceptors';
import { CSRF_ANON, fakeSession, fakeSessionState, fakeUser } from '../testing/fixtures';
import { AuthStore } from './auth.store';
import { CsrfToken } from './csrf-token';

const API = '/api/v1';
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));
const unauthorized = { status: 401, statusText: 'Unauthorized' };

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(withInterceptors([...AUTH_INTERCEPTORS])), provideHttpClientTesting()],
  });
  return { store: TestBed.inject(AuthStore), ctrl: TestBed.inject(HttpTestingController), csrf: TestBed.inject(CsrfToken) };
}

afterEach(() => TestBed.inject(HttpTestingController).verify());

// Contrats (chunk à la demande) déjà chargés : les réponses se valident en microtâches.
beforeAll(() => loadContracts());

describe('AuthStore', () => {
  it('démarre inconnu puis récupère la session (utilisateur, jeton CSRF en mémoire)', async () => {
    const { store, ctrl, csrf } = setup();
    expect(store.status()).toBe('idle');
    expect(store.isLoading()).toBe(true);
    const ready = store.init();
    expect(store.status()).toBe('loading');
    ctrl.expectOne(`${API}/auth/session`).flush(fakeSessionState(fakeSession({ emailVerified: false })));
    await ready;
    expect(store.isAuthenticated()).toBe(true);
    expect(store.user()?.email).toBe('kenji@exemple.fr');
    expect(store.emailVerified()).toBe(false);
    expect(csrf.token()).toBe('csrf-session-token-0123456789abcdef');
    // init est idempotent
    expect(store.init()).toBe(ready);
    expect(store.whenReady()).toBe(ready);
  });

  it('visiteur sans cookie de session : 200 { authenticated: false }, anonyme sans refresh ni erreur', async () => {
    const { store, ctrl, csrf } = setup();
    const ready = store.whenReady();
    ctrl.expectOne(`${API}/auth/session`).flush(fakeSessionState(null));
    await ready;
    expect(store.status()).toBe('anonymous');
    expect(store.user()).toBeNull();
    expect(csrf.token()).toBeNull();
    ctrl.expectNone(`${API}/auth/refresh`);
  });

  it('réponse de session hors contrat (sans `authenticated`) : état error', async () => {
    const { store, ctrl } = setup();
    const ready = store.init();
    ctrl.expectOne(`${API}/auth/session`).flush(fakeSession());
    await ready;
    expect(store.status()).toBe('error');
  });

  it('visiteur jamais connecté (UNAUTHORIZED, ancienne API) : anonyme sans tenter de refresh', async () => {
    const { store, ctrl } = setup();
    const ready = store.whenReady();
    ctrl.expectOne(`${API}/auth/session`).flush({ code: 'UNAUTHORIZED', message: 'x' }, unauthorized);
    await ready;
    expect(store.status()).toBe('anonymous');
    expect(store.user()).toBeNull();
    ctrl.expectNone(`${API}/auth/refresh`);
  });

  it('session expirée : un refresh tenté, refusé, puis anonyme', async () => {
    const { store, ctrl } = setup();
    const ready = store.whenReady();
    ctrl.expectOne(`${API}/auth/session`).flush({ code: 'AUTH_SESSION_EXPIRED', message: 'x' }, unauthorized);
    await flushMicrotasks();
    ctrl.expectOne(`${API}/auth/csrf`).flush({ csrfToken: CSRF_ANON });
    await flushMicrotasks();
    ctrl.expectOne(`${API}/auth/refresh`).flush({ code: 'UNAUTHORIZED', message: 'x' }, unauthorized);
    await ready;
    expect(store.status()).toBe('anonymous');
  });

  it('session expirée : refresh réussi, session rétablie', async () => {
    const { store, ctrl, csrf } = setup();
    csrf.set(CSRF_ANON);
    const ready = store.whenReady();
    ctrl.expectOne(`${API}/auth/session`).flush({ code: 'AUTH_SESSION_EXPIRED', message: 'x' }, unauthorized);
    await flushMicrotasks();
    ctrl.expectOne(`${API}/auth/refresh`).flush(fakeSession());
    await flushMicrotasks();
    ctrl.expectOne(`${API}/auth/session`).flush(fakeSessionState());
    await ready;
    expect(store.isAuthenticated()).toBe(true);
  });

  it('API injoignable : état error, puis réessai forcé', async () => {
    const { store, ctrl } = setup();
    const ready = store.init();
    ctrl.expectOne(`${API}/auth/session`).error(new ProgressEvent('error'));
    await ready;
    expect(store.status()).toBe('error');
    const retry = store.init(true);
    ctrl.expectOne(`${API}/auth/session`).flush(fakeSessionState());
    await retry;
    expect(store.isAuthenticated()).toBe(true);
  });

  it('login applique la session ; une session invalide (schéma) est rejetée', async () => {
    const { store, ctrl, csrf } = setup();
    csrf.set(CSRF_ANON);
    const login = store.login({ email: 'kenji@exemple.fr', password: 'une phrase assez longue' });
    const req = ctrl.expectOne(`${API}/auth/login`);
    expect(req.request.body).toEqual({ email: 'kenji@exemple.fr', password: 'une phrase assez longue' });
    req.flush(fakeSession());
    await expect(login).resolves.toMatchObject({ email: 'kenji@exemple.fr' });
    expect(store.isAuthenticated()).toBe(true);

    const bad = store.verifyMagicLink('a'.repeat(43));
    ctrl.expectOne(`${API}/auth/magic-link/verify`).flush({ user: { id: 'pas-un-uuid' } });
    await expect(bad).rejects.toBeTruthy();
  });

  it('déconnexion : session oubliée même si l’API échoue', async () => {
    const { store, ctrl, csrf } = setup();
    store.applySession(fakeSession());
    const logout = store.logout();
    await flushMicrotasks();
    ctrl.expectOne(`${API}/auth/logout`).flush(null, { status: 500, statusText: 'Error' });
    await logout;
    expect(store.status()).toBe('anonymous');
    expect(csrf.token()).toBeNull();
  });

  it('renvoi de vérification : corps vide connecté, e-mail sinon', async () => {
    const { store, ctrl, csrf } = setup();
    csrf.set(CSRF_ANON);
    void store.resendVerification('kenji@exemple.fr');
    ctrl.expectOne(`${API}/auth/verify-email/resend`).flush({ message: 'ok' });
    // (premier appel anonyme : e-mail envoyé)
    store.applySession(fakeSession());
    void store.resendVerification('autre@exemple.fr');
    expect(ctrl.expectOne(`${API}/auth/verify-email/resend`).request.body).toEqual({});
  });

  it('réinitialisation et suppression : session locale oubliée', async () => {
    const { store, ctrl, csrf } = setup();
    store.applySession(fakeSession());
    const reset = store.resetPassword({ token: 'a'.repeat(43), password: 'nouvelle phrase longue' });
    ctrl.expectOne(`${API}/auth/password/reset`).flush(null, { status: 204, statusText: 'No Content' });
    await reset;
    expect(store.status()).toBe('anonymous');

    store.applySession(fakeSession());
    csrf.set(CSRF_ANON);
    const del = store.deleteAccount({ password: 'mon mot de passe' });
    const req = ctrl.expectOne(`${API}/users/me`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.body).toEqual({ password: 'mon mot de passe' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await del;
    expect(store.isAuthenticated()).toBe(false);
  });

  it('lien magique : session + redirectPath renvoyé par l’API', async () => {
    const { store, ctrl, csrf } = setup();
    csrf.set(CSRF_ANON);
    const verify = store.verifyMagicLink('a'.repeat(43));
    ctrl.expectOne(`${API}/auth/magic-link/verify`).flush({ ...fakeSession(), redirectPath: '/suivis' });
    await expect(verify).resolves.toMatchObject({ redirectPath: '/suivis', user: { email: 'kenji@exemple.fr' } });
    expect(store.isAuthenticated()).toBe(true);
  });

  it('relit le profil et exporte les données', async () => {
    const { store, ctrl } = setup();
    store.applySession(fakeSession({ emailVerified: false }));
    const reload = store.reloadUser();
    ctrl.expectOne(`${API}/users/me`).flush(fakeUser({ emailVerified: true }));
    await reload;
    expect(store.emailVerified()).toBe(true);
    const exported = store.exportData();
    const req = ctrl.expectOne(`${API}/users/me/export`);
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['{}'], { type: 'application/json' }));
    await expect(exported).resolves.toBeInstanceOf(Blob);
  });

  it('n’écrit rien dans le stockage du navigateur', async () => {
    const { store, ctrl } = setup();
    localStorage.clear();
    sessionStorage.clear();
    const ready = store.init();
    ctrl.expectOne(`${API}/auth/session`).flush(fakeSessionState());
    await ready;
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
