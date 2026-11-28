// Orchestration helpers of the paper-engine Edge Function and of auto-paper (feat/paper-trading-v2).
// SIMULATION ONLY: Jupiter is asked for QUOTES (price impact) and nothing else; no transaction is ever built.
// The trading rules themselves live in ./paper.ts (planLegs, step, walletDelta); this file only:
//   - parses the DB rows (positions with their legs, snapshots) defensively;
//   - orders the active positions fairly across users (round robin, each user oldest first);
//   - builds price ticks from the scan's token_snapshots (fresh < 6 min, else no tick → only expiry can happen);
//   - picks the quotes worth asking for (positions that step() would fill, or whose legs it would close, with the
//     default impact) and the amounts to quote (stake; value of the closing legs, see sellLamports);
//   - runs those quotes paced and budget-limited (injectable fetch / clock, never throws);
//   - turns an EngineStep into the paper_apply_v2(p_position, p_expected, p_step, p_delta) arguments;
//   - plans the « Calme » / « Frénésie » auto-paper (feat/calm-sl-test): one all_x2 position per matching book
//     (calm_sl30 + calm_sl40 for young_calm, frenzy_sl30 for young_frenzy), independent of alerts (calmFrenzyPlans,
//     calmFrenzyOpenings), filled at the next scan snapshot (nextTickEntries).
// chore/slim-down: strategy all_x2 only; the alert-driven auto-paper (books half_x2_rest_x3 / all_x2 / young_*), the
// « Jeune & fort » plans and the track-fast ticks were removed. feat/calm-sl-test: books calm_all_x2 / frenzy_all_x2
// archived (no new position; their positions still pending / open are run to completion by the engine).
import { fetchJupQuote, type FetchFn, impactToPercent, SOL_MINT } from './enrich-clients';
import {
  DEFAULT_SL_PCT,
  type EngineStep,
  type EntryMode,
  type LegStatus,
  type PaperLeg,
  type PaperPosition,
  parseEntryMode,
  planLegs,
  type PositionStatus,
  type PriceTick,
  step,
  STRATEGIES,
  type Strategy,
  walletDelta,
} from './paper';
import { isSolanaAddress } from './solana';

/** Active positions read per run (oldest first), before the fair ordering. */
export const ENGINE_FETCH_ROWS = 1000;
/** Positions processed per run (after the fair ordering); the rest waits for the next run (2 min). */
export const MAX_ENGINE_POSITIONS = 500;
/** Kept for scan-tokens' forced tracking read (rows { mint, status } of active positions). */
export const MAX_ENGINE_ORDERS = 500;
/** A snapshot older than this gives no tick (stricter than paper.ts TICK_MAX_AGE_MS). Scan = every 2 min. */
export const TICK_FRESH_MS = 6 * 60_000;
/** Mints per token_snapshots `in (…)` read. */
export const SNAPSHOT_CHUNK = 100;
/** Snapshot rows read per chunk (≈ 3 per mint in 6 min). */
export const SNAPSHOT_ROWS_MAX = 1000;
/** Jupiter quote calls per run (a buy = 1 call, an exit = 2 calls). Beyond: impact unknown → step() uses +2 %. */
export const MAX_QUOTE_CALLS = 10;
/** Jupiter lite-api allows 5 requests / 10 s per client: one call every 2.1 s (same as scan-tokens). */
export const QUOTE_GAP_MS = 2_100;
/**
 * Run budget (offsets from the start). The engine runs at odd minutes, like enrich-tokens whose Jupiter round trips
 * take its first ~3–15 s: the engine's quotes start at 10 s. No new quote after 34 s, every quote aborted at 38 s,
 * no new paper_apply_v2 after 44 s (the rest is applied next run: idempotent), pg_net timeout 55 s.
 */
export const ENGINE_BUDGET = { quoteStartMs: 10_000, quoteStopMs: 34_000, abortMs: 38_000, applyStopMs: 44_000 } as const;

/**
 * Paper books the engine still runs: 'main' (manual positions), the three test books of feat/calm-sl-test and the two
 * books archived by it (calm_all_x2 / frenzy_all_x2: no new position, the pending / open ones run to completion). The
 * books archived by chore/slim-down (half_x2_rest_x3, all_x2, young_*) have no active position (migration 20261121020000).
 */
