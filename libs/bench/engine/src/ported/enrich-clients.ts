// External clients for enrich-tokens: Jupiter round-trip quotes, RugCheck summary, GeckoTerminal multi pools.
// Rules (docs/SECURITY.md): fixed https hosts only, mints validated with isSolanaAddress before any URL is
// built (and encodeURIComponent anyway), AbortSignal.timeout <= 8 s, zod on every payload, never throw
// (null = unknown), no secret in URLs or logs. `fetchFn` is injectable so the whole path is unit tested.
import { runtimeFetch } from './runtime-fetch';
import {
  GeckoMultiSchema,
  GeckoPoolSchema,
  type JupQuote,
  JupQuoteSchema,
  RugReportInsidersSchema,
  RugRiskSchema,
  RugSummarySchema,
} from './enrich-schemas';
import { sanitizeText } from './sanitize';
import { isSolanaAddress } from './solana';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** Round-trip size: 0.1 SOL. */
export const QUOTE_LAMPORTS = 100_000_000n;
export const QUOTE_SLIPPAGE_BPS = 300;
export const JUP_DEFAULT_BASE = 'https://lite-api.jup.ag';
export const RUGCHECK_BASE = 'https://api.rugcheck.xyz';
export const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
export const GECKO_MULTI_MAX = 30;
export const RUG_DANGERS_MAX = 5;
export const RUG_DANGER_NAME_MAX = 40;

const JUP_HOSTS = ['lite-api.jup.ag', 'api.jup.ag'] as const;
/** The only hosts these clients may call. */
export const ENRICH_HOSTS: ReadonlySet<string> = new Set([...JUP_HOSTS, 'api.rugcheck.xyz', 'api.geckoterminal.com']);

const MAX_TIMEOUT_MS = 8_000;
const MAX_BODY_CHARS = 2_000_000;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  fetchFn?: FetchFn;
  /** Capped at 8 s. */
  timeoutMs?: number;
  /** Extra headers (e.g. Jupiter x-api-key from the environment). Never logged. */
  headers?: Record<string, string>;
  /** Receives host + status only. Defaults to console.warn. */
  log?: (message: string) => void;
  /** Run-wide abort (RunBudget.signal): an aborted signal means no new request and in-flight ones are cancelled. */
  signal?: AbortSignal;
  /** Allowed hosts (default ENRICH_HOSTS). scan-tokens' candidate sources pass SOURCE_HOSTS (source-clients.ts). */
  hosts?: ReadonlySet<string>;
  /** Receives the HTTP status of the response (2xx or not), e.g. to stop a source group on 429. */
  onStatus?: (status: number) => void;
}

/** GET a JSON document from an allowed host. Returns null on any failure (bad URL/host, non-2xx, timeout, bad JSON). */
export async function getJson(url: string, opts: ClientOptions = {}): Promise<unknown | null> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !(opts.hosts ?? ENRICH_HOSTS).has(u.hostname) || u.username || u.password || u.port) return null;
  if (opts.signal?.aborted) return null; // run budget exhausted: no new request
  const timeout = AbortSignal.timeout(Math.min(opts.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS));
  try {
    const res = await (opts.fetchFn ?? runtimeFetch())(u.toString(), {
      headers: { accept: 'application/json', ...opts.headers },
      redirect: 'error',
      signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
    });
    opts.onStatus?.(res.status);
    if (!res.ok) {
      log(`enrich fetch ${u.hostname} HTTP ${res.status}`);
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) return null;
    return JSON.parse(text) as unknown;
  } catch (e) {
    log(`enrich fetch ${u.hostname} failed: ${(e instanceof Error ? e.name : 'error')}`);
    return null;
  }
}

/** JUP_API_BASE override, accepted only if it is https on a Jupiter host; otherwise the free lite-api. */
export function resolveJupBase(env: string | undefined | null): string {
  if (!env) return JUP_DEFAULT_BASE;
  try {
    const u = new URL(env);
    if (u.protocol === 'https:' && (JUP_HOSTS as readonly string[]).includes(u.hostname) && !u.port && !u.username) {
      return u.origin;
    }
  } catch {
    // fall through
  }
  return JUP_DEFAULT_BASE;
}

// ---------------------------------------------------------------------------------------------------------
// Jupiter round trip
// ---------------------------------------------------------------------------------------------------------

