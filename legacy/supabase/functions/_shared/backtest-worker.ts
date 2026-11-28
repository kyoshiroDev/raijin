// State machine of the backtest-run worker (feat/strategy-lab, docs/contracts/strategy-lab.md §B6). Pure: no I/O, no
// Date.now(), no zod. The engine, grid, metrics and aggregation live in ./backtest.ts (scanner-quant); this file only
// decides what one worker call does and converts the engine's output into database rows.
//
// A run goes through backtest_runs.cursor (jsonb, bounded):
//   1. 'simulate'  : detections of signal_outcomes, then preset_signals, with since < detected_at <= until (until =
//                    run start, since = until − 30 days: the candle retention), keyset-paginated on (detected_at, key);
//                    then (lab-v2) the events of backtest_events with since < event_at <= until, keyset on
//                    (event_at, id) (keysetFilter(after, 'id', 'event_at')). Each traded detection → one backtest_trades
//                    row (tradeRow), each simulated event → one row (eventTradeRow, source 'backtest_events'); an event
//                    without a 1-minute entry candle is counted pending (recordEvent), not written. Resolution counts and
//                    the newest detected_at accumulate in the cursor.
//   2. 'split'     : global chronological 70 / 30 cutoff over the run's traded rows written to the split column
//                    (informational since lab-v2: aggregatePreset recomputes the cutoff per preset on its own trades).
//   3. 'aggregate' : chunks of (preset, combo range of AGG_CHUNK_COMBOS distinct combos, narrative), in that order
//                    (backtest.ts aggregatePreset with { narratives, comboRange, returnsOffset }); the worker reads
//                    only the returns slice [lo, hi] of the chunk in SQL (comboIndexSpan) and reuses it for the three
//                    narratives of the range. The bootstrap costs ~27 ms per retained variant at 2 400 test trades, so
//                    a chunk is bounded (≤ 48 variants ≈ 1.3 s worst case) and the position (preset, chunk, narr)
//                    is persisted after every chunk.
//   4. done.
// Every step is idempotent (upserts on primary keys, split recomputed from the stored rows), so a call that dies
// half-way is simply replayed by the next one.
import {
  type BacktestPreset,
  type BacktestResult,
  comboIndexSpan,
  comboInPresetGrid,
  DELAYS_MIN,
  DETECTION_ROW_BIT,
  DISTINCT_COMBOS,
  GRID_COUNTS,
  type Narrative,
  NARRATIVES,
  PRESET_BIT,
  PRESET_FLAGS_MAX,
  PRESET_MODE,
  PRESETS,
} from './backtest.ts';
import type { CandleTf } from './candles.ts';

export type WorkerPhase = 'simulate' | 'split' | 'aggregate';
export type DetectionTable = 'signal_outcomes' | 'preset_signals' | 'backtest_events';
/** Simulation order of the tables: the two detection tables (detection mode), then the events (event mode). */
export const DETECTION_TABLES: readonly DetectionTable[] = ['signal_outcomes', 'preset_signals', 'backtest_events'];

export interface Resolutions {
  '1m': number;
  '5m': number;
  '15m': number;
  none: number;
}

export interface WorkerCursor {
  v: 1;
  phase: WorkerPhase;
  /** ISO bounds of the detections of the run (frozen at start). */
  since: string;
  until: string;
  /** Index in DETECTION_TABLES of the table being simulated. */
  table: number;
  /** Keyset position in that table: raw detected_at string as returned by PostgREST (µs kept) and key. */
  after: { detected_at: string; key: string } | null;
  /** Detections read so far (all tables), and the estimated total at start (progress only). */
  read: number;
  total: number;
  /** Detections by finest timeframe of their merged path ('none' = no candle, not stored). */
  res: Resolutions;
  /** Newest detected_at seen (ISO), null before the first detection. */
  max: string | null;
  /** Split cutoff once computed: detected_at of the first test detection, raw PostgREST string (µs kept). */
  cutoff: string | null;
  /** Traded detections (backtest_trades rows) and how many are test, once the split is done. */
  traded: number;
  test: number;
  /** Next aggregation chunk: preset index (PRESETS order), combo chunk index, narrative index (NARRATIVES order). */
  preset: number;
  chunk: number;
  narr: number;
  /** Consecutive failed calls (the run fails at MAX_CONSECUTIVE_ERRORS). */
  errors: number;
  /** Events simulated (traded) and events pending (no 1-minute entry candle yet). Absent in v1 cursors → 0. */
  events: number;
  pending: number;
  /** Simulated events by finest timeframe of their path (kept apart from `res`, which is detections only). */
  eres: Resolutions;
  /**
   * Legacy counters of the removed exploratory presets (fix/lab-priority-exploratory): still parsed so an in-flight
   * cursor stays valid, never incremented since chore/slim-down.
   */
  xevents: number;
  xpending: number;
}

