import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../../auth/auth.store';
import { CsrfToken } from '../../auth/csrf-token';
import { loadContracts } from '../../contracts';
import { AUTH_INTERCEPTORS } from '../../http/interceptors';
import { fakeSession } from '../../testing/fixtures';
import { isAdminApiUrl, isAdminSecurityPath, safeAdminReturn } from './admin-paths';
import { fakeAdminNotEnrolled, fakeAdminRecoveryCodes, fakeAdminSecurityStatus } from './admin-security-fixtures';
import { adminSessionInterceptor } from './admin-session.interceptor';
import { AdminSessionStore } from './admin-session.store';

const API = '/api/v1';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

@Component({ template: '' })
class Blank {}

let active: HttpTestingController | null = null;

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', component: Blank }]),
      provideHttpClient(withInterceptors([adminSessionInterceptor, ...AUTH_INTERCEPTORS])),
      provideHttpClientTesting(),
    ],
  });
  TestBed.inject(CsrfToken).set('csrf-session-token-0123456789abcdef');
  const auth = TestBed.inject(AuthStore);
  auth.applySession(fakeSession({ role: 'ADMIN' }));
  active = TestBed.inject(HttpTestingController);
  return {
    http: TestBed.inject(HttpClient),
    ctrl: active,
    store: TestBed.inject(AdminSessionStore),
    router: TestBed.inject(Router),
    auth,
  };
}

beforeAll(() => loadContracts());
afterEach(() => {
  active?.verify();
  active = null;
  vi.useRealTimers();
});

describe('chemins admin', () => {
  it('reconnaît les routes admin de l’API', () => {
    expect(isAdminApiUrl(`${API}/admin/overview`, API)).toBe(true);
    expect(isAdminApiUrl(`${API}/administration`, API)).toBe(false);
    expect(isAdminApiUrl(`${API}/users/me`, API)).toBe(false);
  });

  it('n’accepte comme retour qu’un écran de la coque admin', () => {
    expect(safeAdminReturn('/admin/trafic?period=30d')).toBe('/admin/trafic?period=30d');
    expect(safeAdminReturn('/admin')).toBe('/admin');
    expect(safeAdminReturn('https://evil.example/admin')).toBe('/admin');
    expect(safeAdminReturn('//evil.example')).toBe('/admin');
    expect(safeAdminReturn('/administrateur')).toBe('/admin');
    expect(safeAdminReturn('/admin/securite/code')).toBe('/admin');
    expect(safeAdminReturn(null)).toBe('/admin');
    expect(isAdminSecurityPath('/admin/securite/code?retour=x')).toBe(true);
  });
});

describe('adminSessionInterceptor', () => {
  it('403 ADMIN_SESSION_EXPIRED : aucun refresh, données effacées, écran du code avec retour', async () => {
    const { http, ctrl, store, router } = setup();
    store.applyStatus(fakeAdminSecurityStatus());
    await router.navigateByUrl('/admin/trafic');
    const reset = vi.fn();
    store.onReset(reset);

    const result = firstValueFrom(http.get(`${API}/admin/traffic`)).catch((error: unknown) => error);
    ctrl.expectOne(`${API}/admin/traffic`).flush(
      { code: 'ADMIN_SESSION_EXPIRED', message: 'expirée' },
      { status: 403, statusText: 'Forbidden' },
    );
    expect(await result).toMatchObject({ status: 403 });
    ctrl.expectNone(`${API}/auth/refresh`);
    await settle();

    expect(reset).toHaveBeenCalledTimes(1);
    expect(store.verified()).toBe(false);
    expect(store.lockReason()).toBe('expired');
    expect(router.url).toBe('/admin/securite/code?retour=%2Fadmin%2Ftrafic&motif=expiree');
  });

  it('403 ADMIN_2FA_ENROLLMENT_REQUIRED : écran d’activation', async () => {
    const { http, ctrl, store, router } = setup();
    store.applyStatus(fakeAdminSecurityStatus());
    await router.navigateByUrl('/admin');
    http.get(`${API}/admin/overview`).subscribe({ error: () => undefined });
    ctrl.expectOne(`${API}/admin/overview`).flush(
      { code: 'ADMIN_2FA_ENROLLMENT_REQUIRED', message: '' },
      { status: 403, statusText: 'Forbidden' },
    );
    ctrl.expectNone(`${API}/auth/refresh`);
    await settle();
    expect(router.url).toBe('/admin/securite/activation');
  });

  it('un 403 d’une autre route ou d’un autre code ne verrouille rien', async () => {
    const { http, ctrl, store } = setup();
    store.applyStatus(fakeAdminSecurityStatus());
    http.get(`${API}/admin/users`).subscribe({ error: () => undefined });
    ctrl.expectOne(`${API}/admin/users`).flush({ code: 'FORBIDDEN', message: '' }, { status: 403, statusText: 'Forbidden' });
    http.get(`${API}/watches`).subscribe({ error: () => undefined });
    ctrl.expectOne(`${API}/watches`).flush(
      { code: 'ADMIN_SESSION_EXPIRED', message: '' },
      { status: 403, statusText: 'Forbidden' },
    );
    await settle();
    expect(store.verified()).toBe(true);
  });

  it('une réponse admin réussie prolonge le minuteur d’inactivité', () => {
    vi.useFakeTimers({ now: new Date('2026-11-22T10:00:00Z') });
    const { http, ctrl, store } = setup();
    store.applyStatus(fakeAdminSecurityStatus({ idleExpiresAt: '2026-11-22T10:30:00.000Z' }));
    vi.setSystemTime(new Date('2026-11-22T10:20:00Z'));
    http.get(`${API}/admin/overview`).subscribe();
    ctrl.expectOne(`${API}/admin/overview`).flush({});
    expect(store.expiresAt()).toBe(Date.parse('2026-11-22T10:50:00Z'));
  });
});

