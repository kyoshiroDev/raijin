import { describe, expect, it } from 'vitest';
import {
  ARCHIVED_BOOKS,
  BOOK_LABEL,
  BOOK_SHORT_LABEL,
  TEST_BOOKS,
  isArchivedBook,
  PAPER_BOOKS,
  PAPER_ERRORS,
  STRATEGY_LABEL,
  isPaperStrategy,
  isPaperBook,
  PAPER_POSITION_COLUMNS,
  defaultWallet,
  isInsufficientBalanceError,
  legGrossPnl,
  parsePaperPosition,
  parsePaperPositions,
  parsePaperWallet,
  parsePaperWallets,
  parseSlPct,
  positionFees,
} from './paper';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  book: 'main',
  mint: MINT,
  symbol: 'GTA6',
  strategy: 'half_x2_rest_x3',
  stake_sol: '0.1',
  source: 'manual',
  status: 'open',
  entry_target_price: 1,
  fill_price: 1.02,
  sl_price: 0.7,
  sl_pct: 30,
  created_at: '2026-11-18T10:00:00Z',
  paper_legs: [
    { id: 'lb', position_id: 'p1', size_pct: 50, tp_price: 3, stop_price: 0.7, status: 'open' },
    { id: 'la', position_id: 'p1', size_pct: '50', tp_price: '2', stop_price: 0.7, status: 'tp_hit', exit_price: 1.96 },
  ],
  ...over,
});

