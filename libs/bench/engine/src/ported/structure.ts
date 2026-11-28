// « Structure cassée » without candles (chore/slim-down). Pure, no I/O.
// Same definition as the former Fibonacci zone 'broken' status (fib.ts, removed): the swing is rebuilt from the
// 5 min / 1 h / 6 h / 24 h % changes (approxSwing), an impulse of at least MIN_IMPULSE is required, and the structure is
// broken when the price sits under the 0.786 retracement of that swing. No zone, plan, TP or invalidation any more.
import type { TokenMetrics } from './types';

/** Retracement under which the structure is considered broken. */
export const BROKEN_RETRACEMENT = 0.786;
/** The swing must be at least +15 % to be meaningful (smaller → never « broken »). */
export const MIN_IMPULSE = 0.15;

export interface Swing {
  low: number;
  high: number;
}

type SwingInput = Pick<TokenMetrics, 'priceUsd' | 'change5m' | 'change1h' | 'change6h' | 'change24h'>;

/** Past prices rebuilt from the % changes; null when the price is unusable. */
export function approxSwing(t: SwingInput): Swing | null {
  const p = t.priceUsd;
  if (!(p > 0)) return null;
  const points = [p];
  for (const c of [t.change5m, t.change1h, t.change6h, t.change24h]) {
    if (Number.isFinite(c) && c > -99.9) points.push(p / (1 + c / 100));
  }
  return { low: Math.min(...points), high: Math.max(...points) };
}

/**
 * true when the price is under the 0.786 retracement of the approximate swing (impulse ≥ 15 %). Unknown / flat data
 * → false (no flag).
 */
export function structureBroken(t: SwingInput): boolean {
  const swing = approxSwing(t);
  const price = t.priceUsd;
  if (!swing || !(swing.low > 0) || !(swing.high > swing.low) || !(price > 0)) return false;
  if ((swing.high - swing.low) / swing.low < MIN_IMPULSE) return false;
  const deep = swing.high - (swing.high - swing.low) * BROKEN_RETRACEMENT;
  return price < deep;
}
