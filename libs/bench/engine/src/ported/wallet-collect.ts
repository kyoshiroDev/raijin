// feat/wallet-study — pure helpers of the wallet-study-collect Edge Function (OFFLINE STUDY ONLY: no alert, no trading,
// no wallet connection). Collects the first 50 DISTINCT buyers of each labelled token from the pool history.
// No Deno / network API here: parsing (zod), buyer extraction / dedupe / rank, exclusions, credit budget, redaction.
//
// Source: Helius getTransactionsForAddress (GTFA), checked in the Helius docs on 2026-11-21
// (https://www.helius.dev/docs/rpc/gettransactionsforaddress.md, /docs/billing/credits.md):
//   - JSON-RPC POST on https://mainnet.helius-rpc.com/?api-key=… (the docs only document the query parameter);
//   - params [address, { transactionDetails: 'full', sortOrder: 'asc', limit ≤ 1000, paginationToken, encoding,
//     maxSupportedTransactionVersion, filters: { status: 'succeeded', blockTime, slot, tokenAccounts, tokenTransfer } }];
//   - result { data: Tx[], paginationToken: "slot:position" | null }; a full Tx = { slot, transactionIndex, blockTime,
//     transaction: { signatures, message: { accountKeys, header, … } }, meta: { err, fee, pre/postBalances,
//     pre/postTokenBalances (accountIndex, mint, owner, uiTokenAmount.amount), … } } (same shape as getTransaction);
//   - metering: full = 10 credits per 100 returned transactions (rounded up, 10 minimum); failed responses free;
//   - no plan restriction documented (unlike getTransfersByAddress, explicitly Developer+): usable on Free (10 req/s).
import { z } from 'zod/v3';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** First DISTINCT buyers kept per mint. */
export const MAX_BUYERS = 50;
/** Transactions per GTFA page: 100 = exactly 10 credits (the minimum), so small pages cost nothing extra. */
export const PAGE_LIMIT = 100;
/** Pages read per pool at most (2 000 transactions, 200 credits): a pool still short of 50 buyers is then 'capped'. */
export const MAX_PAGES_PER_MINT = 20;
/** Hard stop of the whole study: never reserve a credit beyond this (the Free plan has 1 000 000 per month). */
export const CREDIT_HARD_CAP = 600_000;
/** Minimum spacing between two request starts: ≈ 6.7 req/s, under the Free 10 req/s RPC limit with margin. */
export const MIN_REQUEST_INTERVAL_MS = 150;
/** Failed attempts before a mint is given up ('failed'). */
export const MAX_ATTEMPTS = 3;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isBase58Address = (v: unknown): v is string => typeof v === 'string' && BASE58.test(v);

/**
 * Accounts that are never a buyer: core programs, AMM / launchpad programs and their pool authorities, routers.
 * A program cannot pay fees, so most of these are a safety net; the pool authorities can appear as token owners.
 */
export const NON_BUYER_ACCOUNTS: ReadonlySet<string> = new Set([
  '11111111111111111111111111111111', // System program
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated token account
  WSOL_MINT,
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4 authority
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM authority
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', // Raydium LaunchLab
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump.fun bonding curve
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap AMM
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', // pump.fun migration account
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora pools
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // Meteora DAMM v2
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', // Meteora dynamic bonding curve
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
]);

// ---------------------------------------------------------------------------
// Response parsing (zod, row by row: an invalid transaction is dropped, never the page)
// ---------------------------------------------------------------------------
const TokenBalance = z.object({
  accountIndex: z.number().int().nonnegative(),
  mint: z.string(),
  owner: z.string().optional(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d{1,40}$/) }),
});

const AccountKey = z.union([z.string(), z.object({ pubkey: z.string() }).transform((k) => k.pubkey)]);