export const CANDLE_RETENTION_MS = 30 * 24 * 3_600_000;
export const MAX_CONSECUTIVE_ERRORS = 5;
/** A run still running this long after its start is failed (stuck). */
export const RUN_TIMEOUT_MS = 12 * 3_600_000;
/** backtest_trades are kept for the last N runs; backtest_results for the last M runs. */
export const KEEP_TRADES_RUNS = 3;
export const KEEP_RESULTS_RUNS = 14;

/**
 * Budget of one worker call. Edge Functions allow ~2 s of CPU per call: the synchronous work (decode + simulate +
 * aggregate) stops at computeMs, and no new page is started after wallMs (pg_net waits 55 s).
 */
export const WORKER_BUDGET = {
  computeMs: 1_200,
  wallMs: 30_000,
  /** Detections per page (one candle read per page: ≤ ~4 rows per mint, under the PostgREST 1 000-row cap). */
  pageSize: 25,
  /** Detections read per call at most. */
  maxDetectionsPerCall: 300,
  /** Lease of the call on the run (seconds). */
  leaseS: 55,
  /** Rows per upsert request. */
  upsertChunk: 500,
  /** backtest_trades rows per read when aggregating (PostgREST max rows). */
  tradesPage: 1_000,
} as const;

/** Progress weights: simulation 80 %, split 2 %, aggregation 18 %. */
const SIM_W = 0.8;
const SPLIT_W = 0.02;

const emptyRes = (): Resolutions => ({ '1m': 0, '5m': 0, '15m': 0, none: 0 });

/** Cursor of a run that starts now (nowMs) with `total` detections estimated. */
export function initialCursor(nowMs: number, total: number): WorkerCursor {
  if (!Number.isFinite(nowMs)) throw new RangeError('initialCursor: invalid now');
  return {
    v: 1,
    phase: 'simulate',
    since: new Date(nowMs - CANDLE_RETENTION_MS).toISOString(),
    until: new Date(nowMs).toISOString(),
    table: 0,
    after: null,
    read: 0,
    total: Number.isFinite(total) && total > 0 ? Math.floor(total) : 0,
    res: emptyRes(),
    max: null,
    cutoff: null,
    traded: 0,
    test: 0,
    preset: 0,
    chunk: 0,
    narr: 0,
    errors: 0,
    events: 0,
    pending: 0,
    eres: emptyRes(),
    xevents: 0,
    xpending: 0,
  };
}

const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const nonNegInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** backtest_runs.cursor → WorkerCursor, or null when absent / malformed (the run then restarts from scratch). */
export function parseCursor(raw: unknown): WorkerCursor | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || (r.phase !== 'simulate' && r.phase !== 'split' && r.phase !== 'aggregate')) return null;
  if (!isIso(r.since) || !isIso(r.until)) return null;
  const table = nonNegInt(r.table);
  const read = nonNegInt(r.read);
  const total = nonNegInt(r.total);
  const traded = nonNegInt(r.traded);
  const test = nonNegInt(r.test);
  const preset = nonNegInt(r.preset);
  const chunk = nonNegInt(r.chunk);
  const narr = nonNegInt(r.narr);
  const errors = nonNegInt(r.errors);
  const events = r.events === undefined ? 0 : nonNegInt(r.events);
  const pending = r.pending === undefined ? 0 : nonNegInt(r.pending);
  if (events === null || pending === null) return null;
  const xevents = r.xevents === undefined ? 0 : nonNegInt(r.xevents);
  const xpending = r.xpending === undefined ? 0 : nonNegInt(r.xpending);
  if (xevents === null || xpending === null || xevents > events || xpending > pending) return null;
  const eres = emptyRes();
  if (r.eres !== undefined) {
    const e = r.eres as Record<string, unknown> | null;
    if (typeof e !== 'object' || e === null) return null;
    for (const k of ['1m', '5m', '15m', 'none'] as const) {
      const n = nonNegInt(e[k]);
      if (n === null) return null;
      eres[k] = n;
    }
  }
  if (table === null || table > DETECTION_TABLES.length || read === null || total === null || traded === null ||
    test === null || preset === null || preset > PRESETS.length || errors === null || chunk === null || chunk >= AGG_CHUNKS ||
    narr === null || narr >= NARRATIVES.length) return null;
  let after: WorkerCursor['after'] = null;
  if (r.after !== null && r.after !== undefined) {
    const a = r.after as Record<string, unknown>;
    if (typeof a !== 'object' || !isIso(a.detected_at) || typeof a.key !== 'string' || a.key.length === 0 || a.key.length > 64) {
      return null;
    }
    after = { detected_at: a.detected_at, key: a.key };
  }
  const resRaw = r.res as Record<string, unknown> | null;
  if (typeof resRaw !== 'object' || resRaw === null) return null;
  const res = emptyRes();
  for (const k of ['1m', '5m', '15m', 'none'] as const) {
    const n = nonNegInt(resRaw[k]);
    if (n === null) return null;
    res[k] = n;
  }
  if (r.max !== null && !isIso(r.max)) return null;
  if (r.cutoff !== null && !isIso(r.cutoff)) return null;
  return {
    v: 1,
    phase: r.phase,
    since: r.since,
    until: r.until,
    table,
    after,
    read,
    total,
    res,
    max: (r.max as string | null) ?? null,
    cutoff: (r.cutoff as string | null) ?? null,
    traded,
    test,
    preset,
    chunk,
    narr,
    errors,
    events,
    pending,
    eres,
    xevents,
    xpending,
  };
}

