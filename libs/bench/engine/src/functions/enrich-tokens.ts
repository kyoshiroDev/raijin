// Edge Function: enrich-tokens
// Called by pg_cron 1 minute after each scan ('1-59/2 * * * *', see supabase/sql/schedule_enrich.sql).
// Cross-source data for the fresh tokens (young first, then 1 h volume), then a re-flag (chore/slim-down: no score):
//   - GeckoTerminal multi pools (1 call, top 30 pairs): liquidity + price;
//   - RugCheck summary (top 30, cached 30 min via rugcheck_at): LP locked, raw score, 'danger' risks;
//   - Jupiter round trip 0.1 SOL -> token -> SOL (top 15): real trading cost and buy impact.
// Writes with UPDATE (never upsert) only the enrichment + flag columns (buildEnrichmentUpdate).
// Sends no notification. Run budget (createRunBudget): no new task after 30 s, no sell leg after 34 s, every
// in-flight request aborted at 40 s; whatever completed is still written (pg_net timeout: 55 s).
// Deploy: supabase functions deploy enrich-tokens --no-verify-jwt
// Secrets: CRON_SECRET (required, same as scan-tokens), JUP_API_BASE, JUP_API_KEY (optional).
import type { SupabaseClient } from '../db/bench-db';
import { finalFlags, rankYoungFirst } from '../ported/final-score';
import {
  buildEnrichmentUpdate,
  type EnrichResults,
  rowToMetrics,
  TOKEN_ROW_SELECT,
  type TokenRow,
} from '../ported/normalize';
import {
  createRunBudget,
  fetchGeckoPools,
  fetchRoundTrip,
  fetchRugcheck,
  type GeckoInfo,
  mapLimit,
  type RoundTrip,
  type RugInfo,
} from '../ported/enrich-clients';
import type { TokenMetrics } from '../ported/types';

const FRESH_MS = 10 * 60_000;
const TOP_N = 30; // GeckoTerminal multi max per call, and RugCheck candidates
/** Fresh rows read (most active first) before the young-first ranking picks the TOP_N. */
const READ_N = 100;
const QUOTE_TOP_N = 15;
const RUGCHECK_CACHE_MS = 30 * 60_000;
const UPDATE_CONCURRENCY = 6;

export interface EnrichTokensDeps {
  readonly db: SupabaseClient;
  /** Variables de l'ancienne fonction (`JUP_API_BASE`, `JUP_API_KEY`), lues dans les `BENCH_*` du banc. */
  readonly env: (name: string) => string | undefined;
}

export type EnrichTokensStats =
  | { tokens: number; gecko: number; rugcheck: number; quotes: number; ms: number }
  | { tokens: number; stale: number; gecko: number; rugcheck: number; quotes: number; ms: number };

/**
 * Port Node de l'Edge Function `enrich-tokens` (job `enrich-tokens`, `1-59/2 * * * *`). Corps inchangé ; le contrôle
 * `x-cron-secret` disparaît (appel direct par BullMQ), `Response.json(stats)` devient la valeur renvoyée et la réponse
 * 500 une exception (ligne `job_runs` en échec).
 */
