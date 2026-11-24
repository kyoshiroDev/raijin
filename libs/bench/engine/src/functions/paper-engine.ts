// Edge Function: paper-engine v2 (feat/paper-trading-v2). SIMULATION ONLY: no wallet, no key, no signature, no
// transaction. Called every 2 minutes at odd minutes by pg_cron ('1-59/2 * * * *', job raijin-paper, see
// supabase/sql/schedule_paper.sql), i.e. ~20 s after the scan of the previous even minute has written its snapshots.
// 1. Loads the active paper positions with their legs (pending / open, ≤ 1000 oldest first, service_role), then
//    orders them fairly across users (round robin, each user oldest first) and keeps ≤ 500.
// 2. Latest price per mint from token_snapshots (scan or forced 'tracking' rows), fresh < 6 min; otherwise no tick
//    and only an expiry can happen.
// 3. Positions that step() would fill / whose legs it would close get a Jupiter QUOTE for their own amount (buy:
//    stake; exit: value of the closing legs, see _shared/paper-engine.ts sellLamports), one call every 2.1 s from
//    t = 10 s (enrich-tokens' round trips run at the same minute first), ≤ 10 calls, none after 34 s, aborted at
//    38 s, stop on 429. Not quoted → impact unknown → step() uses +2 %.
// 4. step() per position → rpc paper_apply_v2 (status guard = optimistic, legs + wallet delta in the same
//    transaction), 4 in parallel, none started after 44 s (the rest next run: idempotent).
// A pending 'next_tick' position (« Calme » / « Frénésie » auto-paper) is filled at the FIRST scan snapshot captured
// strictly after its creation, whatever the price (_shared/paper-engine.ts nextTickEntries; step() checks the rest).
// Every tick here is a SCAN tick. Strategy all_x2 only; books main / calm_sl30 / calm_sl40 / frenzy_sl30
// (feat/calm-sl-test) plus calm_all_x2 / frenzy_all_x2, archived but run until their last positions close (positions of
// the books / strategies archived by chore/slim-down were cancelled by migration 20261121020000 and are skipped).
// Never throws; logs carry counts only. Response { pending, open, filled, closed, legs, moved, expired, … , ms }.
// Deploy: supabase functions deploy paper-engine --no-verify-jwt
// Secrets: CRON_SECRET (required, same as scan-tokens), JUP_API_BASE, JUP_API_KEY (optional).
import type { SupabaseClient } from '../db/bench-db';
import { mapLimit, resolveJupBase } from '../ported/enrich-clients';
import { step } from '../ported/paper';
import {
  applyArgsV2,
  type ApplyArgsV2,
  type BaseTick,
  buildTicks,
  ENGINE_BUDGET,
  ENGINE_FETCH_ROWS,
  ENGINE_POSITION_SELECT,
  type EnginePosition,
  fairOrder,
  MAX_ENGINE_POSITIONS,
  nextTickEntries,
  parseEnginePositions,
  positionMints,
  quoteCandidates,
  runQuotes,
  SNAPSHOT_CHUNK,
  SNAPSHOT_ROWS_MAX,
  stepLabel,
  TICK_FRESH_MS,
  tickForPosition,
} from '../ported/paper-engine';

const APPLY_CONCURRENCY = 4;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export interface PaperEngineDeps {
  readonly db: SupabaseClient;
  /** `JUP_API_BASE`, `JUP_API_KEY` (lues dans les `BENCH_*` du banc). */
  readonly env: (name: string) => string | undefined;
}

/**
 * Port Node de l'Edge Function `paper-engine` (job `paper-engine`, `1-59/2 * * * *`). SIMULATION uniquement : aucun
 * ordre réel, aucune signature. Corps inchangé ; `Response.json(stats)` devient la valeur renvoyée.
 */
