// Edge Function: scan-tokens
// Called every 2 minutes by pg_cron (see supabase/sql/schedule_cron.sql).
// Deploy: supabase functions deploy scan-tokens --no-verify-jwt
// Secrets: CRON_SECRET (required), SCAN_KEYWORDS (optional, "gta,ai agent"),
//          MIN_MARKET_CAP, MIN_LIQUIDITY (optional), JUP_API_BASE, JUP_API_KEY (optional),
//          VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (optional: Web Push alerts are skipped without them)
// chore/slim-down (migration 20261121020000_slim_down.sql, apply it BEFORE deploying): no score /100, no Fibonacci
// zone / candles / plan, no ×3 model, no Momentum / Strict / « Jeune & fort », no fast tracking, no watchlist.
// Pipeline:
//   1. candidate sources (_shared/source-clients.ts): DexScreener lists + keywords, GeckoTerminal young pools
//      (trending 1 h, PumpSwap, new pools: ≤ 4 calls, pools < 24 h), Jupiter « recent » (1 call), young watch (DB),
//      pump.fun → PumpSwap / Raydium migrations; scan_runs.source_counts = seen / kept / unique / young / youngKept
//      per source;
//   2. DexScreener pairs, MIN_MARKET_CAP / MIN_LIQUIDITY filters, age quota (every token < 24 h and every tracked mint
//      kept, old tokens keep the best 1 h-volume slots, ≥ 40 % young when possible);
//   3. persisted enrichment merged (enrich-tokens), Jupiter audits (young first, then 1 h volume: top 40), flags +
//      consensus (_shared/final-score.ts finalFlags, « Structure cassée » without candles);
//   4. features of the first detection (signal_outcomes), narrative ranks, spark_6h (rpc x3_snapshot_history),
//      market context (sol_usd / eur_usd), point-in-time snapshot columns, preset_signals (young_calm / young_frenzy);
//   5. « Jeune calme » alerts (notify.ts), « Calme » / « Frénésie » auto-paper, 7-day alert tracking + follow-ups,
//      forced pricing of the paper / alert positions outside the kept set.
// Security review (M1/L1/L2): one ScanBudget per scan (_shared/scan-budget.ts) bounds every phase and cancels all
// external requests at 38 s (worst case ≈ 45 s, under pg_net's 55 s); an overlap guard skips the scan while an older
// one is still running; every external GET goes through enrich-clients' getJson (SOURCE_HOSTS, no redirect, body cap).
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { constantTimeEqual } from '../_shared/sanitize.ts';
import { isSolanaAddress } from '../_shared/solana.ts';
import {
  bestPairPerToken,
  ENRICHMENT_SELECT,
  enrichmentFromRow,
  type EnrichmentRow,
  type ScanItem,
  toMetrics,
  toTokenRow,
  type TokenUpsertRow,
} from '../_shared/normalize.ts';
import { flagItem, rankByActivity, rankYoungFirst } from '../_shared/final-score.ts';
import { DexPairSchema, JupiterTokenSchema, parseEach, type DexPair, type JupiterToken } from '../_shared/schemas.ts';
import type { TokenMetrics } from '../_shared/types.ts';
import { narrativeRanks } from '../_shared/features.ts';
import { fetchMarketQuotes, type MarketQuotes, scanVolume24h } from '../_shared/market-context.ts';
import {
  addMigrations,
  collectSources,
  createPacer,
  GECKO_GAP_MS,
  JUP_GAP_MS,
  MIGRATION_WATCH_MAX,
  MIGRATION_WATCH_WINDOW_MS,
  parseKeywords,
  parseYoungWatchRows,
  planCandidates,
  SOURCE_HOSTS,
  SOURCE_TIMEOUT_MS,
  sourceFetcher,
  withoutExcluded,
  withSources,
  YOUNG_WATCH_FRESH_MS,
  YOUNG_WATCH_MAX,
} from '../_shared/source-clients.ts';
import { applyAgeQuota, countBySource, isYoungAge, legacySourcesColumn, oldKeptCap } from '../_shared/sources.ts';
import {
  type FetchFn,
  fetchRoundTrip,
  getJson,
  parseRugSummary,
  resolveJupBase,
  RUGCHECK_BASE,
} from '../_shared/enrich-clients.ts';
import { mergeProbe, probeLpLocks, probeRoundTrips, probeTargets } from '../_shared/detection-probe.ts';
import { type BudgetMilestone, createScanBudget, isOverlapping, OVERLAP_WINDOW_MS, type ScanBudget } from '../_shared/scan-budget.ts';
import {
  HISTORY_WINDOW_MS,
  type HistorySample,
  type OutcomeInsert,
  outcomeRowFromScan,
  parseHistoryRows,
  type RugFlags,
  scanFeatures,
  snapshotExtras,
  x3TokenColumns,
  type X3TokenColumns,
} from '../_shared/x3-rows.ts';
import {
  buildTrackingBatch,
  followUpEligible,
  type ForcedMints,
  MAX_OPEN_POSITIONS,
  MAX_TRACKED_MINTS,
  OPEN_POSITION_SELECT,
  type OpenPosition,
  parseOpenPositions,
  trackingSnapshotRow,
  trackPosition,
  type TrackingPatch,
} from '../_shared/alert-tracking.ts';
import { autoPaperCalmFrenzy, type FollowUp, notifyUsers, type PushDeadline, sendFollowUps } from './notify.ts';
import { presetSignalRows } from '../_shared/preset-alerts.ts';
import { MAX_ENGINE_ORDERS, parsePaperMints } from '../_shared/paper-engine.ts';
import { sparkColumns, splitBySpark } from '../_shared/sparkline.ts';
import { knownChange1h, knownTxns1h, pointInTimeColumns, youngPointInTimeColumns } from '../_shared/snapshot-pit.ts';
import { structureBroken } from '../_shared/structure.ts';