export type Book = 'main' | 'calm_sl30' | 'calm_sl40' | 'frenzy_sl30' | 'calm_all_x2' | 'frenzy_all_x2';
export const BOOKS: readonly Book[] = ['main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30', 'calm_all_x2', 'frenzy_all_x2'];
/** Books that still accept new positions (paper_open_position_as). */
export const OPEN_BOOKS: readonly Book[] = ['main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30'];
/** Books archived by feat/calm-sl-test (history + running positions only). */
export const ARCHIVED_CALM_FRENZY_BOOKS: readonly Book[] = ['calm_all_x2', 'frenzy_all_x2'];
/** Auto-paper test books (feat/calm-sl-test), separate 1.0 SOL wallets, fixed recipe each. */
export const CALM_FRENZY_BOOKS: readonly Book[] = ['calm_sl30', 'calm_sl40', 'frenzy_sl30'];
/** « Calme » books (alerted preset): their positions drive the one-alert-per-episode guard (preset-alerts.ts). */
export const CALM_BOOKS: readonly Book[] = ['calm_sl30', 'calm_sl40'];
export const isCalmFrenzyBook = (b: unknown): boolean =>
  typeof b === 'string' && (CALM_FRENZY_BOOKS as readonly string[]).includes(b);
/** Young preset → its test books and the stop (percent) of each (mirror of the SQL recipe). */
export type CalmFrenzyPreset = 'young_calm' | 'young_frenzy';
export const CALM_FRENZY_BOOK_SL: Readonly<Record<CalmFrenzyPreset, readonly { book: Book; slPct: number }[]>> = {
  young_calm: [{ book: 'calm_sl30', slPct: 30 }, { book: 'calm_sl40', slPct: 40 }],
  young_frenzy: [{ book: 'frenzy_sl30', slPct: 30 }],
};
const LEG_STATUSES: readonly LegStatus[] = ['open', 'tp_hit', 'sl_hit', 'breakeven_hit'];
const MAX_LEGS = 1;

const LAMPORTS_PER_SOL = 1_000_000_000;
const PRICE_MAX = 1e12;

/** Columns read by the engine (legs embedded through the paper_legs → paper_positions foreign key). */
export const ENGINE_POSITION_SELECT =
  'id,user_id,book,mint,strategy,status,stake_sol,entry_target_price,fill_price,sl_price,created_at,filled_at,expires_at,entry_mode,' +
  'paper_legs(id,size_pct,tp_price,status,stop_price,exit_price,closed_at)';

export interface EnginePosition extends PaperPosition {
  user_id: string;
  mint: string;
  book: Book;
  // entry_mode (PaperPosition, optional there) is always set by parseEnginePositions ('target' when unknown).
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && v.length <= 64) {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}
const price = (v: unknown): number | null => {
  const x = num(v);
  return x !== null && x > 0 && x < PRICE_MAX ? x : null;
};
const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

function parseLeg(row: unknown): PaperLeg | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (!isUuid(r['id'])) return null;
  const size = num(r['size_pct']);
  const tp = price(r['tp_price']);
  const stop = price(r['stop_price']);
  const status = r['status'] as LegStatus;
  if (size === null || !(size > 0 && size <= 100) || tp === null || stop === null || !LEG_STATUSES.includes(status)) return null;
  const exit = price(r['exit_price']);
  const closedAt = isoOrNull(r['closed_at']);
  // A closed leg must carry its exit (step() needs it for the final pnl); an open one must not.
  if (status === 'open' ? exit !== null : exit === null || closedAt === null) return null;
  return { id: r['id'], size_pct: size, tp_price: tp, status, stop_price: stop, exit_price: exit, closed_at: closedAt };
}

/**
 * paper_positions rows (with embedded paper_legs) → engine positions (pending / open only), validated row by row:
 * an invalid position or any invalid leg drops the whole position (never act on half-known data).
 */