export async function runPaperEngine(deps: PaperEngineDeps) {
  const JUP_BASE = resolveJupBase(deps.env('JUP_API_BASE'));
  const JUP_KEY = deps.env('JUP_API_KEY');
  const started = Date.now();
  const stats = {
    pending: 0, open: 0, loaded: 0, filled: 0, closed: 0, legs: 0, moved: 0, expired: 0,
    ticks: 0, quotes: 0, rateLimited: false, stale: 0, failed: 0, deferred: 0, ms: 0,
  };
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), ENGINE_BUDGET.abortMs);
  try {
    const db = deps.db;

    const { data, error } = await db
      .from('paper_positions')
      .select(ENGINE_POSITION_SELECT)
      .in('status', ['pending', 'open'])
      .order('created_at', { ascending: true })
      .limit(ENGINE_FETCH_ROWS);
    if (error) throw new Error(`select paper_positions: ${error.message}`);
    const parsed = parseEnginePositions(data);
    stats.loaded = parsed.length;
    const positions: EnginePosition[] = fairOrder(parsed, MAX_ENGINE_POSITIONS);
    stats.pending = positions.filter((p) => p.status === 'pending').length;
    stats.open = positions.length - stats.pending;
    if (positions.length === 0) {
      stats.ms = Date.now() - started;
      return stats;
    }

    // Latest fresh price per mint (scan snapshots, or forced 'tracking' snapshots for mints outside the scan filters).
    const now = Date.now();
    const mints = positionMints(positions);
    const since = new Date(now - TICK_FRESH_MS).toISOString();
    const snapRows: unknown[] = [];
    for (let i = 0; i < mints.length; i += SNAPSHOT_CHUNK) {
      const { data: snaps, error: snapErr } = await db
        .from('token_snapshots')
        .select('mint, price_usd, captured_at')
        .in('mint', mints.slice(i, i + SNAPSHOT_CHUNK))
        .gte('captured_at', since)
        .order('captured_at', { ascending: false })
        .limit(SNAPSHOT_ROWS_MAX);
      if (snapErr) console.warn('paper snapshots', snapErr.message.slice(0, 200)); // no tick: expiries only
      else snapRows.push(...(snaps ?? []));
    }
    const ticks: Map<string, BaseTick> = buildTicks(snapRows, now);
    stats.ticks = ticks.size;
    // next_tick entries: first scan snapshot after created_at (else the latest scan tick, which step() rejects when it
    // is not after the creation).
    const entries = nextTickEntries(snapRows, positions, now, TICK_FRESH_MS);
    const scanTick = (p: EnginePosition): BaseTick | undefined => {
      const base = entries.get(p.id) ?? ticks.get(p.mint);
      return base ? { ...base, source: 'scan' } : undefined;
    };

    // Jupiter quotes for the positions that would trigger (budget-limited; unknown impact → +2 % in step()).
    const candidates = quoteCandidates(positions, ticks, now);
    const quoted = await runQuotes(candidates, {
      jupBase: JUP_BASE,
      headers: JUP_KEY ? { 'x-api-key': JUP_KEY } : undefined,
      signal: controller.signal,
      startAt: started + ENGINE_BUDGET.quoteStartMs,
      stopAt: started + ENGINE_BUDGET.quoteStopMs,
    });
    stats.quotes = quoted.calls;
    stats.rateLimited = quoted.rateLimited;

    // Step with the time of the decision (expiries) and apply one position per rpc (atomic, optimistic).
    const decidedAt = Date.now();
    const work = positions
      .map((p) => applyArgsV2(p, step(p, tickForPosition(p, scanTick(p), quoted.impacts, decidedAt), decidedAt)))
      .filter((a): a is ApplyArgsV2 => a !== null);
    const results = await mapLimit(
      work,
      { concurrency: APPLY_CONCURRENCY, delayMs: 0, deadline: started + ENGINE_BUDGET.applyStopMs },
      async (args) => {
        const { data: balance, error: applyErr } = await db.rpc('paper_apply_v2', args);
        if (applyErr) {
          console.warn('paper apply', applyErr.code ?? '', applyErr.message.slice(0, 120));
          return 'failed' as const;
        }
        return balance === null ? ('stale' as const) : ('applied' as const);
      },
    );
    results.forEach((r, i) => {
      if (r === undefined) stats.deferred++;
      else if (r === 'failed') stats.failed++;
      else if (r === 'stale') stats.stale++;
      else stats[stepLabel(work[i]!)]++;
    });
  } catch (e) {
    console.error('paper-engine failed', errText(e));
    stats.failed++;
  } finally {
    clearTimeout(abortTimer);
  }
  stats.ms = Date.now() - started;
  console.log('paper', JSON.stringify(stats));
  return stats;
}
