// Paper trading v2 (SIMULATION ONLY: no wallet, no key, no signature, no real order).
// Mirrors public.paper_wallets / paper_positions / paper_legs and the backend simulation constants.
// Rows are owner-readable only (RLS). The browser never writes them directly: positions are opened, cancelled and
// wallets reset through RPCs (paper_open_position, paper_cancel_position, paper_reset_wallet) that re-check everything.

/** Simulated network fee per transaction (the buy, then each leg exit), in SOL. Mirrors the backend. */
export const PAPER_NETWORK_FEE_SOL = 0.0002;
/** Token-account rent locked when a position opens and returned when it closes, in SOL (not a cost). */
export const PAPER_RENT_SOL = 0.00204;
/** Default simulated slippage, as a FRACTION (2 %), applied against the trader on buy and sell. */
export const PAPER_SLIPPAGE = 0.02;
/** A pending entry that is not filled within this delay expires. */
export const PAPER_ENTRY_TTL_MS = 24 * 3_600_000;
/** Initial (and reset) virtual balance of every book. */
export const PAPER_START_BALANCE_SOL = 1;

/**
 * Books read by the client (feat/calm-sl-test 2026-11-21): the main book, the three test books (« Calme SL −30 % »,
 * « Calme SL −40 % », « Frénésie SL −30 % (témoin) ») and the two archived books of the first Calme vs Frénésie run
 * (calm_all_x2 / frenzy_all_x2: history readable, read-only, never reset). The older books (half_x2_rest_x3, all_x2,
 * young_*) are archived server-side: their wallets and positions are ignored here.
 */
export type PaperBook = 'main' | 'calm_sl30' | 'calm_sl40' | 'frenzy_sl30' | 'calm_all_x2' | 'frenzy_all_x2';
/**
 * Only all_x2 can be opened now; the other values are kept so that older positions of the main book still parse
 * and show in the history.
 */
export type PaperStrategy = 'half_x2_rest_x3' | 'all_x2' | 'thirds_x2_x3_x4' | 'custom';
export type PaperSource = 'manual' | 'auto_alert';
export type PositionStatus = 'pending' | 'open' | 'closed' | 'cancelled' | 'expired';
/** Allowed leg sizes (percent of the stake). */
export type LegSizePct = 33 | 34 | 50 | 100;
export type LegStatus = 'open' | 'tp_hit' | 'sl_hit' | 'breakeven_hit';

/**
 * Test books: presets young_calm (stop −30 % and −40 %) and young_frenzy (stop −30 %, control without alerts), all at
 * ×2, entry at the next scan, opened for every matching token independently of the alerts (comparable on equal terms).
 */
export const TEST_BOOKS: readonly PaperBook[] = ['calm_sl30', 'calm_sl40', 'frenzy_sl30'];
/** First Calme vs Frénésie run (×2, stop −30 %), replaced by the test books: read-only history. */
export const ARCHIVED_BOOKS: readonly PaperBook[] = ['calm_all_x2', 'frenzy_all_x2'];
/** Every book read (selector order): active books first, archived ones last. */
export const PAPER_BOOKS: readonly PaperBook[] = ['main', ...TEST_BOOKS, ...ARCHIVED_BOOKS];
export const PAPER_STRATEGIES: readonly PaperStrategy[] = ['half_x2_rest_x3', 'all_x2', 'thirds_x2_x3_x4', 'custom'];
const POSITION_STATUSES: readonly string[] = ['pending', 'open', 'closed', 'cancelled', 'expired'];
const LEG_STATUSES: readonly string[] = ['open', 'tp_hit', 'sl_hit', 'breakeven_hit'];
const LEG_SIZES: readonly number[] = [33, 34, 50, 100];

export const DEFAULT_PAPER_SL_PCT = 30;
/** alert_settings.paper_sl_pct check (integer percent). */
export const SL_PCT_LIMITS = { min: 1, max: 90 } as const;

export const STRATEGY_LABEL: Record<PaperStrategy, string> = {
  half_x2_rest_x3: '½ ×2 + ½ ×3',
  all_x2: 'Tout à ×2',
  thirds_x2_x3_x4: 'Tiers ×2 / ×3 / ×4',
  custom: 'Personnalisée',
};

export const BOOK_LABEL: Record<PaperBook, string> = {
  main: 'Principal',
  calm_sl30: 'Calme SL −30 %',
  calm_sl40: 'Calme SL −40 %',
  frenzy_sl30: 'Frénésie SL −30 % (témoin)',
  calm_all_x2: 'Calme ×2 (archivé)',
  frenzy_all_x2: 'Frénésie ×2 (archivé)',
};

