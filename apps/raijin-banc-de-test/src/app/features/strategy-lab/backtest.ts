// Pure parsing / ranking / naming of the backtest laboratory (public.backtest_runs, public.backtest_results).
// SIMULATION ONLY: past data replayed, nothing predicts the future. Rows are written by the backtest-run Edge
// Function (service_role) and read here (SELECT authenticated); every field is parsed defensively.
//
// Column semantics, checked against supabase/migrations/20261119090000_backtest_lab.sql and _shared/backtest.ts:
// - backtest_results.split ∈ 'train' | 'test'; narrative ∈ 'all' | 'gta' | 'other'; only DISTINCT variants are
//   written (no breakeven row for single-leg exits); retained / robust repeated on the train and test rows.
// - win_rate is a fraction (0–1); avg_*_pct and ci_low / ci_high are percentages of the stake (12.5 = +12,5 %).
// - time_exit_h 0 = no time exit; delay_min 0 = immediate entry; profit_factor null = no loss (infinite) or no trade.
// - backtest_runs.progress is a fraction (0–1); data_version = { n_detections, resolutions: { '1m', '5m', '15m',
//   none } (counts by FINEST timeframe), cutoff_at, max_detected_at, train, test }.
// - lab-v2 (docs/contracts/lab-v2.md): event-mode presets (momentum, young_24h, young_3h, post_migration,
//   narrative_leader), data_version.n_events / pending candles, backtest_runs.summary (jsonb, §3).
// - young-calm (docs/contracts/young-calm.md §5): young_calm / young_frenzy (detection mode) and young_calm_ev /
//   young_frenzy_ev (event mode).
// - slim-down (2026-11-21): ONLY those four presets are shown, exit all_x2 (×2), SL −20 / −30 / −40 %, no breakeven,
//   no time exit, entry delay 0 or 2 min = 6 variants per preset. Rows of the removed presets (all, mc_300k_1m,
//   momentum, young_24h, young_3h, post_migration, narrative_leader, *_explo) or exits are ignored (archived runs).
// The parser stays tolerant (percent progress / win rate, alternate data_version keys, fraction shares) in case a
// row is written by an older or local script.

export type RunStatus = 'queued' | 'running' | 'done' | 'failed';
export type RunTrigger = 'nightly' | 'manual';
export type LabPreset = 'young_calm' | 'young_frenzy' | 'young_calm_ev' | 'young_frenzy_ev';
export type LabExit = 'all_x2';
export type LabNarrative = 'all' | 'gta' | 'other';
export type LabSplit = 'train' | 'test';

/** Columns of backtest_runs before lab-v2 (column-level grant); used when `summary` is not readable yet. */
export const LEGACY_RUN_COLUMNS =
  'id,status,trigger,data_version,n_detections,n_variants,n_distinct_variants,progress,created_at,started_at,finished_at';
export const RUN_COLUMNS = `${LEGACY_RUN_COLUMNS},summary`;
export const RESULT_COLUMNS =
  'run_id,preset,exit,sl_pct,breakeven,time_exit_h,delay_min,narrative,split,trades,win_rate,avg_win_pct,avg_loss_pct,' +
  'avg_net_pct,avg_net_sol,profit_factor,max_drawdown_sol,worst_losing_streak,ci_low,ci_high,ci_contains_zero,open_at_end,' +
  'retained,robust';
/** Retained rows read for one run (PostgREST max rows); reaching it is reported as truncated. */
export const RESULT_FETCH_LIMIT = 1000;

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'En file d’attente',
  running: 'En cours',
  done: 'Terminé',
  failed: 'Échec',
};

export const RUN_STATUS_CLASS: Record<RunStatus, string> = {
  queued: 'bg-surface-2 text-muted',
  running: 'bg-info/15 text-info',
  done: 'bg-bull/15 text-bull',
  failed: 'bg-bear/15 text-bear',
};

export const TRIGGER_LABEL: Record<RunTrigger, string> = { nightly: 'nocturne', manual: 'manuel' };

export const PRESET_LABEL: Record<LabPreset, string> = {
  young_calm: 'Jeune calme (à la détection)',
  young_frenzy: 'Jeune frénésie (à la détection)',
  young_calm_ev: 'Jeune calme (événement)',
  young_frenzy_ev: 'Jeune frénésie (événement)',
};

export const EXIT_LABEL: Record<LabExit, string> = {
  all_x2: 'Tout à ×2',
};

export const NARRATIVES: readonly { id: LabNarrative; label: string }[] = [
  { id: 'all', label: 'Tous' },
  { id: 'gta', label: 'GTA' },
  { id: 'other', label: 'Hors GTA' },
];