/** Progress 0..1 of a cursor (simulation by detections read, then split, then presets aggregated). */
export function progressOf(c: WorkerCursor): number {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  if (c.phase === 'simulate') {
    const denom = Math.max(c.total, c.read, 1);
    return clamp(Math.min(0.99, c.read / denom) * SIM_W);
  }
  if (c.phase === 'split') return SIM_W;
  const done = (c.preset * AGG_CHUNKS + c.chunk) * NARRATIVES.length + c.narr;
  return clamp(SIM_W + SPLIT_W + (1 - SIM_W - SPLIT_W) * (done / AGG_TOTAL_STEPS));
}

/** Accounts one detection read during the simulation (finest timeframe of its path, null = no candle). */
export function recordDetection(c: WorkerCursor, detectedAt: string, key: string, finest: CandleTf | null): void {
  c.read++;
  c.res[finest ?? 'none']++;
  c.after = { detected_at: detectedAt, key };
  if (finest !== null && (c.max === null || Date.parse(detectedAt) > Date.parse(c.max))) c.max = new Date(Date.parse(detectedAt)).toISOString();
}

/**
 * Accounts one event read during the simulation (backtest_events, keyset (event_at, id)): traded → events + eres (the
 * event resolutions); pending (no 1-minute entry candle, or an unusable row: sim null) → pending only. Detection counts
 * (res, max) are never touched: n_detections stays detection mode only.
 */
export function recordEvent(
  c: WorkerCursor,
  eventAt: string,
  key: string,
  sim: { traded: boolean; finest: CandleTf | null; pending: boolean } | null,
): void {
  c.read++;
  c.after = { detected_at: eventAt, key };
  if (sim && sim.traded) {
    c.events++;
    c.eres[sim.finest ?? 'none']++;
  } else {
    c.pending++;
  }
}

/** Events simulated (the summary's n_events; legacy exploratory events of an in-flight cursor excluded). */
export const confirmatoryEvents = (c: Pick<WorkerCursor, 'events' | 'xevents'>): number => Math.max(0, c.events - (c.xevents ?? 0));

/** Moves the simulation to the next detection table, or to the split when every table is done. */
export function nextTable(c: WorkerCursor): void {
  c.table++;
  c.after = null;
  if (c.table >= DETECTION_TABLES.length) c.phase = 'split';
}

/**
 * Row index (0-based, detections sorted by detected_at) of the first TEST detection, for n traded detections:
 * identical to backtest.ts chronoCutoff (cutoff = ts[nTrain]); null when n < 2.
 */
export function cutoffIndex(n: number, trainFrac = 0.7): number | null {
  if (!Number.isSafeInteger(n) || n < 2 || !(trainFrac > 0 && trainFrac < 1)) return null;
  return Math.min(n - 1, Math.max(1, Math.round(trainFrac * n)));
}

/**
 * PostgREST keyset filter (or=…) of the rows after `after` in (time, key) order. timeColumn = 'detected_at' for the
 * detection tables, 'event_at' for backtest_events (the cursor field keeps the name detected_at).
 */
