// Pure paper-trading engine v2 (feat/paper-trading-v2): positions made of legs. SIMULATION ONLY: no wallet, no key,
// no signature, no order is ever sent anywhere. No I/O, no dependency: the module is mirrored as-is by the front.
//
// Units: prices in USD, amounts in SOL, *Pct values are PERCENTS (2 = 2 %), *Rate values are FRACTIONS (0–1).
//
// Model:
// - A position has one entry (stake_sol bought at fill_price) and its legs (a single 100 % leg for all_x2), each
//   closing on its own TP or stop.
// - Strategy (planLegs), chore/slim-down: all_x2 ONLY — 1 leg of 100 %, TP ×2, SL −slPct. half_x2_rest_x3,
//   thirds_x2_x3_x4 and custom were removed (their positions are archived history: the RPCs refuse them and the
//   migration 20261121020000_slim_down cancelled the ones still active), so there is no stop ladder any more.
//
// Realism rules (deliberately pessimistic, a paper result must not flatter the strategy):
// - Fills and exits use the OBSERVED tick price adjusted by the Jupiter price impact (DEFAULT_SLIPPAGE_PCT when
//   unknown), never the limit / TP / stop level. A gap below a stop therefore exits below the stop, as in reality.
// - Each swap costs NETWORK_FEE_PER_TX_SOL: one for the entry, one per leg exit. The token-account rent is locked at
//   the fill and returned when the position closes: it moves the balance but is not a cost (not part of pnl_sol).
// - If a tick is both ≥ TP and ≤ stop for a leg (inconsistent levels), the stop wins.
// - Invalid or missing data never throws: step() returns { kind: 'none' }.

export const NETWORK_FEE_PER_TX_SOL = 0.0002;
export const TOKEN_ACCOUNT_RENT_SOL = 0.00204;
export const DEFAULT_SLIPPAGE_PCT = 2;
export const ENTRY_EXPIRY_MS = 24 * 3600_000;
/** A tick older than this (relative to now) is stale and ignored: no fill, no close. Covers the 2-min scan cron
 *  and the 6-min GeckoTerminal cadence with margin. */
export const TICK_MAX_AGE_MS = 10 * 60_000;
/** Tolerated clock skew for a tick dated slightly in the future; beyond it the tick is ignored. */
export const TICK_MAX_SKEW_MS = 60_000;
/** Price impacts are clamped to [0, MAX_IMPACT_PCT] so that an exit price is always > 0. */
export const MAX_IMPACT_PCT = 99;
/** Default stop-loss distance (percent below the fill) for the preset strategies. */
export const DEFAULT_SL_PCT = 30;
/** TP multiplier of all_x2 (applied to the fill price). */
export const ALL_X2_TP_MULTIPLIER = 2;

export type Strategy = 'all_x2';
/** Every strategy still executable. */
export const STRATEGIES: readonly Strategy[] = ['all_x2'];
/** Exact Strategy or null (archived strategies → null). */
export const parseStrategy = (v: unknown): Strategy | null =>
  typeof v === 'string' && (STRATEGIES as readonly string[]).includes(v) ? (v as Strategy) : null;
/**
 * How a pending position fills (paper_positions.entry_mode):
 * - 'target'    : first fresh tick with price ≤ entry_target_price (limit-like, historical behaviour);
 * - 'next_tick' : first fresh SCAN tick captured strictly after created_at, whatever its price (market-like, « Jeune &
 *                 fort » auto-paper: the realistic entry ≈ 2 min after the alert).
 */
export type EntryMode = 'target' | 'next_tick';
export const ENTRY_MODES: readonly EntryMode[] = ['target', 'next_tick'];
/** Unknown / missing → 'target' (the column default). */
export const parseEntryMode = (v: unknown): EntryMode => (v === 'next_tick' ? 'next_tick' : 'target');
/** Origin of a price tick: token_snapshots of scan-tokens (track-fast and its 'fast' ticks were removed). */
export type TickSource = 'scan';
export type PositionStatus = 'pending' | 'open' | 'closed' | 'cancelled' | 'expired';
export type LegStatus = 'open' | 'tp_hit' | 'sl_hit' | 'breakeven_hit';

