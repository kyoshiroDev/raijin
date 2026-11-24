// Edge Function: backtest-run (feat/strategy-lab, docs/contracts/strategy-lab.md §B6). SIMULATION ONLY: past
// detections replayed on stored candles; no wallet, no key, no signature, no transaction, no external call.
// Called EVERY MINUTE by pg_cron (job raijin-backtest-worker, supabase/sql/schedule_backtest.sql) with the
// x-cron-secret header, checked in constant time (401 otherwise, POST only, 405). Runs are queued by the nightly job
// (backtest_enqueue_nightly, 03:40) or by users through rpc('backtest_request_run'), never by calling this function.
// Deploy: supabase functions deploy backtest-run --no-verify-jwt        Secrets: CRON_SECRET (same as scan-tokens).
//
// One call = one slice of the OLDEST queued / running run (state machine in _shared/backtest-worker.ts):
//   0. lease: backtest_runs.locked_until (a concurrent call skips the run); the consecutive-error counter of the cursor is
//      charged BEFORE the work and cleared after it, so a call killed by the CPU limit still counts as a failure; the
//      run fails after 5 consecutive failures or 12 h after its start;
//   1. 'simulate': pages of 25 detections (signal_outcomes, then preset_signals, last 30 days, detected before the run
//      start), their ohlcv_candles rows (one read per page), backtest.ts simulateRows (the 6 grid combinations per
//      detection) → backtest_trades (upsert, only the « Jeune calme / frénésie » candidates); then the events of the two
//      young event presets (backtest_events). Synchronous compute ≤ 1.2 s per call, ≤ 200 detections, no new page after 30 s;
//   2. 'split': global chronological 70 / 30 cutoff over the run's traded detections, split column updated;
//   3. 'aggregate': chunks of (preset, 48 distinct combos, narrative) holding grid combos = 4 presets × 1 × 3 = 12 per run (backtest.ts aggregatePreset
//      with { narratives, comboRange, returnsOffset }, bootstrap on the retained candidates ≈ 27 ms each at 2 400 test
//      trades, so a chunk stays ≤ ~1.3 s). Trades are read through rpc backtest_trades_slice with ONLY the returns slice
//      of the chunk (returns[lo+1:hi+1]), once per (preset, range) for its three narratives. At least one chunk per
//      call, more while the compute stays < 300 ms; cursor (preset, chunk, narr) saved after each chunk →
//      backtest_results (upsert, distinct variants only, time_exit_h 0 = none);
//   4. done: status 'done', data_version, counters; backtest_trades kept for the last 3 runs, backtest_results for the
//      last 14.
// chore/slim-down: presets young_calm / young_frenzy (detection) and young_calm_ev / young_frenzy_ev (event) only, grid
// all_x2 × stop 20 / 30 / 40 % × delay 0 / 2 min (6 variants per preset); the other presets and the exploratory ones are
// archived (their events / results are no longer read or produced).
// Every step is idempotent (upserts on primary keys, cursor saved after each page), so a dead call is replayed.
// Response { run, phase, detections, traded, chunks, computeMs, progress, ms } or { idle: true }. Logs carry counts only.
import type { SupabaseClient } from '../db/bench-db';
import {
  aggregatePreset,
  BOOTSTRAP_ITERATIONS,
  BOOTSTRAP_SEED,
  BootstrapDraws,
  type BacktestResult,
  buildRunSummary,
  detectionFromRow,
  type DetectionInput,
  eventFromRow,
  type EventInput,
  eventTradeRow,
  GRID_COUNTS,
  gridParams,
  isStoredDetection,
  parseTradeRow,
  PRESET_BIT,
  resultFromRow,
  simulateEventRows,
  simulateRows,
  type TradeRecord,
  tradeRow,
} from '../ported/backtest';
import {
  advanceAggregate,
  type AggregateStep,
  confirmatoryEvents,
  aggregateStep,
  cutoffIndex,
  dedupeTradeRows,
  DETECTION_TABLES,
  type DetectionTable,
  finalDataVersion,
  initialCursor,
  keysetFilter,
  MAX_CONSECUTIVE_ERRORS,
  nextTable,
  parseCursor,
  progressOf,
  recordDetection,
  recordEvent,
  resultRow,
  retentionCutoffs,
  RUN_TIMEOUT_MS,
  sameSlice,
  TRADE_KEY_COLUMNS,
  WORKER_BUDGET,
  type WorkerCursor,
} from '../ported/backtest-worker';
import {
  EVENT_PRESETS,
  parseReplayState,
  parseSnapshotRow,
  type ReplayState,
  replayMint,
  type TokenFacts,
} from '../ported/events';
import {
  accountScan,
  boundedState,
  completePrefix,
  eventInsertRows,
  FACTS_SELECT,
  initialScannerCursor,
  parseScannerCursor,
  runMayStart,
  SCANNER_BUDGET,
  type ScannerCursor,
  SNAPSHOT_SELECT,
  snapshotKeyset,
  tokenFactsFromRow,
} from '../ported/event-scanner';
import { engineLog } from './log';

