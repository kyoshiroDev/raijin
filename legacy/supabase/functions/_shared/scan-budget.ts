// Run-wide time budget and overlap guard of scan-tokens (security review M1 of feat/more-sources).
// pg_net gives up after 55 s and the next cron call comes 2 min after the previous one: a scan slowed down by a slow
// (not failing) upstream must still return well before that, and two scans must never run at the same time (both
// would pass the alert_log dedup before either writes → duplicate alerts; per-worker pacers → Jupiter 429s).
// Pure (injectable clock and timers), unit tested in scan_budget_test.ts.

/** Milestones from the scan start (ms). Worst case ≈ pushAbortMs + ~2 s of DB writes ≈ 45 s. */
export const SCAN_BUDGET = {
  /** No new candidate-source request (DexScreener lists, GeckoTerminal young pools, Jupiter recent). */
  collectStopMs: 18_000,
  /** In-flight candidate-source requests are cancelled. */
  collectAbortMs: 22_000,
  /** No new DexScreener /tokens/v1 round. */
  pairsStopMs: 28_000,
  /** No new Jupiter audit request. */
  auditsStopMs: 30_000,
  /** No new DexScreener request for the tracked mints outside the kept set (alert / paper positions). */
  trackingStopMs: 34_000,
  /** Every external request of the scan (except Web Push) is cancelled. */
  abortMs: 38_000,
  /** No new Web Push request (alerts and follow-ups). */
  pushStopMs: 40_000,
  /** In-flight Web Push requests time out by then. */
  pushAbortMs: 43_000,
} as const;

export type BudgetMilestone = keyof typeof SCAN_BUDGET;

export interface ScanBudgetClock {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ScanBudget {
  startedAt: number;
  /** Absolute time (ms) of a milestone. */
  at(m: BudgetMilestone): number;
  /** true once the milestone is reached. */
  passed(m: BudgetMilestone): boolean;
  /** ms left before the milestone (≥ 0). */
  left(m: BudgetMilestone): number;
  /** Aborted at abortMs: pass it to every external fetch of the scan. */
  signal: AbortSignal;
  /** Aborted at collectAbortMs (or abortMs): candidate-source requests. */
  collectSignal: AbortSignal;
  dispose(): void;
}

export function createScanBudget(startedAt: number, clock: ScanBudgetClock = {}): ScanBudget {
  const now = clock.now ?? Date.now;
  const setTimer = clock.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = clock.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const at = (m: BudgetMilestone) => startedAt + SCAN_BUDGET[m];
  const scan = new AbortController();
  const collect = new AbortController();
  const handles = [
    setTimer(() => scan.abort(), Math.max(0, at('abortMs') - now())),
    setTimer(() => collect.abort(), Math.max(0, at('collectAbortMs') - now())),
  ];
  scan.signal.addEventListener('abort', () => collect.abort(), { once: true });
  return {
    startedAt,
    at,
    passed: (m) => now() >= at(m),
    left: (m) => Math.max(0, at(m) - now()),
    signal: scan.signal,
    collectSignal: collect.signal,
    dispose: () => handles.forEach((h) => clearTimer(h)),
  };
}

/** A scan_runs row as read by the overlap guard. */
export interface RunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
}

/** Window in which an unfinished scan_runs row counts as « running » (a crashed run stops blocking after it). */
export const OVERLAP_WINDOW_MS = 90_000;

/**
 * Overlap guard: true when ANOTHER, OLDER run (smaller identity id) started less than OVERLAP_WINDOW_MS ago and has
 * not finished. Each scan first inserts its own scan_runs row, then reads the recent unfinished ones: of two scans
 * starting together, the one with the smaller id proceeds and the other skips (never both proceed; at worst, if
 * a read fails, the scan proceeds as before). Invalid rows are ignored.
 */
export function isOverlapping(myId: number, rows: unknown, nowMs: number, windowMs = OVERLAP_WINDOW_MS): boolean {
  if (!Array.isArray(rows)) return false;
  for (const r of rows as Partial<RunRow>[]) {
    if (!r || typeof r.id !== 'number' || typeof r.started_at !== 'string') continue;
    if (r.id >= myId || r.finished_at !== null) continue;
    const started = Date.parse(r.started_at);
    if (Number.isFinite(started) && nowMs - started < windowMs && started <= nowMs + 5_000) return true;
  }
  return false;
}