export function parseEnginePositions(rows: unknown): EnginePosition[] {
  if (!Array.isArray(rows)) return [];
  const out: EnginePosition[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (!isUuid(r['id']) || !isUuid(r['user_id']) || !isSolanaAddress(r['mint'])) continue;
    const status = r['status'] as PositionStatus;
    if (status !== 'pending' && status !== 'open') continue;
    const book = r['book'] as Book;
    const strategy = r['strategy'] as Strategy;
    if (!BOOKS.includes(book) || !STRATEGIES.includes(strategy)) continue;
    const stake = num(r['stake_sol']);
    const entry = price(r['entry_target_price']);
    const sl = price(r['sl_price']);
    const expires = isoOrNull(r['expires_at']);
    const created = isoOrNull(r['created_at']);
    if (stake === null || stake <= 0 || entry === null || sl === null || expires === null || created === null) continue;
    const fill = price(r['fill_price']);
    const filledAt = isoOrNull(r['filled_at']);
    if (status === 'open' && (fill === null || filledAt === null)) continue;
    if (!Array.isArray(r['paper_legs']) || r['paper_legs'].length === 0 || r['paper_legs'].length > MAX_LEGS) continue;
    const legs = r['paper_legs'].map(parseLeg);
    if (legs.some((l) => l === null)) continue;
    out.push({
      id: r['id'],
      user_id: r['user_id'],
      mint: r['mint'],
      book,
      strategy,
      status,
      stake_sol: stake,
      entry_target_price: entry,
      fill_price: fill,
      sl_price: sl,
      created_at: created,
      filled_at: filledAt,
      expires_at: expires,
      legs: legs as PaperLeg[],
      entry_mode: parseEntryMode(r['entry_mode']),
    });
  }
  return out;
}

/**
 * Fair processing order: round robin across users (first appearance order), each user's positions in input order
 * (oldest first), capped at `max`. A user with 50 positions cannot push the others past the quote / apply budgets.
 */
export function fairOrder<T extends { user_id: string }>(items: readonly T[], max: number = MAX_ENGINE_POSITIONS): T[] {
  const queues = new Map<string, T[]>();
  for (const it of items) {
    const q = queues.get(it.user_id);
    if (q) q.push(it);
    else queues.set(it.user_id, [it]);
  }
  const out: T[] = [];
  const lists = [...queues.values()];
  for (let round = 0; out.length < max; round++) {
    let any = false;
    for (const q of lists) {
      if (round < q.length) {
        any = true;
        out.push(q[round]!);
        if (out.length >= max) break;
      }
    }
    if (!any) break;
  }
  return out;
}

/** Latest observed price of a mint. */
export interface BaseTick {
  price: number;
  /** epoch ms (snapshot captured_at) */
  at: number;
  /** Always 'scan' (token_snapshots) since track-fast was removed. */
  source?: 'scan';
}

/**
 * Latest valid snapshot per mint among `rows` ({ mint, price_usd, captured_at }), kept only if captured within
 * `maxAgeMs` before `nowMs` (and not more than 1 min in the future). Missing / stale mints get no tick.
 */
export function buildTicks(rows: unknown, nowMs: number, maxAgeMs: number = TICK_FRESH_MS): Map<string, BaseTick> {
  const out = new Map<string, BaseTick>();
  if (!Array.isArray(rows) || !Number.isFinite(nowMs)) return out;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (!isSolanaAddress(r['mint'])) continue;
    const p = price(r['price_usd']);
    const at = typeof r['captured_at'] === 'string' && r['captured_at'].length <= 40 ? Date.parse(r['captured_at']) : NaN;
    if (p === null || !Number.isFinite(at)) continue;
    if (nowMs - at > maxAgeMs || at > nowMs + 60_000) continue;
    const prev = out.get(r['mint']);
    if (!prev || at > prev.at) out.set(r['mint'], { price: p, at });
  }
  return out;
}

/** Distinct mints of the positions, in order of first appearance. */
export function positionMints(positions: readonly { mint: string }[]): string[] {
  return [...new Set(positions.map((p) => p.mint))];
}

// ---------------------------------------------------------------------------------------------------------------
// Quotes

/** SOL → lamports for a Jupiter ExactIn amount. null when not a usable positive amount (≤ 1e6 SOL). */
export function solToLamports(sol: number): bigint | null {
  if (typeof sol !== 'number' || !Number.isFinite(sol) || sol <= 0 || sol >= 1e6) return null;
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  return lamports > 0 ? BigInt(lamports) : null;
}

/** Buy quote amount of a pending position: its whole stake (one entry for every leg), in lamports. */
export const buyLamports = (position: Pick<PaperPosition, 'stake_sol'>): bigint | null => solToLamports(position.stake_sol);

/**
 * SOL value at `currentPrice` of the legs that close together in this step, in lamports:
 * Σ stake × size/100 × current / fill. Token decimals are unknown here, so the sell impact is measured with a
 * SOL → token quote of that value followed by a token → SOL quote of exactly the tokens received (≈ the tokens sold;
 * the SOL/USD drift since the fill is ignored). null if unusable.
 */
