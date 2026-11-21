// feat/wallet-study — one call of wallet-study-collect, with every side effect injected (store = Postgres via
// supabase-js in the Edge Function, an in-memory fake in the tests; source = Helius GTFA or a mock). OFFLINE STUDY ONLY.
//
// Security review fixes:
//   L1 lease: claim() returns an opaque token; release(token) only clears the lease it owns. Lease 90 s, no new
//      request after 30 s, 15 s request timeout: the worst-case call (≈ 30 s + 15 s + a few DB writes) stays well
//      under the lease.
//   L2 failures: failurePolicy() — outage (HTTP 401/403/5xx, network, invalid JSON, any store / DB error) and 429 stop
//      the whole call WITHOUT touching the mint's attempts; an error response from Helius gets its reservation
//      refunded (atomic, never below 0). attempts + 1 only for per-mint problems (bad envelope, RPC error, other 4xx).
import {
  collectBuyers,
  creditsToReserve,
  type EarlyBuyerRow,
  exclusionSet,
  failurePolicy,
  HistoryError,
  type HistoryPage,
  isBase58Address,
  MAX_ATTEMPTS,
  type MintStatus,
  PAGE_LIMIT,
  paceDelay,
  redactSecret,
  statusAfterPage,
} from './wallet-collect.ts';
import type { TxHistorySource } from './wallet-collect-helius.ts';

export const LEASE_S = 90;
export const STOP_NEW_REQUEST_MS = 30_000;
export const MINTS_PER_CALL = 5;

export interface QueueRow {
  mint: string;
  pair_address: string;
  pair_created_at: string | null;
  detected_at: string;
  is_new: boolean;
}

export interface StateRow {
  status: MintStatus;
  cursor: string | null;
  pages: number;
  buyers: number;
  creator: string | null;
  creator_checked: boolean;
  pool_creator: string | null;
  attempts: number;
  dropped_txs: number;
}

export type StatePatch = Partial<StateRow> & { error?: string | null; finished_at?: string | null; updated_at?: string };

/** Persistence. Every method throws on a store error (treated as an outage: the call stops, no attempt counted). */
export interface CollectStore {
  /** Lease token, or null when another call holds a live lease. */
  claim(leaseSeconds: number): Promise<string | null>;
  /** Clears the lease only if `token` still owns it. */
  release(token: string): Promise<void>;
  queue(limit: number): Promise<QueueRow[]>;
  ensureState(q: QueueRow): Promise<void>;
  readState(mint: string): Promise<StateRow | null>;
  /** Atomic reservation; false = hard cap reached. */
  reserve(mint: string, credits: number): Promise<boolean>;
  /** Atomic refund of a reservation (never below 0). */
  refund(mint: string, credits: number): Promise<void>;
  updateState(mint: string, patch: StatePatch): Promise<void>;
  knownBuyers(mint: string): Promise<string[]>;
  writeBuyers(rows: EarlyBuyerRow[]): Promise<void>;
  budgetUsed(): Promise<number>;
}

export interface RunDeps {
  store: CollectStore;
  source: TxHistorySource;
  /** Only used to redact error texts. */
  secret: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type StopReason = 'budget' | 'rate_limited' | 'outage' | 'time';

export interface RunStats {
  mints: number;
  pages: number;
  buyers: number;
  /** Credits reserved minus credits refunded during this call. */
  credits: number;
  refunded: number;
  budget: number;
  stopped: StopReason | null;
  /** Secret-free reason of an outage stop. */
  error: string | null;
  skipped?: 'busy';
  ms: number;
}

class StopCall extends Error {
  readonly reason: StopReason;
  readonly origin: unknown;
  constructor(reason: StopReason, cause?: unknown) {
    super(reason);
    this.reason = reason;
    this.origin = cause;
  }
}

export async function runCollectCall(deps: RunDeps): Promise<RunStats> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { store, source } = deps;
  const started = now();
  const stats: RunStats = { mints: 0, pages: 0, buyers: 0, credits: 0, refunded: 0, budget: 0, stopped: null, error: null, ms: 0 };
  const redact = (e: unknown) => redactSecret(e instanceof Error ? e.message : String(e), deps.secret);

  const token = await store.claim(LEASE_S);
  if (token === null) {
    stats.skipped = 'busy';
    stats.ms = now() - started;
    return stats;
  }

