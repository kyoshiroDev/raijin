// Pure statistics of closed paper positions (SIMULATION ONLY), per strategy. Mirrors the backend v2 definitions
// (legacy Edge Functions _shared/paper.ts statsOf, ported to the bench API):
// - a trade = a filled position that closed with a finite pnl_sol (cancelled / expired entries never traded);
// - TP / SL rates are LEG-level: closed legs at TP (or SL) ÷ closed legs (a breakeven exit is neither);
// - losing streak: consecutive pnl < 0 by closed_at, a pnl ≥ 0 resets it;
// - drawdown in SOL: peak-to-trough of the cumulative P&L (the % is taken from the equity peak, base + cumulative).
// Same small-sample rule as the Performance screen: under 30 samples (closed legs), « hits / n » in grey, no %.
import { PAPER_STRATEGIES, roundSol, type PaperPosition, type PaperStrategy } from '../models/paper';
import { hasEnoughSample } from '../performance/performance-stats';

export interface LegCounts {
  tp: number;
  sl: number;
  breakeven: number;
  /** Closed legs: the denominator of the rates. */
  closed: number;
}

export interface Drawdown {
  /** Largest fall from a running peak, in SOL (≥ 0). */
  sol: number;
  /** Same fall in percent of that peak (≥ 0). */
  pct: number;
}

export interface StrategyStats {
  strategy: PaperStrategy;
  trades: number;
  /** Leg counts behind the rates. */
  legs: LegCounts;
  /** Closed legs at TP ÷ closed legs; null when no closed leg. */
  tpRate: number | null;
  /** Closed legs at SL ÷ closed legs; null when no closed leg. */
  slRate: number | null;
  /** Mean P&L of the winning trades (SOL); null when none. */
  avgWinSol: number | null;
  /** Mean P&L of the losing trades (SOL, negative); null when none. */
  avgLossSol: number | null;
  totalPnlSol: number;
  /** Longest run of consecutive losing trades, in closing order. */
  worstStreak: number;
  /** Sum of that run (SOL, ≤ 0). */
  worstStreakSol: number;
  drawdown: Drawdown;
  /** closed legs ≥ 30: rates may be shown as percentages. */
  enough: boolean;
}

const time = (p: PaperPosition): number => {
  const t = Date.parse(p.closed_at ?? p.created_at);
  return Number.isFinite(t) ? t : 0;
};

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : roundSol(values.reduce((a, b) => a + b, 0) / values.length);

/** Trades: closed positions with a known P&L, OLDEST first (closing order). */
export function closedTrades(positions: readonly PaperPosition[]): PaperPosition[] {
  return positions.filter((p) => p.status === 'closed' && p.pnl_sol !== null).sort((a, b) => time(a) - time(b));
}

/** Closed legs of the trades, by exit kind. */
export function legCounts(trades: readonly PaperPosition[]): LegCounts {
  const c: LegCounts = { tp: 0, sl: 0, breakeven: 0, closed: 0 };
  for (const p of trades) {
    for (const l of p.legs) {
      if (l.status === 'open') continue;
      c.closed++;
      if (l.status === 'tp_hit') c.tp++;
      else if (l.status === 'sl_hit') c.sl++;
      else c.breakeven++;
    }
  }
  return c;
}

/** Longest run of consecutive losing trades (pnl < 0), in closing order. A pnl ≥ 0 ends the run. */
export function worstLosingStreak(trades: readonly PaperPosition[]): { count: number; sum: number } {
  const sorted = [...trades].sort((a, b) => time(a) - time(b));
  let best = { count: 0, sum: 0 };
  let run = { count: 0, sum: 0 };
  for (const p of sorted) {
    if (p.pnl_sol !== null && p.pnl_sol < 0) {
      run = { count: run.count + 1, sum: roundSol(run.sum + p.pnl_sol) };
      if (run.count > best.count) best = run;
    } else {
      run = { count: 0, sum: 0 };
    }
  }
  return best;
}

/** Max drawdown of the equity `base + cumulative P&L` (P&L in closing order), from its running peak. */
export function maxDrawdown(pnls: readonly number[], base: number): Drawdown {
  let equity = base;
  let peak = base;
  let worst: Drawdown = { sol: 0, pct: 0 };
  for (const pnl of pnls) {
    equity += Number.isFinite(pnl) ? pnl : 0;
    if (equity > peak) peak = equity;
    const fall = peak - equity;
    if (fall > worst.sol + 1e-12) worst = { sol: roundSol(fall), pct: peak > 0 ? (fall / peak) * 100 : 0 };
  }
  return worst;
}

/** Stats of one strategy over its trades. `base` = initial balance (drawdown % of the equity peak). */
export function statsFor(strategy: PaperStrategy, positions: readonly PaperPosition[], base: number): StrategyStats {
  const own = closedTrades(positions.filter((p) => p.strategy === strategy));
  const wins: number[] = [];
  const losses: number[] = [];
  for (const p of own) {
    if (p.pnl_sol !== null && p.pnl_sol > 0) wins.push(p.pnl_sol);
    else if (p.pnl_sol !== null && p.pnl_sol < 0) losses.push(p.pnl_sol);
  }
  const legs = legCounts(own);
  const streak = worstLosingStreak(own);
  return {
    strategy,
    trades: own.length,
    legs,
    tpRate: legs.closed > 0 ? legs.tp / legs.closed : null,
    slRate: legs.closed > 0 ? legs.sl / legs.closed : null,
    avgWinSol: mean(wins),
    avgLossSol: mean(losses),
    totalPnlSol: roundSol(own.reduce((s, p) => s + (p.pnl_sol ?? 0), 0)),
    worstStreak: streak.count,
    worstStreakSol: streak.sum,
    drawdown: maxDrawdown(
      own.map((p) => p.pnl_sol ?? 0),
      base,
    ),
    enough: hasEnoughSample(legs.closed),
  };
}

/** Stats of every strategy that has at least one trade, in the fixed strategy order. */
export function strategyStats(positions: readonly PaperPosition[], base: number): StrategyStats[] {
  const trades = closedTrades(positions);
  return PAPER_STRATEGIES.filter((s) => trades.some((p) => p.strategy === s)).map((s) => statsFor(s, trades, base));
}
