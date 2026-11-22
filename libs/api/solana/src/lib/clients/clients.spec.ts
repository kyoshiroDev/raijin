import { SILENT_LOGGER, type FetchLike } from '../core/ports';
import { UpstreamGate } from '../core/upstream-gate';
import type { UpstreamId } from '../core/errors';
import { DexScreenerClient } from './dexscreener';
import { GeckoTerminalClient } from './geckoterminal';
import { HeliusDasClient } from './helius-das';
import { callJsonRpc, type JsonRpcTransport } from './json-rpc';
import { JupiterQuoteClient } from './jupiter';
import { RugCheckClient } from './rugcheck';
import { SolanaRpcClient } from './solana-rpc';
import * as z from 'zod';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function gate(source: UpstreamId) {
  return new UpstreamGate({ source, ratePerSecond: 1_000, maxQueue: 10, maxAttempts: 1, backoffBaseMs: 0, maxRetryAfterMs: 0, breakerThreshold: 99, breakerCooldownMs: 1 });
}
function rest(source: UpstreamId, fetchFn: FetchLike) {
  return { source, baseUrl: 'https://example.test', gate: gate(source), fetch: fetchFn, timeoutMs: 1_000, maxBytes: 100_000, logger: SILENT_LOGGER };
}
function rpcTransport(fetchFn: FetchLike, source: 'helius_rpc' | 'helius_das' | 'solana_rpc' = 'solana_rpc'): JsonRpcTransport {
  return { source, url: () => 'https://rpc.test', gate: gate(source), fetch: fetchFn, timeoutMs: 1_000, maxBytes: 100_000, logger: SILENT_LOGGER };
}

describe('JSON-RPC', () => {
  it.each([
    ['erreur RPC générique', json({ jsonrpc: '2.0', error: { code: -32602, message: 'secret details' } }), 'rpc_error'],
    ['erreur RPC 429 dans le corps', json({ error: { code: -32429 } }), 'rate_limited'],
    ['erreur RPC malformée', json({ error: 'oops' }), 'rpc_error'],
    ['sans result', json({ jsonrpc: '2.0' }), 'invalid_response'],
    ['corps non objet', json('texte'), 'invalid_response'],
    ['HTTP 401 (clé invalide)', json({}, 401), 'http_error'],
    ['résultat hors schéma', json({ result: { value: 'x' } }), 'invalid_response'],
  ])('%s → %s', async (_name, response, kind) => {
    await expect(callJsonRpc(rpcTransport(async () => response), 'getX', [], z.object({ value: z.number() }))).rejects.toMatchObject({ kind });
  });
});