export function keysetFilter(
  after: WorkerCursor['after'],
  keyColumn: 'mint' | 'id',
  timeColumn: 'detected_at' | 'event_at' = 'detected_at',
): string | null {
  if (!after) return null;
  // Quoted values: the timestamp contains ':' '+' '.'; the key is a base58 mint or a decimal id (validated upstream).
  if (!/^[1-9A-HJ-NP-Za-km-z0-9]{1,64}$/.test(after.key)) return null;
  const at = after.detected_at.replace(/"/g, '');
  return `${timeColumn}.gt."${at}",and(${timeColumn}.eq."${at}",${keyColumn}.gt.${after.key})`;
}

/**
 * Distinct combos per aggregation chunk. A multiple of the number of delays (delay is the innermost grid axis), so
 * every chunk covers every delay of its combos: the « has at least one entry » test of presetTrades, evaluated on the
 * returns slice, then gives the same mint selection as on the full array.
 */
export const AGG_CHUNK_COMBOS = 48;
export const AGG_CHUNKS = Math.ceil(DISTINCT_COMBOS.length / AGG_CHUNK_COMBOS);

/**
 * The chunk holds at least one combo of the preset's grid. Always true for the 288-combo presets; for the young-calm
 * presets (YOUNG_GRID, 9 all_x2 combos) only chunk 0 does: advanceAggregate skips the others (no empty slice read).
 */
export function chunkHasCombos(preset: BacktestPreset, chunk: number): boolean {
  const from = chunk * AGG_CHUNK_COMBOS;
  const to = Math.min(DISTINCT_COMBOS.length, from + AGG_CHUNK_COMBOS);
  for (let i = from; i < to; i++) if (comboInPresetGrid(preset, DISTINCT_COMBOS[i])) return true;
  return false;
}

/** Aggregation steps of a run: Σ over presets of (chunks with combos) × narratives. */
export const AGG_TOTAL_STEPS = PRESETS.reduce((n, p) => {
  let chunks = 0;
  for (let k = 0; k < AGG_CHUNKS; k++) if (chunkHasCombos(p, k)) chunks++;
  return n + chunks * NARRATIVES.length;
}, 0);

export interface AggregateStep {
  preset: BacktestPreset;
  narrative: Narrative;
  /** [from, to) slice of DISTINCT_COMBOS. */
  comboRange: [number, number];
  /** Inclusive combo-index span of that slice: SQL returns[lo + 1 : hi + 1], returnsOffset = lo. */
  span: [number, number];
}

/** The chunk the cursor points at, or null when the aggregation is complete. */
export function aggregateStep(c: Pick<WorkerCursor, 'preset' | 'chunk' | 'narr'>): AggregateStep | null {
  if (c.preset >= PRESETS.length) return null;
  const from = c.chunk * AGG_CHUNK_COMBOS;
  const to = Math.min(DISTINCT_COMBOS.length, from + AGG_CHUNK_COMBOS);
  const span = comboIndexSpan([from, to]);
  const narrative = NARRATIVES[c.narr];
  if (!span || !narrative) return null;
  return { preset: PRESETS[c.preset], narrative, comboRange: [from, to], span };
}

/**
 * Moves the cursor to the next chunk: narrative, then combo range, then preset. Chunks without any combo of the
 * preset's grid (young-calm presets beyond chunk 0) are skipped.
 */
export function advanceAggregate(c: WorkerCursor): void {
  c.narr++;
  if (c.narr < NARRATIVES.length) return;
  c.narr = 0;
  for (;;) {
    c.chunk++;
    if (c.chunk >= AGG_CHUNKS) {
      c.chunk = 0;
      c.preset++;
    }
    if (c.preset >= PRESETS.length || chunkHasCombos(PRESETS[c.preset], c.chunk)) return;
  }
}

/** Same trades slice (preset + combo span) as the previous chunk: the rows already read can be reused. */
export const sameSlice = (a: AggregateStep | null, b: AggregateStep | null): boolean =>
  a !== null && b !== null && a.preset === b.preset && a.span[0] === b.span[0] && a.span[1] === b.span[1];

if (AGG_CHUNK_COMBOS % DELAYS_MIN.length !== 0) throw new Error('AGG_CHUNK_COMBOS must be a multiple of the delays');

/**
 * preset_flags values that contain the preset's bit: the IN list of the trades read. Detection presets: the odd
 * values (DETECTION_ROW_BIT set) of the detection bits (1, young_calm 1024, young_frenzy 2048) → young_calm: [1025,
 * 3073], young_frenzy: [2049, 3073]. Event presets: exactly their single bit.
 */
export function presetFlagValues(preset: BacktestPreset): number[] {
  const bit = PRESET_BIT[preset];
  if (PRESET_MODE[preset] === 'event') return [bit];
  const detBits = PRESETS.filter((p) => PRESET_MODE[p] === 'detection').reduce((m, p) => m | PRESET_BIT[p], DETECTION_ROW_BIT);
  const out: number[] = [];
  for (let f = 1; f <= PRESET_FLAGS_MAX; f += 2) if ((f & bit) !== 0 && (f & ~detBits) === 0) out.push(f);
  return out;
}

/** Number rounding for real columns (6 significant decimals are plenty; NaN / Infinity → null). */
const realOrNull = (x: number | null | undefined): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null;

/** backtest.ts BacktestResult → public.backtest_results row (time_exit_h null → 0 = no time exit). */
export function resultRow(runId: number, r: BacktestResult) {
  const pf = realOrNull(r.profit_factor);
  return {
    run_id: runId,
    preset: r.preset,
    exit: r.exit,
    sl_pct: r.sl_pct,
    breakeven: r.breakeven,
    time_exit_h: r.time_exit_h ?? 0,
    delay_min: r.delay_min,
    narrative: r.narrative,
    split: r.split,
    trades: r.trades,
    win_rate: realOrNull(r.win_rate),
    avg_win_pct: realOrNull(r.avg_win_pct),
    avg_loss_pct: realOrNull(r.avg_loss_pct),
    avg_net_pct: realOrNull(r.avg_net_pct),
    avg_net_sol: realOrNull(r.avg_net_sol),
    profit_factor: pf !== null && pf >= 0 && pf < 1e9 ? pf : null,
    max_drawdown_sol: realOrNull(r.max_drawdown_sol),
    worst_losing_streak: r.worst_losing_streak,
    ci_low: realOrNull(r.ci_low),
    ci_high: realOrNull(r.ci_high),
    ci_contains_zero: r.ci_contains_zero,
    open_at_end: r.open_at_end,
    retained: r.retained,
    robust: r.robust,
  };
}
export type BacktestResultRow = ReturnType<typeof resultRow>;

/** backtest_runs.data_version of a finished simulation + split (same keys as backtest.ts DataVersion). */
export function finalDataVersion(c: WorkerCursor) {
  const nDetections = c.res['1m'] + c.res['5m'] + c.res['15m'] + c.res.none;
  return {
    n_detections: nDetections,
    traded: c.traded,
    resolutions: { ...c.res },
    cutoff_at: c.cutoff,
    max_detected_at: c.max,
    train: Math.max(0, c.traded - c.test),
    test: c.test,
    since: c.since,
    until: c.until,
    events: c.events,
    events_pending: c.pending,
    event_resolutions: { ...c.eres },
    n_variants: GRID_COUNTS.variants,
    n_distinct_variants: GRID_COUNTS.distinctVariants,
  };
}

/** Run ids whose backtest_trades / backtest_results must be deleted, from every run id (any order). */
export function retentionCutoffs(runIds: readonly number[]): { tradesBelow: number | null; resultsBelow: number | null } {
  const ids = [...new Set((Array.isArray(runIds) ? runIds : []).filter((x) => Number.isSafeInteger(x) && x > 0))].sort((a, b) => b - a);
  return {
    tradesBelow: ids.length > KEEP_TRADES_RUNS ? ids[KEEP_TRADES_RUNS - 1] : null,
    resultsBelow: ids.length > KEEP_RESULTS_RUNS ? ids[KEEP_RESULTS_RUNS - 1] : null,
  };
}

/** Columns of the backtest_trades primary key (the upsert conflict target). */
export const TRADE_KEY_COLUMNS = ['run_id', 'source', 'mint', 'detected_at', 'preset_flags'] as const;

/**
 * Drops rows that repeat the primary key of an earlier row of the same batch (first kept).
 * Why: several preset_signals rows of one mint (e.g. young_calm and momentum matched in the same scan) give
 * detection-mode trades with the same (run, source, mint, detected_at, flags); Postgres refuses an upsert batch that
 * touches one row twice ("ON CONFLICT DO UPDATE command cannot affect row a second time"), which failed runs 5 and 6.
 */
export function dedupeTradeRows<T extends Record<string, unknown>>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const key = TRADE_KEY_COLUMNS.map((c) => String(r[c])).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
