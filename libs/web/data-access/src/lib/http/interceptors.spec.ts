import { loadContracts } from '../contracts';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { CSRF_HEADER } from '@raijin/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../auth/auth.store';
import { CsrfToken } from '../auth/csrf-token';
import { CSRF_ANON, fakeSession } from '../testing/fixtures';
import { AUTH_INTERCEPTORS } from './interceptors';

const API = '/api/v1';
const expired = { code: 'AUTH_SESSION_EXPIRED', message: 'expired' };

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(withInterceptors([...AUTH_INTERCEPTORS])), provideHttpClientTesting()],
  });
  return {
    http: TestBed.inject(HttpClient),
    ctrl: TestBed.inject(HttpTestingController),
    csrf: TestBed.inject(CsrfToken),
    store: TestBed.inject(AuthStore),
  };
}

/** Laisse les promesses et microtâches se résoudre (requêtes enchaînées). */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => TestBed.inject(HttpTestingController).verify());

// Contrats (chunk à la demande) déjà chargés : les réponses se valident en microtâches.
beforeAll(() => loadContracts());

describe('credentialsInterceptor', () => {
  it('envoie les cookies à l’API seulement', () => {
    const { http, ctrl } = setup();
    http.get(`${API}/users/me`).subscribe();
    http.get('https://api.dexscreener.com/latest').subscribe();
    expect(ctrl.expectOne(`${API}/users/me`).request.withCredentials).toBe(true);
    const external = ctrl.expectOne('https://api.dexscreener.com/latest');
    expect(external.request.withCredentials).toBe(false);
    expect(external.request.headers.has(CSRF_HEADER)).toBe(false);
  });
});

describe('csrfInterceptor', () => {
  it('ajoute le jeton en mémoire sur une mutation, pas sur un GET', () => {
    const { http, ctrl, csrf } = setup();
    csrf.set('token-en-memoire-0123456789abcdefghij');
    http.post(`${API}/auth/password/change`, {}).subscribe();
    http.get(`${API}/users/me`).subscribe();
    expect(ctrl.expectOne(`${API}/auth/password/change`).request.headers.get(CSRF_HEADER)).toBe(
      'token-en-memoire-0123456789abcdefghij',
    );
    expect(ctrl.expectOne(`${API}/users/me`).request.headers.has(CSRF_HEADER)).toBe(false);
  });

  it('demande un jeton une seule fois quand il manque, pour des mutations concurrentes', async () => {
    const { http, ctrl, csrf } = setup();
    http.post(`${API}/auth/login`, {}).subscribe();
    http.post(`${API}/auth/magic-link`, {}).subscribe();
    const csrfReq = ctrl.expectOne(`${API}/auth/csrf`);
    expect(csrfReq.request.withCredentials).toBe(true);
    csrfReq.flush({ csrfToken: CSRF_ANON });
    await flushMicrotasks();
    expect(ctrl.expectOne(`${API}/auth/login`).request.headers.get(CSRF_HEADER)).toBe(CSRF_ANON);
    expect(ctrl.expectOne(`${API}/auth/magic-link`).request.headers.get(CSRF_HEADER)).toBe(CSRF_ANON);
    expect(csrf.token()).toBe(CSRF_ANON);
  });

  it('sur AUTH_CSRF_INVALID : nouveau jeton puis un seul rejeu', async () => {
    const { http, ctrl, csrf } = setup();
    csrf.set('ancien-jeton-0123456789abcdefghijklmn');
    const result = firstValueFrom(http.post(`${API}/auth/login`, {}));
    ctrl.expectOne(`${API}/auth/login`).flush({ code: 'AUTH_CSRF_INVALID', message: 'x' }, { status: 403, statusText: 'Forbidden' });
    ctrl.expectOne(`${API}/auth/csrf`).flush({ csrfToken: CSRF_ANON });
    await flushMicrotasks();
    const retry = ctrl.expectOne(`${API}/auth/login`);
    expect(retry.request.headers.get(CSRF_HEADER)).toBe(CSRF_ANON);
    retry.flush({ code: 'AUTH_CSRF_INVALID', message: 'x' }, { status: 403, statusText: 'Forbidden' });
    await expect(result).rejects.toMatchObject({ status: 403 });
    ctrl.expectNone(`${API}/auth/csrf`);
  });
});