export interface RoundTrip {
  /** (1 − SOL back / SOL in) × 100, PERCENT. Negative = more SOL back than sent (rare, positive slippage). */
  roundtripCostPct: number;
  /** Approximation of the non-size-dependent part: max(0, cost − buyImpact − sellImpact), PERCENT. */
  roundtripFeePct: number;
  /** Jupiter priceImpactPct of the buy leg, PERCENT. */
  buyImpactPct: number;
  /** Jupiter priceImpactPct of the sell leg, PERCENT. */
  sellImpactPct: number;
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Jupiter priceImpactPct is a fraction (see enrich-schemas.ts): × 100, must stay within ±100 %. */
export function impactToPercent(fraction: number): number | null {
  if (!Number.isFinite(fraction)) return null;
  const pct = fraction * 100;
  return pct >= -100 && pct <= 100 ? round4(pct) : null;
}

/**
 * Pure round-trip math (BigInt for lamports). Returns null (unknown) when either leg is missing or the two
 * legs are not the same chain SOL → mint → SOL for exactly `lamportsIn` and the bought amount.
 */
export function computeRoundTrip(
  mint: string,
  buy: JupQuote | null,
  sell: JupQuote | null,
  lamportsIn: bigint = QUOTE_LAMPORTS,
): RoundTrip | null {
  if (!buy || !sell || lamportsIn <= 0n) return null;
  if (buy.inputMint !== SOL_MINT || buy.outputMint !== mint) return null;
  if (sell.inputMint !== mint || sell.outputMint !== SOL_MINT) return null;
  if (BigInt(buy.inAmount) !== lamportsIn) return null;
  const bought = BigInt(buy.outAmount);
  if (bought <= 0n || BigInt(sell.inAmount) !== bought) return null;
  const back = BigInt(sell.outAmount);
  if (back > lamportsIn * 2n) return null; // > +100 % on a round trip: not a real quote

  // Parts per million, then percent: integer math, exact to 1e-4 %.
  const ppm = ((lamportsIn - back) * 1_000_000n) / lamportsIn;
  const cost = Number(ppm) / 10_000;
  const buyImpact = impactToPercent(buy.priceImpactPct);
  const sellImpact = impactToPercent(sell.priceImpactPct);
  if (buyImpact === null || sellImpact === null || cost < -100 || cost > 100) return null;
  return {
    roundtripCostPct: round4(cost),
    roundtripFeePct: round4(Math.min(100, Math.max(0, cost - buyImpact - sellImpact))),
    buyImpactPct: buyImpact,
    sellImpactPct: sellImpact,
  };
}

export interface JupOptions extends ClientOptions {
  jupBase?: string;
  /** Epoch ms after which the sell leg is not started (RunBudget.sellDeadline). */
  sellDeadline?: number;
  now?: () => number;
}

/** One ExactIn quote. null on invalid mints/amount, HTTP error or invalid payload. */
export async function fetchJupQuote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  opts: JupOptions = {},
): Promise<JupQuote | null> {
  if (!isSolanaAddress(inputMint) || !isSolanaAddress(outputMint) || inputMint === outputMint) return null;
  if (amount <= 0n || amount >= 10n ** 30n) return null;
  const base = resolveJupBase(opts.jupBase);
  const url = `${base}/swap/v1/quote?inputMint=${encodeURIComponent(inputMint)}` +
    `&outputMint=${encodeURIComponent(outputMint)}&amount=${amount.toString()}&slippageBps=${QUOTE_SLIPPAGE_BPS}`;
  const parsed = JupQuoteSchema.safeParse(await getJson(url, opts));
  return parsed.success ? parsed.data : null;
}

/**
 * Buy 0.1 SOL of `mint`, then sell exactly what was bought. Any failure → null (unknown, written as null).
 * Stopped by the run budget (signal aborted, or sell leg not started after `sellDeadline`) → undefined:
 * "not quoted this run", the quote columns are left untouched.
 */
export async function fetchRoundTrip(mint: string, opts: JupOptions = {}): Promise<RoundTrip | null | undefined> {
  if (!isSolanaAddress(mint) || mint === SOL_MINT) return null;
  const now = opts.now ?? Date.now;
  const stopped = () => opts.signal?.aborted === true;
  if (stopped()) return undefined;
  const buy = await fetchJupQuote(SOL_MINT, mint, QUOTE_LAMPORTS, opts);
  if (stopped()) return undefined;
  if (!buy || buy.outputMint !== mint) return null;
  if (opts.sellDeadline !== undefined && now() >= opts.sellDeadline) return undefined;
  const sell = await fetchJupQuote(mint, SOL_MINT, BigInt(buy.outAmount), opts);
  if (stopped()) return undefined;
  return computeRoundTrip(mint, buy, sell, QUOTE_LAMPORTS);
}

