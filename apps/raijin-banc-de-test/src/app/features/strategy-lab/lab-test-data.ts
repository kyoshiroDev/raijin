// Test fixtures of the laboratory (rows as the bench API returns them, and a bench API double).
import { BENCH_ROUTES, type BenchErrorCode } from '@raijin/bench-contracts';
import { vi } from 'vitest';
import { FakeBenchApi, apiError, list, provideFakeBench } from '../../core/api/bench-api.testing';

/** `error` : `{ status, code?, message? }` of the simulated API failure. */
export interface QueryResult {
  data: unknown;
  error: unknown;
}

/** One read of the laboratory, described by the table it serves and its filters. */
export interface QueryCall {
  table: 'backtest_runs' | 'backtest_results';
  filters: Record<string, unknown>;
}

function fail(error: unknown): never {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { status?: number; code?: BenchErrorCode; message?: string };
  throw apiError(e.status ?? 500, e.code ?? null, e.message);
}

export const runRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 7,
  status: 'done',
  trigger: 'nightly',
  data_version: { n_detections: 600, cutoff: '2026-11-10T00:00:00Z', max_detected_at: '2026-11-18T22:00:00Z', resolutions: { '1m': 120, '5m': 300, '15m': 280 } },
  n_detections: 600,
  n_variants: 1920,
  n_distinct_variants: 1440,
  progress: 1,
  error: null,
  created_at: '2026-11-19T02:40:00Z',
  started_at: '2026-11-19T02:40:30Z',
  finished_at: '2026-11-19T03:10:00Z',
  ...over,
});

/** backtest_runs.summary of a run with a candidate (docs/contracts/lab-v2.md §3). */
export const candidateSummary = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  verdict: 'candidate',
  text: 'Stratégie candidate : …',
  run_at: '2026-11-19T03:10:00Z',
  n_detections: 600,
  n_events: 140,
  candidate: {
    preset: 'young_calm',
    exit: 'all_x2',
    sl_pct: 30,
    breakeven: false,
    time_exit_h: 0,
    delay_min: 2,
    narrative: 'all',
    test: { trades: 42, avg_net_pct: 12.5, ci_low: 2.1, ci_high: 22.4 },
    train: { trades: 98, avg_net_pct: 9.1 },
  },
  ...over,
});

export const resultRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  run_id: 7,
  preset: 'young_calm',
  exit: 'all_x2',
  sl_pct: 30,
  breakeven: false,
  time_exit_h: 0,
  delay_min: 2,
  narrative: 'all',
  split: 'test',
  trades: 42,
  win_rate: 0.45,
  avg_win_pct: 60,
  avg_loss_pct: -28,
  avg_net_pct: 12.5,
  avg_net_sol: 0.0125,
  profit_factor: '1.85',
  max_drawdown_sol: 0.35,
  worst_losing_streak: 5,
  ci_low: 2.1,
  ci_high: 22.4,
  ci_contains_zero: false,
  open_at_end: 1,
  retained: true,
  robust: true,
  ...over,
});

/** Both splits of one variant (train metrics slightly different). */
export const variantRows = (over: Record<string, unknown> = {}, trainOver: Record<string, unknown> = {}): Record<string, unknown>[] => [
  resultRow({ ...over, split: 'train', trades: 98, avg_net_pct: 9.1, avg_net_sol: 0.0091, ci_low: null, ci_high: null, ci_contains_zero: null, ...trainOver }),
  resultRow({ ...over, split: 'test' }),
];

/** `GET /api/lab/backfill` categories (two with rows due, one up to date). */
export const backfillRows = (): Record<string, unknown>[] => [
  { id: 'scan_labels', done: 1000, total: 1392, due_now: 392, last_24h: 300, rows_per_hour: 12 },
  { id: 'candles_1m', done: 5000, total: 6392, due_now: 1392, last_24h: 400, rows_per_hour: 18 },
  { id: 'preset_labels', done: 40, total: 40, due_now: 0, last_24h: 10 },
];

/** Handler of the other laboratory routes (gauge, run request) by route; a missing route answers 404. */
export const rpcByName =
  (answers: Partial<Record<string, () => Promise<QueryResult>>>) =>
  (name: string): Promise<QueryResult> =>
    answers[name]?.() ?? Promise.resolve({ data: null, error: { status: 404, code: 'NOT_FOUND' } });

/**
 * Bench API double: `GET lab/runs` and `GET lab/runs/:id/results` are answered by `handler` (as a `QueryCall`),
 * `GET lab/backfill` and `POST lab/runs` by `rpc(route)`. The gauge answers `data` as the whole body.
 */
export function fakeBench(handler: (call: QueryCall) => Promise<QueryResult>, rpc: (name: string) => Promise<QueryResult> = async () => ({ data: null, error: null })) {
  const calls: QueryCall[] = [];
  const rpcSpy = vi.fn(rpc);
  const read = async (call: QueryCall) => {
    calls.push(call);
    const r = await handler(call);
    if (r.error) fail(r.error);
    return list(Array.isArray(r.data) ? r.data : []);
  };
  const other = async (route: string) => {
    const r = await rpcSpy(route);
    if (r.error) fail(r.error);
    return r.data;
  };
  const api = new FakeBenchApi()
    .on('GET', BENCH_ROUTES.labRuns, (c) => read({ table: 'backtest_runs', filters: c.query['status'] === undefined ? {} : { status: c.query['status'] } }))
    .on('GET', BENCH_ROUTES.labRunResults, (c) => read({ table: 'backtest_results', filters: { run_id: c.params['id'], retained: c.query['retained'] } }))
    .on('GET', BENCH_ROUTES.labBackfill, () => other(BENCH_ROUTES.labBackfill))
    .on('POST', BENCH_ROUTES.labRuns, () => other(BENCH_ROUTES.labRuns));
  return { api, providers: provideFakeBench(api), calls, rpc: rpcSpy };
}