/** Compact labels for narrow places (book selector, comparison column headers). */
export const BOOK_SHORT_LABEL: Record<PaperBook, string> = {
  main: 'Principal',
  calm_sl30: 'Calme −30 %',
  calm_sl40: 'Calme −40 %',
  frenzy_sl30: 'Frénésie −30 %',
  calm_all_x2: 'Calme ×2 · archivé',
  frenzy_all_x2: 'Frénésie ×2 · archivé',
};

export function isPaperStrategy(v: unknown): v is PaperStrategy {
  return typeof v === 'string' && (PAPER_STRATEGIES as readonly string[]).includes(v);
}

export function isPaperBook(v: unknown): v is PaperBook {
  return typeof v === 'string' && (PAPER_BOOKS as readonly string[]).includes(v);
}

/** Archived book: history only (no reset, no cancel). */
export function isArchivedBook(v: unknown): boolean {
  return typeof v === 'string' && (ARCHIVED_BOOKS as readonly string[]).includes(v);
}

export function isValidSlPct(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= SL_PCT_LIMITS.min && v <= SL_PCT_LIMITS.max;
}

/** Database value (number or numeric text) → valid SL percent, or null. */
export function parseSlPct(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return isValidSlPct(n) ? n : null;
}

export interface PaperWallet {
  book: PaperBook;
  balance_sol: number;
  initial_sol: number;
  created_at: string | null;
  reset_at: string | null;
}

export interface PaperLeg {
  id: string;
  position_id: string;
  /** 50 / 50 (half_x2_rest_x3), 33 / 33 / 34 (thirds_x2_x3_x4) or 100. */
  size_pct: LegSizePct;
  tp_price: number | null;
  stop_price: number | null;
  status: LegStatus;
  exit_price: number | null;
  closed_at: string | null;
}

export interface PaperPosition {
  id: string;
  book: PaperBook;
  mint: string;
  symbol: string;
  strategy: PaperStrategy;
  stake_sol: number;
  source: PaperSource;
  status: PositionStatus;
  entry_target_price: number;
  fill_price: number | null;
  sl_price: number | null;
  sl_pct: number | null;
  custom_tp_price: number | null;
  expires_at: string | null;
  created_at: string;
  filled_at: string | null;
  closed_at: string | null;
  pnl_sol: number | null;
  fees_sol: number | null;
  /** Sorted by TP ascending (leg A first). */
  legs: PaperLeg[];
}

export const PAPER_WALLET_COLUMNS = 'book,balance_sol,initial_sol,created_at,reset_at';
export const PAPER_LEG_COLUMNS = 'id,position_id,size_pct,tp_price,stop_price,status,exit_price,closed_at';
/** Positions with their legs embedded (paper_legs.position_id → paper_positions.id). */
export const PAPER_POSITION_COLUMNS =
  'id,book,mint,symbol,strategy,stake_sol,source,status,entry_target_price,fill_price,sl_price,sl_pct,custom_tp_price,' +
  `expires_at,created_at,filled_at,closed_at,pnl_sol,fees_sol,paper_legs(${PAPER_LEG_COLUMNS})`;

/** Postgres numeric arrives as number or text. Non-finite → null. */
export function toNumber(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const id = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v));
const positive = (v: unknown): number | null => {
  const n = toNumber(v);
  return n !== null && n > 0 ? n : null;
};
const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);

export function parsePaperLeg(row: unknown): PaperLeg | null {
  const r = record(row);
  if (!r) return null;
  const legId = id(r['id']);
  const positionId = id(r['position_id']);
  const size = toNumber(r['size_pct']);
  const status = r['status'];
  if (legId === null || positionId === null || size === null || !LEG_SIZES.includes(size)) return null;
  if (typeof status !== 'string' || !LEG_STATUSES.includes(status)) return null;
  return {
    id: legId,
    position_id: positionId,
    size_pct: size as LegSizePct,
    tp_price: positive(r['tp_price']),
    stop_price: positive(r['stop_price']),
    status: status as LegStatus,
    exit_price: positive(r['exit_price']),
    closed_at: str(r['closed_at']),
  };
}