const FullTx = z.object({
  slot: z.number().int().nonnegative(),
  transactionIndex: z.number().int().nonnegative().optional(),
  blockTime: z.number().int().positive().nullable().optional(),
  transaction: z.object({
    signatures: z.array(z.string()).min(1),
    message: z.object({ accountKeys: z.array(AccountKey).min(1) }),
  }),
  meta: z.object({
    err: z.unknown().optional(),
    fee: z.number().nonnegative().optional(),
    preBalances: z.array(z.number()).optional(),
    postBalances: z.array(z.number()).optional(),
    preTokenBalances: z.array(TokenBalance).nullable().optional(),
    postTokenBalances: z.array(TokenBalance).nullable().optional(),
  }).nullable(),
});

const RpcEnvelope = z.object({
  result: z.object({
    data: z.array(z.unknown()),
    paginationToken: z.string().max(64).nullable().optional(),
  }).optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).optional(),
});

export interface TokenDelta {
  accountIndex: number;
  mint: string;
  owner: string | null;
  pre: bigint;
  post: bigint;
}

/** One successful transaction, reduced to what buyer extraction needs. */
export interface ParsedTx {
  signature: string;
  slot: number;
  index: number;
  /** Unix seconds, null when unknown. */
  blockTime: number | null;
  /** Fee payer = first account key = first signer. */
  feePayer: string;
  tokenDeltas: TokenDelta[];
}

export interface HistoryPage {
  txs: ParsedTx[];
  /** Pagination token of the next page, null when the history is exhausted. */
  next: string | null;
  /** Transactions dropped by validation (or failed on chain). */
  dropped: number;
  /** Transactions returned by the API (what is metered). */
  returned: number;
}

/**
 * Failure classes of a history request (security review L2):
 *   rate_limited : HTTP 429 / RPC 429 — stop the call, no attempt counted, reservation refunded (failed = free).
 *   outage       : HTTP 401 / 403 / 5xx, network / timeout, invalid JSON body — configuration or provider problem,
 *                  NOT the mint's fault: stop the call, no attempt counted, reservation refunded.
 *   rpc          : JSON-RPC error object for this request (e.g. invalid params) — per-mint, attempt counted,
 *                  reservation refunded (failed responses are free on Helius).
 *   mint         : a 2xx answer that cannot be used (bad envelope) or another 4xx — per-mint, attempt counted,
 *                  reservation kept (it may have been metered).
 */
export type FailureKind = 'rate_limited' | 'outage' | 'rpc' | 'mint';

export class HistoryError extends Error {
  readonly kind: FailureKind;
  constructor(message: string, kind: FailureKind = 'mint') {
    super(message);
    this.name = 'HistoryError';
    this.kind = kind;
  }
  get rateLimited(): boolean {
    return this.kind === 'rate_limited';
  }
}

export interface FailurePolicy {
  /** Stop the whole call (no further mint). */
  stopCall: boolean;
  /** attempts + 1 on the mint (only for per-mint problems). */
  countAttempt: boolean;
  /** Refund the credits reserved for this request (the response was an error, free on Helius). */
  refund: boolean;
}

/** What to do after a failed request. Anything that is not a HistoryError (store / DB error) = outage. */
export function failurePolicy(e: unknown): FailurePolicy {
  const kind: FailureKind = e instanceof HistoryError ? e.kind : 'outage';
  switch (kind) {
    case 'rate_limited':
    case 'outage':
      return { stopCall: true, countAttempt: false, refund: e instanceof HistoryError };
    case 'rpc':
      return { stopCall: false, countAttempt: true, refund: true };
    default:
      return { stopCall: false, countAttempt: true, refund: false };
  }
}

/** HTTP status → failure kind (only called for non-2xx). */
export function httpFailureKind(status: number): FailureKind {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403 || status === 407 || status === 408 || status >= 500) return 'outage';
  return 'mint';
}

function toBig(s: string): bigint {
  return BigInt(s);
}