export interface PaperLeg {
  id: string;
  /** 100 for all_x2 (percent of the position). */
  size_pct: number;
  tp_price: number;
  status: LegStatus;
  /** Stop of this leg (SL). */
  stop_price: number;
  exit_price: number | null;
  closed_at: string | null;
}

export interface PaperPosition {
  id: string;
  strategy: Strategy;
  status: PositionStatus;
  stake_sol: number;
  entry_target_price: number;
  fill_price: number | null;
  /** SL chosen at creation (relative to entry_target_price, re-based on the fill price at fill). */
  sl_price: number;
  created_at: string;
  filled_at: string | null;
  expires_at: string;
  legs: PaperLeg[];
  /** Absent → 'target'. */
  entry_mode?: EntryMode;
}

export interface PriceTick {
  price: number;
  /** epoch ms */
  at: number;
  buyImpactPct: number | null;
  sellImpactPct: number | null;
  /** Absent → 'scan'. */
  source?: TickSource;
}

export type LegCloseStatus = 'tp_hit' | 'sl_hit' | 'breakeven_hit';

export type EngineStep =
  | { kind: 'fill'; fill_price: number; fees_sol: number; legs: { id: string; tp_price: number; stop_price: number }[] }
  | { kind: 'expire' }
  | {
      kind: 'legs';
      closes: { id: string; status: LegCloseStatus; exit_price: number }[];
      moves: { id: string; stop_price: number }[];
      fees_sol: number;
      position_closed: boolean;
      /** Set when the position closes (all legs settled), null otherwise. */
      pnl_sol: number | null;
    }
  | { kind: 'none' };

const NONE: EngineStep = { kind: 'none' };
const SIZE_EPS = 1e-9;

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

const parseMs = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

const validSlPct = (slPct: unknown): slPct is number =>
  typeof slPct === 'number' && Number.isFinite(slPct) && slPct > 0 && slPct < 100;

/** Impact in percent, DEFAULT_SLIPPAGE_PCT when unknown/invalid, clamped to [0, MAX_IMPACT_PCT]. */
export function effectiveImpactPct(impact: number | null | undefined): number {
  const v = typeof impact === 'number' && Number.isFinite(impact) ? impact : DEFAULT_SLIPPAGE_PCT;
  return Math.min(MAX_IMPACT_PCT, Math.max(0, v));
}

const freshTick = (tick: PriceTick | null, now: number): tick is PriceTick =>
  tick !== null &&
  typeof tick === 'object' &&
  positive(tick.price) &&
  typeof tick.at === 'number' &&
  Number.isFinite(tick.at) &&
  tick.at <= now + TICK_MAX_SKEW_MS &&
  now - tick.at <= TICK_MAX_AGE_MS;

/**
 * Leg plan of all_x2 from an entry price (the target at creation, the fill price at fill time):
 * [{100, entry×2, SL}], SL = entry × (1 − slPct/100). slPct must be in (0, 100). Invalid input (or an archived
 * strategy) → [].
 */
export function planLegs(
  strategy: Strategy,
  entry: number,
  slPct: number,
): { size_pct: number; tp_price: number; stop_price: number }[] {
  if (!positive(entry) || !validSlPct(slPct) || strategy !== 'all_x2') return [];
  const sl = entry * (1 - slPct / 100);
  return [{ size_pct: 100, tp_price: entry * ALL_X2_TP_MULTIPLIER, stop_price: sl }];
}

/** Legs must be an array of objects with string ids, sizes in (0, 100] summing to 100. */
const validLegs = (legs: unknown): legs is PaperLeg[] => {
  if (!Array.isArray(legs) || legs.length === 0) return false;
  let total = 0;
  for (const l of legs) {
    if (!l || typeof l !== 'object' || typeof l.id !== 'string') return false;
    if (!positive(l.size_pct) || l.size_pct > 100) return false;
    total += l.size_pct;
  }
  return Math.abs(total - 100) <= SIZE_EPS;
};