const MAX_DETECTIONS_PER_CALL = 200;
const CANDLE_SELECT = 'mint, tf, ts_start, step_s, ts, o, h, l, c, v';
const CANDLE_PAGE = 1000;
const SIGNAL_SELECT =
  'mint, detected_at, entry_mc, entry_liq_eff, entry_zone, entry_dex_id, entry_roundtrip_pct, ' +
  'change_1h:features->change_1h, log_age_h:features->log_age_h, roundtrip_cost_pct:features->roundtrip_cost_pct, ' +
  // feat/young-calm: features at detection of the young_calm / young_frenzy detection presets (absent → unknown).
  'buy_sell_ratio_1h:features->buy_sell_ratio_1h, lp_locked_pct:features->lp_locked_pct, ' +
  'rug_insiders:features->rug_insiders, rug_creator_bad:features->rug_creator_bad, ' +
  'tokens(narrative)';
const PRESET_SELECT =
  'id, mint, detected_at, entry_mc, entry_liq_eff, entry_zone, entry_dex_id, entry_change_1h, entry_roundtrip_pct, ' +
  'pair_age_h, narrative';
/** lab-v2: events of the run (backtest_events), keyset on (event_at, id). */
const EVENT_SELECT = 'id, preset, mint, event_at, roundtrip_pct, narrative';
/** No new aggregation chunk once the call's synchronous compute reached this (ms). */
const AGG_CONTINUE_MS = 300;
const TRADE_CONFLICT = TRADE_KEY_COLUMNS.join(',');
const RESULT_CONFLICT = 'run_id,preset,exit,sl_pct,breakeven,time_exit_h,delay_min,narrative,split';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const iso = (ms: number) => new Date(ms).toISOString();
const now = () => performance.now();

interface RunRow {
  id: number;
  status: 'queued' | 'running';
  cursor: unknown;
  started_at: string | null;
  created_at: string;
}

interface CallStats {
  detections: number;
  traded: number;
  chunks: number;
  computeMs: number;
}

class Budget {
  private computeMs = 0;
  constructor(private readonly startedAt: number) {}
  charge(ms: number) {
    this.computeMs += ms;
  }
  get compute() {
    return this.computeMs;
  }
  /** A new page / step may start. */
  ok(): boolean {
    return this.computeMs < WORKER_BUDGET.computeMs && Date.now() - this.startedAt < WORKER_BUDGET.wallMs;
  }
}

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

async function saveCursor(db: SupabaseClient, runId: number, cursor: WorkerCursor, extra: Record<string, unknown> = {}) {
  await check(
    db.from('backtest_runs').update({ cursor, progress: progressOf(cursor), ...extra }).eq('id', runId).eq('status', 'running'),
    'save cursor',
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Simulation

/** One page of detections of `table` after the cursor → DetectionInput + raw keyset values. */
async function readDetections(
  db: SupabaseClient,
  table: Exclude<DetectionTable, 'backtest_events'>,
  c: WorkerCursor,
): Promise<{ input: DetectionInput | null; rawAt: string; key: string }[]> {
  const keyColumn = table === 'preset_signals' ? 'id' : 'mint';
  let q = db
    .from(table)
    .select(table === 'preset_signals' ? PRESET_SELECT : SIGNAL_SELECT)
    .gt('detected_at', c.since)
    .lte('detected_at', c.until);
  const ks = keysetFilter(c.after, keyColumn);
  if (c.after && !ks) throw new Error('invalid cursor position');
  if (ks) q = q.or(ks);
  const rows = (await check(
    q.order('detected_at', { ascending: true }).order(keyColumn, { ascending: true }).limit(WORKER_BUDGET.pageSize),
    `read ${table}`,
  ) ?? []) as unknown as Record<string, unknown>[];

  // preset_signals: narrative at detection, else the token's current narrative (one read for the page).
  const narratives = new Map<string, string>();
  if (table === 'preset_signals') {
    const missing = [...new Set(rows.filter((r) => r['narrative'] == null && typeof r['mint'] === 'string').map((r) => r['mint'] as string))];
    if (missing.length > 0) {
      const toks = (await check(db.from('tokens').select('mint, narrative').in('mint', missing), 'read narratives') ?? []) as unknown as {
        mint: string;
        narrative: unknown;
      }[];
      for (const t of toks) if (typeof t.narrative === 'string') narratives.set(t.mint, t.narrative);
    }
  }

  return rows.map((r) => {
    const rawAt = typeof r['detected_at'] === 'string' ? r['detected_at'] : '';
    const key = table === 'preset_signals' ? String(r['id'] ?? '') : String(r['mint'] ?? '');
    let shaped: Record<string, unknown>;
    if (table === 'preset_signals') {
      shaped = { ...r, narrative: r['narrative'] ?? narratives.get(String(r['mint'])) ?? null };
    } else {
      const tok = r['tokens'] as { narrative?: unknown } | null | undefined;
      shaped = {
        ...r,
        features: {
          change_1h: r['change_1h'],
          log_age_h: r['log_age_h'],
          roundtrip_cost_pct: r['roundtrip_cost_pct'],
          buy_sell_ratio_1h: r['buy_sell_ratio_1h'],
          lp_locked_pct: r['lp_locked_pct'],
          rug_insiders: r['rug_insiders'],
          rug_creator_bad: r['rug_creator_bad'],
        },
        narrative: tok && typeof tok.narrative === 'string' ? tok.narrative : null,
      };
    }
    return { input: detectionFromRow(table, shaped), rawAt, key };
  });
}

/** lab-v2: one page of backtest_events after the cursor (since < event_at <= until), keyset (event_at, id). */
async function readEvents(db: SupabaseClient, c: WorkerCursor): Promise<{ input: EventInput | null; rawAt: string; key: string }[]> {
  let q = db.from('backtest_events').select(EVENT_SELECT).in('preset', [...EVENT_PRESETS]).gt('event_at', c.since).lte('event_at', c.until);
  const ks = keysetFilter(c.after, 'id', 'event_at');
  if (c.after && !ks) throw new Error('invalid cursor position');
  if (ks) q = q.or(ks);
  const rows = (await check(
    q.order('event_at', { ascending: true }).order('id', { ascending: true }).limit(WORKER_BUDGET.pageSize),
    'read backtest_events',
  ) ?? []) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    input: eventFromRow(r),
    rawAt: typeof r['event_at'] === 'string' ? r['event_at'] : '',
    key: String(r['id'] ?? ''),
  }));
}

