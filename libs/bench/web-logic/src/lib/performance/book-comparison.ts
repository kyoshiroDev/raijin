// Pure parsing / view of public.paper_book_comparison() rows (Performance screen, « Portefeuilles de test » card).
// One row per test book of the signed-in user (SIMULATION ONLY): closed trades, TP / SL hits, realised P&L, largest
// fall from a peak, worst losing streak, open positions and the trade target of the test.
import { BOOK_LABEL, BOOK_SHORT_LABEL, TEST_BOOKS, toNumber, type PaperBook } from '../models/paper';
import { formatCount, formatSignedSol, formatSolAmount } from '../utils/format';
import { formatHits, formatRate, hasEnoughSample } from './performance-stats';

/** Trades per book the test aims for when the row does not say otherwise. */
export const DEFAULT_TARGET_TRADES = 50;

export interface BookComparisonRow {
  book: PaperBook;
  /** Closed (filled) trades. */
  trades: number;
  tp_hits: number;
  sl_hits: number;
  /** Realised P&L in SOL. */
  pnl_sol: number;
  /** Largest fall of the balance from a previous peak, in SOL (≥ 0). */
  max_drawdown_sol: number;
  /** Longest run of consecutive losing trades. */
  worst_losing_streak: number;
  open_positions: number;
  target_trades: number;
}

const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);

/** Non-negative integer (number or numeric text), else null. */
function count(v: unknown): number | null {
  const n = toNumber(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

/** Defensive parse of one row; null when the book is not a test book or a count is invalid. */
export function parseBookComparisonRow(row: unknown): BookComparisonRow | null {
  const r = record(row);
  if (!r) return null;
  const book = r['book'];
  if (typeof book !== 'string' || !(TEST_BOOKS as readonly string[]).includes(book)) return null;
  const trades = count(r['trades']);
  const tp = count(r['tp_hits']);
  const sl = count(r['sl_hits']);
  if (trades === null || tp === null || sl === null || tp > trades || sl > trades) return null;
  const target = count(r['target_trades']);
  const drawdown = toNumber(r['max_drawdown_sol']);
  return {
    book: book as PaperBook,
    trades,
    tp_hits: tp,
    sl_hits: sl,
    pnl_sol: toNumber(r['pnl_sol']) ?? 0,
    max_drawdown_sol: drawdown !== null ? Math.abs(drawdown) : 0,
    worst_losing_streak: count(r['worst_losing_streak']) ?? 0,
    open_positions: count(r['open_positions']) ?? 0,
    target_trades: target !== null && target > 0 ? target : DEFAULT_TARGET_TRADES,
  };
}

/** Valid rows only; a duplicated book keeps the first one. */
export function parseBookComparisonRows(data: unknown): BookComparisonRow[] {
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: BookComparisonRow[] = [];
  for (const raw of data) {
    const row = parseBookComparisonRow(raw);
    if (row === null || seen.has(row.book)) continue;
    seen.add(row.book);
    out.push(row);
  }
  return out;
}

export interface BookProgress {
  book: PaperBook;
  /** Full label (« Frénésie SL −30 % (témoin) »). */
  label: string;
  /** Trades counted towards the target (capped at the target). */
  value: number;
  target: number;
  /** 0–100, for the bar width. */
  pct: number;
  done: boolean;
  /** « 12 trades sur 50 » (aria-valuetext and visible text). */
  text: string;
}

export interface BookCell {
  text: string;
  /** Small grey secondary line (« 21 / 50 »). */
  sub: string | null;
  /** Rate under 30 trades, or no data: muted, never prominent. */
  muted: boolean;
  tone: 'bull' | 'bear' | null;
}

export interface BookTableRow {
  key: string;
  label: string;
  cells: BookCell[];
}

export interface BookColumn {
  book: PaperBook;
  /** Column header (compact). */
  label: string;
  /** Frénésie: control book, no alerts. */
  control: boolean;
  /** null: the server returned nothing for this book yet. */
  row: BookComparisonRow | null;
}

export interface BookComparisonView {
  columns: BookColumn[];
  rows: BookTableRow[];
  progress: BookProgress[];
  /** At least one book has a row. */
  hasData: boolean;
  /** Some rate is shown as « hits / n » (under 30 trades). */
  insufficient: boolean;
}

const EMPTY: BookCell = { text: '—', sub: null, muted: true, tone: null };
const plain = (text: string, tone: BookCell['tone'] = null): BookCell => ({ text, sub: null, muted: false, tone });

/** Rate per closed trade: « 42,0 % » (sub « 21 / 50 ») from 30 trades; below, « 3 / 12 » in grey only. */
export function rateCell(hits: number, trades: number): BookCell {
  if (trades === 0) return { text: formatHits(0, 0), sub: null, muted: true, tone: null };
  if (!hasEnoughSample(trades)) return { text: formatHits(hits, trades), sub: null, muted: true, tone: null };
  return { text: formatRate(hits / trades), sub: formatHits(hits, trades), muted: false, tone: null };
}

function streakText(n: number): string {
  return n === 0 ? 'aucune' : `${formatCount(n)} d’affilée`;
}

export function bookProgress(book: PaperBook, row: BookComparisonRow | null): BookProgress {
  const target = row?.target_trades ?? DEFAULT_TARGET_TRADES;
  const trades = row?.trades ?? 0;
  const value = Math.min(trades, target);
  return {
    book,
    label: BOOK_LABEL[book],
    value,
    target,
    pct: Math.round((value / target) * 100),
    done: trades >= target,
    text: `${formatCount(trades)} trade${trades > 1 ? 's' : ''} sur ${formatCount(target)}`,
  };
}

/** The three test books in TEST_BOOKS order (missing books shown as « — »), table rows and progress. */
export function bookComparisonView(rows: readonly BookComparisonRow[]): BookComparisonView {
  const columns: BookColumn[] = TEST_BOOKS.map((book) => ({
    book,
    label: BOOK_SHORT_LABEL[book],
    control: book === 'frenzy_sl30',
    row: rows.find((r) => r.book === book) ?? null,
  }));
  const per = (f: (r: BookComparisonRow) => BookCell): BookCell[] => columns.map((c) => (c.row ? f(c.row) : EMPTY));
  const tableRows: BookTableRow[] = [
    { key: 'trades', label: 'Trades clôturés', cells: per((r) => plain(formatCount(r.trades))) },
    { key: 'tp', label: '% TP (×2)', cells: per((r) => rateCell(r.tp_hits, r.trades)) },
    { key: 'sl', label: '% SL', cells: per((r) => rateCell(r.sl_hits, r.trades)) },
    { key: 'pnl', label: 'P&L', cells: per((r) => plain(formatSignedSol(r.pnl_sol), r.pnl_sol > 0 ? 'bull' : r.pnl_sol < 0 ? 'bear' : null)) },
    {
      key: 'drawdown',
      label: 'Perte max depuis un sommet',
      cells: per((r) => plain(r.max_drawdown_sol > 0 ? `−${formatSolAmount(r.max_drawdown_sol)} SOL` : 'aucune')),
    },
    { key: 'streak', label: 'Pire série de pertes', cells: per((r) => plain(streakText(r.worst_losing_streak))) },
    { key: 'open', label: 'Positions ouvertes', cells: per((r) => plain(formatCount(r.open_positions))) },
  ];
  return {
    columns,
    rows: tableRows,
    progress: columns.map((c) => bookProgress(c.book, c.row)),
    hasData: columns.some((c) => c.row !== null),
    insufficient: columns.some((c) => c.row !== null && !hasEnoughSample(c.row.trades)),
  };
}
