import { isSolanaAddress } from '@raijin/shared-util';
import * as z from 'zod';
import { UpstreamError } from '../core/errors';
import { requestJson } from '../core/http';
import type { CreditBudget, CreditLane } from '../core/ports';
import type { JsonRpcTransport } from './json-rpc';

/**
 * Historique de transactions d'une adresse : méthode Helius `getTransactionsForAddress`
 * (doc vérifiée le 2026-11-24 : https://www.helius.dev/docs/rpc/gettransactionsforaddress).
 * Mode `full` : 10 crédits par tranche de 100 transactions renvoyées, 10 au minimum ; une page est
 * bornée à 100 transactions, donc 10 crédits réservés **avant chaque tentative** (rejeux compris).
 * Lecture seule : aucune transaction n'est construite, signée ni envoyée.
 */
export const HISTORY_PAGE_MAX = 100;
export const HISTORY_CREDITS_PER_PAGE = 10;
export const HISTORY_METHOD = 'getTransactionsForAddress';
/** Délai d'une page `full` (quelques centaines de ko) : plus long que les appels RPC courts. */
export const HISTORY_TIMEOUT_MS = 15_000;

/** Jeton de pagination `slot:position` (doc Helius). */
const PAGINATION_TOKEN = /^\d{1,20}:\d{1,10}$/;