describe('paper v2 model', () => {
  it('parses a position with its embedded legs, sorted by target (leg A first), numerics as text included', () => {
    const p = parsePaperPosition(row());
    expect(p).toMatchObject({ id: 'p1', book: 'main', strategy: 'half_x2_rest_x3', stake_sol: 0.1, status: 'open', fill_price: 1.02 });
    expect(p?.legs.map((l) => l.id)).toEqual(['la', 'lb']);
    expect(p?.legs[0]).toMatchObject({ size_pct: 50, tp_price: 2, status: 'tp_hit', exit_price: 1.96 });
  });

  it('rejects positions with an unknown status, book, strategy or a missing stake / entry, and drops invalid legs', () => {
    for (const over of [{ status: 'filled' }, { book: 'other' }, { strategy: 'x10' }, { stake_sol: 0 }, { entry_target_price: null }, { mint: '' }]) {
      expect(parsePaperPosition(row(over))).toBeNull();
    }
    const p = parsePaperPosition(row({ paper_legs: [{ id: 'x', position_id: 'p1', size_pct: 25, status: 'open' }, { id: 'y', position_id: 'p1', size_pct: 100, status: 'won' }] }));
    expect(p?.legs).toEqual([]);
    expect(parsePaperPositions([row(), null, 'x', row({ id: 'p2' })]).map((x) => x.id)).toEqual(['p1', 'p2']);
    expect(parsePaperPositions(null)).toEqual([]);
  });

  it('selects the legs embedded in the positions query', () => {
    expect(PAPER_POSITION_COLUMNS).toContain('paper_legs(id,position_id,size_pct,tp_price,stop_price,status,exit_price,closed_at)');
  });

  it('parses wallets per book, defaulting initial_sol to 1, and a fresh default wallet', () => {
    expect(parsePaperWallet({ book: 'calm_sl40', balance_sol: '0.8', initial_sol: 1, reset_at: null })).toMatchObject({ book: 'calm_sl40', balance_sol: 0.8, initial_sol: 1 });
    expect(parsePaperWallet({ balance_sol: 1.2 })).toMatchObject({ book: 'main', initial_sol: 1 });
    expect(parsePaperWallet({ balance_sol: -1 })).toBeNull();
    expect(parsePaperWallets([{ book: 'main', balance_sol: 1 }, { book: 'main' }])).toHaveLength(1);
    expect(defaultWallet('frenzy_sl30')).toEqual({ book: 'frenzy_sl30', balance_sol: 1, initial_sol: 1, created_at: null, reset_at: null });
  });

  it('reads the main, test and archived books; older archived books (wallets and positions) are ignored', () => {
    expect(PAPER_BOOKS).toEqual(['main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30', 'calm_all_x2', 'frenzy_all_x2']);
    for (const book of ['half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4']) {
      expect(isPaperBook(book)).toBe(false);
      expect(parsePaperPosition(row({ book, strategy: 'all_x2' }))).toBeNull();
      expect(parsePaperWallet({ book, balance_sol: 1 })).toBeNull();
    }
    expect(parsePaperWallet({ book: 'future_book', balance_sol: 1 })).toBeNull();
    expect(parsePaperWallet({ book: 7, balance_sol: 1 })).toBeNull();
  });

  it('knows the three test books and labels them', () => {
    expect(TEST_BOOKS).toEqual(['calm_sl30', 'calm_sl40', 'frenzy_sl30']);
    for (const book of TEST_BOOKS) {
      expect(parsePaperPosition(row({ book, strategy: 'all_x2' }))?.book).toBe(book);
      expect(parsePaperWallet({ book, balance_sol: 1 })?.book).toBe(book);
      expect(isArchivedBook(book)).toBe(false);
    }
    expect(BOOK_LABEL.calm_sl30).toBe('Calme SL −30 %');
    expect(BOOK_LABEL.calm_sl40).toBe('Calme SL −40 %');
    expect(BOOK_LABEL.frenzy_sl30).toBe('Frénésie SL −30 % (témoin)');
    expect(BOOK_SHORT_LABEL.frenzy_sl30).toBe('Frénésie −30 %');
  });

  it('keeps the first Calme vs Frénésie books parseable as archived (read-only)', () => {
    expect(ARCHIVED_BOOKS).toEqual(['calm_all_x2', 'frenzy_all_x2']);
    expect(parsePaperPosition(row({ book: 'calm_all_x2', strategy: 'all_x2' }))?.book).toBe('calm_all_x2');
    expect(parsePaperWallet({ book: 'frenzy_all_x2', balance_sol: 1 })?.book).toBe('frenzy_all_x2');
    expect(isArchivedBook('calm_all_x2')).toBe(true);
    expect(isArchivedBook('frenzy_all_x2')).toBe(true);
    expect(isArchivedBook('main')).toBe(false);
    expect(BOOK_LABEL.calm_all_x2).toContain('archivé');
  });

  it('parses the SL percent strictly (integer 1–90)', () => {
    expect(parseSlPct('30')).toBe(30);
    for (const v of [0, 91, 12.5, 'x', null]) expect(parseSlPct(v)).toBeNull();
  });

  it('maps only an « insufficient » error to the balance message; never shows the raw text', () => {
    expect(isInsufficientBalanceError({ message: 'insufficient paper balance: 0.2 > 0.1' })).toBe(true);
    expect(isInsufficientBalanceError({ hint: 'Solde insuffisant' })).toBe(true);
    expect(isInsufficientBalanceError({ message: 'new row violates row-level security policy' })).toBe(false);
    expect(isInsufficientBalanceError(null)).toBe(false);
    expect(PAPER_ERRORS).toEqual({ insufficient: 'Solde virtuel insuffisant', rejected: 'Position refusée' });
  });

  it('counts one fee for the buy and one per leg exit; gross P&L is stake × (exit / fill − 1)', () => {
    expect(positionFees(2)).toBeCloseTo(0.0006, 12);
    expect(positionFees(1)).toBeCloseTo(0.0004, 12);
    expect(legGrossPnl(0.05, 1.02, 1.96)).toBeCloseTo(0.05 * (1.96 / 1.02 - 1), 12);
  });

  it('still parses older main-book positions of the archived strategies (history), with their 33 / 33 / 34 % legs', () => {
    expect(STRATEGY_LABEL.thirds_x2_x3_x4).toBe('Tiers ×2 / ×3 / ×4');
    expect(isPaperStrategy('thirds_x2_x3_x4')).toBe(true);
    const p = parsePaperPosition(
      row({
        strategy: 'thirds_x2_x3_x4',
        paper_legs: [
          { id: 'c', position_id: 'p1', size_pct: 34, tp_price: 4, status: 'open' },
          { id: 'a', position_id: 'p1', size_pct: 33, tp_price: 2, status: 'tp_hit' },
          { id: 'b', position_id: 'p1', size_pct: '33', tp_price: 3, status: 'open' },
        ],
      }),
    );
    expect(p?.book).toBe('main');
    expect(p?.legs.map((l) => [l.id, l.size_pct])).toEqual([
      ['a', 33],
      ['b', 33],
      ['c', 34],
    ]);
  });
});
