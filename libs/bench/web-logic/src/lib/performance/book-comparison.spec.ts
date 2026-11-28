import { describe, expect, it } from 'vitest';
import { DEFAULT_TARGET_TRADES, bookComparisonView, bookProgress, parseBookComparisonRow, parseBookComparisonRows, rateCell } from './book-comparison';
import { bookRow } from '../../testing';

describe('parseBookComparisonRow', () => {
  it('parses a row (numeric text included) of a test book', () => {
    expect(parseBookComparisonRow(bookRow())).toEqual({
      book: 'calm_sl30',
      trades: 12,
      tp_hits: 5,
      sl_hits: 7,
      pnl_sol: 0.034,
      max_drawdown_sol: 0.12,
      worst_losing_streak: 3,
      open_positions: 2,
      target_trades: 50,
    });
  });

  it('rejects non-test books (archived and main included) and invalid counts', () => {
    for (const book of ['main', 'calm_all_x2', 'frenzy_all_x2', 'all_x2', '<script>', 3, null]) expect(parseBookComparisonRow(bookRow({ book }))).toBeNull();
    expect(parseBookComparisonRow(bookRow({ trades: -1 }))).toBeNull();
    expect(parseBookComparisonRow(bookRow({ trades: 1.5 }))).toBeNull();
    expect(parseBookComparisonRow(bookRow({ tp_hits: 13 }))).toBeNull();
    expect(parseBookComparisonRow(bookRow({ sl_hits: 'x' }))).toBeNull();
    expect(parseBookComparisonRow(null)).toBeNull();
  });

  it('defaults the target to 50, missing optional values to 0, and reads a negative drawdown as its magnitude', () => {
    const r = parseBookComparisonRow(bookRow({ target_trades: null, pnl_sol: null, max_drawdown_sol: '-0.2', worst_losing_streak: undefined, open_positions: -3 }));
    expect(r).toMatchObject({ target_trades: DEFAULT_TARGET_TRADES, pnl_sol: 0, max_drawdown_sol: 0.2, worst_losing_streak: 0, open_positions: 0 });
    expect(parseBookComparisonRow(bookRow({ target_trades: 0 }))?.target_trades).toBe(50);
  });

  it('keeps valid rows only, the first of a duplicated book', () => {
    const rows = parseBookComparisonRows([bookRow({ trades: 3, tp_hits: 1, sl_hits: 2 }), bookRow({ trades: 9 }), { junk: true }, bookRow({ book: 'frenzy_sl30' })]);
    expect(rows.map((r) => [r.book, r.trades])).toEqual([
      ['calm_sl30', 3],
      ['frenzy_sl30', 12],
    ]);
    expect(parseBookComparisonRows({})).toEqual([]);
  });
});

describe('rateCell', () => {
  it('never shows a rate prominently under 30 trades: « hits / n » muted', () => {
    expect(rateCell(5, 12)).toEqual({ text: '5 / 12', sub: null, muted: true, tone: null });
    expect(rateCell(10, 29).muted).toBe(true);
    expect(rateCell(0, 0)).toMatchObject({ text: '0 / 0', muted: true });
  });

  it('shows the rate from 30 trades, with « hits / n » underneath', () => {
    expect(rateCell(21, 50)).toEqual({ text: '42,0 %', sub: '21 / 50', muted: false, tone: null });
  });
});

describe('bookProgress', () => {
  it('counts towards the target, capped, with an accessible text', () => {
    const r = parseBookComparisonRow(bookRow());
    expect(bookProgress('calm_sl30', r)).toEqual({ book: 'calm_sl30', label: 'Calme SL −30 %', value: 12, target: 50, pct: 24, done: false, text: '12 trades sur 50' });
    const over = parseBookComparisonRow(bookRow({ trades: 61, tp_hits: 30, sl_hits: 31 }));
    expect(bookProgress('calm_sl30', over)).toMatchObject({ value: 50, pct: 100, done: true, text: '61 trades sur 50' });
    expect(bookProgress('frenzy_sl30', null)).toMatchObject({ label: 'Frénésie SL −30 % (témoin)', value: 0, target: 50, pct: 0, text: '0 trade sur 50' });
  });
});

describe('bookComparisonView', () => {
  it('lays out the three books in a fixed order, « — » for a missing book, Frénésie flagged as control', () => {
    const v = bookComparisonView(parseBookComparisonRows([bookRow({ book: 'frenzy_sl30', pnl_sol: -0.05 }), bookRow()]));
    expect(v.columns.map((c) => [c.book, c.label, c.control, c.row !== null])).toEqual([
      ['calm_sl30', 'Calme −30 %', false, true],
      ['calm_sl40', 'Calme −40 %', false, false],
      ['frenzy_sl30', 'Frénésie −30 %', true, true],
    ]);
    expect(v.rows.map((r) => r.key)).toEqual(['trades', 'tp', 'sl', 'pnl', 'drawdown', 'streak', 'open']);
    const cells = (key: string) => v.rows.find((r) => r.key === key)?.cells ?? [];
    expect(cells('trades').map((c) => c.text)).toEqual(['12', '—', '12']);
    expect(cells('tp').map((c) => c.text)).toEqual(['5 / 12', '—', '5 / 12']);
    expect(cells('sl')[0]).toMatchObject({ text: '7 / 12', muted: true });
    expect(cells('pnl').map((c) => [c.text, c.tone])).toEqual([
      ['+0,034 SOL', 'bull'],
      ['—', null],
      ['−0,05 SOL', 'bear'],
    ]);
    expect(cells('drawdown')[0]!.text).toBe('−0,12 SOL');
    expect(cells('streak')[0]!.text).toBe('3 d’affilée');
    expect(cells('open')[0]!.text).toBe('2');
    expect(v.progress.map((p) => p.value)).toEqual([12, 0, 12]);
    expect(v.hasData).toBe(true);
    expect(v.insufficient).toBe(true);
  });

  it('reads « aucune » for no drawdown / no losing streak, and no data when the server returned nothing', () => {
    const v = bookComparisonView(parseBookComparisonRows([bookRow({ trades: 30, tp_hits: 30, sl_hits: 0, max_drawdown_sol: 0, worst_losing_streak: 0 })]));
    expect(v.rows.find((r) => r.key === 'drawdown')?.cells[0]!.text).toBe('aucune');
    expect(v.rows.find((r) => r.key === 'streak')?.cells[0]!.text).toBe('aucune');
    expect(v.rows.find((r) => r.key === 'tp')?.cells[0]).toMatchObject({ text: '100,0 %', muted: false });
    expect(v.insufficient).toBe(false);
    const empty = bookComparisonView([]);
    expect(empty.hasData).toBe(false);
    expect(empty.progress.map((p) => p.text)).toEqual(['0 trade sur 50', '0 trade sur 50', '0 trade sur 50']);
  });
});
