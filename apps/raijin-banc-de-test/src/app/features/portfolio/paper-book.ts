// Pure view model of one virtual book (SIMULATION ONLY): live P&L of open positions, leg states, totals.
import {
  PAPER_BOOKS,
  committedSol,
  isArchivedBook,
  defaultWallet,
  legGrossPnl,
  positionFees,
  roundSol,
  simulatedExitPrice,
  simulatedFillPrice,
  type LegStatus,
  type PaperBook,
  type PaperLeg,
  type PaperPosition,
  type PaperWallet,
} from '../../shared/models/paper';
import { balanceCurve, type CurvePoint } from './balance-curve';
import { closedTrades, legCounts, maxDrawdown, strategyStats, type Drawdown, type LegCounts, type StrategyStats } from './paper-stats';

export interface LivePnl {
  pnlSol: number;
  /** pnlSol / stake × 100. */
  pnlPct: number;
  /** What the still-open legs would return if sold now (sell slippage included). */
  openValueSol: number;
}

/** Price the position was bought at: the recorded fill, else the target plus slippage. */
export function fillOf(p: PaperPosition): number {
  return p.fill_price ?? simulatedFillPrice(p.entry_target_price);
}

/**
 * Live P&L of an OPEN position: closed legs at their exit price, open legs at `livePrice` (sell slippage applied),
 * minus the buy fee and one sell fee per leg. null when not open, or an open leg needs an unknown price.
 */
export function livePnl(p: PaperPosition, livePrice: number | null | undefined): LivePnl | null {
  if (p.status !== 'open' || p.legs.length === 0) return null;
  const fill = fillOf(p);
  let gross = 0;
  let openValue = 0;
  for (const leg of p.legs) {
    const legStake = (p.stake_sol * leg.size_pct) / 100;
    if (leg.status === 'open') {
      if (livePrice == null || !Number.isFinite(livePrice) || livePrice <= 0) return null;
      const exit = simulatedExitPrice(livePrice);
      gross += legGrossPnl(legStake, fill, exit);
      openValue += (legStake * exit) / fill;
    } else if (leg.exit_price !== null) {
      gross += legGrossPnl(legStake, fill, leg.exit_price);
    }
  }
  const pnlSol = roundSol(gross - positionFees(p.legs.length));
  return { pnlSol, pnlPct: (pnlSol / p.stake_sol) * 100, openValueSol: roundSol(openValue) };
}

export type LegState = LegStatus;

export interface LegView {
  leg: PaperLeg;
  /** « Moitié A · ×2 », « Moitié B · ×3 », « Tiers C · ×4 », « Position · ×2 », « Position ». */
  label: string;
  state: LegState;
  /** Current stop of this leg (stop_price, else the position stop). */
  currentStop: number | null;
  /** The stop has been moved up (to the fill price after A; thirds_x2_x3_x4: to fill × 2 after B). */
  breakevenMoved: boolean;
  /** Where the moved stop sits (null when not moved): the fill price, or fill × 2 (thirds, last leg after B). */
  raisedTo: 'breakeven' | 'x2' | null;
}

/** Leg rows of a position, with the breakeven move made explicit. */
export function legViews(p: PaperPosition): LegView[] {
  const half = p.legs.length > 1;
  const thirds = p.legs.length === 3;
  const aHit = half && p.legs[0].status === 'tp_hit';
  // Preset levels are recomputed from the fill price at fill time.
  const base = p.fill_price ?? p.entry_target_price;
  return p.legs.map((leg, i) => {
    const multiple = leg.tp_price !== null ? Math.round((leg.tp_price / base) * 10) / 10 : null;
    const name = half ? `${thirds ? 'Tiers' : 'Moitié'} ${'ABC'.charAt(i)}` : 'Position';
    const label = p.strategy === 'custom' || multiple === null ? name : `${name} · ×${String(multiple).replace('.', ',')}`;
    const currentStop = leg.stop_price ?? p.sl_price;
    const raised = currentStop !== null && p.sl_price !== null && currentStop > p.sl_price * (1 + 1e-9);
    const moved = leg.status === 'open' && i > 0 && (aHit || raised);
    const x2 = moved && thirds && i === 2 && p.legs[1].status === 'tp_hit';
    return { leg, label, state: leg.status, currentStop, breakevenMoved: moved, raisedTo: moved ? (x2 ? 'x2' : 'breakeven') : null };
  });
}

