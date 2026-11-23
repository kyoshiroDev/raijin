import { UpstreamError } from './errors';
import { requestJson } from './http';
import type { FetchLike } from './ports';

const URL_WITH_KEY = 'https://mainnet.helius-rpc.com/?api-key=SECRET-KEY-123';
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...(init.headers as object) } });

async function failure(fetchFn: FetchLike, extra: Partial<Parameters<typeof requestJson>[1]> = {}): Promise<UpstreamError> {
  try {
    await requestJson(fetchFn, { source: 'helius_rpc', url: URL_WITH_KEY, timeoutMs: 50, maxBytes: 1_000, ...extra });
  } catch (error) {
    return error as UpstreamError;
  }
  throw new Error('aucune erreur');
}

describe('requestJson', () => {
  it('GET JSON : redirect error, accept JSON, corps parsé', async () => {
    const fetchFn = jest.fn<Promise<Response>, Parameters<FetchLike>>(async () => json({ ok: true }));
    const response = await requestJson(fetchFn, { source: 'dexscreener', url: 'https://api.dexscreener.com/x', timeoutMs: 100, maxBytes: 1_000 });
    expect(response).toEqual({ status: 200, body: { ok: true } });
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { accept: 'application/json' } });
    expect(init?.body).toBeUndefined();
  });

  it('POST JSON : corps sérialisé et content-type', async () => {
    const fetchFn = jest.fn<Promise<Response>, Parameters<FetchLike>>(async () => json({ result: 1 }));
    await requestJson(fetchFn, { source: 'solana_rpc', url: 'https://rpc', method: 'POST', body: { a: 1 }, timeoutMs: 100, maxBytes: 1_000 });
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
  });

  it('accepte application/vnd.api+json (GeckoTerminal)', async () => {
    const fetchFn: FetchLike = async () => new Response('{"data":[]}', { headers: { 'content-type': 'application/vnd.api+json; charset=utf-8' } });
    await expect(requestJson(fetchFn, { source: 'geckoterminal', url: 'https://g', timeoutMs: 100, maxBytes: 1_000 })).resolves.toEqual({ status: 200, body: { data: [] } });
  });

  it.each([
    ['erreur réseau (contient l’URL)', async () => Promise.reject(new TypeError(`fetch failed ${URL_WITH_KEY}`)), 'network'],
    ['429 avec Retry-After', async () => new Response('', { status: 429, headers: { 'retry-after': '3' } }), 'rate_limited'],
    ['503', async () => new Response('<html>', { status: 503 }), 'http_error'],
    ['HTML au lieu de JSON', async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'invalid_response'],
    ['JSON invalide', async () => new Response('{nope', { headers: { 'content-type': 'application/json' } }), 'invalid_response'],
    ['taille annoncée trop grande', async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '5000' } }), 'too_large'],
    ['corps plus grand que la limite', async () => new Response(`"${'x'.repeat(2_000)}"`, { headers: { 'content-type': 'application/json' } }), 'too_large'],
  ] as Array<[string, FetchLike, string]>)('%s → %s, sans cause ni URL', async (_name, fetchFn, kind) => {
    const error = await failure(fetchFn);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.kind).toBe(kind);
    expect(error.cause).toBeUndefined();
    expect(`${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`).not.toContain('SECRET-KEY-123');
  });

  it('Retry-After converti en millisecondes', async () => {
    const error = await failure(async () => new Response('', { status: 429, headers: { 'retry-after': '1.5' } }));
    expect(error.retryAfterMs).toBe(1_500);
    expect((await failure(async () => new Response('', { status: 429, headers: { 'retry-after': 'demain' } }))).retryAfterMs).toBeNull();
  });

  it('délai dépassé → timeout', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error(`aborted ${URL_WITH_KEY}`))));
    expect((await failure(hanging, { timeoutMs: 10 })).kind).toBe('timeout');
  });

  it('signal global annulé avant ou pendant l’appel → aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await failure(async () => json({}), { signal: controller.signal })).kind).toBe('aborted');

    const during = new AbortController();
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    setTimeout(() => during.abort(), 5);
    expect((await failure(hanging, { signal: during.signal, timeoutMs: 1_000 })).kind).toBe('aborted');
  });

  it('flux interrompu pendant la lecture → network', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`boom ${URL_WITH_KEY}`));
      },
    });
    const error = await failure(async () => new Response(stream, { headers: { 'content-type': 'application/json' } }));
    expect(error.kind).toBe('network');
  });

  it('4xx JSON renvoyé tel quel au client (interprétation métier)', async () => {
    const response = await requestJson(async () => json({ errorCode: 'NO_ROUTES_FOUND' }, { status: 400 }), {
      source: 'jupiter',
      url: 'https://j',
      timeoutMs: 100,
      maxBytes: 1_000,
    });
    expect(response).toEqual({ status: 400, body: { errorCode: 'NO_ROUTES_FOUND' } });
  });

  it('UpstreamError levée par un fetch injecté (refus sans requête) : conservée telle quelle', async () => {
    const error = await failure(async () => {
      throw new UpstreamError('dexscreener', 'circuit_open');
    });
    expect(error).toMatchObject({ source: 'dexscreener', kind: 'circuit_open' });
    expect(error.cause).toBeUndefined();
  });
});
