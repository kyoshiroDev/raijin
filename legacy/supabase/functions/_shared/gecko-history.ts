// GeckoTerminal OHLCV history since a detection, for label-outcomes (feat/x3-model).
// Rules (docs/SECURITY.md): fixed https host (api.geckoterminal.com), pool and token validated with isSolanaAddress
// before any URL is built (and encodeURIComponent anyway), redirect: 'error', AbortSignal.timeout ≤ 8 s, body
// ≤ 2 MB, zod on every payload, never throws. The HTTP status is surfaced (unlike enrich-clients' getJson) so the
// caller can stop the whole run on 429. `fetchFn` / `sleep` are injectable: the path is unit tested without network.
//
// Real response (checked 2026-11-17, /networks/solana/pools/{pool}/ohlcv/minute?aggregate=15&limit=3&token={mint}):
//   { data: { id, type: "ohlcv_request_response", attributes: { ohlcv_list: [[1794892500, o, h, l, c, v], …] } },
//     meta: { base: {…}, quote: {…} } }
// - candles are NEWEST FIRST; numbers are JSON numbers; `limit` ≤ 1000; `before_timestamp` (seconds) pages back;
// - `token=<mint address>` returns the price of THAT token in USD whichever side of the pool it is (verified: the
//   same pool gives 0.00106 for the memecoin and 73.05 for SOL); an unknown token value → HTTP 400;
// - an unknown pool → HTTP 404 { errors: [{ status: "404", title: "Not Found" }] }.
import { z } from 'npm:zod@^3.24';
import { isSolanaAddress } from './solana.ts';
import type { Candle } from './types.ts';

export const GECKO_HISTORY_BASE = 'https://api.geckoterminal.com/api/v2';
const GECKO_HOST = 'api.geckoterminal.com';
export const GECKO_MAX_LIMIT = 1000;
/** Labels never look further than 7 days after the detection (outcomes.ts OUTCOME_HORIZON_H). */
export const HISTORY_HORIZON_H = 24 * 7;
/**
 * Windows shorter than this use 15-minute candles, longer ones hourly candles. Since fix/measurement-and-criteria the
 * whole 7-day window is read in 15-minute candles (≤ 673, one request at limit 1000): real intra-day highs and lows
 * decide which of ×2 / −30 % came first, hourly candles would hide it.
 */
export const MINUTE_WINDOW_MAX_H = HISTORY_HORIZON_H + 1;
export const MAX_PAGES = 3;

const MAX_TIMEOUT_MS = 8_000;
const MAX_BODY_CHARS = 2_000_000;
const HOUR_MS = 3_600_000;

const numish = z.union([z.number(), z.string().max(100)]).transform((v) => Number(v)).pipe(z.number().finite());
const CandleRowSchema = z.tuple([z.number().int().nonnegative(), numish, numish, numish, numish, numish]);
export const GeckoOhlcvListSchema = z.object({
  data: z.object({ attributes: z.object({ ohlcv_list: z.array(z.unknown()).max(GECKO_MAX_LIMIT) }) }),
});

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface CandlePlan {
  timeframe: 'minute' | 'hour';
  /** 15 or 1 for the labels (planCandles); 1 / 5 for the backtest capture windows (candles.ts). */
  aggregate: 1 | 5 | 15;
  /** Candle length in seconds. */
  stepSec: number;
  /** Oldest candle open time wanted (seconds): the candle that contains the detection. */
  fromSec: number;
  /** Newest instant of interest (seconds): min(now, detection + 7 days). */
  toSec: number;
  /** Candles expected between fromSec and toSec (+1), capped at GECKO_MAX_LIMIT. */
  limit: number;
}

/**
 * Which candles label a detection: 15-minute candles when the observed window (now − detection, capped at 7 days)
 * is shorter than 48 h, hourly beyond. null for invalid inputs or a detection in the future.
 */
export function planCandles(detectedAtMs: number, nowMs: number): CandlePlan | null {
  if (!Number.isFinite(detectedAtMs) || !Number.isFinite(nowMs) || detectedAtMs <= 0 || nowMs < detectedAtMs) return null;
  const toMs = Math.min(nowMs, detectedAtMs + HISTORY_HORIZON_H * HOUR_MS);
  const windowH = (toMs - detectedAtMs) / HOUR_MS;
  const minute = windowH < MINUTE_WINDOW_MAX_H;
  const stepSec = minute ? 15 * 60 : 3600;
  const fromSec = Math.floor(detectedAtMs / 1000 / stepSec) * stepSec;
  const toSec = Math.floor(toMs / 1000);
  const limit = Math.min(GECKO_MAX_LIMIT, Math.max(1, Math.ceil((toSec - fromSec) / stepSec) + 1));
  return { timeframe: minute ? 'minute' : 'hour', aggregate: minute ? 15 : 1, stepSec, fromSec, toSec, limit };
}

