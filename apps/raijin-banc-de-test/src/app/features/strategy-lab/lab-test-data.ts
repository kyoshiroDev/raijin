// Test fixtures of the laboratory (rows as the bench API returns them, and a bench API double).
import { BENCH_ROUTES, type BenchErrorCode } from '@raijin/bench-contracts';
import { vi } from 'vitest';
export { backfillRows, candidateSummary, resultRow, runRow, variantRows } from '@raijin/bench-web-logic/testing';
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
