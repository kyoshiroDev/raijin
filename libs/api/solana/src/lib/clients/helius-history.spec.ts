import { MemoryCreditBudget } from '../core/memory';
import type { LogFields } from '../core/ports';
import { SolanaDataService } from '../solana-data.service';
import { HISTORY_METHOD, HeliusMethodUnavailableError } from './helius-history';

const KEY = 'history-KEY-0123456789abcdef';
const ADDRESS = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Call {
  readonly url: string;
  readonly body: { method: string; params: [string, Record<string, unknown>] };
}

function service(responses: Array<Response | (() => Response)>, budget = new MemoryCreditBudget(1_000), lines: string[] = []) {
  const calls: Call[] = [];
  const instance = new SolanaDataService({
    heliusApiKey: KEY,
    creditBudget: budget,
    config: { maxAttempts: 2, backoffBaseMs: 1, maxRetryAfterMs: 1 },
    random: () => 0,
    logger: {
      debug: (event: string, fields: LogFields) => lines.push(JSON.stringify({ event, fields })),
      warn: (event: string, fields: LogFields) => lines.push(JSON.stringify({ event, fields })),
    },
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) as Call['body'] });
      const next = responses.shift();
      if (next === undefined) throw new Error('réponse non prévue');
      return typeof next === 'function' ? next() : next;
    },
  });
  return { instance, calls };
}

const ENTRY = { slot: 10, transactionIndex: 2, blockTime: 1_700_000_000, transaction: { signatures: ['x'] }, meta: { err: null } };

