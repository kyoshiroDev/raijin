import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { testConfig } from '../../testing/test-config';
import { ApiException } from '../errors/api-exception';
import { AuthCookies, cookieNames, REFRESH_COOKIE_PATH } from './cookies';
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
    expect(cookieNames(true)).toEqual({ access: '__Host-rj_at', refresh: '__Secure-rj_rt', csrf: '__Host-rj_csrf' });
    expect(cookieNames(false)).toEqual({ access: 'rj_at', refresh: 'rj_rt', csrf: 'rj_csrf' });
  });

  it('pose des cookies HttpOnly, SameSite=Lax, Secure selon la config, refresh limité à /api/v1/auth', () => {
    const cookies = new AuthCookies(testConfig({ COOKIE_SECURE: 'true' }));
    const res = fakeResponse();
    cookies.setSession(res, 'acc', 'ref');
    cookies.setCsrf(res, 'csrf');
    const [access, refresh, csrf] = res.cookie.mock.calls;
    expect(access?.[0]).toBe('__Host-rj_at');
    expect(access?.[2]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect(refresh?.[0]).toBe('__Secure-rj_rt');
    expect(refresh?.[2]).toMatchObject({ path: REFRESH_COOKIE_PATH, httpOnly: true });
    expect(csrf?.[0]).toBe('__Host-rj_csrf');
    expect(access?.[2]).not.toHaveProperty('domain');
    cookies.clearSession(res);
    expect(res.clearCookie).toHaveBeenCalledTimes(2);
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

  it('accepte un jeton anonyme ou lié à la session courante', () => {
    const anon = csrf.issue(null);
    expect(guard(mutation(anon, anon))()).toBe(true);
    const bound = csrf.issue('sid-9');
    expect(guard(mutation(bound, bound), { sid: 'sid-9' })()).toBe(true);
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
