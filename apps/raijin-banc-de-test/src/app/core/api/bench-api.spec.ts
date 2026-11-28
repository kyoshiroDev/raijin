import { TestBed } from '@angular/core/testing';
import { BENCH_CSRF_HEADER, BENCH_ROUTES } from '@raijin/bench-contracts';
import { describe, expect, it, vi } from 'vitest';
import { BENCH_COOKIES, BENCH_FETCH, BenchApi, BenchApiError, benchPath, benchQueryString, itemsOf, readCsrfCookie } from './bench-api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(responses: ((url: string, init: RequestInit) => Response | Promise<Response>)[], cookie = () => '__Host-rjb_csrf=nonce.sig') {
  const queue = [...responses];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error(`Requête inattendue : ${init.method} ${url}`);
    return next(url, init);
  });
  TestBed.configureTestingModule({ providers: [{ provide: BENCH_FETCH, useValue: fetchFn }, { provide: BENCH_COOKIES, useValue: cookie }] });
  const api = TestBed.inject(BenchApi);
  const unauthorized = vi.fn();
  api.onUnauthorized(unauthorized);
  const header = (i: number, name: string) => (fetchFn.mock.calls[i]?.[1].headers as Record<string, string>)[name];
  return { api, fetchFn, unauthorized, header };
}

describe('URL helpers', () => {
  it('encodes path params and refuses a missing one', () => {
    expect(benchPath(BENCH_ROUTES.token, { mint: 'a/b c' })).toBe('tokens/a%2Fb%20c');
    expect(() => benchPath(BENCH_ROUTES.token)).toThrow(/mint/);
  });

  it('builds the query string (lists joined, empty values dropped)', () => {
    expect(benchQueryString({ mints: ['a', 'b'], limit: 10, since: undefined, mint: null })).toBe('?mints=a%2Cb&limit=10');
    expect(benchQueryString({})).toBe('');
  });

  it('reads only the bench CSRF cookie (never a Raijin rj_* cookie)', () => {
    expect(readCsrfCookie('rj_csrf=raijin; __Host-rjb_csrf=abc.def')).toBe('abc.def');
    expect(readCsrfCookie('rjb_csrf=local.sig')).toBe('local.sig');
    expect(readCsrfCookie('rj_csrf=raijin')).toBeNull();
  });

  it('unwraps { items }', () => {
    expect(itemsOf({ items: [1], truncated: false })).toEqual([1]);
    expect(itemsOf(null)).toEqual([]);
  });
});

describe('BenchApi', () => {
  it('GET: same-origin /api URL, cookies sent by the browser, no CSRF header, no cache', async () => {
    const { api, fetchFn, header } = setup([() => json(200, { items: [], truncated: false })]);
    await api.get(BENCH_ROUTES.tokens, { query: { since: '2026-11-24T10:00:00.000Z', limit: 200 } });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('/api/tokens?since=2026-11-24T10%3A00%3A00.000Z&limit=200');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.cache).toBe('no-store');
    expect(header(0, BENCH_CSRF_HEADER)).toBeUndefined();
  });

  it('writes send the CSRF cookie back in X-CSRF-Token (double submit) with a JSON body', async () => {
    const { api, fetchFn, header } = setup([() => json(201, { id: '1' })]);
    await api.post(BENCH_ROUTES.paperPositions, { mint: 'x' });
    expect(header(0, BENCH_CSRF_HEADER)).toBe('nonce.sig');
    expect(header(0, 'Content-Type')).toBe('application/json');
    expect(fetchFn.mock.calls[0]?.[1].body).toBe('{"mint":"x"}');
  });

  it('204 → null', async () => {
    const { api } = setup([() => new Response(null, { status: 204 })]);
    expect(await api.post(BENCH_ROUTES.authLogout, undefined, { anonymous: true })).toBeNull();
  });

  it('403 AUTH_CSRF_INVALID: re-reads the session (new CSRF cookie) then replays the write once with the new token', async () => {
    let cookie = '__Host-rjb_csrf=old.sig';
    const { api, fetchFn, header } = setup(
      [
        () => json(403, { code: 'AUTH_CSRF_INVALID', message: 'CSRF.' }),
        (url) => {
          expect(url).toBe('/api/auth/session');
          cookie = '__Host-rjb_csrf=new.sig';
          return json(200, { email: 'me@example.com', mode: 'shadow', expiresAt: '2026-11-24T20:00:00.000Z' });
        },
        () => json(200, { ok: true }),
      ],
      () => cookie,
    );
    expect(await api.put(BENCH_ROUTES.alertEnabled, { enabled: true })).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(header(0, BENCH_CSRF_HEADER)).toBe('old.sig');
    expect(header(2, BENCH_CSRF_HEADER)).toBe('new.sig');
  });

  it('does not loop on a second CSRF refusal', async () => {
    const csrf = () => json(403, { code: 'AUTH_CSRF_INVALID', message: 'CSRF.' });
    const { api, fetchFn } = setup([csrf, () => json(200, {}), csrf]);
    await expect(api.post(BENCH_ROUTES.pushTest)).rejects.toMatchObject({ status: 403, code: 'AUTH_CSRF_INVALID' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('401 on a protected route → onUnauthorized (back to the login screen)', async () => {
    const { api, unauthorized } = setup([() => json(401, { code: 'AUTH_SESSION_EXPIRED', message: 'Session expirée.' })]);
    const error = await api.get(BENCH_ROUTES.alerts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BenchApiError);
    expect(error).toMatchObject({ status: 401, code: 'AUTH_SESSION_EXPIRED' });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('401 on an anonymous auth call does not redirect (wrong password is not an expired session)', async () => {
    const { api, unauthorized } = setup([() => json(401, { code: 'AUTH_INVALID_CREDENTIALS', message: 'Identifiants.' })]);
    await expect(api.post(BENCH_ROUTES.authLogin, {}, { anonymous: true })).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('a CSRF refresh that ends in 401 also goes back to /login', async () => {
    const { api, unauthorized } = setup([
      () => json(403, { code: 'AUTH_CSRF_INVALID', message: 'CSRF.' }),
      () => json(401, { code: 'AUTH_SESSION_EXPIRED', message: 'Session expirée.' }),
    ]);
    await expect(api.post(BENCH_ROUTES.labRuns)).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('keeps only known error codes and bounded messages; non-JSON errors get a generic message', async () => {
    const { api } = setup([
      () => json(409, { code: 'BACKTEST_ALREADY_QUEUED', message: 'Un run est déjà en file.' }),
      () => json(500, { code: 'PGRST202', message: 'x'.repeat(400) }),
      () => new Response('<html>Bad gateway</html>', { status: 502 }),
    ]);
    await expect(api.post(BENCH_ROUTES.labRuns)).rejects.toMatchObject({ code: 'BACKTEST_ALREADY_QUEUED', message: 'Un run est déjà en file.' });
    const e500 = (await api.get(BENCH_ROUTES.status).catch((e: unknown) => e)) as BenchApiError;
    expect(e500.code).toBeNull();
    expect(e500.message.length).toBeLessThanOrEqual(300);
    await expect(api.get(BENCH_ROUTES.status)).rejects.toMatchObject({ status: 502, code: null });
  });

  it('network failure → status 0; an abort is propagated as is', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const controller = new AbortController();
    const { api } = setup([
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => {
        controller.abort();
        return Promise.reject(abort);
      },
    ]);
    await expect(api.get(BENCH_ROUTES.tokens)).rejects.toMatchObject({ status: 0 });
    await expect(api.get(BENCH_ROUTES.tokens, { signal: controller.signal })).rejects.toBe(abort);
  });
});
