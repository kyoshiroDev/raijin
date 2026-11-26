import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { testConfig } from '../../testing/test-config';
import { ApiException } from '../errors/api-exception';
import { AuthCookies, cookieNames, LEGACY_REFRESH_COOKIE_PATH, LEGACY_SECURE_REFRESH_COOKIE, REFRESH_COOKIE_PATH } from './cookies';
import { hmac, randomToken, safeEqual, sha256 } from './crypto';
import { CsrfGuard, CsrfService, SessionIdResolverRegistry, SKIP_CSRF } from './csrf';

describe('crypto', () => {
  it('produit des jetons aléatoires base64url', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });
  it('hache et signe de façon déterministe', () => {
    expect(sha256('a')).toBe(sha256('a'));
    expect(sha256('a')).toHaveLength(64);
    expect(hmac('k', 'v')).toBe(hmac('k', 'v'));
    expect(hmac('k', 'v')).not.toBe(hmac('k2', 'v'));
  });
  it('compare en temps constant', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

function fakeResponse() {
  return { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response & {
    cookie: jest.Mock;
    clearCookie: jest.Mock;
  };
}

describe('AuthCookies', () => {
  it('noms préfixés en mode Secure, simples en dev', () => {
    expect(cookieNames(true)).toEqual({ access: '__Host-rj_at', refresh: '__Host-rj_rt', csrf: '__Host-rj_csrf' });
    expect(cookieNames(false)).toEqual({ access: 'rj_at', refresh: 'rj_rt', csrf: 'rj_csrf' });
  });

  it('pose des cookies HttpOnly, SameSite=Lax, Secure, `__Host-` (Path=/, sans Domain) ; efface l’ancien refresh', () => {
    const cookies = new AuthCookies(testConfig({ COOKIE_SECURE: 'true' }));
    const res = fakeResponse();
    cookies.setSession(res, 'acc', 'ref');
    cookies.setCsrf(res, 'csrf');
    const [access, refresh, csrf] = res.cookie.mock.calls;
    expect(access?.[0]).toBe('__Host-rj_at');
    expect(access?.[2]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect(refresh?.[0]).toBe('__Host-rj_rt');
    expect(REFRESH_COOKIE_PATH).toBe('/');
    expect(refresh?.[2]).toMatchObject({ path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
    expect(csrf?.[0]).toBe('__Host-rj_csrf');
    for (const call of res.cookie.mock.calls) expect(call[2]).not.toHaveProperty('domain');
    // Migration : l'ancien `__Secure-rj_rt` (Path=/api/v1/auth) est expiré à chaque pose de session.
    expect(res.clearCookie).toHaveBeenCalledWith(
      LEGACY_SECURE_REFRESH_COOKIE,
      expect.objectContaining({ path: LEGACY_REFRESH_COOKIE_PATH, secure: true, httpOnly: true }),
    );
    res.clearCookie.mockClear();
    cookies.clearSession(res);
    expect(res.clearCookie.mock.calls.map((call) => [call[0], call[1].path])).toEqual([
      [LEGACY_SECURE_REFRESH_COOKIE, LEGACY_REFRESH_COOKIE_PATH],
      ['__Host-rj_at', '/'],
      ['__Host-rj_rt', '/'],
    ]);
  });

  it('en dev (http), `rj_rt` passe sur Path=/ et l’ancien chemin /api/v1/auth est expiré', () => {
    const cookies = new AuthCookies(testConfig());
    const res = fakeResponse();
    cookies.setSession(res, 'acc', 'ref');
    expect(res.clearCookie).toHaveBeenCalledWith('rj_rt', expect.objectContaining({ path: LEGACY_REFRESH_COOKIE_PATH }));
    expect(res.cookie).toHaveBeenCalledWith('rj_rt', 'ref', expect.objectContaining({ path: '/' }));
  });

  describe('readRefresh', () => {
    const secure = new AuthCookies(testConfig({ COOKIE_SECURE: 'true' }));
    const req = (header: string, cookies: Record<string, string>) =>
      ({ headers: { cookie: header }, cookies }) as unknown as Request;

    it('nouveau nom prioritaire ; ancien `__Secure-rj_rt` lu seulement en son absence (migration)', () => {
      expect(secure.readRefresh(req('__Host-rj_rt=n', { '__Host-rj_rt': 'n' }))).toEqual({ kind: 'token', token: 'n', legacy: false });
      expect(secure.readRefresh(req('__Secure-rj_rt=o', { '__Secure-rj_rt': 'o' }))).toEqual({ kind: 'token', token: 'o', legacy: true });
      expect(
        secure.readRefresh(req('__Secure-rj_rt=o; __Host-rj_rt=n', { '__Secure-rj_rt': 'o', '__Host-rj_rt': 'n' })),
      ).toEqual({ kind: 'token', token: 'n', legacy: false });
      expect(secure.readRefresh(req('', {}))).toEqual({ kind: 'none' });
      expect(secure.readRefresh({} as Request)).toEqual({ kind: 'none' });
    });

    it('après LEGACY_REFRESH_COOKIE_UNTIL : ancien nom ignoré (ni lu ni compté), seulement à effacer', () => {
      const expired = new AuthCookies(testConfig({ COOKIE_SECURE: 'true', LEGACY_REFRESH_COOKIE_UNTIL: '2020-01-01T00:00:00Z' }));
      const r = req('__Secure-rj_rt=o; __Secure-rj_rt=p', { '__Secure-rj_rt': 'o' });
      expect(expired.readRefresh(r)).toEqual({ kind: 'none' });
      expect(expired.hasLegacyRefresh(r)).toBe(true);
      expect(expired.hasLegacyRefresh(req('__Host-rj_rt=n', { '__Host-rj_rt': 'n' }))).toBe(false);
    });

    it('efface l’ancien nom sans Domain et avec Domain=<parent de APP_URL>, sur les chemins connus', () => {
      const cookies = new AuthCookies(
        testConfig({ COOKIE_SECURE: 'true', APP_URL: 'https://app.raijinshield.com' }),
      );
      const res = fakeResponse();
      cookies.clearLegacyRefreshEverywhere(res);
      const calls = res.clearCookie.mock.calls.map((call) => [call[0], call[1].path, call[1].domain]);
      expect(calls).toEqual([
        [LEGACY_SECURE_REFRESH_COOKIE, '/api/v1/auth', undefined],
        [LEGACY_SECURE_REFRESH_COOKIE, '/api/v1/auth/refresh', undefined],
        [LEGACY_SECURE_REFRESH_COOKIE, '/', undefined],
        [LEGACY_SECURE_REFRESH_COOKIE, '/api/v1/auth', 'raijinshield.com'],
        [LEGACY_SECURE_REFRESH_COOKIE, '/api/v1/auth/refresh', 'raijinshield.com'],
        [LEGACY_SECURE_REFRESH_COOKIE, '/', 'raijinshield.com'],
      ]);
      for (const call of res.clearCookie.mock.calls) expect(call[1]).toMatchObject({ secure: true, httpOnly: true });
      // En dev (http) : aucun ancien nom distinct, rien à effacer.
      const dev = fakeResponse();
      new AuthCookies(testConfig()).clearLegacyRefreshEverywhere(dev);
      expect(dev.clearCookie).not.toHaveBeenCalled();
    });

    it('nom répété dans l’en-tête brut (cookie injecté par un sous-domaine) : duplicate', () => {
      const header = '__Host-rj_rt=attaquant; __Host-rj_at=a; __Host-rj_rt=victime';
      expect(secure.readRefresh(req(header, { '__Host-rj_rt': 'attaquant' }))).toEqual({ kind: 'duplicate' });
      const legacy = '__Secure-rj_rt=attaquant;__Secure-rj_rt=victime';
      expect(secure.readRefresh(req(legacy, { '__Secure-rj_rt': 'attaquant' }))).toEqual({ kind: 'duplicate' });
      const dev = new AuthCookies(testConfig());
      expect(dev.readRefresh(req('rj_rt=a; rj_rt=b', { rj_rt: 'a' }))).toEqual({ kind: 'duplicate' });
    });
  });

  it('lit un cookie borné et ignore les valeurs vides ou démesurées', () => {
    const cookies = new AuthCookies(testConfig());
    const req = (value: unknown) => ({ cookies: { rj_at: value } }) as unknown as Request;
    expect(cookies.read(req('jeton'), 'access')).toBe('jeton');
    expect(cookies.read(req(''), 'access')).toBeNull();
    expect(cookies.read(req('x'.repeat(5000)), 'access')).toBeNull();
    expect(cookies.read({} as Request, 'access')).toBeNull();
  });
});

describe('CSRF', () => {
  const config = testConfig();
  const csrf = new CsrfService(config);
  const cookies = new AuthCookies(config);

  it('un jeton est lié à sa session', () => {
    const anon = csrf.issue(null);
    expect(anon).toMatch(/^[A-Za-z0-9_.-]{32,256}$/);
    expect(csrf.verify(anon, null)).toBe(true);
    expect(csrf.verify(anon, 'sid-1')).toBe(false);
    const bound = csrf.issue('sid-1');
    expect(csrf.verify(bound, 'sid-1')).toBe(true);
    expect(csrf.verify(bound, 'sid-2')).toBe(false);
    expect(csrf.verify('pas-un-jeton', null)).toBe(false);
    expect(csrf.verify(`${bound}.extra`, 'sid-1')).toBe(false);
  });

  it('un jeton signé avec un autre secret est refusé', () => {
    const other = new CsrfService(testConfig({ COOKIE_SECRET: 'z'.repeat(48) }));
    expect(csrf.verify(other.issue(null), null)).toBe(false);
  });

  function context(req: Partial<Request>, skip = false): { ctx: ExecutionContext; reflector: Reflector } {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => (key === SKIP_CSRF ? skip : undefined));
    const ctx = {
      getType: () => 'http',
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { ctx, reflector };
  }

  function guard(req: Partial<Request>, options: { skip?: boolean; sid?: string | null } = {}) {
    const { ctx, reflector } = context(req, options.skip);
    const registry = new SessionIdResolverRegistry();
    if (options.sid !== undefined) registry.register(() => options.sid ?? null);
    return () => new CsrfGuard(reflector, csrf, cookies, registry, config).canActivate(ctx);
  }

  const mutation = (token: string | undefined, cookie: string | undefined, origin = 'http://localhost:4200') =>
    ({
      method: 'POST',
      headers: { origin, ...(token ? { 'x-csrf-token': token } : {}) },
      cookies: cookie ? { rj_csrf: cookie } : {},
    }) as unknown as Request;

  it('laisse passer les méthodes sûres, les routes exemptées et les contextes non HTTP', () => {
    expect(guard({ method: 'GET', headers: {} })()).toBe(true);
    expect(guard({ method: 'OPTIONS', headers: {} })()).toBe(true);
    expect(guard(mutation(undefined, undefined), { skip: true })()).toBe(true);
    const rpc = { getType: () => 'rpc' } as unknown as ExecutionContext;
    expect(new CsrfGuard(new Reflector(), csrf, cookies, new SessionIdResolverRegistry(), config).canActivate(rpc)).toBe(true);
  });

  it('sans session : jeton anonyme ; avec session : jeton lié uniquement', () => {
    const anon = csrf.issue(null);
    expect(guard(mutation(anon, anon))()).toBe(true);
    const bound = csrf.issue('sid-9');
    expect(guard(mutation(bound, bound), { sid: 'sid-9' })()).toBe(true);
    expect(guard(mutation(anon, anon), { sid: 'sid-9' })).toThrow(ApiException);
  });

  it.each([
    ['Origin absente', () => ({ method: 'POST', headers: {}, cookies: {} })],
    ['Origin tierce', () => mutation(csrf.issue(null), csrf.issue(null), 'https://evil.example')],
    ['en-tête absent', () => mutation(undefined, csrf.issue(null))],
    ['cookie absent', () => mutation(csrf.issue(null), undefined)],
    ['en-tête ≠ cookie', () => mutation(csrf.issue(null), csrf.issue(null))],
  ])('refuse : %s', (_label, build) => {
    expect(guard(build() as Request)).toThrow(ApiException);
  });

  it('refuse un jeton lié à une autre session', () => {
    const bound = csrf.issue('sid-autre');
    let thrown: unknown;
    try {
      guard(mutation(bound, bound), { sid: 'sid-courante' })();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiException);
    expect((thrown as ApiException).code).toBe('AUTH_CSRF_INVALID');
    expect((thrown as ApiException).getStatus()).toBe(403);
    expect(guard(mutation(bound, bound))).toThrow(ApiException);
  });
});