// ---------------------------------------------------------------------------------------------------------
// RugCheck
// ---------------------------------------------------------------------------------------------------------

export interface RugInfo {
  /** PERCENT 0–100. */
  lpLockedPct: number | null;
  /** Raw RugCheck score (higher = riskier). */
  score: number | null;
  /** Sanitised names of the 'danger' risks, ≤ 5, ≤ 40 chars, deduplicated. */
  dangers: string[];
  /** Full report `graphInsidersDetected` > 0 (or an « insider » risk in the summary). null = unknown. */
  insidersDetected: boolean | null;
  /** Risk « Creator history of rugged tokens » present, any level. null = risks unknown. */
  creatorRugHistory: boolean | null;
}

/** Names of the risks with level 'danger', validated one by one and sanitised (hostile data). */
export function extractDangers(risks: unknown): string[] {
  if (!Array.isArray(risks)) return [];
  const out: string[] = [];
  for (const item of risks) {
    const r = RugRiskSchema.safeParse(item);
    if (!r.success || r.data.level.trim().toLowerCase() !== 'danger') continue;
    const name = sanitizeText(r.data.name, RUG_DANGER_NAME_MAX);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= RUG_DANGERS_MAX) break;
  }
  return out;
}

const CREATOR_RUG_RISK = /creator history of rugged/i;
const INSIDER_RISK = /insider/i;

/** true if one risk (any level) matches `pattern`; null when `risks` is not an array (unknown). */
export function hasRisk(risks: unknown, pattern: RegExp): boolean | null {
  if (!Array.isArray(risks)) return null;
  for (const item of risks) {
    const r = RugRiskSchema.safeParse(item);
    if (r.success && pattern.test(sanitizeText(r.data.name, 200))) return true;
  }
  return false;
}

/** Pure mapping of an untrusted RugCheck summary. null when nothing usable. */
export function parseRugSummary(input: unknown): RugInfo | null {
  const parsed = RugSummarySchema.safeParse(input);
  if (!parsed.success) return null;
  const { score, lpLockedPct, risks } = parsed.data;
  if (score === undefined && lpLockedPct === undefined && risks === undefined) return null;
  return {
    lpLockedPct: lpLockedPct === undefined ? null : round4(lpLockedPct),
    score: score === undefined ? null : score,
    dangers: extractDangers(risks),
    // The summary has no insider graph: only an explicit « insider » risk says yes; absence is not a « no ».
    insidersDetected: hasRisk(risks, INSIDER_RISK) === true ? true : null,
    creatorRugHistory: hasRisk(risks, CREATOR_RUG_RISK),
  };
}

/** Pure mapping of an untrusted full report: graphInsidersDetected > 0, null when absent/invalid. */
export function parseRugInsiders(input: unknown): boolean | null {
  const parsed = RugReportInsidersSchema.safeParse(input);
  if (!parsed.success) return null;
  const n = parsed.data.graphInsidersDetected;
  return typeof n === 'number' ? n > 0 : null;
}

/**
 * Summary (score, LP lock, risks, creator history), then — only if the summary worked — the full report for the
 * insider graph. A failed report keeps the summary result with insidersDetected from the summary (null or true).
 */
export async function fetchRugcheck(mint: string, opts: ClientOptions = {}): Promise<RugInfo | null> {
  if (!isSolanaAddress(mint)) return null;
  const base = `${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(mint)}/report`;
  const summary = parseRugSummary(await getJson(`${base}/summary`, opts));
  if (!summary) return null;
  const insiders = parseRugInsiders(await getJson(base, opts));
  return insiders === null ? summary : { ...summary, insidersDetected: insiders || summary.insidersDetected === true };
}

// ---------------------------------------------------------------------------------------------------------
// GeckoTerminal multi pools
// ---------------------------------------------------------------------------------------------------------

export interface GeckoInfo {
  liquidityUsd: number | null;
  priceUsd: number | null;
}

export interface PoolRef {
  mint: string;
  pairAddress: string;
}

const positive = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/**
 * Pure mapping of a multi-pool response, keyed by pair address. Only pools that were asked for are kept;
 * the price is taken from the side (base or quote) whose token id is `solana_<mint>`, else null.
 */