const DS = 'https://api.dexscreener.com';
/** JUP_API_BASE accepted on a Jupiter host only (resolveJupBase), so x-api-key never leaves Jupiter. */
const JUP = resolveJupBase(Deno.env.get('JUP_API_BASE'));
const JUP_KEY = Deno.env.get('JUP_API_KEY');
const MIN_MC = Number(Deno.env.get('MIN_MARKET_CAP') ?? 50_000);
const MIN_LIQ = Number(Deno.env.get('MIN_LIQUIDITY') ?? 10_000);
/** Jupiter audits per scan (young tokens first, then 1 h volume): ~2 calls of 20 mints, minus the « recent » records. */
const AUDIT_TOP_N = 40;
/** Mints per `in (…)` select (keeps the PostgREST URL short: 100 × 44 chars). */
const ENRICHMENT_CHUNK = 100;
/** Mints sent to x3_snapshot_history (the rpc caps at 200 too): the most active ones. */
const HISTORY_TOP_N = 200;

/** DexScreener /tokens/v1 calls in flight at once (300 req/min limit; ≤ 15 calls per scan). */
const PAIR_CONCURRENCY = 3;

/**
 * Every external GET of the scan: SOURCE_HOSTS only (https, no credentials/port), redirect 'error' (an x-api-key is
 * never forwarded), 8 s timeout, body ≤ 2 MB, cancelled by the scan budget signal; null on any failure.
 */
function tryJson(url: string, budget: ScanBudget, headers?: Record<string, string>): Promise<unknown> {
  return getJson(url, { hosts: SOURCE_HOSTS, timeoutMs: SOURCE_TIMEOUT_MS, headers, signal: budget.signal });
}

/** DexScreener pairs by batches of 30 (PAIR_CONCURRENCY at once); no new round once `stop` is passed. */
async function fetchPairs(mints: string[], budget: ScanBudget, stop: BudgetMilestone): Promise<DexPair[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));
  const out: DexPair[] = [];
  for (let i = 0; i < chunks.length; i += PAIR_CONCURRENCY) {
    if (budget.passed(stop)) {
      console.warn('pairs: budget reached', chunks.length - i, 'batches skipped');
      break;
    }
    const res = await Promise.all(
      chunks.slice(i, i + PAIR_CONCURRENCY).map((c) => tryJson(`${DS}/tokens/v1/solana/${c.join(',')}`, budget)),
    );
    for (const r of res) out.push(...parseEach(DexPairSchema, r));
  }
  return out;
}

/**
 * pump.fun tokens persisted recently (tokens.dex_id = 'pumpfun', updated < 24 h): their pairs are re-fetched so a
 * migration to PumpSwap/Raydium is detected between two scans. Best effort: empty map on error.
 */
async function loadMigrationWatch(db: SupabaseClient, now: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { data, error } = await db
      .from('tokens')
      .select('mint, dex_id')
      .eq('dex_id', 'pumpfun')
      .gte('updated_at', new Date(now - MIGRATION_WATCH_WINDOW_MS).toISOString())
      .order('updated_at', { ascending: false })
      .limit(MIGRATION_WATCH_MAX);
    if (error) {
      console.warn('migration watch', error.message.slice(0, 200));
      return out;
    }
    for (const r of (data ?? []) as { mint: unknown; dex_id: unknown }[]) {
      if (typeof r.mint === 'string' && isSolanaAddress(r.mint) && r.dex_id === 'pumpfun') out.set(r.mint, 'pumpfun');
    }
  } catch (e) {
    console.warn('migration watch', (e instanceof Error ? e.message : String(e)).slice(0, 200));
  }
  return out;
}

/**
 * Young watch (fix/young-sources): tokens persisted with a pair < 24 h and kept by a scan in the last 10 min, highest
 * 1 h volume first (then DexScreener liquidity), re-fetched at every scan. Best effort: [] on error.
 */
async function loadYoungWatch(db: SupabaseClient, now: number): Promise<string[]> {
  try {
    const { data, error } = await db
      .from('tokens')
      .select('mint, pair_created_at')
      .gte('pair_created_at', new Date(now - 24 * 3_600_000).toISOString())
      .gte('updated_at', new Date(now - YOUNG_WATCH_FRESH_MS).toISOString())
      .order('volume_1h', { ascending: false, nullsFirst: false })
      .order('liquidity_usd', { ascending: false })
      .limit(YOUNG_WATCH_MAX);
    if (error) {
      console.warn('young watch', error.message.slice(0, 200));
      return [];
    }
    return parseYoungWatchRows(data, now);
  } catch (e) {
    console.warn('young watch', (e instanceof Error ? e.message : String(e)).slice(0, 200));
    return [];
  }
}

/** One pacer for every Jupiter lite-api call of the scan (5 requests / 10 s, shared by all endpoints). */
const jupPace = createPacer(JUP_GAP_MS);
/** fetch behind the Jupiter pacer (detection probe round trips: each leg waits for its slot). */
const pacedJupFetch: FetchFn = async (input, init) => {
  await jupPace();
  return await fetch(input, init);
};

