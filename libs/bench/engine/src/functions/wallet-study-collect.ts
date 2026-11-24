// Edge Function: wallet-study-collect (feat/wallet-study). OFFLINE STUDY ONLY: no alert, no trading, no wallet
// connection, no key in the database / logs / responses.
// Called every minute by pg_cron (supabase/sql/schedule_wallet_study.sql) with the x-cron-secret header, compared in
// constant time (401 otherwise, POST only). No user JWT: deploy with --no-verify-jwt.
//
// The call itself is _shared/wallet-collect-run.ts runCollectCall (tested with an in-memory store):
//   1. Lease 90 s with an owner token (rpc wallet_study_claim / wallet_study_release(token)): an overlapping call
//      returns { skipped: 'busy' } without any request; a late call can never release a lease it does not own.
//   2. Budget: every Helius request first RESERVES its maximum cost (rpc wallet_study_reserve: 10 credits for a
//      100-transaction page); a refused reservation = HARD STOP at 600 000 credits. An error response from Helius
//      (free) is refunded (rpc wallet_study_refund, never below 0).
//   3. Queue (rpc wallet_study_queue): in-progress mints first, then labelled signal_outcomes (status final or
//      x2_before_sl30 known), oldest detection first, ≤ 5 per call. Per mint: creator lookup (mint's first
//      transaction), then pool pages oldest first until 50 distinct buyers / end of history / 20 pages.
//   4. Pacing ≥ 150 ms between request starts; no new request after 30 s; 15 s timeout per request.
//   5. Failures: 429 and outages (HTTP 401/403/5xx, network, DB error) stop the call WITHOUT counting an attempt on
//      the mint; per-mint problems (bad envelope, RPC error) count an attempt, 'failed' after 3.
// Response { mints, pages, buyers, credits, refunded, budget, stopped, error, skipped?, ms } (secret-free).
// Deploy: supabase functions deploy wallet-study-collect --no-verify-jwt
// Secrets: CRON_SECRET (same as scan-tokens), HELIUS_API_KEY (never logged / echoed).
import type { SupabaseClient } from '../db/bench-db';
import { type EarlyBuyerRow } from '../ported/wallet-collect';
import { HistoryError, parseHistoryResponse } from '../ported/wallet-collect';
import type { TxHistorySource } from '../ported/wallet-collect-helius';
import { type CollectStore, type QueueRow, runCollectCall, type StateRow } from '../ported/wallet-collect-run';
import { engineLog } from './log';

const STATE_COLUMNS = 'status, cursor, pages, buyers, creator, creator_checked, pool_creator, attempts, dropped_txs';

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

function supabaseStore(db: SupabaseClient): CollectStore {
  return {
    async claim(leaseSeconds) {
      const { data, error } = await db.rpc('wallet_study_claim', { p_lease_seconds: leaseSeconds });
      check(error, 'claim');
      return typeof data === 'string' && data.length > 0 ? data : null;
    },
    async release(token) {
      const { error } = await db.rpc('wallet_study_release', { p_token: token });
      check(error, 'release');
    },
    async queue(limit) {
      const { data, error } = await db.rpc('wallet_study_queue', { p_limit: limit });
      check(error, 'queue');
      return (data ?? []) as QueueRow[];
    },
    async ensureState(q) {
      const { error } = await db.from('wallet_study_state').upsert(
        { mint: q.mint, pair_address: q.pair_address, pair_created_at: q.pair_created_at, detected_at: q.detected_at },
        { onConflict: 'mint', ignoreDuplicates: true },
      );
      check(error, 'state insert');
    },
    async readState(mint) {
      const { data, error } = await db.from('wallet_study_state').select(STATE_COLUMNS).eq('mint', mint).maybeSingle();
      check(error, 'state read');
      return (data ?? null) as StateRow | null;
    },
    async reserve(mint, credits) {
      const { data, error } = await db.rpc('wallet_study_reserve', { p_mint: mint, p_credits: credits });
      check(error, 'reserve');
      return data === true;
    },
    async refund(mint, credits) {
      const { error } = await db.rpc('wallet_study_refund', { p_mint: mint, p_credits: credits });
      check(error, 'refund');
    },
    async updateState(mint, patch) {
      const { error } = await db.from('wallet_study_state')
        .update({ updated_at: new Date().toISOString(), ...patch })
        .eq('mint', mint);
      check(error, 'state update');
    },
    async knownBuyers(mint) {
      const { data, error } = await db.from('early_buyers').select('wallet').eq('mint', mint);
      check(error, 'buyers read');
      return ((data ?? []) as { wallet: string }[]).map((r) => r.wallet);
    },
    async writeBuyers(rows: EarlyBuyerRow[]) {
      const { error } = await db.from('early_buyers').upsert(rows, { onConflict: 'mint,wallet', ignoreDuplicates: true });
      check(error, 'buyers write');
    },
    async budgetUsed() {
      const { data, error } = await db.from('wallet_study_budget').select('credits_used').eq('id', 1).single();
      check(error, 'budget read');
      return (data as { credits_used: number } | null)?.credits_used ?? 0;
    },
  };
}