export interface PositionView {
  position: PaperPosition;
  livePrice: number | null;
  pnl: LivePnl | null;
  legs: LegView[];
}

export interface BookView {
  book: PaperBook;
  wallet: PaperWallet;
  /** Pending and open positions, most recent first. */
  active: PositionView[];
  /** Closed, cancelled and expired positions since the last reset, most recent first. */
  history: PaperPosition[];
  openValueSol: number;
  /** Reserved by pending positions (stake + buy fee + rent). */
  reservedSol: number;
  /** balance − reserved (what a new position can use). */
  availableSol: number;
  realizedSol: number;
  unrealizedSol: number;
  totalPnlSol: number;
  /** totalPnlSol / initial_sol × 100. */
  totalPnlPct: number;
  strategies: StrategyStats[];
  curve: CurvePoint[];
  drawdown: Drawdown;
  /** Closed (filled) trades counted in the stats. */
  trades: number;
  /** Closed legs of those trades (book-level TP / SL rates). */
  legs: LegCounts;
}

const time = (iso: string | null): number => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
};

/** Positions of the current wallet period: created at or after the last reset. */
export function sinceReset(positions: readonly PaperPosition[], wallet: PaperWallet): PaperPosition[] {
  const reset = time(wallet.reset_at);
  return reset === 0 ? [...positions] : positions.filter((p) => time(p.created_at) >= reset);
}

export function buildBookView(
  book: PaperBook,
  wallets: readonly PaperWallet[],
  positions: readonly PaperPosition[],
  prices: ReadonlyMap<string, number>,
): BookView {
  const wallet = wallets.find((w) => w.book === book) ?? defaultWallet(book);
  const own = sinceReset(
    positions.filter((p) => p.book === book),
    wallet,
  );
  const active = own
    .filter((p) => p.status === 'pending' || p.status === 'open')
    .sort((a, b) => time(b.created_at) - time(a.created_at))
    .map((position) => {
      const livePrice = prices.get(position.mint) ?? null;
      return { position, livePrice, pnl: livePnl(position, livePrice), legs: legViews(position) };
    });
  const history = own
    .filter((p) => p.status === 'closed' || p.status === 'cancelled' || p.status === 'expired')
    .sort((a, b) => time(b.closed_at ?? b.created_at) - time(a.closed_at ?? a.created_at));
  const trades = closedTrades(own);
  const realized = roundSol(trades.reduce((s, p) => s + (p.pnl_sol ?? 0), 0));
  const unrealized = roundSol(active.reduce((s, v) => s + (v.pnl?.pnlSol ?? 0), 0));
  const total = roundSol(realized + unrealized);
  const reserved = committedSol(active.map((v) => v.position));
  return {
    book,
    wallet,
    active,
    history,
    reservedSol: reserved,
    availableSol: Math.max(0, roundSol(wallet.balance_sol - reserved)),
    openValueSol: roundSol(active.reduce((s, v) => s + (v.pnl?.openValueSol ?? 0), 0)),
    realizedSol: realized,
    unrealizedSol: unrealized,
    totalPnlSol: total,
    totalPnlPct: (total / wallet.initial_sol) * 100,
    strategies: strategyStats(trades, wallet.initial_sol),
    curve: balanceCurve(trades, wallet),
    drawdown: maxDrawdown(
      trades.map((p) => p.pnl_sol ?? 0),
      wallet.initial_sol,
    ),
    trades: trades.length,
    legs: legCounts(trades),
  };
}

/**
 * Books to offer: always the main one, every test book that has a wallet or a position, and an archived book only
 * when it still has positions (its history stays readable; an empty archived wallet is hidden).
 */
export function availableBooks(wallets: readonly PaperWallet[], positions: readonly PaperPosition[]): PaperBook[] {
  return PAPER_BOOKS.filter((b) => {
    if (b === 'main') return true;
    if (positions.some((p) => p.book === b)) return true;
    return !isArchivedBook(b) && wallets.some((w) => w.book === b);
  });
}