/** Defensive parse of a paper_positions row (legs embedded under `paper_legs`); null when invalid. */
export function parsePaperPosition(row: unknown): PaperPosition | null {
  const r = record(row);
  if (!r) return null;
  const posId = id(r['id']);
  const mint = str(r['mint']);
  const status = r['status'];
  const stake = positive(r['stake_sol']);
  const entry = positive(r['entry_target_price']);
  const createdAt = str(r['created_at']);
  if (posId === null || mint === null || stake === null || entry === null || createdAt === null) return null;
  if (typeof status !== 'string' || !POSITION_STATUSES.includes(status)) return null;
  const book = r['book'];
  const strategy = r['strategy'];
  if (!isPaperBook(book) || !isPaperStrategy(strategy)) return null;
  const rawLegs = r['paper_legs'];
  const legs = (Array.isArray(rawLegs) ? rawLegs : [])
    .map(parsePaperLeg)
    .filter((l): l is PaperLeg => l !== null)
    .sort((a, b) => (a.tp_price ?? Infinity) - (b.tp_price ?? Infinity));
  return {
    id: posId,
    book,
    mint,
    symbol: typeof r['symbol'] === 'string' ? r['symbol'] : '',
    strategy,
    stake_sol: stake,
    source: r['source'] === 'auto_alert' ? 'auto_alert' : 'manual',
    status: status as PositionStatus,
    entry_target_price: entry,
    fill_price: positive(r['fill_price']),
    sl_price: positive(r['sl_price']),
    sl_pct: toNumber(r['sl_pct']),
    custom_tp_price: positive(r['custom_tp_price']),
    expires_at: str(r['expires_at']),
    created_at: createdAt,
    filled_at: str(r['filled_at']),
    closed_at: str(r['closed_at']),
    pnl_sol: toNumber(r['pnl_sol']),
    fees_sol: toNumber(r['fees_sol']),
    legs,
  };
}

export function parsePaperPositions(rows: unknown): PaperPosition[] {
  return Array.isArray(rows) ? rows.map(parsePaperPosition).filter((p): p is PaperPosition => p !== null) : [];
}

export function parsePaperWallet(row: unknown): PaperWallet | null {
  const r = record(Array.isArray(row) ? row[0] : row);
  if (!r) return null;
  const balance = toNumber(r['balance_sol']);
  if (balance === null || balance < 0) return null;
  const book = r['book'];
  // A wallet of a book this client does not know (or an archived one) is ignored (never merged into « main »); no book = main.
  if (book != null && !isPaperBook(book)) return null;
  return {
    book: isPaperBook(book) ? book : 'main',
    balance_sol: balance,
    initial_sol: positive(r['initial_sol']) ?? PAPER_START_BALANCE_SOL,
    created_at: str(r['created_at']),
    reset_at: str(r['reset_at']),
  };
}

export function parsePaperWallets(rows: unknown): PaperWallet[] {
  return Array.isArray(rows) ? rows.map(parsePaperWallet).filter((w): w is PaperWallet => w !== null) : [];
}

/** A wallet that does not exist yet reads as a fresh 1 SOL book. */
export function defaultWallet(book: PaperBook): PaperWallet {
  return { book, balance_sol: PAPER_START_BALANCE_SOL, initial_sol: PAPER_START_BALANCE_SOL, created_at: null, reset_at: null };
}

/** Generic, never leaks the database message. */
export const PAPER_ERRORS = {
  insufficient: 'Solde virtuel insuffisant',
  rejected: 'Position refusée',
} as const;

/** Picks the message from a balance-related hint in the error; the raw text is never shown. */
export function isInsufficientBalanceError(error: unknown): boolean {
  const e = record(error);
  if (!e) return false;
  const text = [e['message'], e['details'], e['hint']].filter((v): v is string => typeof v === 'string').join(' ');
  return /insufficient|insuffisant/i.test(text);
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Rounded to the lamport (1e-9 SOL): removes float noise. */
export function roundSol(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;
}

/** Simulated buy price: the slippage is paid on top of the reference price. */
export function simulatedFillPrice(price: number, slippage = PAPER_SLIPPAGE): number {
  return price * (1 + slippage);
}

/** Simulated sell price: the slippage is paid below the reference price. */
export function simulatedExitPrice(price: number, slippage = PAPER_SLIPPAGE): number {
  return price * (1 - slippage);
}

/**
 * Gross result in SOL of `legStakeSol` bought at `fillPrice` and sold at `exitPrice` (both slippage included),
 * BEFORE network fees. Same formula as the backend: stake × (exit / fill − 1).
 */
export function legGrossPnl(legStakeSol: number, fillPrice: number, exitPrice: number): number {
  return legStakeSol * (exitPrice / fillPrice - 1);
}

/** SOL reserved by a PENDING position (stake + buy fee + rent); open ones are already debited. Backend committedSol. */
export function committedSol(positions: readonly Pick<PaperPosition, 'status' | 'stake_sol'>[]): number {
  return roundSol(positions.reduce((sum, p) => (p.status === 'pending' ? sum + p.stake_sol + PAPER_NETWORK_FEE_SOL + PAPER_RENT_SOL : sum), 0));
}

/** Network fees of a position: the buy + one sell per leg. */
export function positionFees(legCount: number): number {
  return roundSol((1 + legCount) * PAPER_NETWORK_FEE_SOL);
}