/**
 * Jupiter audits of `mints`. Records already returned by this scan's Jupiter « recent » list (same Tokens API v2
 * payload, seconds old) are reused; only the missing mints are asked to /tokens/v2/search (20 per call, paced).
 */
async function fetchAudits(
  mints: string[],
  known: ReadonlyMap<string, JupiterToken>,
  budget: ScanBudget,
): Promise<Map<string, JupiterToken>> {
  const map = new Map<string, JupiterToken>();
  const missing: string[] = [];
  for (const m of mints) {
    const k = known.get(m);
    if (k) map.set(m, k);
    else missing.push(m);
  }
  const headers: Record<string, string> = JUP_KEY ? { 'x-api-key': JUP_KEY } : {};
  for (let i = 0; i < missing.length; i += 20) {
    if (budget.passed('auditsStopMs')) break;
    await jupPace();
    if (budget.passed('auditsStopMs')) break;
    const res = await tryJson(`${JUP}/tokens/v2/search?query=${missing.slice(i, i + 20).join(',')}`, budget, headers);
    for (const t of parseEach(JupiterTokenSchema, res)) map.set(t.id, t);
  }
  return map;
}

/** Jupiter usdPrice worth storing/comparing: finite and > 0, else null. */
function jupPrice(audit: JupiterToken | undefined): number | null {
  const v = audit?.usdPrice;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Latest enrichment persisted by enrich-tokens (GeckoTerminal, RugCheck, round trip) for these mints, so every
 * scan's flags keep the cross-source info between enrich runs. Stale values are dropped by enrichmentFromRow.
 * Best effort: on error the scan flags without enrichment.
 * Also returns which mints already exist in public.tokens (`existing`; `complete` = every chunk was read), so the
 * detection step knows which tokens are seen for the FIRST time.
 */
async function loadEnrichment(
  db: SupabaseClient,
  mints: string[],
): Promise<{ rows: Map<string, EnrichmentRow>; existing: Set<string>; complete: boolean }> {
  const rows = new Map<string, EnrichmentRow>();
  const existing = new Set<string>();
  let complete = true;
  for (let i = 0; i < mints.length; i += ENRICHMENT_CHUNK) {
    const { data, error } = await db.from('tokens').select(ENRICHMENT_SELECT).in('mint', mints.slice(i, i + ENRICHMENT_CHUNK));
    if (error) {
      complete = false;
      console.warn('enrichment load', error.message.slice(0, 200));
      continue;
    }
    for (const row of (data ?? []) as unknown as EnrichmentRow[]) {
      if (typeof row.mint !== 'string') continue;
      existing.add(row.mint);
      if (row.enriched_at) rows.set(row.mint, row);
    }
  }
  return { rows, existing, complete };
}

/** Open tracked positions (alert_log, tracking_until > now), newest first. Best effort: [] on error. */
async function loadOpenPositions(db: SupabaseClient, now: number): Promise<OpenPosition[]> {
  try {
    const { data, error } = await db
      .from('alert_log')
      .select(OPEN_POSITION_SELECT)
      .gt('tracking_until', new Date(now).toISOString())
      .not('entry_price', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(MAX_OPEN_POSITIONS);
    if (error) {
      console.warn('tracking positions', error.message.slice(0, 200));
      return [];
    }
    return parseOpenPositions(data);
  } catch (e) {
    console.warn('tracking positions', (e instanceof Error ? e.message : String(e)).slice(0, 200));
    return [];
  }
}

/**
 * Mints with active paper positions (feat/paper-trading-v2, paper_positions pending / open): priced every scan even
 * outside the scan filters, open positions first. Best effort: none on error (e.g. migration
 * 20261118020000_paper_trading_v2.sql not applied yet).
 */
async function loadPaperMints(db: SupabaseClient): Promise<ForcedMints> {
  const none: ForcedMints = { open: [], pending: [] };
  try {
    const { data, error } = await db
      .from('paper_positions')
      .select('mint, status')
      .in('status', ['pending', 'open'])
      .order('created_at', { ascending: false })
      .limit(MAX_ENGINE_ORDERS);
    if (error) {
      console.warn('paper mints', error.message.slice(0, 200));
      return none;
    }
    return parsePaperMints(data);
  } catch (e) {
    console.warn('paper mints', (e instanceof Error ? e.message : String(e)).slice(0, 200));
    return none;
  }
}

interface TrackingStats {
  /** Distinct mints with active paper positions (forced into the batch). */
  paper: number;
  positions: number;
  tracked: number;
  fetched: number;
  snapshots: number;
  updated: number;
  hits: number;
  followUps: number;
}

/**
 * « Suivi après alerte »: prices every open position (scan price, or DexScreener for mints outside the kept set),
 * writes 'tracking' snapshots for the latter, applies max/min/last/first hit in ONE rpc, then sends the follow-ups
 * due. Never throws (the caller also wraps it).
 */
async function trackPositions(
  db: SupabaseClient,
  positions: OpenPosition[],
  scanned: ReadonlyMap<string, TokenMetrics>,
  extraPairs: DexPair[],
  now: number,
  pushDeadline?: PushDeadline,
  forced: ForcedMints = { open: [], pending: [] },
): Promise<TrackingStats> {
  const paper = forced.open.length + forced.pending.length;
  const stats: TrackingStats = { paper, positions: positions.length, tracked: 0, fetched: 0, snapshots: 0, updated: 0, hits: 0, followUps: 0 };
  if (positions.length === 0 && paper === 0) return stats;
  const batch = buildTrackingBatch(positions, new Set(scanned.keys()), MAX_TRACKED_MINTS, forced);
  stats.tracked = batch.tracked.length;

  const prices = new Map<string, number>();
  const symbols = new Map<string, string>();
  for (const m of batch.tracked) {
    const t = scanned.get(m);
    if (t) {
      prices.set(m, t.priceUsd);
      symbols.set(m, t.symbol);
    }
  }
  const wanted = new Set(batch.toFetch);
  const extra = bestPairPerToken(extraPairs)
    .map((p) => toMetrics(p, now))
    .filter((t): t is TokenMetrics => t !== null && wanted.has(t.mint) && t.priceUsd > 0);
  stats.fetched = extra.length;

  if (extra.length > 0) {
    const { data: last, error } = await db.from('tokens').select('mint, symbol').in('mint', extra.map((t) => t.mint));
    if (error) console.warn('tracking tokens', error.message.slice(0, 200));
    const lastByMint = new Map<string, { symbol: unknown }>();
    for (const r of (last ?? []) as { mint: string; symbol: unknown }[]) lastByMint.set(r.mint, r);
    const snaps = [];
    for (const t of extra) {
      prices.set(t.mint, t.priceUsd);
      const known = lastByMint.get(t.mint);
      symbols.set(t.mint, typeof known?.symbol === 'string' ? known.symbol : t.symbol);
      const row = trackingSnapshotRow(t, known);
      if (row) snaps.push(row);
    }
    if (snaps.length > 0) {
      const { error: snapErr } = await db.from('token_snapshots').insert(snaps);
      if (snapErr) console.warn('tracking snapshots', snapErr.message.slice(0, 200));
      else stats.snapshots = snaps.length;
    }
  }

  const sampledAt = Date.now();
  const patches: TrackingPatch[] = [];
  const state = new Map<number, OpenPosition>();
  for (const p of positions) {
    const price = prices.get(p.mint);
    if (price === undefined) continue;
    const patch = trackPosition(p, price, sampledAt);
    if (!patch) continue;
    patches.push(patch);
    state.set(p.id, { ...p, firstHit: p.firstHit ?? patch.first_hit });
  }
  if (patches.length > 0) {
    const { data, error } = await db.rpc('apply_alert_tracking', { p_rows: patches });
    if (error) {
      console.warn('tracking update', error.message.slice(0, 200));
      return stats; // positions unchanged in the DB: no follow-up decided from them this scan
    }
    stats.updated = patches.length;
    stats.hits = Array.isArray(data) ? data.length : 0;
  }

  const due: FollowUp[] = [];
  for (const p of state.values()) {
    if (followUpEligible(p, now)) due.push({ position: p, symbol: symbols.get(p.mint) ?? '???' });
  }
  if (due.length > 0) {
    try {
      const f = await sendFollowUps(db, due, undefined, pushDeadline);
      stats.followUps = f.sent;
    } catch (e) {
      console.warn('follow-ups skipped', (e instanceof Error ? e.message : String(e)).slice(0, 200));
    }
  }
  return stats;
}

interface HistoryInputs {
  history: Map<string, HistorySample[]>;
  /** Mints sent to x3_snapshot_history when the read succeeded; null when it failed (spark_6h is then omitted). */
  historyMints: Set<string> | null;
}

/**
 * The 24 h snapshot history (ONE rpc x3_snapshot_history, 15-min downsampled) of these mints, loaded while the scan
 * fetches the audits: features (holder growth, migration) and spark_6h. Never throws: failure → empty history.
 */
async function loadHistory(db: SupabaseClient, mints: string[], now: number): Promise<HistoryInputs> {
  if (mints.length === 0) return { history: new Map(), historyMints: new Set() };
  try {
    const hist = await db.rpc('x3_snapshot_history', { p_mints: mints, p_since: new Date(now - HISTORY_WINDOW_MS).toISOString() });
    if (hist.error) {
      console.warn('history', hist.error.message.slice(0, 200));
      return { history: new Map(), historyMints: null };
    }
    return { history: parseHistoryRows(hist.data), historyMints: new Set(mints) };
  } catch (e) {
    console.warn('history', (e instanceof Error ? e.message : String(e)).slice(0, 200));
    return { history: new Map(), historyMints: null };
  }
}

Deno.serve(async (req) => {
  const expected = Deno.env.get('CRON_SECRET');
  const given = req.headers.get('x-cron-secret') ?? '';
  if (!expected || expected.length < 32 || !constantTimeEqual(given, expected)) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const { data: run } = await db.from('scan_runs').insert({}).select('id').single();

  // Overlap guard: an OLDER scan (smaller id) started < 90 s ago and still unfinished → skip this one. Running both
  // would let both pass the alert_log dedup (duplicate alerts) and double the upstream calls. If the read fails, the
  // scan proceeds as before. See _shared/scan-budget.ts (isOverlapping).
  if (run) {
    const { data: running, error: runningErr } = await db
      .from('scan_runs')
      .select('id, started_at, finished_at')
      .is('finished_at', null)
      .lt('id', run.id)
      .gte('started_at', new Date(Date.now() - OVERLAP_WINDOW_MS).toISOString())
      .limit(5);
    if (runningErr) console.warn('overlap guard', runningErr.message.slice(0, 200));
    else if (isOverlapping(run.id, running, Date.now())) {
      await db.from('scan_runs').update({ finished_at: new Date().toISOString(), error: 'skipped: overlap' }).eq('id', run.id);
      console.warn('scan skipped: overlap');
      return Response.json({ skipped: 'overlap' });
    }
  }

  const budget = createScanBudget(Date.now());
  const pushDeadline: PushDeadline = { stopAt: budget.at('pushStopMs'), abortAt: budget.at('pushAbortMs') };
  try {
    const now = budget.startedAt;
    const started = now;
    // Market context: one Jupiter request (SOL change + SOL/USD + EUR/USD) in parallel with the whole scan.
    const noQuotes: MarketQuotes = { solChange24h: null, solUsd: null, eurUsd: null };
    const jupHeaders: Record<string, string> = JUP_KEY ? { 'x-api-key': JUP_KEY } : {};
    const marketP = jupPace()
      .then(() =>
        fetchMarketQuotes({ jupBase: Deno.env.get('JUP_API_BASE') ?? null, headers: jupHeaders, signal: budget.collectSignal })
      )
      .catch(() => noQuotes);
    const solChangeP = marketP.then((q) => q.solChange24h);
    // Open tracked positions (alert_log), paper positions, the pump.fun watch list and the young watch, read while the
    // sources are collected.
    const positionsP = loadOpenPositions(db, now);
    const paperMintsP = loadPaperMints(db);
    const watchP = loadMigrationWatch(db, now);
    const youngWatchP = loadYoungWatch(db, now);

    // Candidate sources: DexScreener lists + keywords, GeckoTerminal young pools (≤ 4 paced calls), Jupiter « recent »
    // (1 paced call), young watch (DB). Each source fails alone; the scan continues with the others.
    const collectStarted = Date.now();
    const jupHost = (url: string) => /^https:\/\/(lite-api|api)\.jup\.ag\//.test(url);
    const collected = await collectSources({
      fetchJson: sourceFetcher((url) => (jupHost(url) ? jupHeaders : {}), budget.collectSignal),
      jupPace,
      geckoPace: createPacer(GECKO_GAP_MS),
      jupBase: Deno.env.get('JUP_API_BASE') ?? null,
      keywords: parseKeywords(Deno.env.get('SCAN_KEYWORDS')),
      deadline: budget.at('collectStopMs'),
    });
    const youngWatch = await youngWatchP;
    const lists = withoutExcluded([...collected.lists, { source: 'young_watch', mints: youngWatch }], collected.excluded);
    const watch = await watchP;
    const plan = planCandidates(lists, watch);
    const collectMs = Date.now() - collectStarted;

    const pairsStarted = Date.now();
    const allPairs = [...(await fetchPairs(plan.fetchMints, budget, 'pairsStopMs')), ...collected.searchPairs];
    const best = bestPairPerToken(allPairs);
    // Migrations (persisted 'pumpfun' → PumpSwap/Raydium now, or a fresh PumpSwap pair) add the 'migration' source.
    const { merged, migrated } = addMigrations(lists, watch, best, allPairs, now);
    // Watched pump.fun tokens that did not migrate (and no source brought) are not candidates.
    const pairs = best.filter((p) => merged.has(p.baseToken.address));
    const pairsMs = Date.now() - pairsStarted;
    // young-calm: 1 h transactions only when the pair payload carried BOTH counts (normalize.ts defaults them to 0,
    // which would read as a known 1.0 ratio). Unknown → null in the snapshots and for the young presets.
    const txns1h = new Map(pairs.map((p) => [p.baseToken.address, knownTxns1h(p)]));
    // Same for the 1 h price change (normalize.ts defaults a missing priceChange.h1 to 0, which would pass « Jeune
    // calme » 0 ≤ change ≤ 100): known-or-null for the presets and the point-in-time change_1h.
    const change1h = new Map(pairs.map((p) => [p.baseToken.address, knownChange1h(p)]));

    const candidates = pairs.map((p) => toMetrics(p, now)).filter((t): t is TokenMetrics => t !== null);
    const passing = candidates.filter((t) => t.marketCap >= MIN_MC && t.liquidityUsd >= MIN_LIQ && t.priceUsd > 0);
    // Candidates (with a pair) younger than 24 h: source_counts young / youngKept.
    const youngMints = new Set(candidates.filter((t) => isYoungAge(t.ageHours)).map((t) => t.mint));

    // Age quota: every token < 24 h and every tracked mint (open alert positions, paper positions: they are priced by
    // the forced tracking anyway, keeping them here keeps their tokens row fresh) is kept; older tokens keep the
    // oldKeptCap most active slots (1 h volume, then liquidity). Ranked on DexScreener data only.
    const [openPositions, paperForced] = await Promise.all([positionsP, paperMintsP]);
    const forcedMints = new Set<string>([...openPositions.map((p) => p.mint), ...paperForced.open, ...paperForced.pending]);
    const ranked = rankByActivity(passing);
    const oldCap = oldKeptCap(ranked.filter((t) => isYoungAge(t.ageHours)).length);
    const quota = applyAgeQuota(ranked, forcedMints, oldCap);
    const kept = quota.kept;

    // Tracked mints outside the kept set: priced from DexScreener anyway, in parallel with the audits.
    const keptSet = new Set(kept.map((t) => t.mint));
    // Paper trading: mints with pending/open paper positions are forced into the same batch (priority, ≤ 100 mints).
    const noForced: ForcedMints = { open: [], pending: [] };
    const trackingP = Promise.resolve().then(async () => {
      const { chunks } = buildTrackingBatch(openPositions, keptSet, MAX_TRACKED_MINTS, paperForced);
      const pairs = (await Promise.all(chunks.map((c) => fetchPairs(c, budget, 'trackingStopMs')))).flat();
      return { positions: openPositions, forced: paperForced, pairs };
    }).catch(() => ({ positions: [] as OpenPosition[], forced: noForced, pairs: [] as DexPair[] }));

    // 1. Merge the persisted enrichment (enrich-tokens) so the flags use it.
    const { rows: enrichment, existing, complete: existingComplete } = await loadEnrichment(db, kept.map((t) => t.mint));
    const metrics = kept.map((t) => {
      const row = enrichment.get(t.mint);
      return row ? { ...t, ...enrichmentFromRow(row, now) } : t;
    });

    // Snapshot history (one rpc) of the most active mints, loaded while the audits are fetched.
    const historyP = loadHistory(db, rankByActivity(metrics).slice(0, HISTORY_TOP_N).map((t) => t.mint), now);

    // Detection probe (feat/calm-sl-test, _shared/detection-probe.ts): LP lock (RugCheck summary, in parallel with the
    // audits) and round trip (Jupiter, after the audits on the same pacer) of the first-detected young tokens, so their
    // detection features, flags and point-in-time snapshot columns are not empty. Bounded (≤ 4 + ≤ 2), never fails.
    const probeList = probeTargets(rankByActivity(metrics), existing, existingComplete);
    const lpProbeP = probeLpLocks(probeList, async (mint) =>
      parseRugSummary(
        await getJson(`${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(mint)}/report/summary`, {
          timeoutMs: SOURCE_TIMEOUT_MS,
          signal: budget.signal,
        }),
      )
    ).catch(() => new Map());

    // 2. Jupiter audits: young tokens first (the « Jeune calme » safety needs top 10 / authorities), then 1 h volume.
    const audits = await fetchAudits(rankYoungFirst(metrics).slice(0, AUDIT_TOP_N).map((t) => t.mint), collected.jupTokens, budget);

    const rtProbe = await probeRoundTrips(probeList, (mint) => {
      if (budget.passed('auditsStopMs')) return Promise.resolve(undefined);
      return fetchRoundTrip(mint, {
        jupBase: JUP,
        headers: JUP_KEY ? { 'x-api-key': JUP_KEY } : {},
        timeoutMs: SOURCE_TIMEOUT_MS,
        signal: budget.signal,
        fetchFn: pacedJupFetch,
        sellDeadline: budget.at('trackingStopMs'),
      });
    }).catch(() => new Map());
    const probed = mergeProbe(metrics, await lpProbeP, rtProbe);

    // 3. Flags + consensus with the Jupiter price (price divergence only; Jupiter liquidity is not used any more), in
    //    activity order: upsert, snapshots, presets and alerts all read these items.
    const flagged: ScanItem[] = rankByActivity(probed).map((t) => {
      const price = jupPrice(audits.get(t.mint));
      return flagItem(price === null ? t : { ...t, priceJupUsd: price });
    });

    // 4. Rows: toTokenRow never contains the enrich-tokens columns (the upsert leaves them untouched).
    const rowsAt = Date.now();
    const baseRows = flagged.map((s) => toTokenRow(s, audits.get(s.t.mint), rowsAt));
    // tokens.sources (union of the sources that brought the mint this scan) rides with every upsert payload.
    const rows = withSources(baseRows, merged);

    // 5. Detection features, narrative and first detections. Never fails the scan.
    const featuresStarted = Date.now();
    const x3Cols = new Map<string, X3TokenColumns>();
    const outcomeRows: OutcomeInsert[] = [];
    try {
      const inputs = await historyP;
      const market = { solChange24h: await solChangeP, scanVolume24h: scanVolume24h(flagged.map((s) => s.t)) };
      const narratives = narrativeRanks(
        flagged.map((s) => ({ mint: s.t.mint, name: s.t.name, symbol: s.t.symbol, marketCap: s.t.marketCap })),
      );
      const rug = new Map<string, RugFlags>();
      for (const [mint, row] of enrichment) {
        const insiders = typeof row.insiders_detected === 'boolean' ? row.insiders_detected : null;
        const creatorBad = typeof row.creator_rug_history === 'boolean' ? row.creator_rug_history : null;
        if (insiders !== null || creatorBad !== null) rug.set(mint, { insiders, creatorBad });
      }
      const ctx = { nowMs: rowsAt, history: inputs.history, narratives, market, rug };
      for (const s of flagged) {
        const features = scanFeatures(s, audits.get(s.t.mint), ctx);
        x3Cols.set(s.t.mint, x3TokenColumns(features, narratives.get(s.t.mint)));
        // First detection = not in public.tokens before this scan. Known tokens without an outcome row are
        // backfilled by label-outcomes from their first snapshot. Unsure (a select failed) → skip this scan.
        if (existingComplete && !existing.has(s.t.mint)) {
          const o = outcomeRowFromScan(s, features, rowsAt);
          if (o) outcomeRows.push(o);
        }
      }
    } catch (e) {
      x3Cols.clear();
      outcomeRows.length = 0;
      console.warn('features skipped', (e instanceof Error ? e.message : String(e)).slice(0, 200));
    }
    const fullRows: (TokenUpsertRow & Partial<X3TokenColumns> & { sources: string[] })[] = rows.map((r) => ({
      ...r,
      ...x3Cols.get(r.mint),
    }));
    // spark_6h (owned by scan): only for mints whose history read succeeded; never fails the scan.
    let spark = new Map<string, number[] | null>();
    try {
      const inputs = await historyP;
      spark = sparkColumns(flagged.map((s) => ({ mint: s.t.mint, price: s.t.priceUsd })), inputs.history, inputs.historyMints, rowsAt);
    } catch (e) {
      console.warn('spark_6h skipped', (e instanceof Error ? e.message : String(e)).slice(0, 200));
    }
    const featuresMs = Date.now() - featuresStarted;

    let pushRows: typeof fullRows = fullRows;
    let outcomesInserted = 0;
    let pushMs = 0;
    if (rows.length > 0) {
      // With spark_6h: rows that have one and rows that do not go in two upserts (a mixed batch would write NULL
      // for the missing key). Any error → the same rows without spark_6h.
      let error: { message: string } | null = null;
      if (spark.size > 0) {
        const { withSpark, without } = splitBySpark(fullRows, spark);
        ({ error } = await db.from('tokens').upsert(withSpark, { onConflict: 'mint' }));
        if (!error && without.length > 0) ({ error } = await db.from('tokens').upsert(without, { onConflict: 'mint' }));
        if (error) console.warn('upsert tokens with spark_6h', error.message.slice(0, 200));
      }
      if (spark.size === 0 || error) ({ error } = await db.from('tokens').upsert(fullRows, { onConflict: 'mint' }));
      if (error && /sources/i.test(error.message)) {
        // tokens_sources_check rejects the chore/slim-down names (migration 20261121020000 not applied yet): same
        // payload with the names accepted before it.
        console.warn('upsert tokens with new source names', error.message.slice(0, 200));
        ({ error } = await db.from('tokens').upsert(
          fullRows.map((r) => ({ ...r, sources: legacySourcesColumn(r.sources) })),
          { onConflict: 'mint' },
        ));
      }
      if (error) {
        // Feature / narrative columns rejected: the scan itself must still be written.
        console.warn('upsert tokens with feature columns', error.message.slice(0, 200));
        const { error: baseErr } = await db.from('tokens').upsert(
          rows.map((r) => ({ ...r, sources: legacySourcesColumn(r.sources) })),
          { onConflict: 'mint' },
        );
        pushRows = rows;
        if (baseErr) throw new Error(`upsert tokens: ${baseErr.message}`);
      }
      const baseSnapshots = rows.map((r) => ({
        mint: r.mint,
        price_usd: r.price_usd,
        market_cap: r.market_cap,
        liquidity_usd: r.liquidity_usd,
        volume_24h: r.volume_24h,
      }));
      const snapshots = flagged.map((s, i) => ({ ...baseSnapshots[i], ...snapshotExtras(s, audits.get(s.t.mint)) }));
      // Point-in-time columns = the token row written above + the enrichment merged in this scan (values known NOW,
      // never refreshed later), so the event backtest never reads future data; young-calm columns on top.
      const snapRows = snapshots.map((snap, i) => ({
        ...snap,
        ...pointInTimeColumns({
          mint_authority_disabled: rows[i].mint_authority_disabled,
          freeze_authority_disabled: rows[i].freeze_authority_disabled,
          top10_pct: rows[i].top10_pct,
          change_1h: change1h.get(rows[i].mint) ?? null,
          insiders_detected: enrichment.get(rows[i].mint)?.insiders_detected,
          roundtrip_cost_pct: flagged[i].t.roundtripCostPct,
        }),
        ...youngPointInTimeColumns({
          buys_1h: txns1h.get(rows[i].mint)?.buys,
          sells_1h: txns1h.get(rows[i].mint)?.sells,
          liquidity_effective_usd: rows[i].liquidity_effective_usd,
          lp_locked_pct: flagged[i].t.lpLockedPct,
        }),
      }));
      const { error: snapErr } = await db.from('token_snapshots').insert(snapRows);
      if (snapErr) {
        console.warn('snapshots', snapErr.message.slice(0, 200));
        const { error: baseSnapErr } = await db.from('token_snapshots').insert(baseSnapshots);
        if (baseSnapErr) console.warn('snapshots (base)', baseSnapErr.message.slice(0, 200));
      }

      // First detections (after the tokens upsert: FK). ON CONFLICT (mint) DO NOTHING keeps the earliest entry.
      if (outcomeRows.length > 0 && pushRows === fullRows) {
        try {
          const { data: inserted, error: outErr } = await db
            .from('signal_outcomes')
            .upsert(outcomeRows, { onConflict: 'mint', ignoreDuplicates: true })
            .select('mint');
          if (outErr) console.warn('signal_outcomes', outErr.message.slice(0, 200));
          else outcomesInserted = inserted?.length ?? 0;
        } catch (e) {
          console.warn('signal_outcomes', (e instanceof Error ? e.message : String(e)).slice(0, 200));
        }
      }

      // Enrichment-owned RugCheck safety signals and the (fresh) round trip are not in the upsert rows: add them.
      // pair_created_at becomes EPOCH MS (age rule of presets.ts); change_1h, buys_1h / sells_1h are replaced by the
      // KNOWN values (null when the pair payload lacked them); lp_locked_pct = fresh RugCheck LP lock (null = unknown);
      // structure_broken = « Structure cassée » of this scan (same structureBroken as the flag, feat/calm-sl-test).
      const metricsByMint = new Map(flagged.map((s) => [s.t.mint, s.t]));
      const alertRows = pushRows.map((r) => {
        const e = enrichment.get(r.mint);
        const createdMs = typeof r.pair_created_at === 'string' ? Date.parse(r.pair_created_at) : NaN;
        const m = metricsByMint.get(r.mint);
        const lp = m?.lpLockedPct;
        return {
          ...r,
          pair_created_at: Number.isFinite(createdMs) ? createdMs : null,
          insiders_detected: typeof e?.insiders_detected === 'boolean' ? e.insiders_detected : null,
          creator_rug_history: typeof e?.creator_rug_history === 'boolean' ? e.creator_rug_history : null,
          roundtrip_cost_pct: m?.roundtripCostPct ?? null,
          change_1h: change1h.get(r.mint) ?? null,
          buys_1h: txns1h.get(r.mint)?.buys ?? null,
          sells_1h: txns1h.get(r.mint)?.sells ?? null,
          lp_locked_pct: typeof lp === 'number' && Number.isFinite(lp) ? lp : null,
          structure_broken: m ? structureBroken(m) : null,
        };
      });

      // Preset matches (measurement): first match per preset per mint (young_calm, young_frenzy), with the narrative
      // and the pair age at detection; best effort, never fails the scan.
      try {
        const presetRows = presetSignalRows(alertRows, rowsAt);
        if (presetRows.length > 0) {
          const { error: presetErr } = await db
            .from('preset_signals')
            .upsert(presetRows, { onConflict: 'preset,mint', ignoreDuplicates: true });
          if (presetErr) console.warn('preset_signals', presetErr.message.slice(0, 200));
        }
      } catch (e) {
        console.warn('preset_signals', (e instanceof Error ? e.message : String(e)).slice(0, 200));
      }

      // « Jeune calme » Web Push alerts: best effort, must never fail the scan. No endpoint, key or payload in logs.
      const pushStarted = Date.now();
      try {
        const stats = await notifyUsers(db, alertRows, started, undefined, pushDeadline);
        if (stats.notifications > 0 || stats.removed > 0) console.log('push', JSON.stringify(stats));
      } catch (e) {
        console.warn('push skipped', (e instanceof Error ? e.message : String(e)).slice(0, 200));
      }
      pushMs = Date.now() - pushStarted;

      // « Calme » / « Frénésie » auto-paper (simulation): every scan, every auto_paper user, independent of alerts.
      // Bounded and fail-closed inside; never fails the scan.
      try {
        const cf = await autoPaperCalmFrenzy(db, alertRows, rowsAt);
        if (cf.calm > 0 || cf.frenzy > 0) console.log('calm/frenzy', JSON.stringify(cf));
      } catch (e) {
        console.warn('calm/frenzy skipped', (e instanceof Error ? e.message : String(e)).slice(0, 200));
      }
    }

    // « Suivi après alerte » (7 days) and follow-ups (48 h): best effort, never fails the scan.
    const trackingStarted = Date.now();
    let tracking: TrackingStats | null = null;
    try {
      const { positions, forced, pairs: extraPairs } = await trackingP;
      tracking = await trackPositions(db, positions, new Map(flagged.map((s) => [s.t.mint, s.t])), extraPairs, now, pushDeadline, forced);
      if (tracking.positions > 0 || tracking.paper > 0) console.log('tracking', JSON.stringify(tracking));
    } catch (e) {
      console.warn('tracking skipped', (e instanceof Error ? e.message : String(e)).slice(0, 200));
    }
    const trackingMs = Date.now() - trackingStarted;

    // Yield per source (seen / kept / unique / young / youngKept), stored in scan_runs.source_counts.
    const sourceCounts = countBySource(merged, new Set(rows.map((r) => r.mint)), youngMints);
    const quotes = await marketP;
    if (run) {
      const { error: runErr } = await db.from('scan_runs').update({
        finished_at: new Date().toISOString(),
        tokens_seen: pairs.length,
        tokens_kept: rows.length,
        source_counts: sourceCounts,
        sol_usd: quotes.solUsd,
        eur_usd: quotes.eurUsd,
      }).eq('id', run.id);
      if (runErr) {
        console.warn('scan_runs', runErr.message.slice(0, 200));
        await db.from('scan_runs').update({ finished_at: new Date().toISOString(), tokens_seen: pairs.length, tokens_kept: rows.length }).eq('id', run.id);
      }
    }
    const ms = Date.now() - started;
    const keptYoung = rows.filter((r) => youngMints.has(r.mint)).length;
    const detections = { features: x3Cols.size, outcomes: outcomesInserted, computeMs: featuresMs };
    const timings = { collectMs, pairsMs, pushMs, trackingMs };
    const sources = {
      candidates: merged.size,
      fetched: plan.fetchMints.length,
      watched: watch.size,
      youngWatch: youngWatch.length,
      young: { candidates: youngMints.size, passing: passing.filter((t) => isYoungAge(t.ageHours)).length, kept: keptYoung, oldCap, oldDropped: quota.dropped.length },
      migrated: migrated.length,
      excluded: collected.excluded.size,
      failed: collected.failed,
      skipped: collected.skipped,
      rateLimited: collected.rateLimited,
      counts: sourceCounts,
    };
    console.log('scan', JSON.stringify({ seen: pairs.length, kept: rows.length, enriched: enrichment.size, sources, detections, tracking, timings, ms }));
    return Response.json({ seen: pairs.length, kept: rows.length, sources, detections, tracking, timings, ms });
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    console.error('scan failed', message);
    if (run) await db.from('scan_runs').update({ finished_at: new Date().toISOString(), error: message }).eq('id', run.id);
    return new Response('Scan failed', { status: 500 });
  } finally {
    budget.dispose();
  }
});