export function sellLamports(
  position: Pick<PaperPosition, 'stake_sol' | 'fill_price' | 'legs'>,
  closingLegIds: readonly string[],
  currentPrice: number,
): bigint | null {
  const fill = position.fill_price;
  if (typeof fill !== 'number' || !(fill > 0) || !(currentPrice > 0) || closingLegIds.length === 0) return null;
  let pct = 0;
  for (const id of new Set(closingLegIds)) {
    const leg = position.legs.find((l) => l.id === id);
    if (!leg) return null;
    pct += leg.size_pct;
  }
  return solToLamports(position.stake_sol * (pct / 100) * (currentPrice / fill));
}

export interface QuoteRequest {
  kind: 'buy' | 'sell';
  mint: string;
  lamports: bigint;
  key: string;
}

export const quoteKey = (kind: 'buy' | 'sell', mint: string, lamports: bigint): string => `${kind}:${mint}:${lamports}`;

/** Calls a request costs: buy = 1 quote, sell = 2 (SOL → token for the value, then token → SOL). */
export const quoteCost = (q: Pick<QuoteRequest, 'kind'>): number => (q.kind === 'sell' ? 2 : 1);

const noImpactTick = (t: BaseTick): PriceTick => ({ price: t.price, at: t.at, buyImpactPct: null, sellImpactPct: null });

/**
 * Quote needed by one position at this tick: what step() does with the default impact decides it (which legs close
 * depends on the price only, never on the impact, so the amount is the same with the quoted impact).
 */
function quoteFor(position: EnginePosition, base: BaseTick, nowMs: number): QuoteRequest | null {
  const s = step(position, noImpactTick(base), nowMs);
  if (s.kind === 'fill') {
    const lamports = buyLamports(position);
    return lamports === null ? null : { kind: 'buy', mint: position.mint, lamports, key: quoteKey('buy', position.mint, lamports) };
  }
  if (s.kind === 'legs' && s.closes.length > 0) {
    const lamports = sellLamports(position, s.closes.map((c) => c.id), base.price);
    return lamports === null ? null : { kind: 'sell', mint: position.mint, lamports, key: quoteKey('sell', position.mint, lamports) };
  }
  return null;
}

/**
 * Quotes worth asking for this run: positions that step() fills (pending) or whose legs it closes (open) with the
 * default impact. Deduplicated (same mint + amount share a quote). Exits first (they settle P&L), then entries, each
 * group in input order (pass the fair order).
 */
export function quoteCandidates(positions: readonly EnginePosition[], ticks: ReadonlyMap<string, BaseTick>, nowMs: number): QuoteRequest[] {
  const sells: QuoteRequest[] = [];
  const buys: QuoteRequest[] = [];
  const seen = new Set<string>();
  for (const p of positions) {
    const t = ticks.get(p.mint);
    if (!t) continue;
    const req = quoteFor(p, t, nowMs);
    if (!req || seen.has(req.key)) continue;
    seen.add(req.key);
    (req.kind === 'sell' ? sells : buys).push(req);
  }
  return [...sells, ...buys];
}

/** Tick of one position: the mint's price plus the impact quoted for THIS position's amount (null = unknown → +2 %). */
export function tickForPosition(
  position: EnginePosition,
  base: BaseTick | undefined,
  impacts: ReadonlyMap<string, number | null>,
  nowMs: number,
): PriceTick | null {
  if (!base) return null;
  const tick = noImpactTick(base);
  const req = quoteFor(position, base, nowMs);
  if (req) {
    const impact = impacts.get(req.key) ?? null;
    if (req.kind === 'buy') tick.buyImpactPct = impact;
    else tick.sellImpactPct = impact;
  }
  return tick;
}

export interface QuoteRunOptions {
  fetchFn?: FetchFn;
  jupBase?: string;
  /** Jupiter x-api-key (never logged). */
  headers?: Record<string, string>;
  /** Run-wide abort (quotes in flight are cancelled). */
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Epoch ms before which no quote starts (waits). */
  startAt?: number;
  /** Epoch ms after which no new quote starts. */
  stopAt: number;
  maxCalls?: number;
  gapMs?: number;
  log?: (message: string) => void;
}

export interface QuoteRunResult {
  /** key → impact PERCENT (null = quoted but unusable). Keys not present = not quoted (budget). */
  impacts: Map<string, number | null>;
  calls: number;
  rateLimited: boolean;
}