describe('AdminSessionStore', () => {
  it('lit le statut une fois et le garde en cache', async () => {
    const { ctrl, store } = setup();
    const first = store.ensureStatus();
    const second = store.ensureStatus();
    await settle();
    ctrl.expectOne(`${API}/admin/security/status`).flush(fakeAdminNotEnrolled());
    expect(await first).toBe('ready');
    expect(await second).toBe('ready');
    expect(store.enrolled()).toBe(false);
    expect(await store.ensureStatus()).toBe('ready');
    ctrl.expectNone(`${API}/admin/security/status`);
  });

  it('404 du statut : espace invisible (not_found)', async () => {
    const { ctrl, store } = setup();
    const state = store.ensureStatus();
    await settle();
    ctrl.expectOne(`${API}/admin/security/status`).flush({ code: 'NOT_FOUND', message: '' }, { status: 404, statusText: 'Not Found' });
    expect(await state).toBe('not_found');
  });

  it('expire la session à l’échéance d’inactivité et masque les données', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-22T10:00:00Z') });
    const { store, router } = setup();
    await router.navigateByUrl('/admin/sante');
    const reset = vi.fn();
    store.onReset(reset);
    store.applyStatus(fakeAdminSecurityStatus({ idleExpiresAt: '2026-11-22T10:30:00.000Z' }));
    vi.advanceTimersByTime(29 * 60_000);
    expect(store.verified()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(store.verified()).toBe(false);
    expect(store.lockReason()).toBe('expired');
    expect(reset).toHaveBeenCalled();
    vi.useRealTimers();
    await settle();
    expect(router.url).toContain('/admin/securite/code');
    expect(router.url).toContain('motif=expiree');
  });

  it('plafonne le minuteur par la fin absolue de la session', () => {
    vi.useFakeTimers({ now: new Date('2026-11-22T10:00:00Z') });
    const { store } = setup();
    store.applyStatus(
      fakeAdminSecurityStatus({ idleExpiresAt: '2026-11-22T10:30:00.000Z', absoluteExpiresAt: '2026-11-22T10:10:00.000Z' }),
    );
    expect(store.expiresAt()).toBe(Date.parse('2026-11-22T10:10:00Z'));
  });

  it('montre les codes de secours une seule fois', () => {
    const { store } = setup();
    const codes = fakeAdminRecoveryCodes();
    store.setPendingRecoveryCodes(codes);
    expect(store.takePendingRecoveryCodes()).toBe(codes);
    expect(store.takePendingRecoveryCodes()).toBeNull();
  });

  it('oublie tout à la déconnexion', async () => {
    const { store, auth } = setup();
    store.applyStatus(fakeAdminSecurityStatus());
    TestBed.tick();
    auth.clear();
    TestBed.tick();
    await settle();
    expect(store.status()).toBeNull();
    expect(store.state()).toBe('idle');
  });

  it('signale les codes de secours presque épuisés', () => {
    const { store } = setup();
    store.applyStatus(fakeAdminSecurityStatus({ recoveryCodesRemaining: 2 }));
    expect(store.recoveryCodesLow()).toBe(true);
  });
});