/** Validates one raw GTFA transaction; null when unusable (invalid shape, failed on chain, bad addresses). */
export function parseTx(raw: unknown): ParsedTx | null {
  const r = FullTx.safeParse(raw);
  if (!r.success || !r.data.meta) return null;
  const { meta, transaction, slot } = r.data;
  if (meta.err !== undefined && meta.err !== null) return null;
  const signature = transaction.signatures[0];
  const feePayer = transaction.message.accountKeys[0];
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature!) || !isBase58Address(feePayer)) return null;
  const byIndex = new Map<number, TokenDelta>();
  for (const [side, list] of [['pre', meta.preTokenBalances ?? []], ['post', meta.postTokenBalances ?? []]] as const) {
    for (const b of list) {
      if (!isBase58Address(b.mint)) continue;
      const d = byIndex.get(b.accountIndex) ?? {
        accountIndex: b.accountIndex,
        mint: b.mint,
        owner: isBase58Address(b.owner) ? b.owner : null,
        pre: 0n,
        post: 0n,
      };
      if (d.owner === null && isBase58Address(b.owner)) d.owner = b.owner;
      d[side] = toBig(b.uiTokenAmount.amount);
      byIndex.set(b.accountIndex, d);
    }
  }
  const blockTime = r.data.blockTime ?? null;
  return {
    signature: signature!,
    slot,
    index: r.data.transactionIndex ?? 0,
    blockTime: blockTime && blockTime > 1_500_000_000 && blockTime < 4_000_000_000 ? blockTime : null,
    feePayer,
    tokenDeltas: [...byIndex.values()],
  };
}

/**
 * Parses a GTFA JSON-RPC response. Throws HistoryError on an RPC error object or an unusable envelope (the caller
 * counts it as a failed attempt). Transactions are validated one by one and kept in chain order (slot, index).
 */
export function parseHistoryResponse(json: unknown): HistoryPage {
  const env = RpcEnvelope.safeParse(json);
  if (!env.success) throw new HistoryError('invalid RPC envelope');
  if (env.data.error) {
    const code = env.data.error.code ?? 0;
    throw new HistoryError(`RPC error ${code}`, code === 429 || code === -32429 ? 'rate_limited' : 'rpc');
  }
  if (!env.data.result) throw new HistoryError('RPC response without result');
  const raw = env.data.result.data;
  const txs: ParsedTx[] = [];
  for (const item of raw) {
    const tx = parseTx(item);
    if (tx) txs.push(tx);
  }
  txs.sort((a, b) => a.slot - b.slot || a.index - b.index);
  const next = env.data.result.paginationToken ?? null;
  return {
    txs,
    next: next && /^\d{1,20}:\d{1,10}$/.test(next) ? next : null,
    dropped: raw.length - txs.length,
    returned: raw.length,
  };
}

// ---------------------------------------------------------------------------
// Buyer extraction
// ---------------------------------------------------------------------------
export interface BuyEvent {
  wallet: string;
  signature: string;
  slot: number;
  /** Unix seconds or null. */
  blockTime: number | null;
  /** SOL paid (WSOL received by the other side of the swap), null when the quote is not SOL. */
  sol: number | null;
}

/**
 * The transaction is a BUY of `mint` when its fee payer's token balance of `mint` (summed over the accounts it owns)
 * increased. SOL amount = sum of the positive WSOL balance changes of accounts NOT owned by the buyer (pool vault +
 * fee accounts: what the buyer paid, without the network fee, the ATA rent or a Jito tip). Null when no WSOL moved
 * to the other side (e.g. a USDC-quoted pool). Approximation documented in docs/ARCHITECTURE.md.
 */
export function extractBuy(tx: ParsedTx, mint: string): BuyEvent | null {
  const wallet = tx.feePayer;
  let tokenDelta = 0n;
  let wsolToOthers = 0n;
  for (const d of tx.tokenDeltas) {
    const delta = d.post - d.pre;
    if (d.mint === mint && d.owner === wallet) tokenDelta += delta;
    if (d.mint === WSOL_MINT && d.owner !== wallet && delta > 0n) wsolToOthers += delta;
  }
  if (tokenDelta <= 0n) return null;
  const sol = wsolToOthers > 0n ? Number(wsolToOthers) / 1e9 : null;
  return {
    wallet,
    signature: tx.signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    sol: sol !== null && Number.isFinite(sol) && sol < 1e9 ? Math.round(sol * 1e9) / 1e9 : null,
  };
}

