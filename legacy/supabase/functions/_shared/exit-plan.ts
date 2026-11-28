// Pure exit plan of an alert. No I/O.
// chore/slim-down: the Fibonacci plan (+20 % capped by TP1 / −20 % tightened by the invalidation) is gone with the
// zones. The only alert preset (« Jeune calme ») uses a FIXED plan: target = entry × 2, stop = entry × 0.7
// (rr = 3.333), the same levels as its paper book (all_x2) and the alert tracking (alert_log target / stop).

export const TARGET_MULTIPLE = 2;
export const STOP_MULTIPLE = 0.7;
/** alert_log price bound. */
export const PLAN_PRICE_MAX = 1e12;

export interface ExitPlan {
  entry: number;
  target: number;
  stop: number;
  /** Reward / risk, rounded to 3 decimals. */
  rr: number;
  /** (target / entry − 1) × 100, PERCENT (> 0). */
  targetPct: number;
  /** (stop / entry − 1) × 100, PERCENT (< 0). */
  stopPct: number;
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Fixed exit plan: target = entry × 2 (+100 %), stop = entry × 0.7 (−30 %), rr = 3.333. null when the entry is unusable
 * (≤ 0, non-finite) or the target would reach the alert_log bound (1e12).
 */
export function fixedExitPlan(entry: number | null | undefined): ExitPlan | null {
  if (!finite(entry) || entry <= 0) return null;
  const target = entry * TARGET_MULTIPLE;
  const stop = entry * STOP_MULTIPLE;
  if (!(target < PLAN_PRICE_MAX) || !(stop > 0) || !(stop < entry)) return null;
  const rr = Math.round(((target - entry) / (entry - stop)) * 1000) / 1000;
  return {
    entry,
    target,
    stop,
    rr,
    targetPct: (TARGET_MULTIPLE - 1) * 100,
    stopPct: (STOP_MULTIPLE - 1) * 100,
  };
}
