// Test builders for the performance rows (GET /api/performance/*, performance specs only).
import { BENCH_ROUTES, type BenchRoute } from '@raijin/bench-contracts';
import { FakeBenchApi, apiError, list } from '../../core/api/bench-api.testing';
export { bookRow, breakdownRow, presetRow } from '@raijin/bench-web-logic/testing';

/** Answer of a performance route: `data` = items; `error` = failure (`{ status: 404 }` = route not deployed). */
export interface PerfResult {
  data: unknown;
  error: unknown;
}

/** Fake API for the three performance routes; `rpc(route)` gives each answer (recorded, like the calls). */
export function performanceApi(rpc: (route: BenchRoute) => PerfResult | Promise<PerfResult>): FakeBenchApi {
  const api = new FakeBenchApi();
  for (const route of [BENCH_ROUTES.performanceBreakdown, BENCH_ROUTES.performancePresets, BENCH_ROUTES.performanceBooks]) {
    api.on('GET', route, async () => {
      const r = await rpc(route);
      if (r.error) throw apiError((r.error as { status?: number }).status === 404 ? 404 : 500);
      return list(Array.isArray(r.data) ? r.data : []);
    });
  }
  return api;
}
