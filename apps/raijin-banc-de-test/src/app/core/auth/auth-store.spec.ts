import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { BENCH_ROUTES, type BenchSession } from '@raijin/bench-contracts';
import { describe, expect, it, vi } from 'vitest';
import { BenchApi, BENCH_COOKIES, BENCH_FETCH } from '../api/bench-api';
import { FakeBenchApi, apiError, provideFakeBench } from '../api/bench-api.testing';
import { authGuard, guestGuard } from './auth-guard';
import { AuthStore, parseBenchSession } from './auth-store';

const SESSION: BenchSession = { email: 'me@example.com', mode: 'shadow', expiresAt: '2026-11-24T20:00:00.000Z' };
const LOGIN = { email: 'me@example.com', password: 'pw', totp: '123456' };

function setup(api: FakeBenchApi) {
  TestBed.configureTestingModule({ providers: [provideRouter([]), ...provideFakeBench(api)] });
  return TestBed.inject(AuthStore);
}

describe('parseBenchSession', () => {
  it('keeps a valid session and rejects anything else', () => {
    expect(parseBenchSession(SESSION)).toEqual(SESSION);
    expect(parseBenchSession({ ...SESSION, mode: 'other' })).toBeNull();
    expect(parseBenchSession({ ...SESSION, expiresAt: 'demain' })).toBeNull();
    expect(parseBenchSession(null)).toBeNull();
  });
});

describe('AuthStore', () => {
  it('reads the current session at start-up (anonymous call: a 401 is not a redirect)', async () => {
    const api = new FakeBenchApi().on('GET', BENCH_ROUTES.authSession, SESSION);
    const store = setup(api);
    await store.whenReady();
    expect(store.isAuthenticated()).toBe(true);
    expect(store.email()).toBe('me@example.com');
    expect(store.mode()).toBe('shadow');
    expect(api.callsTo('GET', BENCH_ROUTES.authSession)).toHaveLength(1);
  });

  it('starts signed out when the session is missing', async () => {
    const api = new FakeBenchApi().on('GET', BENCH_ROUTES.authSession, () => {
      throw apiError(401, 'AUTH_SESSION_EXPIRED');
    });
    const store = setup(api);
    await store.whenReady();
    expect(store.ready()).toBe(true);
    expect(store.isAuthenticated()).toBe(false);
  });

  it('signs in with password + TOTP in one step', async () => {
    const api = new FakeBenchApi()
      .on('GET', BENCH_ROUTES.authSession, () => {
        throw apiError(401);
      })
      .on('POST', BENCH_ROUTES.authLogin, SESSION);
    const store = setup(api);
    await store.whenReady();
    expect(await store.signIn(LOGIN)).toBe('ok');
    expect(api.callsTo('POST', BENCH_ROUTES.authLogin)[0]?.body).toEqual(LOGIN);
    expect(store.isAuthenticated()).toBe(true);
  });

  it.each([
    [401, 'invalid'],
    [400, 'invalid'],
    [429, 'throttled'],
    [500, 'error'],
    [0, 'error'],
  ] as const)('maps a %i on sign-in to « %s »', async (status, expected) => {
    const api = new FakeBenchApi().on('POST', BENCH_ROUTES.authLogin, () => {
      throw apiError(status);
    });
    const store = setup(api);
    expect(await store.signIn(LOGIN)).toBe(expected);
    expect(store.isAuthenticated()).toBe(false);
  });

  it('signs out even when the API is unreachable', async () => {
    const api = new FakeBenchApi()
      .on('GET', BENCH_ROUTES.authSession, SESSION)
      .on('POST', BENCH_ROUTES.authLogout, () => {
        throw apiError(0);
      });
    const store = setup(api);
    await store.whenReady();
    await store.signOut();
    expect(store.isAuthenticated()).toBe(false);
    expect(api.callsTo('POST', BENCH_ROUTES.authLogout)).toHaveLength(1);
  });
});

describe('AuthStore with the real client: 401 → /login', () => {
  it('forgets the session and goes back to /login when a protected route answers 401', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.endsWith('/api/auth/session')
        ? new Response(JSON.stringify(SESSION), { status: 200 })
        : new Response(JSON.stringify({ code: 'AUTH_SESSION_EXPIRED', message: 'Session expirée.' }), { status: 401 }),
    );
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: BENCH_FETCH, useValue: fetchFn }, { provide: BENCH_COOKIES, useValue: () => '' }],
    });
    const store = TestBed.inject(AuthStore);
    await store.whenReady();
    expect(store.isAuthenticated()).toBe(true);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    await expect(TestBed.inject(BenchApi).get(BENCH_ROUTES.tokens)).rejects.toMatchObject({ status: 401 });
    expect(store.isAuthenticated()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/login', { replaceUrl: true });
  });
});

describe('route guards', () => {
  const route = {} as ActivatedRouteSnapshot;
  const state = {} as RouterStateSnapshot;

  it('authGuard sends a visitor without session to /login and lets the owner in', async () => {
    const api = new FakeBenchApi().on('GET', BENCH_ROUTES.authSession, () => {
      throw apiError(401);
    });
    setup(api);
    const denied = await TestBed.runInInjectionContext(() => authGuard(route, state));
    expect(denied).toBeInstanceOf(UrlTree);
    expect(String(denied)).toBe('/login');
  });

  it('guestGuard sends a signed-in owner home', async () => {
    setup(new FakeBenchApi().on('GET', BENCH_ROUTES.authSession, SESSION));
    expect(await TestBed.runInInjectionContext(() => authGuard(route, state))).toBe(true);
    const home = await TestBed.runInInjectionContext(() => guestGuard(route, state));
    expect(String(home)).toBe('/');
  });
});