/** ohlcv_candles rows of these mints grouped by mint (paged: a page can have more than 1000 candle windows). */
async function readCandles(db: SupabaseClient, mints: string[]): Promise<Map<string, unknown[]>> {
  const candleRows: { mint: string }[] = [];
  for (let from = 0; mints.length > 0; from += CANDLE_PAGE) {
    const rows = ((await check(
      db.from('ohlcv_candles').select(CANDLE_SELECT).in('mint', mints).order('id').range(from, from + CANDLE_PAGE - 1),
      'read candles',
    ) ?? []) as unknown as { mint: string }[]);
    candleRows.push(...rows);
    if (rows.length < CANDLE_PAGE) break;
  }
  const byMint = new Map<string, unknown[]>();
  for (const r of candleRows) {
    const list = byMint.get(r.mint) ?? [];
    list.push(r);
    byMint.set(r.mint, list);
  }
  return byMint;
}

/**
 * lab-v2: one page of events. Entry = a 1-minute candle after event_at + delay (backtest.ts simulateEvent); an event
 * without one is counted pending (« en attente de bougies ») and not written. Returns the page length.
 */
async function simulateEventPage(db: SupabaseClient, runId: number, c: WorkerCursor, budget: Budget, stats: CallStats): Promise<number> {
  const page = await readEvents(db, c);
  if (page.length === 0) return 0;
  const mints = [...new Set(page.map((p) => p.input?.mint).filter((m): m is string => typeof m === 'string'))];
  const byMint = await readCandles(db, mints);
  const t0 = now();
  const trades: Record<string, unknown>[] = [];
  for (const p of page) {
    if (!p.rawAt || !/^\d{1,18}$/.test(p.key)) throw new Error('invalid backtest_events row (no key)');
    if (!p.input) {
      recordEvent(c, p.rawAt, p.key, null);
      continue;
    }
    const sim = simulateEventRows(byMint.get(p.input.mint) ?? [], p.input.eventAtMs, p.input.roundtripPct);
    recordEvent(c, p.rawAt, p.key, sim);
    if (sim.traded) trades.push({ run_id: runId, ...eventTradeRow(p.input, sim, 'train') });
  }
  budget.charge(now() - t0);
  const rows = dedupeTradeRows(trades);
  for (let i = 0; i < rows.length; i += WORKER_BUDGET.upsertChunk) {
    await check(db.from('backtest_trades').upsert(rows.slice(i, i + WORKER_BUDGET.upsertChunk), { onConflict: TRADE_CONFLICT }), 'write event trades');
  }
  stats.detections += page.length;
  stats.traded += rows.length;
  return page.length;
}