const STATUSES: readonly string[] = ['queued', 'running', 'done', 'failed'];
const PRESETS: readonly string[] = Object.keys(PRESET_LABEL);
const EXITS: readonly string[] = Object.keys(EXIT_LABEL);
const NARRATIVE_IDS: readonly string[] = NARRATIVES.map((n) => n.id);

export interface DataVersion {
  detections: number | null;
  /** Train / test cutoff (ISO date). */
  cutoff: string | null;
  maxDetectedAt: string | null;
  /** Share (0–1) of the detections by finest candle timeframe: 1 min, 5 min, 15 min only, no candle. */
  share1m: number | null;
  share5m: number | null;
  share15mOnly: number | null;
  shareNone: number | null;
  /** Event-mode signals (lab-v2), null when the run does not report them. */
  events: number | null;
  /** Events not simulated yet for lack of 1 min candles covering the entry (« en attente de bougies »). */
  pendingCandles: number | null;
}

export interface BacktestRun {
  id: string;
  status: RunStatus;
  trigger: RunTrigger | null;
  nDetections: number | null;
  nVariants: number | null;
  nDistinctVariants: number | null;
  /** 0–1, null when unknown. */
  progress: number | null;
  failed: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  data: DataVersion;
  /** Raw backtest_runs.summary (parsed by lab-summary.ts); null when absent or not readable. */
  summaryRaw: unknown;
}

export interface VariantKey {
  preset: LabPreset;
  exit: LabExit;
  slPct: number;
  breakeven: boolean;
  /** Hours, null = no time exit. */
  timeExitH: number | null;
  delayMin: number;
}

export interface LabMetrics {
  trades: number;
  /** 0–1. */
  winRate: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  avgNetPct: number | null;
  /** Per trade, for a 0.1 SOL stake. */
  avgNetSol: number | null;
  profitFactor: number | null;
  /** SOL, 0.1 SOL per trade (positive number = loss from the peak). */
  maxDrawdownSol: number | null;
  worstLosingStreak: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  ciContainsZero: boolean | null;
  openAtEnd: number | null;
}

export interface ResultRow {
  key: VariantKey;
  narrative: LabNarrative;
  split: LabSplit;
  metrics: LabMetrics;
  retained: boolean;
  robust: boolean;
}

export interface RankedVariant {
  /** Stable id (variant + narrative). */
  id: string;
  key: VariantKey;
  name: string;
  narrative: LabNarrative;
  train: LabMetrics | null;
  test: LabMetrics | null;
  robust: boolean;
}

export const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
export const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Finite number (numerics may arrive as text) or null. */
export function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export const count = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? Math.round(n) : null;
};

export const bool = (v: unknown): boolean | null => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

export const isoDate = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && Number.isFinite(Date.parse(s)) ? s : null;
};

export const first = (r: Record<string, unknown>, keys: readonly string[]): unknown => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k];
  return null;
};

/** 0–1 fraction from a fraction or a percentage (]1, 100]); anything else → null. */
export function fraction(v: unknown): number | null {
  const n = num(v);
  if (n === null || n < 0) return null;
  if (n <= 1) return n;
  return n <= 100 ? n / 100 : null;
}

/** Share of the detections: a fraction (when every share is ≤ 1) or a count divided by the detections. */
function share(v: unknown, detections: number | null, asFraction: boolean): number | null {
  const n = num(v);
  if (n === null || n < 0) return null;
  if (asFraction) return n <= 1 ? n : null;
  return detections !== null && detections > 0 ? Math.min(1, n / detections) : null;
}

/** A count, or the sum of the counts of an object (e.g. pending candles by preset); null when nothing usable. */
function countOrSum(v: unknown): number | null {
  const r = record(v);
  if (!r) return count(v);
  const counts = Object.values(r).map(count).filter((n): n is number => n !== null);
  return counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : null;
}

export function parseDataVersion(value: unknown, fallbackDetections: number | null = null): DataVersion {
  const r = record(value) ?? {};
  const detections = count(first(r, ['n_detections', 'detections'])) ?? fallbackDetections;
  const res = record(r['resolutions']) ?? r;
  const raw = [first(res, ['1m', 'with_1m']), first(res, ['5m', 'with_5m']), first(res, ['15m', 'only_15m']), first(res, ['none', 'no_candles'])];
  const numbers = raw.map(num).filter((n): n is number => n !== null);
  const asFraction = numbers.length > 0 && numbers.every((n) => n <= 1);
  return {
    detections,
    cutoff: isoDate(first(r, ['cutoff_at', 'cutoff', 'split_cutoff', 'train_test_cutoff'])),
    maxDetectedAt: isoDate(r['max_detected_at']),
    share1m: share(raw[0], detections, asFraction),
    share5m: share(raw[1], detections, asFraction),
    share15mOnly: share(raw[2], detections, asFraction),
    shareNone: share(raw[3], detections, asFraction),
    events: count(first(r, ['n_events', 'events'])),
    pendingCandles: countOrSum(first(r, ['events_pending', 'n_pending_candles', 'pending_candles', 'awaiting_candles'])),
  };
}