/** Entrée renvoyée (mode `full`) : `slot`, `transactionIndex`, `blockTime`, `transaction`, `meta` (non interprétés ici). */
const historyEntrySchema = z.looseObject({
  slot: z.number().int().nonnegative(),
  transactionIndex: z.number().int().nonnegative().optional(),
  blockTime: z.number().int().nullable().optional(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

const historyResultSchema = z.object({
  data: z.array(z.unknown()).max(1_000),
  paginationToken: z.string().max(40).nullable().optional(),
});

const rpcErrorSchema = z.object({ code: z.number().optional(), message: z.string().max(2_000).optional() });

/**
 * Codes et messages qui signalent une méthode absente de l'offre (la doc Helius ne documente pas
 * l'erreur exacte) : -32601 (méthode inconnue, JSON-RPC 2.0), -32403 / 403 (accès refusé), message
 * citant l'offre ou une mise à niveau. Le message du fournisseur n'est **jamais** conservé ni journalisé.
 */
const UNAVAILABLE_CODES: ReadonlySet<number> = new Set([-32601, -32403, 403]);
const UNAVAILABLE_MESSAGE = /\b(?:plan|upgrade|paid|not (?:available|supported|enabled|allowed)|method not found|unsupported)\b/i;

/** La méthode n'est pas disponible avec cette clé / offre Helius : l'appelant se désactive proprement. */
export class HeliusMethodUnavailableError extends Error {
  override readonly name = 'HeliusMethodUnavailableError';
  readonly code = 'HELIUS_METHOD_UNAVAILABLE' as const;

  constructor(readonly method: string) {
    super('Méthode Helius indisponible sur cette offre.');
  }
}

export interface HistoryPageOptions {
  /** Jeton de la page précédente (`null` : depuis la première transaction). */
  readonly cursor?: string | null;
  /** Transactions par page (1 à 100, défaut 100). */
  readonly limit?: number;
  /** Ordre chronologique (défaut `asc` : plus anciennes d'abord). */
  readonly sortOrder?: 'asc' | 'desc';
  readonly signal?: AbortSignal;
}

export interface HistoryPage {
  /** Transactions réussies, au format `json` (`transaction`, `meta` à valider par l'appelant). */
  readonly entries: readonly HistoryEntry[];
  /** Entrées écartées (forme inattendue). */
  readonly dropped: number;
  /** Jeton de la page suivante, `null` en fin d'historique. */
  readonly next: string | null;
}

/** Client `getTransactionsForAddress` (clé requise, file `helius_rpc` partagée avec les autres appels RPC). */
export class HeliusHistoryClient {
  constructor(
    private readonly transport: JsonRpcTransport | null,
    private readonly budget: CreditBudget,
    readonly lane: CreditLane = 'wallet',
  ) {}

  get configured(): boolean {
    return this.transport !== null;
  }

  /**
   * Une page d'historique. Lève `UpstreamError` (`not_configured`, `budget_exhausted`, panne…) ou
   * `HeliusMethodUnavailableError` si l'offre ne propose pas la méthode.
   */
  async page(address: string, options: HistoryPageOptions = {}): Promise<HistoryPage> {
    const transport = this.transport;
    if (transport === null) throw new UpstreamError('helius_rpc', 'not_configured');
    if (!isSolanaAddress(address)) throw new RangeError('Adresse invalide.');
    const limit = options.limit ?? HISTORY_PAGE_MAX;
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_MAX) throw new RangeError('Taille de page invalide.');
    const cursor = options.cursor ?? null;
    if (cursor !== null && !PAGINATION_TOKEN.test(cursor)) throw new RangeError('Jeton de pagination invalide.');

    const params: Record<string, unknown> = {
      transactionDetails: 'full',
      sortOrder: options.sortOrder ?? 'asc',
      limit,
      encoding: 'json',
      maxSupportedTransactionVersion: 1,
      commitment: 'finalized',
      filters: { status: 'succeeded' },
    };
    if (cursor !== null) params['paginationToken'] = cursor;

    let unavailable = false;
    const startedAt = Date.now();
    let status: number | string = 'error';
    try {
      const result = await transport.gate.run(async () => {
        if (!(await this.budget.tryConsume(HISTORY_CREDITS_PER_PAGE, this.lane))) throw new UpstreamError('helius_rpc', 'budget_exhausted');
        let response;
        try {
          response = await requestJson(transport.fetch, {
            source: 'helius_rpc',
            url: transport.url(),
            method: 'POST',
            body: { jsonrpc: '2.0', id: 1, method: HISTORY_METHOD, params: [address, params] },
            timeoutMs: Math.max(transport.timeoutMs, HISTORY_TIMEOUT_MS),
            maxBytes: transport.maxBytes,
            signal: options.signal,
          });
        } catch (error) {
          // 403 sans corps JSON : accès refusé à la méthode.
          if (error instanceof UpstreamError && error.status === 403) {
            unavailable = true;
            throw new UpstreamError('helius_rpc', 'rpc_error', 403);
          }
          throw error;
        }
        status = response.status;
        const body = response.body as Record<string, unknown> | null;
        const rawError = typeof body === 'object' && body !== null && body['error'] != null ? rpcErrorSchema.safeParse(body['error']) : null;
        const rpcError = rawError === null ? null : rawError.success ? rawError.data : {};
        const code = rpcError?.code ?? null;
        // Limite de débit d'abord (son message peut citer l'offre) : rejouée, jamais « indisponible ».
        if (code === 429 || code === -32429) throw new UpstreamError('helius_rpc', 'rate_limited', code);
        if (response.status === 403 || (rpcError !== null && isUnavailable(rpcError))) {
          unavailable = true;
          throw new UpstreamError('helius_rpc', 'rpc_error', 403);
        }
        if (rpcError !== null) throw new UpstreamError('helius_rpc', 'rpc_error', code);
        if (response.status !== 200) throw new UpstreamError('helius_rpc', 'http_error', response.status);
        if (typeof body !== 'object' || body === null || !('result' in body)) throw new UpstreamError('helius_rpc', 'invalid_response', response.status);
        const parsed = historyResultSchema.safeParse(body['result']);
        if (!parsed.success) throw new UpstreamError('helius_rpc', 'invalid_response', response.status);
        return parsed.data;
      }, options.signal);

      const entries: HistoryEntry[] = [];
      for (const raw of result.data) {
        const entry = historyEntrySchema.safeParse(raw);
        if (entry.success) entries.push(entry.data);
      }
      const next = result.paginationToken ?? null;
      return { entries, dropped: result.data.length - entries.length, next: next !== null && PAGINATION_TOKEN.test(next) ? next : null };
    } catch (error) {
      if (error instanceof UpstreamError) status = error.kind;
      if (unavailable) throw new HeliusMethodUnavailableError(HISTORY_METHOD);
      throw error;
    } finally {
      transport.logger.debug('upstream_call', { source: 'helius_rpc', method: HISTORY_METHOD, status, latencyMs: Date.now() - startedAt });
    }
  }
}

function isUnavailable(error: { code?: number; message?: string }): boolean {
  if (error.code !== undefined && UNAVAILABLE_CODES.has(error.code)) return true;
  return error.message !== undefined && UNAVAILABLE_MESSAGE.test(error.message);
}