/** OHLCV URL for `pool`, priced in USD for `mint`. null if either address is not a Solana address. */
export function buildOhlcvUrl(pool: string, mint: string, plan: CandlePlan, beforeSec?: number): string | null {
  if (!isSolanaAddress(pool) || !isSolanaAddress(mint)) return null;
  const params = new URLSearchParams({
    aggregate: String(plan.aggregate),
    limit: String(Math.min(GECKO_MAX_LIMIT, Math.max(1, Math.floor(plan.limit)))),
    currency: 'usd',
    token: mint,
  });
  if (beforeSec !== undefined && Number.isFinite(beforeSec) && beforeSec > 0) {
    params.set('before_timestamp', String(Math.floor(beforeSec)));
  }
  return `${GECKO_HISTORY_BASE}/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/${plan.timeframe}?${params}`;
}

/**
 * Untrusted OHLCV payload → candles OLDEST FIRST. Rows are validated one by one (a bad row is dropped, not the
 * page): finite numbers, low > 0, high ≥ low. null when the envelope itself is invalid.
 */
export function parseOhlcv(input: unknown): Candle[] | null {
  const env = GeckoOhlcvListSchema.safeParse(input);
  if (!env.success) return null;
  const out: Candle[] = [];
  for (const row of env.data.data.attributes.ohlcv_list) {
    const r = CandleRowSchema.safeParse(row);
    if (!r.success) continue;
    const c = r.data as Candle;
    if (!(c[3] > 0) || !(c[2] >= c[3])) continue;
    out.push(c);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Merges pages, oldest first, one candle per open time (the first page seen wins). */
export function mergeCandles(pages: readonly (readonly Candle[])[]): Candle[] {
  const byTs = new Map<number, Candle>();
  for (const page of pages) for (const c of page) if (!byTs.has(c[0])) byTs.set(c[0], c);
  return [...byTs.values()].sort((a, b) => a[0] - b[0]);
}

export type HistoryStatus = 'ok' | 'rate_limited' | 'not_found' | 'error' | 'invalid';

export interface CandleHistory {
  status: HistoryStatus;
  /** Oldest first, only candles with open time ≥ plan.fromSec. Empty unless status is 'ok'. */
  candles: Candle[];
  /** HTTP requests actually sent (for the caller's rate limiting). */
  calls: number;
  /** Short reason for label_error (no URL, no secret). */
  error: string | null;
}

export interface HistoryOptions {
  fetchFn?: FetchFn;
  /** Capped at 8 s. */
  timeoutMs?: number;
  maxPages?: number;
  /** Called before every request after the first (rate limiting between pages). */
  beforeRequest?: () => Promise<void>;
  signal?: AbortSignal;
}

interface Fetched {
  status: number;
  body: unknown;
}

async function getGecko(url: string, opts: HistoryOptions): Promise<Fetched | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== GECKO_HOST || u.username || u.password || u.port) return null;
  if (opts.signal?.aborted) return null;
  const timeout = AbortSignal.timeout(Math.min(opts.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS));
  try {
    const res = await (opts.fetchFn ?? fetch)(u.toString(), {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, body: null };
    }
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) return { status: 0, body: null };
    return { status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: 0, body: null };
  }
}

/**
 * Candles of `pool` (priced for `mint`) from the detection to min(now, detection + 7 d). One request in practice
 * (≤ 192 × 15 min or ≤ 168 × 1 h, limit 1000); pages back with before_timestamp only if a full page did not reach
 * the detection yet (≤ maxPages requests). A closed window (detection > 7 days ago) starts with
 * before_timestamp = window end. Stops at the first 429 (status 'rate_limited', no candle returned).
 */