  let lastStart: number | null = null;
  /** Reserve → pace → request. A Helius error response gets its reservation refunded before rethrowing. */
  const request = async (mint: string, address: string, cursor: string | null, limit: number): Promise<HistoryPage> => {
    if (now() - started > STOP_NEW_REQUEST_MS) throw new StopCall('time');
    const cost = creditsToReserve(limit);
    if (!(await store.reserve(mint, cost))) throw new StopCall('budget');
    stats.credits += cost;
    await sleep(paceDelay(lastStart, now()));
    lastStart = now();
    try {
      return await source.page(address, cursor, limit);
    } catch (e) {
      if (failurePolicy(e).refund) {
        await store.refund(mint, cost);
        stats.credits -= cost;
        stats.refunded += cost;
      }
      throw e;
    }
  };

  try {
    const rows = (await store.queue(MINTS_PER_CALL))
      .filter((q) => isBase58Address(q.mint) && isBase58Address(q.pair_address))
      .slice(0, MINTS_PER_CALL);
    for (const q of rows) {
      if (now() - started > STOP_NEW_REQUEST_MS) throw new StopCall('time');
      if (q.is_new) await store.ensureState(q);
      const state = await store.readState(q.mint);
      if (!state || state.status !== 'pending') continue;
      stats.mints++;
      try {
        await collectMint(store, q, state, request, stats);
      } catch (e) {
        if (e instanceof StopCall) throw e;
        const policy = failurePolicy(e);
        if (policy.stopCall) {
          // Outage / 429: the mint is not at fault, its attempts and status are left untouched.
          throw new StopCall(e instanceof HistoryError && e.kind === 'rate_limited' ? 'rate_limited' : 'outage', e);
        }
        const attempts = state.attempts + 1;
        const failed = attempts >= MAX_ATTEMPTS;
        const at = new Date(now()).toISOString();
        await store.updateState(q.mint, {
          attempts,
          error: redact(e),
          status: failed ? 'failed' : 'pending',
          finished_at: failed ? at : null,
          updated_at: at,
        });
      }
    }
  } catch (e) {
    if (e instanceof StopCall) {
      stats.stopped = e.reason;
      if (e.origin !== undefined) stats.error = redact(e.origin);
    } else {
      stats.stopped = 'outage';
      stats.error = redact(e);
    }
  } finally {
    try {
      stats.budget = await store.budgetUsed();
    } catch {
      /* best effort */
    }
    try {
      await store.release(token);
    } catch {
      /* the lease expires by itself */
    }
  }
  stats.ms = now() - started;
  return stats;
}

type RequestFn = (mint: string, address: string, cursor: string | null, limit: number) => Promise<HistoryPage>;

async function collectMint(
  store: CollectStore,
  q: QueueRow,
  state: StateRow,
  request: RequestFn,
  stats: { pages: number; buyers: number },
): Promise<void> {
  // a. Token creator: fee payer of the mint's first transaction (looked up once, even when none is found).
  if (!state.creator_checked) {
    const first = await request(q.mint, q.mint, null, 1);
    state.creator = first.txs[0]?.feePayer ?? null;
    state.creator_checked = true;
    await store.updateState(q.mint, { creator: state.creator, creator_checked: true });
  }

  // Wallets already stored (resume): never duplicated, ranks continue.
  const known = new Set<string>(state.buyers > 0 ? await store.knownBuyers(q.mint) : []);

  // b. Pool pages, oldest first.
  let status: MintStatus = 'pending';
  while (status === 'pending') {
    const page = await request(q.mint, q.pair_address, state.cursor, PAGE_LIMIT);
    stats.pages++;
    if (state.pages === 0 && state.cursor === null) state.pool_creator = page.txs[0]?.feePayer ?? null;
    const excluded = exclusionSet(q.pair_address, q.mint, [state.creator, state.pool_creator]);
    const rows = collectBuyers(q.mint, page.txs, known, excluded);
    if (rows.length > 0) {
      await store.writeBuyers(rows);
      for (const r of rows) known.add(r.wallet);
      stats.buyers += rows.length;
    }
    state.pages += 1;
    state.cursor = page.next;
    state.dropped_txs = Math.min(1_000_000, state.dropped_txs + page.dropped);
    status = statusAfterPage(known.size, page.next, state.pages);
    const at = new Date().toISOString();
    await store.updateState(q.mint, {
      status,
      cursor: status === 'pending' ? state.cursor : null,
      pages: state.pages,
      buyers: known.size,
      pool_creator: state.pool_creator,
      dropped_txs: state.dropped_txs,
      error: null,
      updated_at: at,
      finished_at: status === 'pending' ? null : at,
    });
  }
}