/** Legs sorted by ascending TP (stable on input order), i.e. leg A first. */
const byTp = (legs: PaperLeg[]): PaperLeg[] =>
  legs
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (a.l.tp_price - b.l.tp_price) || a.i - b.i)
    .map((x) => x.l);

/**
 * One engine step for one position. Call it for every pending/open position on each new price tick (or with
 * tick = null to process expiries). Terminal statuses (closed, cancelled, expired) always return 'none'.
 *
 * pending:
 * - now ≥ expires_at → 'expire' (wins over a fill on the same tick; boundary inclusive).
 * - stale (> TICK_MAX_AGE_MS), future (> TICK_MAX_SKEW_MS) or pre-creation ticks are ignored.
 * - entry_mode 'target' (default): tick.at ≥ created_at and tick.price ≤ entry_target_price → 'fill'.
 *   entry_mode 'next_tick': tick.at > created_at (strictly), any price → 'fill'.
 *   Fill at observed × (1 + buy impact). The legs' TPs and stops are recomputed from the FILL price, keeping the SL
 *   distance chosen at creation (slPct = 1 − sl_price / entry_target_price).
 * open:
 * - ticks before filled_at are ignored (same freshness rules).
 * - per open leg: stop hit (price ≤ stop) → 'sl_hit' (or 'breakeven_hit' when the stop is ≥ the fill price, kept for
 *   legacy rows); else price ≥ TP → 'tp_hit'. Exit at observed × (1 − sell impact). 'moves' is always empty since
 *   the stop ladders were removed with their strategies.
 * - pnl_sol (when every leg is settled) = Σ stake × size/100 × (exit/fill − 1) − entry fee − Σ exit fees.
 *   A previously closed leg without a valid exit_price makes the data corrupt → 'none'.
 */
export function step(position: PaperPosition, tick: PriceTick | null, now: number): EngineStep {
  if (!position || typeof position !== 'object' || !Number.isFinite(now)) return NONE;
  if (!positive(position.stake_sol) || !validLegs(position.legs)) return NONE;

  if (position.status === 'pending') {
    const expiresMs = parseMs(position.expires_at);
    if (expiresMs === null) return NONE;
    if (now >= expiresMs) return { kind: 'expire' };
    if (!positive(position.entry_target_price)) return NONE;
    if (!freshTick(tick, now)) return NONE;
    // A price observed before the position existed cannot fill it (no look-back).
    const createdMs = parseMs(position.created_at);
    if (createdMs === null || tick.at < createdMs) return NONE;
    if (parseEntryMode(position.entry_mode) === 'next_tick') {
      if (tick.at === createdMs) return NONE; // strictly after the creation
    } else if (tick.price > position.entry_target_price) {
      return NONE;
    }

    const fill_price = tick.price * (1 + effectiveImpactPct(tick.buyImpactPct) / 100);
    if (!positive(fill_price)) return NONE;

    const sorted = byTp(position.legs);
    if (!positive(position.sl_price)) return NONE;
    const slPct = (1 - position.sl_price / position.entry_target_price) * 100;
    const plan = planLegs(position.strategy, fill_price, slPct);
    if (plan.length === 0 || plan.length !== sorted.length) return NONE;
    const legs = sorted.map((l, i) => ({ id: l.id, tp_price: plan[i].tp_price, stop_price: plan[i].stop_price }));
    return { kind: 'fill', fill_price, fees_sol: NETWORK_FEE_PER_TX_SOL, legs };
  }

  if (position.status === 'open') {
    const fill = position.fill_price;
    if (!positive(fill)) return NONE;
    if (!freshTick(tick, now)) return NONE;
    const filledMs = parseMs(position.filled_at);
    if (filledMs !== null && tick.at < filledMs) return NONE;

    const openLegs = position.legs.filter((l) => l.status === 'open');
    if (openLegs.length === 0) return NONE;
    if (!openLegs.every((l) => positive(l.tp_price) && positive(l.stop_price))) return NONE;

    const exit_price = tick.price * (1 - effectiveImpactPct(tick.sellImpactPct) / 100);
    if (!positive(exit_price)) return NONE;

    const closes: { id: string; status: LegCloseStatus; exit_price: number }[] = [];
    for (const leg of openLegs) {
      const stop = leg.stop_price;
      if (tick.price <= stop) {
        // Stop first, even if the same tick is also ≥ TP (inconsistent levels).
        closes.push({ id: leg.id, status: stop >= fill ? 'breakeven_hit' : 'sl_hit', exit_price });
      } else if (tick.price >= leg.tp_price) {
        closes.push({ id: leg.id, status: 'tp_hit', exit_price });
      }
    }

    const closedIds = new Set(closes.map((c) => c.id));
    const moves: { id: string; stop_price: number }[] = [];
    if (closes.length === 0) return NONE;

    const fees_sol = closes.length * NETWORK_FEE_PER_TX_SOL;
    const position_closed = closes.length === openLegs.length;
    let pnl_sol: number | null = null;
    if (position_closed) {
      let gross = 0;
      for (const leg of position.legs) {
        const exit = closedIds.has(leg.id) ? exit_price : leg.exit_price;
        if (!positive(exit)) return NONE; // corrupt history: never write a half-true pnl
        gross += position.stake_sol * (leg.size_pct / 100) * (exit / fill - 1);
      }
      pnl_sol = gross - NETWORK_FEE_PER_TX_SOL - position.legs.length * NETWORK_FEE_PER_TX_SOL;
      if (!Number.isFinite(pnl_sol)) return NONE;
    }
    return { kind: 'legs', closes, moves, fees_sol, position_closed, pnl_sol };
  }

  return NONE;
}

