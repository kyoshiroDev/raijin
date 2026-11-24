// Exit slippage on stops (SIMULATION ONLY): how far below (or above) the planned stop a stopped leg was really sold.
import type { PaperBook, PaperLeg, PaperPosition } from '../models/paper';

export interface StopSlippage {
  book: PaperBook;
  /** Stopped legs measured (status sl_hit, stop and exit prices > 0). */
  n: number;
  /** Mean of exit / stop − 1, in PERCENT (negative = sold below the stop); null when n = 0. */
  avgPct: number | null;
  /** Lowest (most unfavourable) value, in PERCENT; null when n = 0. */
  worstPct: number | null;
}

/** exit_price / stop_price − 1 in PERCENT for a leg closed on its stop; null for any other leg or missing prices. */
export function legStopSlippagePct(leg: Pick<PaperLeg, 'status' | 'stop_price' | 'exit_price'>): number | null {
  if (leg.status !== 'sl_hit') return null;
  const { stop_price: stop, exit_price: exit } = leg;
  if (stop === null || exit === null || !Number.isFinite(stop) || !Number.isFinite(exit) || stop <= 0 || exit <= 0) return null;
  return (exit / stop - 1) * 100;
}

/** Aggregate of a list of slippages (percent). */
export function summarizeSlippage(book: PaperBook, values: readonly number[]): StopSlippage {
  if (values.length === 0) return { book, n: 0, avgPct: null, worstPct: null };
  const sum = values.reduce((s, v) => s + v, 0);
  return { book, n: values.length, avgPct: sum / values.length, worstPct: Math.min(...values) };
}

/** One entry per requested book, in that order (books without a stopped leg → n = 0). */
export function stopSlippageByBook(positions: readonly Pick<PaperPosition, 'book' | 'legs'>[], books: readonly PaperBook[]): StopSlippage[] {
  const byBook = new Map<PaperBook, number[]>(books.map((b) => [b, []]));
  for (const p of positions) {
    const values = byBook.get(p.book);
    if (!values) continue;
    for (const leg of p.legs) {
      const v = legStopSlippagePct(leg);
      if (v !== null) values.push(v);
    }
  }
  return books.map((b) => summarizeSlippage(b, byBook.get(b) ?? []));
}