/** Defensive parse of a backtest_runs row; null without a valid id, status or creation date. */
export function parseRun(value: unknown): BacktestRun | null {
  const r = record(Array.isArray(value) ? value[0] : value);
  if (!r) return null;
  const id = typeof r['id'] === 'number' && Number.isFinite(r['id']) ? String(r['id']) : str(r['id']);
  const status = r['status'];
  const createdAt = isoDate(r['created_at']);
  if (id === null || typeof status !== 'string' || !STATUSES.includes(status) || createdAt === null) return null;
  const trigger = r['trigger'] === 'nightly' || r['trigger'] === 'manual' ? r['trigger'] : null;
  const nDetections = count(r['n_detections']);
  return {
    id,
    status: status as RunStatus,
    trigger,
    nDetections,
    nVariants: count(r['n_variants']),
    nDistinctVariants: count(r['n_distinct_variants']),
    progress: fraction(r['progress']),
    failed: status === 'failed',
    createdAt,
    startedAt: isoDate(r['started_at']),
    finishedAt: isoDate(r['finished_at']),
    data: parseDataVersion(r['data_version'], nDetections),
    summaryRaw: r['summary'] ?? null,
  };
}

export function isActiveRun(run: BacktestRun | null): boolean {
  return run !== null && (run.status === 'queued' || run.status === 'running');
}

function parseMetrics(r: Record<string, unknown>): LabMetrics | null {
  const trades = count(r['trades']);
  if (trades === null) return null;
  return {
    trades,
    winRate: fraction(r['win_rate']),
    avgWinPct: num(r['avg_win_pct']),
    avgLossPct: num(r['avg_loss_pct']),
    avgNetPct: num(r['avg_net_pct']),
    avgNetSol: num(r['avg_net_sol']),
    profitFactor: num(r['profit_factor']),
    maxDrawdownSol: num(r['max_drawdown_sol']),
    worstLosingStreak: count(r['worst_losing_streak']),
    ciLow: num(r['ci_low']),
    ciHigh: num(r['ci_high']),
    ciContainsZero: bool(r['ci_contains_zero']),
    openAtEnd: count(r['open_at_end']),
  };
}

export function isLabPreset(v: unknown): v is LabPreset {
  return typeof v === 'string' && PRESETS.includes(v);
}

export function isLabNarrative(v: unknown): v is LabNarrative {
  return typeof v === 'string' && NARRATIVE_IDS.includes(v);
}

/** Variant parameters (preset, exit, sl_pct, breakeven, time_exit_h, delay_min) of a row; null when invalid. */
export function parseVariantKey(r: Record<string, unknown>): VariantKey | null {
  const { preset, exit } = r;
  if (typeof preset !== 'string' || !PRESETS.includes(preset)) return null;
  if (typeof exit !== 'string' || !EXITS.includes(exit)) return null;
  const slPct = num(r['sl_pct']);
  const delayMin = num(r['delay_min']);
  const timeRaw = r['time_exit_h'];
  const time = timeRaw === null || timeRaw === undefined ? 0 : num(timeRaw);
  const breakeven = bool(r['breakeven']);
  if (slPct === null || slPct <= 0 || slPct >= 100 || delayMin === null || delayMin < 0 || time === null || time < 0 || breakeven === null) return null;
  return { preset: preset as LabPreset, exit: exit as LabExit, slPct, breakeven, timeExitH: time > 0 ? time : null, delayMin };
}

/** Defensive parse of a backtest_results row; unknown preset / exit / narrative / split or bad numbers → null. */
export function parseResultRow(value: unknown): ResultRow | null {
  const r = record(value);
  if (!r) return null;
  const { narrative, split } = r;
  if (!isLabNarrative(narrative)) return null;
  if (split !== 'train' && split !== 'test') return null;
  const key = parseVariantKey(r);
  if (!key) return null;
  const metrics = parseMetrics(r);
  if (!metrics) return null;
  // A row flagged exploratory by the server is never shown (the exploratory section was removed).
  if (bool(r['exploratory']) === true) return null;
  return { key, narrative, split, metrics, retained: bool(r['retained']) === true, robust: bool(r['robust']) === true };
}

export function parseResultRows(data: unknown): ResultRow[] {
  return Array.isArray(data) ? data.map(parseResultRow).filter((r): r is ResultRow => r !== null) : [];
}

const frNumber = (n: number): string => String(n).replace('.', ',');