/**
 * Change to apply to the paper balance_sol for an engine step.
 * - fill   → −(stake + entry fee + rent)                          (rent locked in the token account)
 * - legs   → +Σ closed legs stake × size/100 × exit/fill − exit fees, + rent when the position closes
 *            (a step with only stop moves → 0). fill + all legs deltas sum exactly to pnl_sol.
 * - expire → 0. A pending position is never debited: its stake + entry fee + rent are only RESERVED
 *            (see reservedSol/committedSol), so expiring or cancelling it just drops the reservation.
 * - none   → 0. Invalid data → 0.
 */
export function walletDelta(stepResult: EngineStep, position: PaperPosition): number {
  if (!stepResult || !position || !positive(position.stake_sol)) return 0;
  const stake = position.stake_sol;
  if (stepResult.kind === 'fill') {
    const fee = Number.isFinite(stepResult.fees_sol) && stepResult.fees_sol >= 0 ? stepResult.fees_sol : NETWORK_FEE_PER_TX_SOL;
    return -(stake + fee + TOKEN_ACCOUNT_RENT_SOL);
  }
  if (stepResult.kind === 'legs') {
    const fill = position.fill_price;
    if (!positive(fill) || !Array.isArray(stepResult.closes) || !Array.isArray(position.legs)) return 0;
    let proceeds = 0;
    for (const c of stepResult.closes) {
      const leg = position.legs.find((l) => l && l.id === c.id);
      if (!leg || !positive(leg.size_pct) || !positive(c.exit_price)) return 0;
      proceeds += stake * (leg.size_pct / 100) * (c.exit_price / fill);
    }
    const fees = Number.isFinite(stepResult.fees_sol) && stepResult.fees_sol >= 0
      ? stepResult.fees_sol
      : stepResult.closes.length * NETWORK_FEE_PER_TX_SOL;
    const delta = proceeds - fees + (stepResult.position_closed ? TOKEN_ACCOUNT_RENT_SOL : 0);
    return Number.isFinite(delta) ? delta : 0;
  }
  return 0;
}

/**
 * SOL reserved by one pending position: stake + entry network fee + rent (exactly what the fill will debit).
 * legCount is only validated (integer ≥ 1): exit fees are NOT reserved, they are paid out of each leg's proceeds
 * (an exit always yields > 0 since impacts are clamped to MAX_IMPACT_PCT). Invalid input → 0.
 */