/**
 * Runs the quote requests sequentially, one Jupiter call every `gapMs`, within `maxCalls` and before `stopAt`; stops
 * at the first 429. Never throws. Buy: SOL → mint for the stake (buy impact). Sell: SOL → mint for the legs' value,
 * then mint → SOL for exactly the tokens received (sell impact of the second leg).
 */
export async function runQuotes(requests: readonly QuoteRequest[], opts: QuoteRunOptions): Promise<QuoteRunResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxCalls = opts.maxCalls ?? MAX_QUOTE_CALLS;
  const gap = opts.gapMs ?? QUOTE_GAP_MS;
  const result: QuoteRunResult = { impacts: new Map(), calls: 0, rateLimited: false };
  if (requests.length === 0) return result;
  let nextAt = Math.max(now(), opts.startAt ?? 0);

  const call = async (input: string, output: string, amount: bigint) => {
    const wait = nextAt - now();
    if (wait > 0) await sleep(wait);
    if (now() >= opts.stopAt || opts.signal?.aborted || result.rateLimited) return undefined;
    result.calls++;
    nextAt = now() + gap;
    return await fetchJupQuote(input, output, amount, {
      fetchFn: opts.fetchFn,
      jupBase: opts.jupBase,
      headers: opts.headers,
      signal: opts.signal,
      log: opts.log,
      onStatus: (s) => {
        if (s === 429) result.rateLimited = true;
      },
    });
  };

  for (const q of requests) {
    if (result.calls + quoteCost(q) > maxCalls || result.rateLimited || opts.signal?.aborted) break;
    if (now() >= opts.stopAt) break;
    try {
      const buy = await call(SOL_MINT, q.mint, q.lamports);
      if (buy === undefined) break;
      if (!buy || buy.inputMint !== SOL_MINT || buy.outputMint !== q.mint || BigInt(buy.inAmount) !== q.lamports) {
        result.impacts.set(q.key, null);
        continue;
      }
      if (q.kind === 'buy') {
        result.impacts.set(q.key, impactToPercent(buy.priceImpactPct));
        continue;
      }
      const tokens = BigInt(buy.outAmount);
      if (tokens <= 0n) {
        result.impacts.set(q.key, null);
        continue;
      }
      const sell = await call(q.mint, SOL_MINT, tokens);
      if (sell === undefined) break;
      const ok = sell && sell.inputMint === q.mint && sell.outputMint === SOL_MINT && BigInt(sell.inAmount) === tokens;
      result.impacts.set(q.key, ok ? impactToPercent(sell.priceImpactPct) : null);
    } catch {
      result.impacts.set(q.key, null);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// paper_apply_v2 arguments

export type StepPayload =
  | { kind: 'fill'; fill_price: number; fees_sol: number; legs: { id: string; tp_price: number; stop_price: number }[] }
  | { kind: 'expire' }
  | {
      kind: 'legs';
      closes: { id: string; status: 'tp_hit' | 'sl_hit' | 'breakeven_hit'; exit_price: number }[];
      moves: { id: string; stop_price: number }[];
      fees_sol: number;
      position_closed: boolean;
      pnl_sol: number | null;
    };

export interface ApplyArgsV2 {
  p_position: string;
  /** Optimistic guard: the step is applied only if the position still has this status. */
  p_expected: 'pending' | 'open';
  p_step: StepPayload;
  /** walletDelta(step, position). */
  p_delta: number;
}

const rounded = (x: number, digits = 12): number => Number(x.toFixed(digits));
const okPrice = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0 && x < PRICE_MAX;

/**
 * rpc paper_apply_v2 arguments for an engine step; null for 'none' or anything inconsistent (never applied).
 * Timestamps (filled_at / closed_at) are set by the database clock. Mirrors the checks of paper_apply_v2 so that a
 * payload the database would reject is never sent.
 */
export function applyArgsV2(position: EnginePosition, s: EngineStep): ApplyArgsV2 | null {
  if (!position || !s) return null;
  const legIds = new Set(position.legs.map((l) => l.id));
  if (s.kind === 'expire' && position.status === 'pending') {
    return { p_position: position.id, p_expected: 'pending', p_step: { kind: 'expire' }, p_delta: 0 };
  }
  if (s.kind === 'fill' && position.status === 'pending') {
    const delta = walletDelta(s, position);
    if (!okPrice(s.fill_price) || !(Number.isFinite(delta) && delta < 0)) return null;
    if (s.legs.length !== legIds.size || new Set(s.legs.map((l) => l.id)).size !== s.legs.length) return null;
    if (!s.legs.every((l) => legIds.has(l.id) && okPrice(l.tp_price) && okPrice(l.stop_price))) return null;
    return {
      p_position: position.id,
      p_expected: 'pending',
      p_step: {
        kind: 'fill',
        fill_price: s.fill_price,
        fees_sol: rounded(s.fees_sol),
        legs: s.legs.map((l) => ({ id: l.id, tp_price: l.tp_price, stop_price: l.stop_price })),
      },
      p_delta: rounded(delta),
    };
  }
  if (s.kind === 'legs' && position.status === 'open') {
    if (s.closes.length === 0 && s.moves.length === 0) return null;
    const openIds = new Set(position.legs.filter((l) => l.status === 'open').map((l) => l.id));
    if (new Set(s.closes.map((c) => c.id)).size !== s.closes.length) return null;
    if (!s.closes.every((c) => openIds.has(c.id) && okPrice(c.exit_price))) return null;
    if (!s.moves.every((m) => openIds.has(m.id) && okPrice(m.stop_price))) return null;
    const delta = s.closes.length > 0 ? walletDelta(s, position) : 0;
    const fees = s.closes.length > 0 ? rounded(s.fees_sol) : 0;
    if (!Number.isFinite(delta) || !(fees >= 0 && fees < 1)) return null;
    if (s.position_closed && (typeof s.pnl_sol !== 'number' || !Number.isFinite(s.pnl_sol))) return null;
    if (s.position_closed !== (s.closes.length === openIds.size)) return null;
    return {
      p_position: position.id,
      p_expected: 'open',
      p_step: {
        kind: 'legs',
        closes: s.closes.map((c) => ({ id: c.id, status: c.status, exit_price: c.exit_price })),
        moves: s.moves.map((m) => ({ id: m.id, stop_price: m.stop_price })),
        fees_sol: fees,
        position_closed: s.position_closed,
        pnl_sol: s.position_closed && s.pnl_sol !== null ? rounded(s.pnl_sol) : null,
      },
      p_delta: rounded(delta),
    };
  }
  return null;
}

/** Outcome label of an applied step, for the run stats. */
export function stepLabel(args: ApplyArgsV2): 'filled' | 'expired' | 'closed' | 'legs' | 'moved' {
  const s = args.p_step;
  if (s.kind === 'fill') return 'filled';
  if (s.kind === 'expire') return 'expired';
  if (s.position_closed) return 'closed';
  return s.closes.length > 0 ? 'legs' : 'moved';
}

// ---------------------------------------------------------------------------------------------------------------
// Forced price tracking (scan-tokens)

/** Mints with active paper positions, for scan-tokens' tracking batch: open positions first, then pending entries. */
export interface PaperMints {
  open: string[];
  pending: string[];
}

/** paper_positions rows { mint, status } → distinct valid mints per status (a mint open somewhere is not repeated). */
export function parsePaperMints(rows: unknown): PaperMints {
  const open = new Set<string>();
  const pending = new Set<string>();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Record<string, unknown>;
      if (!isSolanaAddress(r['mint'])) continue;
      if (r['status'] === 'open') open.add(r['mint']);
      else if (r['status'] === 'pending') pending.add(r['mint']);
    }
  }
  return { open: [...open], pending: [...pending].filter((m) => !open.has(m)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Auto-paper plans (« Calme » / « Frénésie »)

/** Fields of a matched token needed to place the entry. */
export interface AutoPaperToken {
  mint: string;
  price_usd?: number | null;
}

export interface AutoPaperPlan {
  book: Book;
  strategy: Strategy;
  stake_sol: number;
  entry: number;
  sl_pct: number;
  /** Always 'next_tick' for the comparison books (filled at the first scan snapshot after the creation). */
  entry_mode: EntryMode;
}

/** Same levels as the SQL (planLegs mirror): every TP must stay storable. */
function storablePlan(p: AutoPaperPlan): boolean {
  const legs = planLegs(p.strategy, p.entry, p.sl_pct);
  return legs.length > 0 && legs.every((l) => okPrice(l.tp_price) && okPrice(l.stop_price));
}

/** rpc paper_open_position_as arguments (service_role) of one auto-paper plan. */
export interface OpenPositionAsArgs {
  p_user: string;
  p_book: Book;
  p_mint: string;
  p_strategy: Strategy;
  p_stake: number;
  p_entry: number;
  p_sl_pct: number;
  p_custom_tp: null;
  p_custom_sl: null;
  p_source: 'auto_alert';
  p_alert_id: number | null;
  p_entry_mode: EntryMode;
}

export function openPositionArgs(userId: string, mint: string, plan: AutoPaperPlan, alertId: number | null): OpenPositionAsArgs | null {
  if (!isUuid(userId) || !isSolanaAddress(mint) || !plan) return null;
  const id = typeof alertId === 'number' && Number.isSafeInteger(alertId) && alertId > 0 ? alertId : null;
  return {
    p_user: userId,
    p_book: plan.book,
    p_mint: mint,
    p_strategy: plan.strategy,
    p_stake: plan.stake_sol,
    p_entry: plan.entry,
    p_sl_pct: plan.sl_pct,
    p_custom_tp: null,
    p_custom_sl: null,
    p_source: 'auto_alert',
    p_alert_id: id,
    p_entry_mode: parseEntryMode(plan.entry_mode),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// « Calme » / « Frénésie » auto-paper (feat/calm-sl-test)
//
// At every scan, for each token matching young_calm (matchesYoungCalm) or young_frenzy (matchesYoungFrenzy) and for
// each user with auto_paper = true, INDEPENDENTLY of alerts (no caps, no quiet hours, no persistence) so the books are
// comparable: one all_x2 position of 0.1 SOL, entry_mode 'next_tick' (market entry at the next scan snapshot), in each
// book of the preset (young_calm → calm_sl30 + calm_sl40, young_frenzy → frenzy_sl30) with the book's stop. A book gets
// no new position on a mint while one is pending / open there, nor for 12 h after a stop on that mint IN THAT BOOK
// (per-book cooldown: a stop in calm_sl30 must not keep calm_sl40 out, or the stop comparison would be biased).

/** Stake (SOL) of every test-book position. */
export const CALM_FRENZY_STAKE_SOL = 0.1;
/** Default stop (percent) of the frenzy control and of calm_sl30. */
export const CALM_FRENZY_SL_PCT = DEFAULT_SL_PCT;
/** Cooldown after a stop (sl_hit leg) on the same mint in the same test book: mirrors paper_open_position_as (12 h). */
export const CALM_FRENZY_STOP_COOLDOWN_MS = 12 * 3_600_000;

/**
 * The plans of one young_calm / young_frenzy match: one per book of the preset (CALM_FRENZY_BOOK_SL), all_x2, 0.1 SOL,
 * entry = current price, 'next_tick'. [] when the preset, mint or price is unusable (or a level not storable).
 */
export function calmFrenzyPlans(token: AutoPaperToken, preset: CalmFrenzyPreset): AutoPaperPlan[] {
  if (!token || !isSolanaAddress(token.mint)) return [];
  if (preset !== 'young_calm' && preset !== 'young_frenzy') return [];
  const entry = price(token.price_usd ?? null);
  if (entry === null) return [];
  const out: AutoPaperPlan[] = [];
  for (const { book, slPct } of CALM_FRENZY_BOOK_SL[preset]) {
    const plan: AutoPaperPlan = {
      book,
      strategy: 'all_x2',
      stake_sol: CALM_FRENZY_STAKE_SOL,
      entry,
      sl_pct: slPct,
      entry_mode: 'next_tick',
    };
    if (storablePlan(plan)) out.push(plan);
  }
  return out;
}

/** One young preset match of this scan (the caller runs matchesYoungCalm / matchesYoungFrenzy). */
export interface CalmFrenzyMatch {
  preset: CalmFrenzyPreset;
  token: AutoPaperToken;
}

export interface CalmFrenzyOpening {
  user_id: string;
  mint: string;
  plan: AutoPaperPlan;
}

/**
 * Positions to open this scan: for each match × each user (UUIDs of auto_paper = true users) × each plan of
 * calmFrenzyPlans, EXCEPT when, for that user, in that book, on that mint:
 *   - a position is pending / open (no stacking; a closed / expired / cancelled one does not block), or
 *   - a leg hit its stop (status 'sl_hit') less than 12 h before nowMs (the SQL cooldown would refuse it; skipping
 *     saves a failing RPC every scan). A stop with an unreadable date counts as recent.
 * `existing` = paper_positions rows { user_id, book, mint, status, paper_legs?: [{ status, closed_at }] } of those users
 * on the matched mints (at least every active one and every one closed in the last 12 h). A row with an unreadable
 * status counts as active (fail safe). Duplicate matches (same mint) open once per book. Deterministic order: matches,
 * then users, then the preset's books. Never throws.
 */
export function calmFrenzyOpenings(
  matches: readonly CalmFrenzyMatch[],
  userIds: readonly string[],
  existing: unknown,
  nowMs: number,
): CalmFrenzyOpening[] {
  if (!Array.isArray(matches) || !Array.isArray(userIds)) return [];
  const taken = new Set<string>(); // `${user}|${book}|${mint}`: active position or stop cooldown
  for (const row of Array.isArray(existing) ? existing : []) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (!isUuid(r['user_id']) || !isSolanaAddress(r['mint']) || typeof r['book'] !== 'string') continue;
    const key = `${r['user_id']}|${r['book']}|${r['mint']}`;
    const terminal = r['status'] === 'closed' || r['status'] === 'expired' || r['status'] === 'cancelled';
    if (!terminal) taken.add(key);
    const legs = Array.isArray(r['paper_legs']) ? r['paper_legs'] : [];
    for (const leg of legs) {
      if (typeof leg !== 'object' || leg === null) continue;
      const l = leg as Record<string, unknown>;
      if (l['status'] !== 'sl_hit') continue;
      const closed = typeof l['closed_at'] === 'string' && l['closed_at'].length <= 40 ? Date.parse(l['closed_at']) : NaN;
      if (!Number.isFinite(closed) || !Number.isFinite(nowMs) || nowMs - closed < CALM_FRENZY_STOP_COOLDOWN_MS) {
        taken.add(key);
      }
    }
  }
  const users = [...new Set(userIds.filter(isUuid))];
  const out: CalmFrenzyOpening[] = [];
  for (const m of matches) {
    if (!m || typeof m !== 'object') continue;
    const plans = calmFrenzyPlans(m.token, m.preset);
    const mint = m.token.mint;
    for (const user of users) {
      for (const plan of plans) {
        const key = `${user}|${plan.book}|${mint}`;
        if (taken.has(key)) continue;
        taken.add(key);
        out.push({ user_id: user, mint, plan });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// next_tick entry (paper-engine), moved here from young-wiring.ts (removed with « Jeune & fort »)

/**
 * Entry tick of each PENDING 'next_tick' position: the EARLIEST scan snapshot of its mint captured strictly after
 * created_at, provided it is still within `maxAgeMs` of `nowMs` (and not more than 1 min in the future). Rows are
 * { mint, price_usd, captured_at } from token_snapshots (scan or forced tracking rows of scan-tokens). Positions
 * without such a snapshot get no entry (their latest-tick fallback is the caller's choice). Ticks carry source 'scan'.
 */
export function nextTickEntries(
  rows: unknown,
  positions: readonly { id: string; mint: string; status: string; entry_mode?: string; created_at: string }[],
  nowMs: number,
  maxAgeMs: number,
): Map<string, BaseTick> {
  const out = new Map<string, BaseTick>();
  if (!Array.isArray(rows) || !Number.isFinite(nowMs)) return out;
  const byMint = new Map<string, BaseTick[]>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (!isSolanaAddress(r['mint'])) continue;
    const p = typeof r['price_usd'] === 'number' ? r['price_usd'] : typeof r['price_usd'] === 'string' && r['price_usd'].length <= 64 ? Number(r['price_usd']) : NaN;
    const at = typeof r['captured_at'] === 'string' && r['captured_at'].length <= 40 ? Date.parse(r['captured_at']) : NaN;
    if (!Number.isFinite(p) || !(p > 0) || !(p < PRICE_MAX) || !Number.isFinite(at)) continue;
    if (nowMs - at > maxAgeMs || at > nowMs + 60_000) continue;
    const list = byMint.get(r['mint']) ?? [];
    list.push({ price: p, at, source: 'scan' });
    byMint.set(r['mint'], list);
  }
  for (const list of byMint.values()) list.sort((a, b) => a.at - b.at);
  for (const pos of positions) {
    if (!pos || pos.status !== 'pending' || pos.entry_mode !== 'next_tick') continue;
    const created = typeof pos.created_at === 'string' ? Date.parse(pos.created_at) : NaN;
    if (!Number.isFinite(created)) continue;
    const first = byMint.get(pos.mint)?.find((t) => t.at > created);
    if (first) out.set(pos.id, first);
  }
  return out;
}