export async function runEnrichTokens(deps: EnrichTokensDeps): Promise<EnrichTokensStats> {
  const JUP_BASE = deps.env('JUP_API_BASE') ?? undefined; // validated by resolveJupBase (Jupiter hosts only)
  const JUP_KEY = deps.env('JUP_API_KEY');
  const started = Date.now();
  const db = deps.db;

  try {
    const { data, error } = await db
      .from('tokens')
      .select(TOKEN_ROW_SELECT)
      .gte('updated_at', new Date(started - FRESH_MS).toISOString())
      .order('volume_1h', { ascending: false, nullsFirst: false })
      .order('liquidity_usd', { ascending: false })
      .limit(READ_N);
    if (error) throw new Error(`select tokens: ${error.message}`);

    const now = Date.now();
    const parsed: { row: TokenRow; t: TokenMetrics }[] = [];
    for (const row of (data ?? []) as unknown as TokenRow[]) {
      const t = rowToMetrics(row, now);
      if (t) parsed.push({ row, t });
    }
    // Young tokens first (« Jeune calme » needs the round trip, RugCheck and GeckoTerminal liquidity), then 1 h volume.
    const order = new Map(rankYoungFirst(parsed.map((p) => p.t)).map((t, i) => [t.mint, i]));
    const items = [...parsed].sort((a, b) => (order.get(a.t.mint) ?? 0) - (order.get(b.t.mint) ?? 0)).slice(0, TOP_N);
    if (items.length === 0) return { tokens: 0, gecko: 0, rugcheck: 0, quotes: 0, ms: Date.now() - started };

    const budget = createRunBudget(started);
    const deadline = budget.stopNewAt;
    const jupOpts = {
      jupBase: JUP_BASE,
      headers: JUP_KEY ? { 'x-api-key': JUP_KEY } : undefined,
      signal: budget.signal,
      sellDeadline: budget.sellDeadline,
    };
    const rugTargets = items.filter(({ row }) => {
      const at = typeof row.rugcheck_at === 'string' ? Date.parse(row.rugcheck_at) : NaN;
      return !Number.isFinite(at) || now - at > RUGCHECK_CACHE_MS;
    });
    const quoteTargets = items.slice(0, QUOTE_TOP_N);

    // Three different hosts: run in parallel, each with its own rate limit.
    // GeckoTerminal ~30/min shared with scan-tokens' young-pool sources and label-outcomes: 1 call per run.
    // RugCheck: x-rate-limit-limit 15 per ~1 s window observed: 3 in flight, 300 ms pause.
    // Jupiter lite-api: 2 round trips in flight (2 sequential quotes each), 300 ms pause.
    const [gecko, rugs, quotes] = await Promise.all([
      fetchGeckoPools(items.map(({ t }) => ({ mint: t.mint, pairAddress: t.pairAddress })), { signal: budget.signal }),
      mapLimit(rugTargets, { concurrency: 3, delayMs: 300, deadline }, ({ t }) => fetchRugcheck(t.mint, { signal: budget.signal })),
      mapLimit(quoteTargets, { concurrency: 2, delayMs: 300, deadline }, ({ t }) => fetchRoundTrip(t.mint, jupOpts)),
    ]).finally(() => budget.dispose());
    const aborted = budget.signal.aborted;

    const rugByMint = new Map<string, RugInfo | null | undefined>(rugTargets.map(({ t }, i) => [t.mint, rugs[i]]));
    // undefined = not started before the deadline: columns left untouched.
    const quoteByMint = new Map<string, RoundTrip | null | undefined>(quoteTargets.map(({ t }, i) => [t.mint, quotes[i]]));

    const writeAt = Date.now();
    const updates = items.map(({ row, t }) => {
      const g: GeckoInfo | undefined = gecko.get(t.pairAddress);
      const rug = rugByMint.get(t.mint) ?? undefined; // failed (null) → keep the cached value, retried next run
      const quote = quoteByMint.get(t.mint); // undefined = not quoted this run, null = quoted but failed
      const results: EnrichResults = { gecko: g ?? null, rug, quote };
      // Same flags as scan-tokens (« Structure cassée » from the persisted % changes), with the fresh enrichment.
      const merged: TokenMetrics = {
        ...t,
        liquidityGeckoUsd: g?.liquidityUsd ?? null,
        priceGeckoUsd: g?.priceUsd ?? null,
        ...(rug
          ? { lpLockedPct: rug.lpLockedPct, rugcheckScore: rug.score, rugcheckDangers: rug.dangers }
          : {}),
        ...(quote !== undefined
          ? {
            roundtripCostPct: quote?.roundtripCostPct ?? null,
            roundtripFeePct: quote?.roundtripFeePct ?? null,
            buyImpactPct: quote?.buyImpactPct ?? null,
          }
          : {}),
      };
      // Optimistic concurrency: only write if scan-tokens has not upserted this row since we read it,
      // otherwise our flags (computed on the old metrics) would overwrite the fresh ones.
      const readAt = typeof (row as { updated_at?: unknown }).updated_at === 'string'
        ? (row as unknown as { updated_at: string }).updated_at
        : null;
      return { mint: t.mint, readAt, payload: buildEnrichmentUpdate(results, finalFlags(merged), writeAt) };
    });

    let failed = 0;
    let stale = 0;
    await mapLimit(updates, { concurrency: UPDATE_CONCURRENCY, delayMs: 0, deadline: Number.POSITIVE_INFINITY }, async (u) => {
      let q = db.from('tokens').update(u.payload).eq('mint', u.mint);
      if (u.readAt) q = q.eq('updated_at', u.readAt);
      const { data: written, error: upErr } = await q.select('mint');
      if (upErr) {
        failed++;
        console.warn('enrich update', upErr.message.slice(0, 200));
      } else if (!written || written.length === 0) {
        stale++; // row re-scanned meanwhile: the next enrich run picks it up with the fresh data
      }
    });

    const stats = {
      tokens: updates.length - failed - stale,
      stale,
      gecko: gecko.size,
      rugcheck: rugs.filter((r) => r).length,
      quotes: quotes.filter((q) => q).length,
      ms: Date.now() - started,
    };
    console.log('enrich', JSON.stringify({ ...stats, rugTargets: rugTargets.length, failed, aborted }));
    return stats;
  } catch (e) {
    console.error('enrich failed', (e instanceof Error ? e.message : String(e)).slice(0, 500));
    throw new Error('Enrich failed', { cause: e });
  }
}