/**
 * Source d'historique du banc (`BenchWalletStudySource` de `@raijin/bench-solana`, même forme) : Helius
 * `getTransactionsForAddress` via `api-solana`, voie de crédits `wallet` plafonnée par jour
 * (`BENCH_WALLET_STUDY_DAILY_CREDITS`, BENCH.md §9 P1) en plus du plafond cumulé de 600 000 (SQL, inchangé).
 */
export interface WalletHistoryPort {
  state(): Promise<string>;
  page(
    address: string,
    options: { cursor?: string | null; limit?: number },
  ): Promise<
    | { readonly status: 'ok'; readonly page: { readonly entries: readonly unknown[]; readonly next: string | null } }
    | { readonly status: 'unavailable'; readonly reason: string }
  >;
}

/**
 * Remplace `createHeliusSource` (clé dans l'URL) : la page vient de `api-solana` (clé jamais vue ici), puis passe
 * par le **même** `parseHistoryResponse` qu'avant. Toute indisponibilité (budget du jour, méthode absente, panne)
 * est une `HistoryError` de type `outage` : l'appel s'arrête et la réservation SQL est remboursée, comme avant.
 */
export function historySourceFromPort(port: WalletHistoryPort): TxHistorySource {
  return {
    async page(address, cursor, limit) {
      const res = await port.page(address, { cursor, limit });
      if (res.status !== 'ok') throw new HistoryError(`history unavailable: ${res.reason}`, 'outage');
      return parseHistoryResponse({ jsonrpc: '2.0', id: 1, result: { data: [...res.page.entries], paginationToken: res.page.next } });
    },
  };
}

export interface WalletStudyCollectDeps {
  readonly db: SupabaseClient;
  readonly history: WalletHistoryPort;
}

/**
 * Port Node de l'Edge Function `wallet-study-collect` (job `wallet-study-collect`, chaque minute). ÉTUDE HORS LIGNE.
 * Sans source active (clé absente, méthode indisponible, budget du jour atteint), rien n'est réservé ni demandé.
 */
export async function runWalletStudyCollect(deps: WalletStudyCollectDeps) {
  const state = await deps.history.state();
  if (state !== 'active') return { skipped: state };
  try {
    const stats = await runCollectCall({ store: supabaseStore(deps.db), source: historySourceFromPort(deps.history), secret: '' });
    // Counters + secret-free reason only: never a URL, a key or a raw upstream payload.
    engineLog.info(JSON.stringify({ fn: 'wallet-study-collect', ...stats }));
    return stats;
  } catch (e) {
    // claim() failed (DB unreachable): nothing was requested.
    throw new Error('lease failed', { cause: e });
  }
}
