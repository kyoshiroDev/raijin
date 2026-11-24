// Client HTTP sortant commun (http-client.ts) : hôtes autorisés, redirections refusées, corps plafonné en flux,
// délai, expurgation des URL. fetch simulé : aucun appel réseau.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, readBodyCapped, redactUrls, safeRequest } from './http-client';
import { getJson } from './enrich-clients';
import { createHeliusSource } from './wallet-collect-helius';
import { fetchCandleHistory } from './gecko-history';

const HOSTS: ReadonlySet<string> = new Set(['api.example-allowed.test']);
const OK_URL = 'https://api.example-allowed.test/v1/x';
const FAKE_KEY = '00000000-0000-4000-8000-000000000000';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';

function recorder(answer: () => Response | Error) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const a = answer();
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  return { fetchFn, calls };
}

/** Flux de `chunks` morceaux de `size` octets ; compte les morceaux réellement tirés. */
function streamed(chunks: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (state.pulled >= chunks) return ctrl.close();
      state.pulled++;
      ctrl.enqueue(new Uint8Array(size).fill(0x20));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { res: new Response(body, { status: 200 }), state };
}

describe('http-client (safeRequest)', () => {
  it('refuse un hôte hors liste, http, port, identifiants, sans aucun appel', async () => {
    const r = recorder(() => new Response('{}'));
    for (const bad of [
      'https://evil.test/v1/x',
      'https://api.example-allowed.test.evil.test/x',
      'http://api.example-allowed.test/x',
      'https://api.example-allowed.test:8443/x',
      'https://user:pw@api.example-allowed.test/x',
      'not a url',
    ]) {
      const res = await safeRequest(bad, { hosts: HOSTS, timeoutMs: 1000, fetchFn: r.fetchFn });
      assert.equal(res.kind, 'refused', bad);
    }
    assert.equal(r.calls.length, 0);
    assert.deepEqual(checkUrl('https://evil.test/', HOSTS), { refused: 'host' });
  });

  it('demande redirect: error, un délai, et refuse toute réponse 3xx', async () => {
    const r = recorder(() => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }));
    const statuses: number[] = [];
    const res = await safeRequest(OK_URL, { hosts: HOSTS, timeoutMs: 1000, fetchFn: r.fetchFn, onStatus: (s) => statuses.push(s) });
    assert.deepEqual(res, { kind: 'refused', reason: 'redirect', status: 302 });
    assert.equal(r.calls[0].init?.redirect, 'error');
    assert.ok(r.calls[0].init?.signal instanceof AbortSignal);
    assert.deepEqual(statuses, [302]);
  });

  it('coupe un corps trop gros en flux (sans tout lire) et via Content-Length', async () => {
    const s = streamed(100, 64 * 1024); // 6,4 Mo annoncés en flux
    const res = await safeRequest(OK_URL, { hosts: HOSTS, timeoutMs: 1000, maxBytes: 2_000_000, fetchFn: () => Promise.resolve(s.res) });
    assert.deepEqual(res, { kind: 'refused', reason: 'too_large' });
    assert.ok(s.state.pulled < 40, `lecture arrêtée tôt (${s.state.pulled} morceaux)`);
    assert.ok(s.state.cancelled, 'flux annulé');

    const declared = new Response('{}', { headers: { 'content-length': '5000000' } });
    await assert.rejects(readBodyCapped(declared, 2_000_000), /too large/);

    const small = streamed(3, 1000);
    assert.equal((await readBodyCapped(small.res, 2_000_000)).length, 3000);
  });

  it('délai dépassé → erreur, jamais une exception', async () => {
    const hang = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const res = await safeRequest(OK_URL, { hosts: HOSTS, timeoutMs: 20, fetchFn: hang });
    assert.equal(res.kind, 'error');
  });

  it('signal du run déjà abandonné → aucune requête', async () => {
    const r = recorder(() => new Response('{}'));
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await safeRequest(OK_URL, { hosts: HOSTS, timeoutMs: 1000, signal: ctrl.signal, fetchFn: r.fetchFn });
    assert.deepEqual(res, { kind: 'refused', reason: 'aborted' });
    assert.equal(r.calls.length, 0);
  });

  it("expurge les paramètres de requête des messages d'erreur (clé Helius)", async () => {
    const r = recorder(() => new TypeError(`error sending request for url (https://mainnet.helius-rpc.com/?api-key=${FAKE_KEY})`));
    const res = await safeRequest(OK_URL, { hosts: HOSTS, timeoutMs: 1000, fetchFn: r.fetchFn });
    assert.equal(res.kind, 'error');
    assert.ok(res.kind === 'error' && !res.message.includes(FAKE_KEY));
    assert.equal(redactUrls('https://u:p@h.test/?a=1&api-key=SECRET'), 'https://h.test/?a=[redacted]&api-key=[redacted]');
  });
});

describe('http-client branché sur les clients portés', () => {
  it('getJson : redirection refusée, corps trop gros, hôte refusé → null, journal sans URL', async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    const redirect = recorder(() => new Response(null, { status: 301, headers: { location: 'https://evil.test/' } }));
    assert.equal(await getJson('https://api.rugcheck.xyz/v1/x', { fetchFn: redirect.fetchFn, log }), null);
    const big = streamed(64, 64 * 1024);
    assert.equal(await getJson('https://api.rugcheck.xyz/v1/x', { fetchFn: () => Promise.resolve(big.res), log }), null);
    const host = recorder(() => new Response('{}'));
    assert.equal(await getJson('https://evil.test/v1/x', { fetchFn: host.fetchFn, log }), null);
    assert.equal(host.calls.length, 0);
    assert.ok(logs.every((m) => !m.includes('/v1/')), 'host only in logs');
  });

  it('Helius : redirection et corps trop gros refusés, clé jamais dans le message', async () => {
    const redirect = recorder(() => new Response(null, { status: 307, headers: { location: 'https://evil.test/' } }));
    await assert.rejects(createHeliusSource(FAKE_KEY, redirect.fetchFn).page(PAIR, null), (e: unknown) => {
      assert.ok(e instanceof Error && /redirect refused/.test(e.message) && !e.message.includes(FAKE_KEY));
      return true;
    });
    const big = streamed(200, 64 * 1024); // 12,8 Mo > 8 Mo
    await assert.rejects(createHeliusSource(FAKE_KEY, () => Promise.resolve(big.res)).page(PAIR, null), /too_large/);
  });

  it('GeckoTerminal : redirection refusée → erreur, pas de bougies', async () => {
    const redirect = recorder(() => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }));
    const now = Date.UTC(2026, 0, 2);
    const res = await fetchCandleHistory(PAIR, MINT, now - 3_600_000, now, { fetchFn: redirect.fetchFn });
    assert.equal(res.status, 'error');
    assert.equal(res.candles.length, 0);
  });
});
