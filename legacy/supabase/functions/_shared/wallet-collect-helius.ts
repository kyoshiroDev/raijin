// feat/wallet-study — transaction-history source of wallet-study-collect behind a small interface, so another
// provider / method (e.g. getSignaturesForAddress + getTransaction) can replace Helius GTFA without touching the
// Edge Function. OFFLINE STUDY ONLY.
//
// Secret hygiene: the Helius key is only accepted as an argument (read by the Edge Function with
// Deno.env.get('HELIUS_API_KEY')). The docs only document the `?api-key=` query parameter, so the key is in the URL:
// the URL is NEVER logged, returned or stored, and every error message leaving this module goes through
// redactSecret() (a fetch error can embed the URL).
import { HistoryError, type HistoryPage, httpFailureKind, PAGE_LIMIT, parseHistoryResponse, redactSecret } from './wallet-collect.ts';

export const HELIUS_RPC_HOST = 'mainnet.helius-rpc.com';
/** Per-request timeout (a 100-transaction full page is a few hundred KB). */
export const HISTORY_TIMEOUT_MS = 15_000;

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
  if (cursor) opts.paginationToken = cursor;
  return { jsonrpc: '2.0', id: 1, method: 'getTransactionsForAddress', params: [address, opts] };
}

/** Helius getTransactionsForAddress (full transactions, ascending, succeeded only). */
export function createHeliusSource(apiKey: string, fetchFn: FetchFn = fetch): TxHistorySource {
  if (!/^[A-Za-z0-9-]{16,100}$/.test(apiKey)) {
    throw new HistoryError('HELIUS_API_KEY has an unexpected format', 'outage');
  }
  const url = `https://${HELIUS_RPC_HOST}/?api-key=${encodeURIComponent(apiKey)}`;
  return {
    async page(address, cursor, limit = PAGE_LIMIT) {
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(heliusGtfaRequest(address, cursor, limit)),
          signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS),
          redirect: 'error',
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : 'Error';
        const text = e instanceof Error ? e.message : String(e);
        throw new HistoryError(redactSecret(`fetch failed (${name}): ${text}`, apiKey), 'outage');
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new HistoryError(`HTTP ${res.status}`, httpFailureKind(res.status));
      }
      let json: unknown;
      try {
        json = await res.json();
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