describe('HeliusHistoryClient (getTransactionsForAddress)', () => {
  it('requête conforme à la doc, page validée, entrées malformées écartées, jeton suivant filtré', async () => {
    const budget = new MemoryCreditBudget(1_000);
    const { instance, calls } = service([json({ jsonrpc: '2.0', id: 1, result: { data: [ENTRY, { slot: -1 }, 'x'], paginationToken: '10:2' } })], budget);
    const page = await instance.transactionHistoryPage(ADDRESS, { cursor: '9:1', limit: 50 });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ slot: 10, transaction: { signatures: ['x'] } });
    expect(page.dropped).toBe(2);
    expect(page.next).toBe('10:2');
    expect(calls[0]?.body.method).toBe(HISTORY_METHOD);
    expect(calls[0]?.body.params).toEqual([
      ADDRESS,
      {
        transactionDetails: 'full',
        sortOrder: 'asc',
        limit: 50,
        encoding: 'json',
        maxSupportedTransactionVersion: 1,
        commitment: 'finalized',
        filters: { status: 'succeeded' },
        paginationToken: '9:1',
      },
    ]);
    // 10 crédits réservés sur la voie `wallet`.
    expect(await budget.tryConsume(990, 'wallet')).toBe(true);
    expect(await budget.tryConsume(1, 'wallet')).toBe(false);
  });

  it('fin d’historique (jeton null ou malformé) → next null', async () => {
    const { instance } = service([
      json({ result: { data: [], paginationToken: null } }),
      json({ result: { data: [ENTRY], paginationToken: 'abc; DROP' } }),
    ]);
    expect((await instance.transactionHistoryPage(ADDRESS)).next).toBeNull();
    expect((await instance.transactionHistoryPage(ADDRESS, { sortOrder: 'desc' })).next).toBeNull();
  });

  it('entrées refusées avant tout appel : adresse, taille de page, jeton', async () => {
    const { instance, calls } = service([]);
    await expect(instance.transactionHistoryPage('pas-une-adresse')).rejects.toThrow(RangeError);
    await expect(instance.transactionHistoryPage(ADDRESS, { limit: 101 })).rejects.toThrow(RangeError);
    await expect(instance.transactionHistoryPage(ADDRESS, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(instance.transactionHistoryPage(ADDRESS, { cursor: '../x' })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('sans clé : not_configured ; budget épuisé : budget_exhausted sans appel', async () => {
    const noKey = new SolanaDataService({ heliusApiKey: null, fetch: async () => json({}) });
    await expect(noKey.transactionHistoryPage(ADDRESS)).rejects.toMatchObject({ name: 'UpstreamError', kind: 'not_configured' });
    const { instance, calls } = service([], new MemoryCreditBudget(5));
    await expect(instance.transactionHistoryPage(ADDRESS)).rejects.toMatchObject({ kind: 'budget_exhausted' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['méthode inconnue (-32601)', json({ error: { code: -32601, message: 'Method not found' } })],
    ['accès refusé (-32403)', json({ error: { code: -32403, message: 'Forbidden' } })],
    ['message d’offre', json({ error: { code: -32600, message: 'This method is not available on the free plan' } })],
    ['HTTP 403 JSON', json({ error: { message: 'nope' } }, 403)],
    ['HTTP 403 sans JSON', new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain' } })],
  ])('%s → HeliusMethodUnavailableError, sans rejeu ni message du fournisseur', async (_label, response) => {
    const { instance, calls } = service([response]);
    const error = (await instance.transactionHistoryPage(ADDRESS).catch((e: unknown) => e)) as HeliusMethodUnavailableError;
    expect(error).toBeInstanceOf(HeliusMethodUnavailableError);
    expect(error.code).toBe('HELIUS_METHOD_UNAVAILABLE');
    expect(error.message).not.toMatch(/plan|Forbidden|nope/);
    expect(calls).toHaveLength(1);
    // Pas un échec du fournisseur : le disjoncteur reste fermé.
    expect(instance.breakerStates()['helius_rpc']).toBe('closed');
  });

  it('429 (même si le message cite l’offre) : rejoué, crédits réservés à chaque tentative, jamais « indisponible »', async () => {
    const budget = new MemoryCreditBudget(15);
    const { instance, calls } = service([json({ error: { code: -32429, message: 'rate limit for your plan' } }), json({ result: { data: [ENTRY] } })], budget);
    await expect(instance.transactionHistoryPage(ADDRESS)).rejects.toMatchObject({ kind: 'budget_exhausted' });
    expect(calls).toHaveLength(1);
  });

  it('autres erreurs : rpc_error, http_error, invalid_response', async () => {
    const { instance } = service([
      json({ error: { code: -32602, message: 'invalid params' } }),
      json({ error: 'bizarre' }),
      json({ result: { data: [] } }, 404),
      json({ nothing: true }),
      json({ result: { data: 'x' } }),
    ]);
    await expect(instance.transactionHistoryPage(ADDRESS)).rejects.toMatchObject({ kind: 'rpc_error', status: -32602 });
    await expect(instance.transactionHistoryPage(ADDRESS)).rejects.toMatchObject({ kind: 'rpc_error', status: null });
    await expect(instance.transactionHistoryPage(ADDRESS)).rejects.toMatchObject({ kind: 'http_error', status: 404 });
    await expect(instance.transactionHistoryPage(ADDRESS)).rejects.toMatchObject({ kind: 'invalid_response' });
    await expect(instance.transactionHistoryPage(ADDRESS)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('anti-fuite : clé absente des journaux et des erreurs, présente seulement dans l’URL appelée', async () => {
    const lines: string[] = [];
    const { instance, calls } = service(
      [
        () => {
          throw new TypeError(`fetch failed: https://mainnet.helius-rpc.com/?api-key=${KEY}`);
        },
        () => {
          throw new TypeError(`fetch failed: https://mainnet.helius-rpc.com/?api-key=${KEY}`);
        },
      ],
      new MemoryCreditBudget(1_000),
      lines,
    );
    const error = (await instance.transactionHistoryPage(ADDRESS).catch((e: unknown) => e)) as Error;
    expect(calls.every((call) => call.url.includes(KEY))).toBe(true);
    expect(error.cause).toBeUndefined();
    const everything = [error.message, error.stack ?? '', JSON.stringify(error), ...lines].join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain('api-key');
  });
});