export async function fetchCandleHistory(
  pool: string,
  mint: string,
  detectedAtMs: number,
  nowMs: number,
  opts: HistoryOptions = {},
): Promise<CandleHistory> {
  const plan = planCandles(detectedAtMs, nowMs);
  if (!plan || !isSolanaAddress(pool) || !isSolanaAddress(mint)) {
    return { status: 'invalid', candles: [], calls: 0, error: 'invalid pool, mint or time' };
  }
  const maxPages = Math.max(1, Math.min(MAX_PAGES, Math.floor(opts.maxPages ?? MAX_PAGES)));
  const pages: Candle[][] = [];
  // Window already closed (detection > 7 days ago): start right after its end instead of at « now », otherwise the
  // first page(s) would only hold candles after the window.
  let before: number | undefined = plan.toSec < Math.floor(nowMs / 1000) - plan.stepSec ? plan.toSec + plan.stepSec : undefined;
  let calls = 0;
  for (let page = 0; page < maxPages; page++) {
    const url = buildOhlcvUrl(pool, mint, plan, before);
    if (!url) return { status: 'invalid', candles: [], calls, error: 'invalid url' };
    if (calls > 0 && opts.beforeRequest) await opts.beforeRequest();
    if (opts.signal?.aborted) return { status: 'error', candles: [], calls, error: 'run budget exhausted' };
    calls++;
    const res = await getGecko(url, opts);
    if (!res) return { status: 'error', candles: [], calls, error: 'request refused' };
    if (res.status === 429) return { status: 'rate_limited', candles: [], calls, error: 'GeckoTerminal HTTP 429' };
    if (res.status === 404) return { status: 'not_found', candles: [], calls, error: 'GeckoTerminal pool not found (404)' };
    if (res.status < 200 || res.status >= 300) {
      return { status: 'error', candles: [], calls, error: res.status ? `GeckoTerminal HTTP ${res.status}` : 'GeckoTerminal fetch failed' };
    }
    const candles = parseOhlcv(res.body);
    if (!candles) return { status: 'error', candles: [], calls, error: 'GeckoTerminal invalid payload' };
    pages.push(candles);
    const oldest = candles.length > 0 ? candles[0][0] : null;
    // Done: short page (no older data), detection reached, or no progress.
    if (oldest === null || candles.length < plan.limit || oldest <= plan.fromSec || (before !== undefined && oldest >= before)) break;
    before = oldest;
  }
  const candles = mergeCandles(pages).filter((c) => c[0] >= plan.fromSec);
  return { status: 'ok', candles, calls, error: null };
}

/**
 * ONE request for a fixed window (backtest candle capture, candles.ts captureWindow): candles of `pool` priced for
 * `mint` with open time in [plan.fromSec, plan.fromSec + plan.limit × plan.stepSec), using
 * before_timestamp = end of that window so a capture made late (catch-up script) still gets the right candles.
 * Same safety rules and statuses as fetchCandleHistory (429 → 'rate_limited', 404 → 'not_found'). Never throws.
 */
export async function fetchCandleWindow(pool: string, mint: string, plan: CandlePlan, opts: HistoryOptions = {}): Promise<CandleHistory> {
  if (!isSolanaAddress(pool) || !isSolanaAddress(mint) || !Number.isFinite(plan?.fromSec) || !(plan.stepSec > 0)) {
    return { status: 'invalid', candles: [], calls: 0, error: 'invalid pool, mint or window' };
  }
  const endSec = plan.fromSec + Math.min(GECKO_MAX_LIMIT, Math.max(1, Math.floor(plan.limit))) * plan.stepSec;
  const url = buildOhlcvUrl(pool, mint, plan, endSec);
  if (!url) return { status: 'invalid', candles: [], calls: 0, error: 'invalid url' };
  if (opts.signal?.aborted) return { status: 'error', candles: [], calls: 0, error: 'run budget exhausted' };
  const res = await getGecko(url, opts);
  if (!res) return { status: 'error', candles: [], calls: 1, error: 'request refused' };
  if (res.status === 429) return { status: 'rate_limited', candles: [], calls: 1, error: 'GeckoTerminal HTTP 429' };
  if (res.status === 404) return { status: 'not_found', candles: [], calls: 1, error: 'GeckoTerminal pool not found (404)' };
  if (res.status < 200 || res.status >= 300) {
    return { status: 'error', candles: [], calls: 1, error: res.status ? `GeckoTerminal HTTP ${res.status}` : 'GeckoTerminal fetch failed' };
  }
  const candles = parseOhlcv(res.body);
  if (!candles) return { status: 'error', candles: [], calls: 1, error: 'GeckoTerminal invalid payload' };
  return { status: 'ok', candles: candles.filter((c) => c[0] >= plan.fromSec && c[0] < endSec), calls: 1, error: null };
}