/** Wallets never kept as buyers for one mint: programs / AMM authorities, the pool itself, the creators. */
export function exclusionSet(pairAddress: string, mint: string, creators: readonly (string | null)[]): Set<string> {
  const s = new Set<string>(NON_BUYER_ACCOUNTS);
  s.add(pairAddress);
  s.add(mint);
  for (const c of creators) if (c) s.add(c);
  return s;
}

export interface EarlyBuyerRow {
  mint: string;
  wallet: string;
  ts: string | null;
  sol_amount: number | null;
  rank: number;
  slot: number;
  signature: string;
}

/**
 * Keeps the FIRST buy of each new wallet, in chain order, until MAX_BUYERS. `known` = wallets already stored for the
 * mint (resume after a partial run: re-reading a page never duplicates a buyer nor shifts a rank). Ranks continue
 * after `known.size`. Pure: `known` is not mutated.
 */
export function collectBuyers(
  mint: string,
  txs: readonly ParsedTx[],
  known: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
  max = MAX_BUYERS,
): EarlyBuyerRow[] {
  const seen = new Set(known);
  const rows: EarlyBuyerRow[] = [];
  for (const tx of txs) {
    if (seen.size >= max) break;
    const buy = extractBuy(tx, mint);
    if (!buy || excluded.has(buy.wallet) || seen.has(buy.wallet)) continue;
    seen.add(buy.wallet);
    rows.push({
      mint,
      wallet: buy.wallet,
      ts: buy.blockTime !== null ? new Date(buy.blockTime * 1000).toISOString() : null,
      sol_amount: buy.sol,
      rank: seen.size,
      slot: buy.slot,
      signature: buy.signature,
    });
  }
  return rows;
}

export type MintStatus = 'pending' | 'done' | 'exhausted' | 'capped' | 'failed';

/** Status after a page: done at 50 buyers, exhausted when the history ended, capped at the page limit. */
export function statusAfterPage(buyers: number, next: string | null, pages: number): MintStatus {
  if (buyers >= MAX_BUYERS) return 'done';
  if (next === null) return 'exhausted';
  if (pages >= MAX_PAGES_PER_MINT) return 'capped';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------
/** Credits of a successful full-mode GTFA response returning `returned` transactions. */
export function gtfaFullCredits(returned: number): number {
  return Math.max(10, 10 * Math.ceil(Math.max(0, returned) / 100));
}

/** Credits RESERVED before a request of `limit` transactions: the maximum it can cost (a failure is free). */
export function creditsToReserve(limit: number): number {
  return gtfaFullCredits(limit);
}

/** true when `cost` more credits keep the total at or under the hard cap. */
export function budgetAllows(used: number, cost: number, cap = CREDIT_HARD_CAP): boolean {
  return Number.isFinite(used) && used >= 0 && cost >= 0 && used + cost <= Math.min(cap, CREDIT_HARD_CAP);
}

/** Expected credits for `mints` tokens: 1 creator lookup + `pagesPerMint` pool pages, 10 credits each. */
export function estimateCredits(mints: number, pagesPerMint: number): number {
  return Math.max(0, mints) * (1 + Math.max(0, pagesPerMint)) * creditsToReserve(PAGE_LIMIT);
}

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------
/**
 * Removes the API key from any text before it is logged, stored or returned: the literal key (when given) and any
 * `api-key=` / `api_key=` query parameter value. Also caps the length.
 */
export function redactSecret(text: string, secret?: string | null, max = 200): string {
  let out = text;
  if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  out = out.replace(/(api[-_]?key=)[^&\s"')]+/gi, '$1[redacted]');
  return out.slice(0, max);
}

/** Minimum wait before the next request start (pacing ≤ 1 / MIN_REQUEST_INTERVAL_MS). */
export function paceDelay(lastStartMs: number | null, nowMs: number, interval = MIN_REQUEST_INTERVAL_MS): number {
  if (lastStartMs === null) return 0;
  return Math.max(0, lastStartMs + interval - nowMs);
}