/**
 * « SL −30 % · entrée +2 min · Jeune calme (à la détection) ». The exit is always « tout à ×2 » (not repeated); a
 * breakeven or a time exit (not in the current grid) would still be named so that a row is never misread.
 */
export function variantName(k: VariantKey): string {
  const parts = [`SL −${frNumber(k.slPct)} %`, k.delayMin === 0 ? 'entrée immédiate' : `entrée +${frNumber(k.delayMin)} min`];
  if (k.breakeven) parts.push('BE');
  if (k.timeExitH !== null) parts.push(`sortie ${frNumber(k.timeExitH)} h`);
  parts.push(PRESET_LABEL[k.preset]);
  return parts.join(' · ');
}

export function variantId(k: VariantKey, narrative: LabNarrative): string {
  return [k.preset, k.exit, k.slPct, k.breakeven ? 'be' : 'nobe', k.timeExitH ?? 0, k.delayMin, narrative].join('|');
}

/** Pairs the train / test rows of each variant of one narrative (first row wins), best test average net first. */
function pairAndSort(rows: readonly ResultRow[], narrative: LabNarrative, keep: (row: ResultRow) => boolean): RankedVariant[] {
  const byId = new Map<string, RankedVariant>();
  for (const row of rows) {
    if (row.narrative !== narrative || !keep(row)) continue;
    const id = variantId(row.key, narrative);
    const v = byId.get(id) ?? { id, key: row.key, name: variantName(row.key), narrative, train: null, test: null, robust: false };
    if (v[row.split] === null) v[row.split] = row.metrics;
    v.robust = v.robust || row.robust;
    byId.set(id, v);
  }
  const score = (v: RankedVariant) => v.test?.avgNetPct ?? Number.NEGATIVE_INFINITY;
  return [...byId.values()].sort((a, b) => score(b) - score(a) || (b.test?.trades ?? 0) - (a.test?.trades ?? 0));
}

/**
 * Retained variants of one narrative, train and test side by side, sorted by the test average net gain per trade
 * (best first; unknown last; ties by test trades). A duplicated (variant, split) keeps the first row.
 */
export function rankVariants(rows: readonly ResultRow[], narrative: LabNarrative): RankedVariant[] {
  return pairAndSort(rows, narrative, (row) => row.retained);
}

export interface NarrativeCounts {
  retained: number;
  robust: number;
}

/** Number of retained and robust variants per narrative. */
export function narrativeCounts(rows: readonly ResultRow[]): Record<LabNarrative, NarrativeCounts> {
  const out = {} as Record<LabNarrative, NarrativeCounts>;
  for (const n of NARRATIVES) {
    const ranked = rankVariants(rows, n.id);
    out[n.id] = { retained: ranked.length, robust: ranked.filter((v) => v.robust).length };
  }
  return out;
}

/** PostgREST / Postgres « relation or function does not exist » (laboratory not deployed yet). */
export function isMissingRelationError(error: unknown): boolean {
  const e = record(error);
  const code = e?.['code'];
  return code === 'PGRST205' || code === '42P01' || code === 'PGRST202' || code === '42883';
}

/**
 * A column of the SELECT is not readable: unknown column (42703, PGRST204) or no column-level grant yet (42501).
 * Used to fall back to LEGACY_RUN_COLUMNS while the lab-v2 migration is not deployed.
 */
export function isMissingColumnError(error: unknown): boolean {
  const code = record(error)?.['code'];
  return code === '42703' || code === '42501' || code === 'PGRST204';
}

export const LAB_MSG = {
  loadFailed: 'Impossible de charger le laboratoire. Réessaie dans un instant.',
  requestFailed: 'Impossible de relancer le backtest. Réessaie dans un instant.',
  unavailable: 'Le laboratoire n’est pas encore disponible côté serveur.',
  requested: 'Backtest demandé : il démarre dans la minute qui vient.',
} as const;

/**
 * French message of a failed rpc('backtest_request_run'). The RPC raises its own French explanation (run already
 * queued / running, or started less than 10 min ago) with errcode 23514 (P0001 also accepted): that text is shown
 * (interpolated, never as HTML, control characters removed, capped).
 * Any other error gets a generic message; the database text is never shown.
 */
export function requestErrorMessage(error: unknown): string {
  if (isMissingRelationError(error)) return LAB_MSG.unavailable;
  const e = record(error);
  const message = e?.['message'];
  if ((e?.['code'] === '23514' || e?.['code'] === 'P0001') && typeof message === 'string') {
    const clean = message.replace(/\p{Cc}/gu, ' ').trim();
    if (clean.length > 0 && clean.length <= 200) return clean;
  }
  return LAB_MSG.requestFailed;
}