describe('sessionRefreshInterceptor', () => {
  it('rafraîchit une seule fois et rejoue les requêtes concurrentes (file)', async () => {
    const { http, ctrl, store, csrf } = setup();
    csrf.set('ancien-jeton-0123456789abcdefghijklmn');
    const results = [
      firstValueFrom(http.get(`${API}/users/me`)),
      firstValueFrom(http.get(`${API}/suivis`)),
      firstValueFrom(http.post(`${API}/suivis`, { mint: 'x' })),
    ];
    for (const req of ctrl.match(() => true)) {
      req.flush(expired, { status: 401, statusText: 'Unauthorized' });
    }
    await flushMicrotasks();
    const refresh = ctrl.expectOne(`${API}/auth/refresh`);
    expect(refresh.request.method).toBe('POST');
    refresh.flush(fakeSession({}, 'nouveau-jeton-0123456789abcdefghijklm'));
    await flushMicrotasks();
    const retries = ctrl.match(() => true);
    expect(retries.map((r) => `${r.request.method} ${r.request.url}`).sort()).toEqual(
      ['GET /api/v1/suivis', 'GET /api/v1/users/me', 'POST /api/v1/suivis'].sort(),
    );
    // Le rejeu de la mutation porte le nouveau jeton CSRF renvoyé par le refresh.
    expect(retries.find((r) => r.request.method === 'POST')?.request.headers.get(CSRF_HEADER)).toBe(
      'nouveau-jeton-0123456789abcdefghijklm',
    );
    retries.forEach((r) => r.flush({ ok: true }));
    await expect(Promise.all(results)).resolves.toHaveLength(3);
    expect(store.isAuthenticated()).toBe(true);
  });

  it('ne rejoue qu’une fois : un nouveau 401 après refresh sort en erreur', async () => {
    const { http, ctrl } = setup();
    const result = firstValueFrom(http.get(`${API}/users/me`));
    ctrl.expectOne(`${API}/users/me`).flush(expired, { status: 401, statusText: 'Unauthorized' });
    await flushMicrotasks();
    ctrl.expectOne(`${API}/auth/csrf`).flush({ csrfToken: CSRF_ANON });
    await flushMicrotasks();
    ctrl.expectOne(`${API}/auth/refresh`).flush(fakeSession());
    await flushMicrotasks();
    ctrl.expectOne(`${API}/users/me`).flush(expired, { status: 401, statusText: 'Unauthorized' });
    await expect(result).rejects.toMatchObject({ status: 401 });
    ctrl.expectNone(`${API}/auth/refresh`);
  });

  it('refresh refusé : erreur d’origine propagée et session locale oubliée', async () => {
    const { http, ctrl, store, csrf } = setup();
    store.applySession(fakeSession());
    const result = firstValueFrom(http.get(`${API}/users/me`));
    ctrl.expectOne(`${API}/users/me`).flush(expired, { status: 401, statusText: 'Unauthorized' });
    await flushMicrotasks();
    ctrl.expectOne(`${API}/auth/refresh`).flush(expired, { status: 401, statusText: 'Unauthorized' });
    await expect(result).rejects.toMatchObject({ status: 401, url: `${API}/users/me` });
    expect(store.status()).toBe('anonymous');
    expect(csrf.token()).toBeNull();
  });

  it('refresh en 409 CONFLICT (autre onglet) : pas de déconnexion, rejeu unique avec un nouveau jeton CSRF', async () => {
    const { http, ctrl, store } = setup();
    store.applySession(fakeSession({}, 'ancien-jeton-0123456789abcdefghijklmn'));
    const result = firstValueFrom(http.post(`${API}/suivis`, { mint: 'x' }));
    ctrl.expectOne(`${API}/suivis`).flush(expired, { status: 401, statusText: 'Unauthorized' });
    await flushMicrotasks();
    ctrl.expectOne(`${API}/auth/refresh`).flush({ code: 'CONFLICT', message: 'x' }, { status: 409, statusText: 'Conflict' });
    await flushMicrotasks();
    expect(store.isAuthenticated()).toBe(true);
    // Le jeton lié à l'ancienne session est oublié : un nouveau est demandé (cookies déjà à jour).
    ctrl.expectOne(`${API}/auth/csrf`).flush({ csrfToken: CSRF_ANON });
    await flushMicrotasks();
    const retry = ctrl.expectOne(`${API}/suivis`);
    expect(retry.request.headers.get(CSRF_HEADER)).toBe(CSRF_ANON);
    retry.flush({ ok: true });
    await expect(result).resolves.toEqual({ ok: true });
    ctrl.expectNone(`${API}/auth/refresh`);
  });

  it('après un refresh refusé, la mutation suivante redemande un jeton CSRF anonyme', async () => {
    const { http, ctrl, store, csrf } = setup();
    store.applySession(fakeSession({}, 'ancien-jeton-0123456789abcdefghijklmn'));
    const me = firstValueFrom(http.get(`${API}/users/me`));
    ctrl.expectOne(`${API}/users/me`).flush(expired, { status: 401, statusText: 'Unauthorized' });
    await flushMicrotasks();
    ctrl.expectOne(`${API}/auth/refresh`).flush(expired, { status: 401, statusText: 'Unauthorized' });
    await expect(me).rejects.toMatchObject({ status: 401 });
    expect(csrf.token()).toBeNull();
    http.post(`${API}/auth/login`, {}).subscribe();
    ctrl.expectOne(`${API}/auth/csrf`).flush({ csrfToken: CSRF_ANON });
    await flushMicrotasks();
    expect(ctrl.expectOne(`${API}/auth/login`).request.headers.get(CSRF_HEADER)).toBe(CSRF_ANON);
  });

  it('pas de refresh pour un mauvais mot de passe ni pour les appels d’auth', async () => {
    const { http, ctrl, csrf } = setup();
    csrf.set(CSRF_ANON);
    const change = firstValueFrom(http.post(`${API}/auth/password/change`, {}));
    ctrl
      .expectOne(`${API}/auth/password/change`)
      .flush({ code: 'AUTH_INVALID_CREDENTIALS', message: 'x' }, { status: 401, statusText: 'Unauthorized' });
    await expect(change).rejects.toMatchObject({ status: 401 });
    ctrl.expectNone(`${API}/auth/refresh`);
  });

  it('pas de refresh sur UNAUTHORIZED (aucun cookie) ni sur un 401 hors format', async () => {
    const { http, ctrl } = setup();
    const me = firstValueFrom(http.get(`${API}/users/me`));
    ctrl.expectOne(`${API}/users/me`).flush({ code: 'UNAUTHORIZED', message: 'x' }, { status: 401, statusText: 'Unauthorized' });
    await expect(me).rejects.toMatchObject({ status: 401 });
    const raw = firstValueFrom(http.get(`${API}/suivis`));
    ctrl.expectOne(`${API}/suivis`).flush(null, { status: 401, statusText: 'Unauthorized' });
    await expect(raw).rejects.toMatchObject({ status: 401 });
    await flushMicrotasks();
    ctrl.expectNone(`${API}/auth/refresh`);
    ctrl.expectNone(`${API}/auth/csrf`);
  });

  it('rafraîchit aussi quand le corps d’erreur arrive en Blob (export des données)', async () => {
    const { http, ctrl, csrf } = setup();
    csrf.set(CSRF_ANON);
    const result = firstValueFrom(http.get(`${API}/users/me/export`, { responseType: 'blob' }));
    const blobBody = new Blob([JSON.stringify(expired)], { type: 'application/json' });
    ctrl.expectOne(`${API}/users/me/export`).flush(blobBody, { status: 401, statusText: 'Unauthorized' });
    // Lecture asynchrone du Blob (FileReader sous jsdom) : on attend que le refresh parte.
    const refresh = await vi.waitFor(() => ctrl.expectOne(`${API}/auth/refresh`));
    refresh.flush(fakeSession());
    await flushMicrotasks();
    const retry = ctrl.expectOne(`${API}/users/me/export`);
    retry.flush(new Blob(['{"ok":true}'], { type: 'application/json' }));
    await expect(result).resolves.toBeInstanceOf(Blob);
  });

  it('erreur Blob : le code est exposé en objet, un corps non JSON reste intact', async () => {
    const { http, ctrl } = setup();
    const forbidden = firstValueFrom(http.get(`${API}/users/me/export`, { responseType: 'blob' }));
    ctrl
      .expectOne(`${API}/users/me/export`)
      .flush(new Blob([JSON.stringify({ code: 'FORBIDDEN', message: 'x' })]), { status: 403, statusText: 'Forbidden' });
    await expect(forbidden).rejects.toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } });
    const garbage = firstValueFrom(http.get(`${API}/users/me/export`, { responseType: 'blob' }));
    ctrl.expectOne(`${API}/users/me/export`).flush(new Blob(['<html>']), { status: 502, statusText: 'Bad Gateway' });
    const error: unknown = await garbage.catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502 });
    expect((error as { error: unknown }).error).toBeInstanceOf(Blob);
    ctrl.expectNone(`${API}/auth/refresh`);
  });

  it('ignore les 401 d’une autre origine', async () => {
    const { http, ctrl } = setup();
    const result = firstValueFrom(http.get('https://api.helius.xyz/v0/x'));
    ctrl.expectOne('https://api.helius.xyz/v0/x').flush(null, { status: 401, statusText: 'Unauthorized' });
    await expect(result).rejects.toMatchObject({ status: 401 });
    ctrl.expectNone(`${API}/auth/refresh`);
  });
});