async function simulateSlice(db: SupabaseClient, runId: number, c: WorkerCursor, budget: Budget, stats: CallStats) {
  while (c.phase === 'simulate' && budget.ok() && stats.detections < MAX_DETECTIONS_PER_CALL) {
    const table = DETECTION_TABLES[c.table];
    if (table === 'backtest_events') {
      const n = await simulateEventPage(db, runId, c, budget, stats);
      if (n < WORKER_BUDGET.pageSize) nextTable(c);
      await saveCursor(db, runId, c);
      continue;
    }
    const page = await readDetections(db, table!, c);
    if (page.length === 0) {
      nextTable(c);
      await saveCursor(db, runId, c);
      continue;
    }
    const mints = [...new Set(page.map((p) => p.input?.mint).filter((m): m is string => typeof m === 'string'))];
    // Paged: a page of detections can have more than 1000 candle windows (1m + 5m + 15m per detection).
    const byMint = await readCandles(db, mints);

    const t0 = now();
    const trades: Record<string, unknown>[] = [];
    for (const p of page) {
      // An unusable row (invalid mint / time) still advances the keyset so the run cannot loop on it.
      if (!p.rawAt || !p.key) throw new Error(`invalid ${table} row (no key)`);
      if (!p.input) {
        recordDetection(c, p.rawAt, p.key, null);
        continue;
      }
      const sim = simulateRows(byMint.get(p.input.mint) ?? [], p.input.detectedAtMs, p.input.roundtripPct);
      recordDetection(c, p.rawAt, p.key, sim.traded ? sim.finest : null);
      // Split is provisional ('train'): the global cutoff is only known once every detection is simulated. Only the
      // « Jeune calme / frénésie » candidates are stored (no other preset reads a detection row).
      if (sim.traded && isStoredDetection(p.input)) trades.push({ run_id: runId, ...tradeRow(p.input, sim, 'train') });
    }
    budget.charge(now() - t0);

    const rows = dedupeTradeRows(trades);
    for (let i = 0; i < rows.length; i += WORKER_BUDGET.upsertChunk) {
      await check(db.from('backtest_trades').upsert(rows.slice(i, i + WORKER_BUDGET.upsertChunk), { onConflict: TRADE_CONFLICT }), 'write trades');
    }
    stats.detections += page.length;
    stats.traded += rows.length;
    if (page.length < WORKER_BUDGET.pageSize) nextTable(c);
    await saveCursor(db, runId, c);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Split

async function splitRun(db: SupabaseClient, runId: number, c: WorkerCursor) {
  const { count, error } = await db.from('backtest_trades').select('mint', { count: 'exact', head: true }).eq('run_id', runId);
  if (error) throw new Error(`count trades: ${error.message}`);
  const n = count ?? 0;
  const idx = cutoffIndex(n);
  let cutoff: string | null = null;
  if (idx !== null) {
    const rows = (await check(
      db.from('backtest_trades').select('detected_at').eq('run_id', runId).order('detected_at', { ascending: true })
        .order('source', { ascending: true }).order('mint', { ascending: true }).range(idx, idx),
      'read cutoff',
    ) ?? []) as unknown as { detected_at: string }[];
    cutoff = rows[0]?.detected_at ?? null;
  }
  if (cutoff === null) {
    // Fewer than 2 traded detections: no test part (nothing can be retained).
    await check(db.from('backtest_trades').update({ split: 'train' }).eq('run_id', runId), 'split');
    c.test = 0;
  } else {
    await check(db.from('backtest_trades').update({ split: 'train' }).eq('run_id', runId).lt('detected_at', cutoff), 'split train');
    await check(db.from('backtest_trades').update({ split: 'test' }).eq('run_id', runId).gte('detected_at', cutoff), 'split test');
    const t = await db.from('backtest_trades').select('mint', { count: 'exact', head: true }).eq('run_id', runId).eq('split', 'test');
    if (t.error) throw new Error(`count test: ${t.error.message}`);
    c.test = t.count ?? 0;
  }
  c.cutoff = cutoff;
  c.traded = n;
  c.phase = 'aggregate';
  c.preset = 0;
  c.chunk = 0;
  c.narr = 0;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Aggregation: chunks of (preset, 48 distinct combos, narrative)

/** Trades of one preset with only the returns slice of `step` (rpc backtest_trades_slice, pages of 1 000). */
async function readSlice(db: SupabaseClient, runId: number, step: AggregateStep, budget: Budget): Promise<TradeRecord[]> {
  const trades: TradeRecord[] = [];
  for (let offset = 0; ; offset += WORKER_BUDGET.tradesPage) {
    const rows = (await check(
      db.rpc('backtest_trades_slice', {
        p_run: runId,
        p_bit: PRESET_BIT[step.preset],
        p_lo: step.span[0],
        p_hi: step.span[1],
        p_offset: offset,
        p_limit: WORKER_BUDGET.tradesPage,
      }),
      'read trades slice',
    ) ?? []) as unknown[];
    const t0 = now();
    for (const r of rows) {
      const t = parseTradeRow(r, step.span[0]);
      if (t) trades.push(t);
    }
    budget.charge(now() - t0);
    if (rows.length < WORKER_BUDGET.tradesPage) break;
  }
  return trades;
}

/**
 * Aggregation chunks while the call has budget: always at least one chunk, then the next ones only while the
 * synchronous compute stays under AGG_CONTINUE_MS (a worst-case chunk ≈ 1.3 s of bootstrap). The trades slice is read
 * once per (preset, combo range) and reused for its three narratives. Cursor saved after every chunk.
 */
async function aggregateSlice(db: SupabaseClient, runId: number, c: WorkerCursor, budget: Budget, stats: CallStats) {
  let cached: { step: AggregateStep; trades: TradeRecord[] } | null = null;
  const draws = new BootstrapDraws(BOOTSTRAP_ITERATIONS, BOOTSTRAP_SEED);
  let first = true;
  for (let step = aggregateStep(c); step !== null; step = aggregateStep(c)) {
    if (!first && (budget.compute >= AGG_CONTINUE_MS || !budget.ok())) break;
    first = false;
    if (!cached || !sameSlice(cached.step, step)) cached = { step, trades: await readSlice(db, runId, step, budget) };
    const t0 = now();
    const results = aggregatePreset(cached.trades, step.preset, {
      narratives: [step.narrative],
      comboRange: step.comboRange,
      returnsOffset: step.span[0],
      draws,
    }).map((r) => resultRow(runId, r));
    budget.charge(now() - t0);
    for (let i = 0; i < results.length; i += WORKER_BUDGET.upsertChunk) {
      await check(db.from('backtest_results').upsert(results.slice(i, i + WORKER_BUDGET.upsertChunk), { onConflict: RESULT_CONFLICT }), 'write results');
    }
    advanceAggregate(c);
    stats.chunks++;
    if (aggregateStep(c) !== null) await saveCursor(db, runId, c);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Finish + retention

/**
 * lab-v2 §3: backtest_runs.summary from the robust results of the run (buildRunSummary). Best effort: null on error
 * (the run still finishes). n_detections = detection-mode rows read (recordEvent also counts the events in the
 * resolutions), n_events = events simulated.
 */
async function runSummary(db: SupabaseClient, runId: number, c: WorkerCursor, nDetections: number, runAt: string | null) {
  try {
    const rows = (await check(
      db.from('backtest_results').select('*').eq('run_id', runId).eq('robust', true).limit(5000),
      'read robust results',
    ) ?? []) as unknown[];
    const results = rows.map(resultFromRow).filter((r): r is BacktestResult => r !== null);
    // n_events = events of the young event presets (legacy exploratory events of an in-flight cursor excluded).
    return buildRunSummary(results, { run_at: runAt ?? new Date().toISOString(), n_detections: nDetections, n_events: confirmatoryEvents(c) });
  } catch (e) {
    engineLog.warn('backtest summary', msg(e));
    return null;
  }
}

/**
 * Detection-mode rows only: every row read (detections + events, c.read) minus the events (simulated + pending).
 * Independent of whether backtest-worker.ts recordEvent also counts the events in the resolutions.
 */
const detectionsOnly = (c: WorkerCursor): number => Math.max(0, c.read - c.events - c.pending);

async function finishRun(db: SupabaseClient, runId: number, c: WorkerCursor, runAt: string | null) {
  // data_version.n_detections and backtest_runs.n_detections = DETECTIONS ONLY; events in events / events_pending.
  const dv = { ...finalDataVersion(c), n_detections: detectionsOnly(c) };
  c.errors = 0;
  const summary = await runSummary(db, runId, c, dv.n_detections, runAt);
  await check(
    db.from('backtest_runs').update({
      summary,
      status: 'done',
      finished_at: new Date().toISOString(),
      progress: 1,
      cursor: c,
      data_version: dv,
      n_detections: dv.n_detections,
      n_variants: GRID_COUNTS.variants,
      n_distinct_variants: GRID_COUNTS.distinctVariants,
      locked_until: null,
      error: null,
    }).eq('id', runId).eq('status', 'running'),
    'finish run',
  );
  // Retention (best effort): trades of the last 3 runs, results of the last 14.
  try {
    const ids = ((await check(db.from('backtest_runs').select('id').order('id', { ascending: false }).limit(50), 'read runs') ?? []) as unknown as {
      id: number;
    }[]).map((r) => Number(r.id));
    const { tradesBelow, resultsBelow } = retentionCutoffs(ids);
    if (tradesBelow !== null) await check(db.from('backtest_trades').delete().lt('run_id', tradesBelow), 'purge trades');
    if (resultsBelow !== null) await check(db.from('backtest_results').delete().lt('run_id', resultsBelow), 'purge results');
  } catch (e) {
    engineLog.warn('backtest retention', msg(e));
  }
}

async function failRun(db: SupabaseClient, runId: number, error: string) {
  await db.from('backtest_runs').update({
    status: 'failed',
    finished_at: new Date().toISOString(),
    locked_until: null,
    error: error.slice(0, 500),
  }).eq('id', runId).in('status', ['queued', 'running']).not('started_at', 'is', null);
}

// ---------------------------------------------------------------------------------------------------------------
// 5. Incremental event scanner (lab-v2 §2): token_snapshots → backtest_events

interface ScanStats {
  pages: number;
  snapshots: number;
  mints: number;
  events: number;
  noPool: number;
  computeMs: number;
  caughtUp: boolean;
  skipped?: 'locked';
}

/** The scanner cursor (backtest_event_state key 'cursor'), null when absent / malformed. */
async function readScannerCursor(db: SupabaseClient): Promise<ScannerCursor | null> {
  const rows = (await check(db.from('backtest_event_state').select('state').eq('key', 'cursor').limit(1), 'read scanner cursor') ??
    []) as unknown as { state: unknown }[];
  return rows.length > 0 ? parseScannerCursor(rows[0]!.state) : null;
}

/** Rows of `table` whose `column` is in `values`, read by chunks (short URLs). */
async function readIn<T>(db: SupabaseClient, table: string, select: string, column: string, values: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += SCANNER_BUDGET.inChunk) {
    const rows = (await check(db.from(table).select(select).in(column, values.slice(i, i + SCANNER_BUDGET.inChunk)), `read ${table}`) ??
      []) as unknown as T[];
    out.push(...rows);
  }
  return out;
}

/**
 * One bounded slice of the scanner: pages of snapshots after the cursor (complete 2-min buckets only), replayed per
 * mint (events.ts replayMint) with the stored per-mint states, then events (insert,
 * duplicates ignored) → mint states → cursor. Lease on the cursor row (locked_until): never two scanners at once.
 */
async function scannerSlice(db: SupabaseClient, started: number): Promise<ScanStats> {
  const stats: ScanStats = { pages: 0, snapshots: 0, mints: 0, events: 0, noPool: 0, computeMs: 0, caughtUp: false };
  const nowIso = () => new Date().toISOString();
  await check(
    db.from('backtest_event_state').upsert({ key: 'cursor', state: initialScannerCursor() }, { onConflict: 'key', ignoreDuplicates: true }),
    'init scanner cursor',
  );
  // Lease value kept so the release below only clears OUR lease (never one a later call has taken over).
  const lease = iso(Date.now() + SCANNER_BUDGET.leaseS * 1000);
  const claimed = (await check(
    db.from('backtest_event_state').update({ locked_until: lease }).eq('key', 'cursor')
      .or(`locked_until.is.null,locked_until.lt."${nowIso()}"`).select('state'),
    'lease scanner',
  ) ?? []) as unknown as { state: unknown }[];
  if (claimed.length === 0) return { ...stats, skipped: 'locked' };
  const cursor = parseScannerCursor(claimed[0]!.state) ?? initialScannerCursor();

  const facts = new Map<string, TokenFacts | null>();
  const states = new Map<string, ReplayState | null>();
  const mintsSeen = new Set<string>();
  try {
    while (stats.pages < SCANNER_BUDGET.maxPages && Date.now() - started < SCANNER_BUDGET.wallMs && stats.computeMs < SCANNER_BUDGET.computeMs) {
      let q = db.from('token_snapshots').select(SNAPSHOT_SELECT);
      const ks = snapshotKeyset(cursor);
      if (ks) q = q.or(ks);
      const rows = (await check(
        q.order('captured_at', { ascending: true }).order('id', { ascending: true }).limit(SCANNER_BUDGET.pageSize),
        'read snapshots',
      ) ?? []) as unknown as Record<string, unknown>[];
      stats.pages++;
      const times = rows.map((r) => (typeof r['captured_at'] === 'string' ? Date.parse(r['captured_at']) : Number.NaN));
      if (times.some((t) => !Number.isFinite(t))) throw new Error('invalid captured_at');
      const { count, tail } = completePrefix(times, rows.length === SCANNER_BUDGET.pageSize, Date.now());
      if (count === 0) {
        if (tail) {
          stats.caughtUp = true;
          cursor.caughtUpAt = nowIso();
        }
        break;
      }
      const take = rows.slice(0, count);

      // Facts, first dex and states of the page's new mints.
      const bySnapMint = new Map<string, ReturnType<typeof parseSnapshotRow>[]>();
      for (const r of take) {
        if (typeof r['mint'] !== 'string') continue;
        const list = bySnapMint.get(r['mint']) ?? [];
        list.push(parseSnapshotRow(r));
        bySnapMint.set(r['mint'], list);
      }
      const missing = [...bySnapMint.keys()].filter((m) => !facts.has(m));
      if (missing.length > 0) {
        const [tokRows, outRows, stateRows] = await Promise.all([
          readIn<Record<string, unknown>>(db, 'tokens', FACTS_SELECT, 'mint', missing),
          readIn<{ mint: string; entry_dex_id: unknown }>(db, 'signal_outcomes', 'mint, entry_dex_id', 'mint', missing),
          readIn<{ key: string; state: unknown }>(db, 'backtest_event_state', 'key, state', 'key', missing),
        ]);
        const firstDex = new Map(outRows.map((o) => [o.mint, o.entry_dex_id]));
        const tokByMint = new Map(tokRows.map((t) => [String(t['mint']), t]));
        const stByMint = new Map(stateRows.map((r) => [r.key, r.state]));
        const t0 = now();
        for (const m of missing) {
          facts.set(m, tokByMint.has(m) ? tokenFactsFromRow(tokByMint.get(m), firstDex.get(m) ?? null) : null);
          states.set(m, stByMint.has(m) ? parseReplayState(stByMint.get(m)) : null);
        }
        stats.computeMs += now() - t0;
      }

      // Replay per mint.
      const t0 = now();
      const events: Parameters<typeof eventInsertRows>[0][number][] = [];
      const gaps: ReturnType<typeof replayMint>['gaps'][] = [];
      const touched: string[] = [];
      for (const [mint, snaps] of bySnapMint) {
        const f = facts.get(mint);
        if (!f) continue; // token row gone (its snapshots are deleted with it)
        const res = replayMint(f, snaps.filter((x): x is NonNullable<typeof x> => x !== null), states.get(mint) ?? null);
        if (res.processed === 0) continue;
        states.set(mint, res.state);
        touched.push(mint);
        mintsSeen.add(mint);
        events.push(...res.events);
        gaps.push(res.gaps);
      }
      const { rows: eventRows, noPool } = eventInsertRows(events);
      const stateUpserts = touched.map((m) => ({ key: m, state: boundedState(states.get(m) as ReplayState), updated_at: nowIso() }));
      stats.computeMs += now() - t0;

      // Writes: events (first one per (preset, mint) wins), then mint states, then the cursor.
      const inserted: { preset: unknown }[] = [];
      for (let i = 0; i < eventRows.length; i += SCANNER_BUDGET.upsertChunk) {
        const ins = (await check(
          db.from('backtest_events').upsert(eventRows.slice(i, i + SCANNER_BUDGET.upsertChunk), { onConflict: 'preset,mint', ignoreDuplicates: true })
            .select('preset'),
          'write events',
        ) ?? []) as unknown as { preset: unknown }[];
        inserted.push(...ins);
      }
      for (let i = 0; i < stateUpserts.length; i += SCANNER_BUDGET.upsertChunk) {
        await check(db.from('backtest_event_state').upsert(stateUpserts.slice(i, i + SCANNER_BUDGET.upsertChunk), { onConflict: 'key' }), 'write states');
      }
      const last = take[take.length - 1];
      cursor.at = String(last!['captured_at']);
      cursor.id = Number(last!['id']);
      cursor.snapshots += take.length;
      cursor.noPool += noPool;
      accountScan(cursor, inserted, gaps);
      if (tail) {
        stats.caughtUp = true;
        cursor.caughtUpAt = nowIso();
      }
      await check(db.from('backtest_event_state').update({ state: cursor, updated_at: nowIso() }).eq('key', 'cursor'), 'save scanner cursor');
      stats.snapshots += take.length;
      stats.events += inserted.length;
      stats.noPool += noPool;
      if (tail) break;
    }
    if (stats.caughtUp) {
      await check(db.from('backtest_event_state').update({ state: cursor, updated_at: nowIso() }).eq('key', 'cursor'), 'save scanner cursor');
    }
  } finally {
    await db.from('backtest_event_state').update({ locked_until: null }).eq('key', 'cursor').eq('locked_until', lease)
      .then(() => undefined, () => undefined);
  }
  stats.mints = mintsSeen.size;
  stats.computeMs = Math.round(stats.computeMs);
  return stats;
}

// ---------------------------------------------------------------------------------------------------------------

export interface BacktestRunDeps {
  readonly db: SupabaseClient;
}

/**
 * Port Node de l'Edge Function `backtest-run` (job `backtest-run`, chaque minute). SIMULATION sur données passées.
 * Corps inchangé (bornes de calcul Edge conservées, BENCH.md §9 P8) ; `Response.json(out)` devient la valeur
 * renvoyée et la réponse 500 une exception (après libération du bail, comme avant).
 */
export async function runBacktestRun(deps: BacktestRunDeps): Promise<Record<string, unknown>> {
  const started = Date.now();
  const db = deps.db;
  const stats: CallStats = { detections: 0, traded: 0, chunks: 0, computeMs: 0 };
  let runId: number | null = null;
  let cursor: WorkerCursor | null = null;

  try {
    // 0. Oldest active run + lease.
    const runs = (await check(
      db.from('backtest_runs').select('id, status, cursor, started_at, created_at').in('status', ['queued', 'running'])
        .order('created_at', { ascending: true }).limit(1),
      'read runs',
    ) ?? []) as unknown as RunRow[];
    // lab-v2: no active run → advance the event scanner. A queued run waits until the scanner reached the tail of
    // token_snapshots (every event up to the run start recorded), at most RUN_WAIT_MAX_MS after its creation.
    if (runs.length === 0 || (runs[0]!.status === 'queued' && !runMayStart(await readScannerCursor(db), Date.parse(runs[0]!.created_at), Date.now()))) {
      const scanner = await scannerSlice(db, started);
      const out = { idle: runs.length === 0, waiting: runs.length > 0 ? 'scanner' : undefined, scanner, ms: Date.now() - started };
      engineLog.info('backtest scanner', JSON.stringify(out));
      return out;
    }
    const run = runs[0];
    runId = Number(run!.id);
    const claimed = (await check(
      db.from('backtest_runs').update({ locked_until: iso(Date.now() + WORKER_BUDGET.leaseS * 1000) }).eq('id', runId)
        .in('status', ['queued', 'running']).or(`locked_until.is.null,locked_until.lt."${iso(Date.now())}"`).select('id'),
      'lease run',
    ) ?? []) as unknown[];
    if (claimed.length === 0) {
      runId = null; // owned by another call: never touch it
      return { skipped: 'locked', ms: Date.now() - started };
    }

    if (run!.status === 'running' && run!.started_at && Date.now() - Date.parse(run!.started_at) > RUN_TIMEOUT_MS) {
      await failRun(db, runId, 'Backtest interrompu : plus de 12 h sans se terminer.');
      return { run: runId, failed: 'timeout', ms: Date.now() - started };
    }

    cursor = run!.status === 'running' ? parseCursor(run!.cursor) : null;
    if (cursor && cursor.errors >= MAX_CONSECUTIVE_ERRORS) {
      await failRun(db, runId, `Backtest abandonné après ${MAX_CONSECUTIVE_ERRORS} échecs consécutifs.`);
      return { run: runId, failed: 'errors', ms: Date.now() - started };
    }
    if (!cursor) {
      // Start (or restart from scratch when the cursor is unreadable): estimated total for the progress bar.
      let total = 0;
      for (const table of DETECTION_TABLES) {
        const s = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
        const { count } = await db.from(table).select('mint', { count: 'exact', head: true })
          .gt(table === 'backtest_events' ? 'event_at' : 'detected_at', s);
        total += count ?? 0;
      }
      cursor = initialCursor(Date.now(), total);
      await check(
        db.from('backtest_runs').update({
          status: 'running',
          started_at: run!.started_at ?? new Date().toISOString(),
          params: gridParams(),
          n_variants: GRID_COUNTS.variants,
          n_distinct_variants: GRID_COUNTS.distinctVariants,
          cursor,
          progress: 0,
          error: null,
        }).eq('id', runId).in('status', ['queued', 'running']),
        'start run',
      );
    }

    // Charge the error counter before the work (a call killed by the CPU limit never reaches its catch).
    cursor.errors++;
    await saveCursor(db, runId, cursor);

    const budget = new Budget(started);
    const fresh = () => budget.compute === 0 && stats.detections === 0;
    if (cursor.phase === 'simulate') await simulateSlice(db, runId, cursor, budget, stats);
    if (cursor.phase === 'split' && budget.ok()) await splitRun(db, runId, cursor);
    // Aggregation (bootstrap) is the heaviest step: only in a call that did nothing else, chunk by chunk.
    if (cursor.phase === 'aggregate' && aggregateStep(cursor) !== null && fresh()) await aggregateSlice(db, runId, cursor, budget, stats);

    stats.computeMs = Math.round(budget.compute);
    if (cursor.phase === 'aggregate' && aggregateStep(cursor) === null) {
      await finishRun(db, runId, cursor, run!.started_at ?? null);
    } else {
      cursor.errors = 0;
      await saveCursor(db, runId, cursor, { locked_until: null, error: null });
    }
    const out = { run: runId, phase: cursor.phase, ...stats, progress: progressOf(cursor), ms: Date.now() - started };
    engineLog.info('backtest', JSON.stringify(out));
    return out;
  } catch (e) {
    engineLog.error('backtest failed', msg(e));
    if (runId !== null) {
      // The error counter was charged before the work; keep it, store the reason, release the lease.
      await db.from('backtest_runs').update({ error: `Échec d'une tranche du backtest : ${msg(e)}`.slice(0, 500), locked_until: null })
        .eq('id', runId).then(() => undefined, () => undefined);
    }
    throw new Error('Backtest failed', { cause: e });
  }
}