export function reservedSol(stakeSol: number, legCount: number): number {
  if (!positive(stakeSol) || !Number.isInteger(legCount) || legCount < 1) return 0;
  return stakeSol + NETWORK_FEE_PER_TX_SOL + TOKEN_ACCOUNT_RENT_SOL;
}

/**
 * Σ reservedSol of PENDING positions. Open positions are already debited from balance_sol and closed ones are
 * settled, so they are not counted. available = balance_sol − committedSol(positions).
 */
export function committedSol(positions: ReadonlyArray<Pick<PaperPosition, 'status' | 'stake_sol' | 'legs'>>): number {
  if (!Array.isArray(positions)) return 0;
  let sum = 0;
  for (const p of positions) {
    if (p && p.status === 'pending') sum += reservedSol(p.stake_sol, Array.isArray(p.legs) ? p.legs.length : 0);
  }
  return sum;
}

/** True when availableSol covers reservedSol(stakeSol, legCount). Invalid input → false. */
export function hasSufficientBalance(availableSol: number, stakeSol: number, legCount: number): boolean {
  const needed = reservedSol(stakeSol, legCount);
  return needed > 0 && typeof availableSol === 'number' && Number.isFinite(availableSol) && availableSol >= needed;
}

// ─── Stats ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Peak-to-trough drawdown of a value series. `start` is the value before the first point (0 for a cumulative pnl
 * curve, the initial balance for an equity curve) and counts as the first peak.
 * maxDrawdownSol ≥ 0 (absolute drop); maxDrawdownPct = FRACTION of the peak at which the worst drop started,
 * null when that peak is ≤ 0 (e.g. a pnl curve that never went positive). Non-finite points are skipped.
 */
export function maxDrawdown(series: ReadonlyArray<number>, start = 0): { maxDrawdownSol: number; maxDrawdownPct: number | null } {
  let peak = Number.isFinite(start) ? start : 0;
  let worst = 0;
  let worstPeak: number | null = null;
  for (const v of Array.isArray(series) ? series : []) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > worst) {
      worst = dd;
      worstPeak = peak;
    }
  }
  return { maxDrawdownSol: worst, maxDrawdownPct: worstPeak !== null && worstPeak > 0 ? worst / worstPeak : null };
}

export interface ClosedPositionInput {
  strategy: Strategy;
  pnl_sol: number | null;
  closed_at: string | null;
  legs: ReadonlyArray<Pick<PaperLeg, 'status'>>;
}

export interface StrategyStats {
  /** Closed positions with a finite pnl_sol (cancelled/expired never have one). */
  trades: number;
  /** LEG level: FRACTION of closed legs closed by TP; null when no closed leg. */
  tpRate: number | null;
  /** LEG level: FRACTION of closed legs closed by the SL; null when no closed leg. */
  slRate: number | null;
  /** LEG level: FRACTION of closed legs closed at breakeven; null when no closed leg. */
  breakevenRate: number | null;
  /** POSITION level: FRACTION of trades closing with pnl_sol > 0 (fees included); null when trades = 0. */
  winRate: number | null;
  /** Mean pnl_sol of winning trades (pnl > 0); null when none. */
  avgWinSol: number | null;
  /** Mean pnl_sol of losing trades (pnl < 0, a NEGATIVE number); null when none. */
  avgLossSol: number | null;
  /** Σ pnl_sol (fees included). */
  totalPnlSol: number;
  /** Longest run of consecutive losing trades (pnl < 0, by closed_at); a pnl ≥ 0 resets it. */
  worstLosingStreak: number;
  /** Peak-to-trough drop (≥ 0) of the cumulative pnl curve starting at 0, by closed_at. */
  maxDrawdownSol: number;
}

const sortByDate = <T>(items: T[], dateOf: (t: T) => number | null): T[] =>
  items
    .map((t, idx) => ({ t, idx, ms: dateOf(t) }))
    // date ascending, unknown dates last, input order as tie-breaker (stable, deterministic)
    .sort((a, b) => {
      if (a.ms === null && b.ms === null) return a.idx - b.idx;
      if (a.ms === null) return 1;
      if (b.ms === null) return -1;
      return a.ms - b.ms || a.idx - b.idx;
    })
    .map((x) => x.t);

