// Test builders for paper positions (used by the portfolio specs only).
import type { LegStatus, PaperLeg, PaperPosition } from '../../shared/models/paper';

export const TEST_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let seq = 0;

export function testLeg(over: Partial<PaperLeg> = {}): PaperLeg {
  return { id: `l${++seq}`, position_id: 'p', size_pct: 100, tp_price: 2, stop_price: 0.7, status: 'open', exit_price: null, closed_at: null, ...over };
}

export function testPosition(over: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: `p${++seq}`,
    book: 'main',
    mint: TEST_MINT,
    symbol: 'GTA6',
    strategy: 'all_x2',
    stake_sol: 0.1,
    source: 'manual',
    status: 'open',
    entry_target_price: 1,
    fill_price: 1,
    sl_price: 0.7,
    sl_pct: 30,
    custom_tp_price: null,
    expires_at: null,
    created_at: '2026-11-10T00:00:00Z',
    filled_at: '2026-11-10T00:00:00Z',
    closed_at: null,
    pnl_sol: null,
    fees_sol: null,
    legs: [testLeg()],
    ...over,
  };
}

/** A closed trade at minute `minute` with a P&L and one leg in `legStatus`. */
export function testClosed(minute: number, pnl: number, legStatus: LegStatus, over: Partial<PaperPosition> = {}): PaperPosition {
  return testPosition({
    status: 'closed',
    pnl_sol: pnl,
    closed_at: new Date(Date.UTC(2026, 10, 10, 0, minute)).toISOString(),
    legs: [testLeg({ status: legStatus })],
    ...over,
  });
}