export function parseGeckoMulti(input: unknown, refs: readonly PoolRef[]): Map<string, GeckoInfo> {
  const out = new Map<string, GeckoInfo>();
  const wanted = new Map(refs.map((r) => [r.pairAddress, r.mint]));
  const parsed = GeckoMultiSchema.safeParse(input);
  if (!parsed.success) return out;
  for (const item of parsed.data.data) {
    const p = GeckoPoolSchema.safeParse(item);
    if (!p.success) continue;
    const a = p.data.attributes;
    const mint = wanted.get(a.address);
    if (!mint || out.has(a.address)) continue;
    const id = `solana_${mint}`;
    const rel = p.data.relationships;
    const price = rel?.base_token?.data.id === id
      ? a.base_token_price_usd
      : rel?.quote_token?.data.id === id
      ? a.quote_token_price_usd
      : null;
    out.set(a.address, { liquidityUsd: positive(a.reserve_in_usd), priceUsd: positive(price) });
  }
  return out;
}

/** One call for up to 30 pools (extra refs are ignored). Empty map on failure. */
export async function fetchGeckoPools(refs: readonly PoolRef[], opts: ClientOptions = {}): Promise<Map<string, GeckoInfo>> {
  const seen = new Set<string>();
  const valid: PoolRef[] = [];
  for (const r of refs) {
    if (valid.length >= GECKO_MULTI_MAX) break;
    if (!isSolanaAddress(r.mint) || !isSolanaAddress(r.pairAddress) || seen.has(r.pairAddress)) continue;
    seen.add(r.pairAddress);
    valid.push(r);
  }
  if (valid.length === 0) return new Map();
  const url = `${GECKO_BASE}/networks/solana/pools/multi/${valid.map((r) => encodeURIComponent(r.pairAddress)).join(',')}`;
  return parseGeckoMulti(await getJson(url, opts), valid);
}

// ---------------------------------------------------------------------------------------------------------
// Bounded concurrency with a deadline
// ---------------------------------------------------------------------------------------------------------

export interface LimitOptions {
  concurrency: number;
  /** Pause after each task, per worker (rate limiting). */
  delayMs: number;
  /** Epoch ms after which no new task is started (running ones finish). */
  deadline: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Runs `fn` over `items` with at most `concurrency` in flight. Items not started before the deadline → undefined. */
export async function mapLimit<T, R>(
  items: readonly T[],
  opts: LimitOptions,
  fn: (item: T) => Promise<R>,
): Promise<(R | undefined)[]> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const results: (R | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && now() < opts.deadline) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!);
      } catch {
        results[i] = undefined;
      }
      if (opts.delayMs > 0 && next < items.length) await sleep(opts.delayMs);
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// ---------------------------------------------------------------------------------------------------------
// Run budget (pg_net calls the function with a 55 s timeout)
// ---------------------------------------------------------------------------------------------------------

/**
 * Offsets from the start of an enrich-tokens run. Worst case: a request started just before `abortMs` is cancelled
 * at `abortMs` (40 s), then ≤ 30 DB updates (~1 s) → well under pg_net's 55 s.
 * - stopNewMs: mapLimit starts no new task (RugCheck report, round trip);
 * - stopSellLegMs: a round trip whose buy leg ends later does not start its sell leg (2 × 8 s otherwise);
 * - abortMs: every in-flight request is aborted (AbortController), whatever was completed is still written.
 */
export const ENRICH_BUDGET = { stopNewMs: 30_000, stopSellLegMs: 34_000, abortMs: 40_000 } as const;

export interface RunBudget {
  signal: AbortSignal;
  stopNewAt: number;
  sellDeadline: number;
  abortAt: number;
  /** Clears the abort timer (call once the external calls are done). */
  dispose(): void;
}

export interface BudgetClock {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Global time budget for one run, with an AbortController fired at `abortAt`. Clock and timers injectable. */
export function createRunBudget(startedAt: number, clock: BudgetClock = {}): RunBudget {
  const now = clock.now ?? Date.now;
  const setTimer = clock.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = clock.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const controller = new AbortController();
  const abortAt = startedAt + ENRICH_BUDGET.abortMs;
  const handle = setTimer(() => controller.abort(), Math.max(0, abortAt - now()));
  return {
    signal: controller.signal,
    stopNewAt: startedAt + ENRICH_BUDGET.stopNewMs,
    sellDeadline: startedAt + ENRICH_BUDGET.stopSellLegMs,
    abortAt,
    dispose: () => clearTimer(handle),
  };
}