function statsOf(trades: ReadonlyArray<ClosedPositionInput & { pnl_sol: number }>): StrategyStats {
  let legsClosed = 0;
  let legTp = 0;
  let legSl = 0;
  let legBe = 0;
  let wins = 0;
  let winSum = 0;
  let losses = 0;
  let lossSum = 0;
  let total = 0;
  let streak = 0;
  let worstStreak = 0;
  const curve: number[] = [];
  for (const t of trades) {
    for (const l of Array.isArray(t.legs) ? t.legs : []) {
      if (!l) continue;
      if (l.status === 'tp_hit') legTp++;
      else if (l.status === 'sl_hit') legSl++;
      else if (l.status === 'breakeven_hit') legBe++;
      else continue;
      legsClosed++;
    }
    total += t.pnl_sol;
    curve.push(total);
    if (t.pnl_sol > 0) {
      wins++;
      winSum += t.pnl_sol;
    }
    if (t.pnl_sol < 0) {
      losses++;
      lossSum += t.pnl_sol;
      streak++;
      if (streak > worstStreak) worstStreak = streak;
    } else {
      streak = 0;
    }
  }
  const n = trades.length;
  return {
    trades: n,
    tpRate: legsClosed > 0 ? legTp / legsClosed : null,
    slRate: legsClosed > 0 ? legSl / legsClosed : null,
    breakevenRate: legsClosed > 0 ? legBe / legsClosed : null,
    winRate: n > 0 ? wins / n : null,
    avgWinSol: wins > 0 ? winSum / wins : null,
    avgLossSol: losses > 0 ? lossSum / losses : null,
    totalPnlSol: total,
    worstLosingStreak: worstStreak,
    maxDrawdownSol: maxDrawdown(curve, 0).maxDrawdownSol,
  };
}

/**
 * Stats per strategy over closed positions. Every strategy key is always present (zero-trade stats when none).
 * Entries with an unknown strategy or a non-finite pnl_sol are ignored.
 */
export function strategyStats(closedPositions: ReadonlyArray<ClosedPositionInput>): Record<Strategy, StrategyStats> {
  const valid = (Array.isArray(closedPositions) ? closedPositions : []).filter(
    (p): p is ClosedPositionInput & { pnl_sol: number } =>
      !!p && STRATEGIES.includes(p.strategy) && typeof p.pnl_sol === 'number' && Number.isFinite(p.pnl_sol),
  );
  const sorted = sortByDate(valid, (p) => parseMs(p.closed_at));
  const out = {} as Record<Strategy, StrategyStats>;
  for (const s of STRATEGIES) out[s] = statsOf(sorted.filter((p) => p.strategy === s));
  return out;
}

/**
 * Balance after each event, sorted by date (stable on input order for equal dates). `at` is epoch ms or an ISO
 * string; the output `at` is epoch ms. Events with an invalid date or a non-finite delta are skipped. The initial
 * balance is not emitted as a point (no date); use maxDrawdown(curve.map(p => p.balance), initialSol).
 * A non-finite initialSol → [].
 */
export function equityCurve(
  initialSol: number,
  events: ReadonlyArray<{ at: number | string; delta: number }>,
): { at: number; balance: number }[] {
  if (typeof initialSol !== 'number' || !Number.isFinite(initialSol)) return [];
  const toMs = (at: unknown): number | null =>
    typeof at === 'number' ? (Number.isFinite(at) ? at : null) : parseMs(at);
  const valid = (Array.isArray(events) ? events : [])
    .filter((e) => !!e && typeof e.delta === 'number' && Number.isFinite(e.delta) && toMs(e.at) !== null)
    .map((e) => ({ at: toMs(e.at) as number, delta: e.delta }));
  let balance = initialSol;
  return sortByDate(valid, (e) => e.at).map((e) => {
    balance += e.delta;
    return { at: e.at, balance };
  });
}
