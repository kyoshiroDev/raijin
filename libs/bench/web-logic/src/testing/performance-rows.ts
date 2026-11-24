// Performance rows (GET /api/performance/*) for the performance specs of the lib and of the app.
export function breakdownRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'scan',
    dimension: 'all',
    bucket: 'all',
    n: 40,
    n_final: 30,
    x2: 12,
    x3: 6,
    x2_before_sl30: 10,
    sl30_before_x2: 20,
    dd50_first: 8,
    median_max_multiple: '1.4500',
    ...over,
  };
}

/** Test builder for performance_by_preset() rows. */
export function presetRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    preset: 'young_calm',
    segment: 'all',
    signals: 50,
    labelled: 40,
    x2_before_sl30: 12,
    sl30_before_x2: 20,
    sim_pnl_sol: '0.3640',
    trades: 18,
    paper_pnl_sol: '-0.0420',
    paper_open: 3,
    ...over,
  };
}

/** One paper_book_comparison() row (calm_sl30 by default, 12 trades). */
export function bookRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    book: 'calm_sl30',
    trades: 12,
    tp_hits: 5,
    sl_hits: 7,
    pnl_sol: '0.034',
    max_drawdown_sol: 0.12,
    worst_losing_streak: 3,
    open_positions: 2,
    target_trades: 50,
    ...over,
  };
}