describe('SolanaRpcClient', () => {
  it('compte qui n’est pas un mint parsé → null ; options de pagination et méthode réservée au scan', async () => {
    const bodies: unknown[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { method: string };
      bodies.push(payload);
      if (payload.method === 'getAccountInfo') {
        return json({ result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { program: 'spl-token', parsed: { type: 'account', info: {} } } } } });
      }
      if (payload.method === 'getSignaturesForAddress') return json({ result: [] });
      return json({ result: { value: [] } });
    };
    const client = new SolanaRpcClient(null, { id: 'solana_rpc', transport: rpcTransport(fetchFn) }, { tryConsume: async () => true }, SILENT_LOGGER);
    expect(client.heliusConfigured).toBe(false);
    await expect(client.getMint(MINT)).resolves.toEqual({ value: null, servedBy: 'solana_rpc' });
    await client.getSignaturesForAddress(MINT, 10, 'sig-avant');
    await expect(client.getTokenAccountsByOwner(MINT, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).resolves.toEqual({
      value: { accounts: [], received: 0, rejected: 0 },
      servedBy: 'solana_rpc',
    });
    expect(bodies[1]).toMatchObject({ params: [MINT, { limit: 10, before: 'sig-avant' }] });
  });

  it('Helius annulé par l’échéance : pas de repli', async () => {
    const controller = new AbortController();
    const helius = rpcTransport(async () => {
      controller.abort();
      throw new TypeError('aborted');
    }, 'helius_rpc');
    const publicFetch = jest.fn<Promise<Response>, Parameters<FetchLike>>();
    const client = new SolanaRpcClient({ id: 'helius', transport: helius }, { id: 'solana_rpc', transport: rpcTransport(publicFetch) }, { tryConsume: async () => true }, SILENT_LOGGER);
    await expect(client.getMint(MINT, controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
    expect(publicFetch).not.toHaveBeenCalled();
  });
});

describe('HeliusDasClient', () => {
  it('sans clé : not_configured ; budget épuisé : budget_exhausted', async () => {
    await expect(new HeliusDasClient(null, { tryConsume: async () => true }).getAsset(MINT)).rejects.toMatchObject({ kind: 'not_configured' });
    const das = new HeliusDasClient(rpcTransport(async () => json({}), 'helius_das'), { tryConsume: async () => false });
    expect(das.configured).toBe(true);
    await expect(das.getAsset(MINT)).rejects.toMatchObject({ kind: 'budget_exhausted' });
  });
});

describe('DexScreener / GeckoTerminal', () => {
  it('404 → aucun pool ; autre statut → http_error ; corps invalide → invalid_response', async () => {
    expect(await new DexScreenerClient(rest('dexscreener', async () => json({}, 404))).getTokenPairs(MINT)).toEqual([]);
    await expect(new DexScreenerClient(rest('dexscreener', async () => json({}, 403))).getTokenPairs(MINT)).rejects.toMatchObject({ kind: 'http_error' });
    await expect(new DexScreenerClient(rest('dexscreener', async () => json({ pairs: 1 }))).getTokenPairs(MINT)).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(await new DexScreenerClient(rest('dexscreener', async () => json({}, 404))).getPair(MINT)).toBeNull();
    await expect(new DexScreenerClient(rest('dexscreener', async () => json({}, 403))).getPair(MINT)).rejects.toMatchObject({ kind: 'http_error' });
    await expect(new DexScreenerClient(rest('dexscreener', async () => json([]))).getPair(MINT)).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(await new DexScreenerClient(rest('dexscreener', async () => json({ pairs: null }))).getPair(MINT)).toBeNull();

    expect(await new GeckoTerminalClient(rest('geckoterminal', async () => json({}, 404))).getTokenPools(MINT)).toEqual([]);
    await expect(new GeckoTerminalClient(rest('geckoterminal', async () => json({}, 403))).getTokenPools(MINT)).rejects.toMatchObject({ kind: 'http_error' });
    await expect(new GeckoTerminalClient(rest('geckoterminal', async () => json({ data: 'x' }))).getTokenPools(MINT)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('éléments malformés ignorés un par un (données hostiles)', async () => {
    const pairs = await new DexScreenerClient(
      rest('dexscreener', async () =>
        json([
          { chainId: 'solana', dexId: 'x', pairAddress: 'court' },
          { chainId: 'ethereum', dexId: 'u', pairAddress: MINT, baseToken: { address: MINT }, quoteToken: { address: MINT } },
          { chainId: 'solana', dexId: 'orca', pairAddress: MINT, baseToken: { address: MINT, name: 'N' }, quoteToken: { address: MINT }, priceUsd: '0.5' },
        ]),
      ),
    ).getTokenPairs(MINT);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.priceUsd).toBe(0.5);
  });
});

describe('JupiterQuoteClient (devis seulement)', () => {
  const client = (response: Response, seen: string[] = []) =>
    new JupiterQuoteClient(rest('jupiter', async (url) => (seen.push(url), response)), 500);

  it('construit la requête de devis (aucune route /swap)', async () => {
    const seen: string[] = [];
    await client(json({ inAmount: '10', outAmount: '5', priceImpactPct: '0.1', routePlan: [] }), seen).getSellQuote(MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 10n);
    expect(seen[0]).toBe(`https://example.test/quote?inputMint=${MINT}&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=10&slippageBps=500`);
    expect(seen[0]).not.toContain('/swap');
  });

  it.each([
    ['TOKEN_NOT_TRADABLE', json({ error: 'not tradable', errorCode: 'TOKEN_NOT_TRADABLE' }, 400), { routeFound: false }],
    ['COULD_NOT_FIND_ANY_ROUTE', json({ errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }, 400), { routeFound: false }],
  ])('%s → aucune route', async (_name, response, expected) => {
    await expect(client(response).getSellQuote(MINT, MINT, 1n)).resolves.toEqual(expected);
  });

  it.each([
    ['400 inconnu', json({ errorCode: 'INVALID_MINT' }, 400), 'http_error'],
    ['403', json({}, 403), 'http_error'],
    ['réponse hors schéma', json({ inAmount: 'x' }), 'invalid_response'],
    ['impact non numérique', json({ inAmount: '1', outAmount: '1', priceImpactPct: 'abc', routePlan: [] }), 'invalid_response'],
  ])('%s → %s', async (_name, response, kind) => {
    await expect(client(response).getSellQuote(MINT, MINT, 1n)).rejects.toMatchObject({ kind });
  });
});

describe('RugCheckClient', () => {
  it('404 → null ; 403 → http_error ; corps invalide → invalid_response ; erreur réseau non rattrapée par le repli', async () => {
    expect(await new RugCheckClient(rest('rugcheck', async () => json({}, 404))).getReport(MINT)).toBeNull();
    await expect(new RugCheckClient(rest('rugcheck', async () => json({}, 403))).getReport(MINT)).rejects.toMatchObject({ kind: 'http_error' });
    await expect(new RugCheckClient(rest('rugcheck', async () => json({ score_normalised: 'x' }))).getReport(MINT)).rejects.toMatchObject({ kind: 'invalid_response' });
    await expect(new RugCheckClient(rest('rugcheck', async () => Promise.reject(new TypeError('x')))).getReport(MINT)).rejects.toMatchObject({ kind: 'network' });
  });
});
