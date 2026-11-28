// feat/wallet-study — transaction-history source of wallet-study-collect behind a small interface, so another
// provider / method (e.g. getSignaturesForAddress + getTransaction) can replace Helius GTFA without touching the
// Edge Function. OFFLINE STUDY ONLY.
//
// Secret hygiene: the Helius key is only accepted as an argument (read by the Edge Function with
// Deno.env.get('HELIUS_API_KEY')). The docs only document the `?api-key=` query parameter, so the key is in the URL:
// the URL is NEVER logged, returned or stored, and every error message leaving this module goes through
// redactSecret() (a fetch error can embed the URL).
import { safeRequest } from './http-client';
import { HistoryError, type HistoryPage, httpFailureKind, PAGE_LIMIT, parseHistoryResponse, redactSecret } from './wallet-collect';

export const HELIUS_RPC_HOST = 'mainnet.helius-rpc.com';
/** Per-request timeout (a 100-transaction full page is a few hundred KB). */
export const HISTORY_TIMEOUT_MS = 15_000;
/** Body cap of one history page (100 full transactions stay well below). */
export const HISTORY_MAX_BODY_BYTES = 8_000_000;
const HELIUS_HOSTS: ReadonlySet<string> = new Set([HELIUS_RPC_HOST]);

export interface TxHistorySource {
  /**
   * Successful transactions referencing `address`, OLDEST FIRST, `limit` per page, resumed from `cursor`
   * (null = from the very first transaction). Throws HistoryError (message free of secrets).
   */
  page(address: string, cursor: string | null, limit?: number): Promise<HistoryPage>;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function heliusGtfaRequest(address: string, cursor: string | null, limit: number): unknown {
  const opts: Record<string, unknown> = {
    transactionDetails: 'full',
    sortOrder: 'asc',
    limit,
    encoding: 'json',
    maxSupportedTransactionVersion: 1,
    commitment: 'finalized',
    filters: { status: 'succeeded' },
  };
  if (cursor) opts['paginationToken'] = cursor;
  return { jsonrpc: '2.0', id: 1, method: 'getTransactionsForAddress', params: [address, opts] };
}

/** Helius getTransactionsForAddress (full transactions, ascending, succeeded only). */
export function createHeliusSource(apiKey: string, fetchFn: FetchFn = (input, init) => fetch(input, init)): TxHistorySource {
  if (!/^[A-Za-z0-9-]{16,100}$/.test(apiKey)) {
    throw new HistoryError('HELIUS_API_KEY has an unexpected format', 'outage');
  }
  const url = `https://${HELIUS_RPC_HOST}/?api-key=${encodeURIComponent(apiKey)}`;
  return {
    async page(address, cursor, limit = PAGE_LIMIT) {
      const res = await safeRequest(url, {
        hosts: HELIUS_HOSTS,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(heliusGtfaRequest(address, cursor, limit)),
        timeoutMs: HISTORY_TIMEOUT_MS,
        maxBytes: HISTORY_MAX_BODY_BYTES,
        fetchFn,
      });
      if (res.kind === 'error') {
        throw new HistoryError(redactSecret(`fetch failed (${res.name}): ${res.message}`, apiKey), 'outage');
      }
      if (res.kind === 'http') throw new HistoryError(`HTTP ${res.status}`, httpFailureKind(res.status));
      if (res.kind === 'refused') {
        const why = res.reason === 'redirect' ? `redirect refused (HTTP ${res.status ?? 0})` : `request refused (${res.reason})`;
        throw new HistoryError(why, 'outage');
      }
      let json: unknown;
      try {
        json = JSON.parse(res.text) as unknown;
      } catch {
        throw new HistoryError('invalid JSON', 'outage');
      }
      try {
        return parseHistoryResponse(json);
      } catch (e) {
        if (e instanceof HistoryError) throw new HistoryError(redactSecret(e.message, apiKey), e.kind);
        throw new HistoryError('unparsable response', 'mint');
      }
    },
  };
}
