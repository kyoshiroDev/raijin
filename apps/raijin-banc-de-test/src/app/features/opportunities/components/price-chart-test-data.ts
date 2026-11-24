// Test fixtures for the price chart / token detail specs (not imported by app code).
import { BENCH_ROUTES, type BenchRoute } from '@raijin/bench-contracts';
import { FakeBenchApi, apiError, list, provideFakeBench } from '../../../core/api/bench-api.testing';
import type { TokenRow } from '../../../shared/models/token';

export const CHART_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface QueryResult {
  data: unknown;
  error: unknown;
}

type Responder = () => Promise<QueryResult>;

/** Tables of raijin_bench read by the chart → bench API route. */
export const CHART_ROUTES = {
  token_snapshots: BENCH_ROUTES.tokenSnapshots,
  alert_log: BENCH_ROUTES.alerts,
  paper_positions: BENCH_ROUTES.paperPositions,
} as const;
export type ChartTable = keyof typeof CHART_ROUTES;

/**
 * Bench API double for the chart: `responders[table]` decides the `{ items }` of the matching GET route (default: empty
 * list); `error` simulates an API failure.
 */
export function mockBench(responders: Partial<Record<ChartTable, Responder>> = {}) {
  const api = new FakeBenchApi();
  for (const [table, route] of Object.entries(CHART_ROUTES) as [ChartTable, BenchRoute][]) {
    api.on('GET', route, async () => {
      const r = await (responders[table]?.() ?? Promise.resolve({ data: [], error: null }));
      if (r.error) throw apiError(500);
      return list(Array.isArray(r.data) ? r.data : []);
    });
  }
  const callsOf = (table: ChartTable) => api.callsTo('GET', CHART_ROUTES[table]);
  return { api, providers: provideFakeBench(api), callsOf };
}

export const ok = (data: unknown): Responder => () => Promise.resolve({ data, error: null });

/** Snapshot rows every 2 min over the last `hours`, ending at `end`; `price(i)` defaults to a gentle wave. */
export function snapshotRows(hours: number, end = Date.now(), price: (i: number) => number = (i) => 0.0004 + Math.sin(i / 8) * 0.00003) {
  const n = Math.floor((hours * 60) / 2);
  return Array.from({ length: n + 1 }, (_, i) => ({
    price_usd: price(i),
    captured_at: new Date(end - (n - i) * 2 * 60_000).toISOString(),
  }));
}

export function chartToken(over: Partial<TokenRow> = {}): TokenRow {
  return {
    mint: CHART_MINT,
    symbol: 'GTA6',
    name: 'GTA VI',
    pair_address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    dex_id: 'raydium',
    image_url: null,
    website_url: null,
    x_url: null,
    telegram_url: null,
    price_usd: 0.00042,
    market_cap: 1_200_000,
    liquidity_usd: 85_000,
    liquidity_jup_usd: null,
    volume_24h: 430_000,
    change_1h: 4.2,
    change_24h: -12.5,
    buys_1h: 120,
    sells_1h: 80,
    pair_created_at: null,
    flags: [],
    mint_authority_disabled: true,
    freeze_authority_disabled: true,
    top10_pct: 22.4,
    holder_count: 1520,
    organic_score: 64,
    first_seen_at: new Date(0).toISOString(),
    // Old enough that the live price is never newer than the snapshots unless a test says so.
    updated_at: new Date(0).toISOString(),
    liquidity_dex_usd: null,
    liquidity_gecko_usd: null,
    liquidity_effective_usd: null,
    liquidity_divergence: null,
    roundtrip_cost_pct: null,
    roundtrip_fee_pct: null,
    buy_impact_pct: null,
    lp_locked_pct: null,
    rugcheck_score: null,
    rugcheck_dangers: [],
    price_jup_usd: null,
    price_gecko_usd: null,
    data_confidence: null,
    quote_at: null,
    rugcheck_at: null,
    enriched_at: null,
    narrative: null,
    narrative_rank: null,
    insiders_detected: null,
    creator_rug_history: null,
    ...over,
  };
}
