// Candle-capture queue of label-outcomes (feat/strategy-lab, docs/contracts/strategy-lab.md §B1). Pure: no I/O, no
// Date.now(). Kept apart from candles.ts because it builds on label-queue.ts (whose import chain loads zod), while
// candles.ts must stay dependency-free for the backtest worker.
//
// Three tables carry the capture columns: signal_outcomes (scan, key mint), preset_signals (key id) and, since lab-v2,
// backtest_events (key id; its pool / event_at columns are read under the aliases pair_address / detected_at):
//   candles_1m_at  next 1-minute capture due (detection + 6 h), null = done or useless
//   candles_5m_at  next 5-minute capture due (detection + 72 h), null = done or useless
//   candles_attempts  failed captures so far (both timeframes share the counter)
// chore/slim-down: only the events of the remaining lab presets (LAB_EVENT_PRESETS) are read from backtest_events; the
// archived events (momentum, young_24h / 3h, post_migration, narrative_leader, *_explo) keep their queue columns but
// are skipped. The radar (early_outcomes) is archived and was never captured.
// One GeckoTerminal request per item (gecko-history.ts fetchCandleWindow(pool, mint, candlePlan(captureWindow(tf, det)))).
// Global order of label-outcomes (mergeWorkQueue, lab-v2 §1, fix/lab-priority-exploratory, feat/calm-sl-test —
// GeckoTerminal is the bottleneck, the 1-minute windows age out of GeckoTerminal first): 1. 1-minute candles of the
// detections whose pair was < 24 h old at the detection (scan and presets: ABSOLUTE priority, the scanner's universe);
// 2. the other 1-minute candles of the detections (24–48 h or unknown age; pairs ≥ 48 h old get no candles_1m_at, see
// oneMinuteCandlesWanted); 3. 1-minute candles of the backtest events (young_calm_ev / young_frenzy_ev); 4. preset
// labels; 5. scan labels; 6. 5-minute candles (every table, last). Pair age at the detection: preset_signals.pair_age_h
// and signal_outcomes.pair_age_h (generated from features.log_age_h, migration 20261122010000).
// Same 429 handling as the labels (label-queue.ts): a 429 is never an item failure, the run just stops.
import { type CaptureTf, captureWindow } from './candles';
import { compareLabelItems, type LabelItem, type LabelTable } from './label-queue';
import { isSolanaAddress } from './solana';

/** The array itself, or [] for a non-array (keeps the element type: Array.isArray narrows readonly arrays to any[]). */
const arr = <T>(x: readonly T[] | null | undefined): readonly T[] => (Array.isArray(x) ? x : []);

export type CandleTable = 'signal_outcomes' | 'preset_signals' | 'backtest_events';
export const CANDLE_TABLES: readonly CandleTable[] = ['signal_outcomes', 'preset_signals', 'backtest_events'];
/** backtest_events presets whose candles are still captured (the Laboratoire's event presets). */
export const LAB_EVENT_PRESETS: readonly string[] = ['young_calm_ev', 'young_frenzy_ev'];

export interface CandleItem {
  table: CandleTable;
  keyColumn: 'mint' | 'id';
  keyValue: string | number;
  mint: string;
  pairAddress: string;
  detectedAtMs: number;
  attempts: number;
  tf: CaptureTf;
  /** epoch ms of candles_<tf>_at. */
  dueAtMs: number;
  /** Pair age at the detection, hours (pair_age_h of the row); null = unknown or an event row. */
  pairAgeH: number | null;
}

/** Column holding the due time of a timeframe. */
export const candleColumn = (tf: CaptureTf): 'candles_1m_at' | 'candles_5m_at' => (tf === '1m' ? 'candles_1m_at' : 'candles_5m_at');

const BASE = 'mint, pair_address, detected_at, pair_age_h, candles_1m_at, candles_5m_at, candles_attempts';
const QUEUE = 'candles_1m_at, candles_5m_at, candles_attempts';
/**
 * select() list per table. Filter in SQL: candles_1m_at <= now or candles_5m_at <= now. backtest_events: PostgREST
 * aliases (pair_address:pool, detected_at:event_at) so parseCandleRow reads every table the same way.
 */
export function candleQueueColumns(table: CandleTable): string {
  if (table === 'backtest_events') return `id, mint, pair_address:pool, detected_at:event_at, ${QUEUE}`;
  return table === 'preset_signals' ? `id, ${BASE}` : BASE;
}

/** 1-minute candles of a detection are captured only for pairs younger than this at the detection (hours). */
export const ONE_MINUTE_MAX_PAIR_AGE_H = 48;

/**
 * Pair age (hours) at the detection from tokens.pair_created_at (epoch ms); null when unknown or more than 5 min in
 * the future (clock skew within 5 min → 0). Same rule as presets.ts pairAgeHours.
 */
export function pairAgeAtDetectionH(pairCreatedAtMs: number | null | undefined, detectedAtMs: number): number | null {
  if (typeof pairCreatedAtMs !== 'number' || !Number.isFinite(pairCreatedAtMs) || pairCreatedAtMs <= 0) return null;
  if (!Number.isFinite(detectedAtMs)) return null;
  const ageMs = detectedAtMs - pairCreatedAtMs;
  if (ageMs < -5 * 60_000) return null;
  return Math.max(0, ageMs) / 3_600_000;
}

/**
 * 1-minute candles wanted for a DETECTION (scan / preset): not when the pair is known to be ≥ 48 h old at the
 * detection (contract: « les bougies 1 min des tokens ≥ 48 h ne sont plus demandées »); an unknown age keeps them
 * (same rule as the insert trigger: pair_created_at null or detected_at − pair_created_at < 48 h).
 */
export const oneMinuteCandlesWanted = (pairAgeH: number | null | undefined): boolean =>
  !(typeof pairAgeH === 'number' && Number.isFinite(pairAgeH) && pairAgeH >= ONE_MINUTE_MAX_PAIR_AGE_H);

/**
 * Initial queue columns of a new row (mirror of the insert trigger and of the backfill): candles_5m_at = detection +
 * 72 h always; candles_1m_at = detection + 6 h for an event (always), and for a detection unless the pair is known to
 * be ≥ 48 h old at the detection (null then: never requested). A detection older than the 30-day candle retention at `nowMs`
 * gets nothing. null for an invalid detection time.
 */
export function candleScheduleFor(
  table: CandleTable,
  detectedAtMs: number,
  pairCreatedAtMs: number | null | undefined,
  nowMs: number,
): { candles_1m_at: string | null; candles_5m_at: string | null } | null {
  const w1 = captureWindow('1m', detectedAtMs);
  const w5 = captureWindow('5m', detectedAtMs);
  if (!w1 || !w5 || !Number.isFinite(nowMs)) return null;
  if (detectedAtMs <= nowMs - CANDLE_RETENTION_MS) return { candles_1m_at: null, candles_5m_at: null };
  const want1m = table === 'backtest_events' || oneMinuteCandlesWanted(pairAgeAtDetectionH(pairCreatedAtMs, detectedAtMs));
  return {
    candles_1m_at: want1m ? new Date(w1.dueAtMs).toISOString() : null,
    candles_5m_at: new Date(w5.dueAtMs).toISOString(),
  };
}

/** Candles older than this are purged (ohlcv_candles retention). */
export const CANDLE_RETENTION_MS = 30 * 24 * 3_600_000;

/** Failed captures after which a timeframe is abandoned (its column set to null). */
export const CANDLE_MAX_ATTEMPTS = 6;
/** Delay before retrying a failed capture (not a 429). */
export const CANDLE_RETRY_MS = 3_600_000;

function timeMs(v: unknown): number | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * One row → its DUE capture items (0, 1 or 2: candles_<tf>_at ≤ now). Invalid mint / pool / detection / id → [];
 * an unparsable due time is skipped (that timeframe only).
 */
export function parseCandleRow(table: CandleTable, row: unknown, nowMs: number): CandleItem[] {
  if (typeof row !== 'object' || row === null || !Number.isFinite(nowMs)) return [];
  const r = row as Record<string, unknown>;
  if (!isSolanaAddress(r['mint']) || !isSolanaAddress(r['pair_address'])) return [];
  const detectedAtMs = timeMs(r['detected_at']);
  if (detectedAtMs === null) return [];
  let keyColumn: 'mint' | 'id' = 'mint';
  let keyValue: string | number = r['mint'];
  if (table === 'preset_signals' || table === 'backtest_events') {
    const id = typeof r['id'] === 'number' ? r['id'] : typeof r['id'] === 'string' && /^\d{1,18}$/.test(r['id']) ? Number(r['id']) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) return [];
    keyColumn = 'id';
    keyValue = id;
  } else if (table !== 'signal_outcomes') {
    return [];
  }
  const a = typeof r['candles_attempts'] === 'number' ? r['candles_attempts'] : Number(r['candles_attempts']);
  const attempts = Number.isFinite(a) && a >= 0 ? Math.floor(a) : 0;
  const ageRaw = table === 'backtest_events' ? NaN : typeof r['pair_age_h'] === 'number' ? r['pair_age_h']
    : typeof r['pair_age_h'] === 'string' && r['pair_age_h'].length <= 40 ? Number(r['pair_age_h']) : NaN;
  const pairAgeH = Number.isFinite(ageRaw) && ageRaw >= 0 ? ageRaw : null;
  const out: CandleItem[] = [];
  for (const tf of ['1m', '5m'] as const) {
    const due = timeMs(r[candleColumn(tf)]);
    if (due === null || due > nowMs) continue;
    out.push({ table, keyColumn, keyValue, mint: r['mint'], pairAddress: r['pair_address'], detectedAtMs, attempts, tf, dueAtMs: due, pairAgeH });
  }
  return out;
}

/** Oldest due time first, then 1m before 5m (finer data is the most likely to age out), oldest detection, key. */
export function compareCandleItems(a: CandleItem, b: CandleItem): number {
  if (a.dueAtMs !== b.dueAtMs) return a.dueAtMs - b.dueAtMs;
  if (a.tf !== b.tf) return a.tf === '1m' ? -1 : 1;
  if (a.detectedAtMs !== b.detectedAtMs) return a.detectedAtMs - b.detectedAtMs;
  if (a.table !== b.table) return a.table < b.table ? -1 : 1;
  const ka = String(a.keyValue);
  const kb = String(b.keyValue);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export type WorkItem = { kind: 'label'; item: LabelItem } | { kind: 'candles'; item: CandleItem };

export type WorkGroup =
  | { kind: 'label'; table: LabelTable }
  | { kind: 'candles'; tables: readonly CandleTable[]; tf: CaptureTf; maxPairAgeH?: number };

/** Detections younger than this at the detection (hours) get the first rank (feat/calm-sl-test). */
export const PRIORITY_PAIR_AGE_H = 24;

/**
 * Priority of label-outcomes (lab-v2 §1 as amended by fix/lab-priority-exploratory, chore/slim-down and
 * feat/calm-sl-test, ranks 1..6). A group with maxPairAgeH only takes the items whose known pair age is below it.
 */
export const WORK_PRIORITY: readonly WorkGroup[] = [
  { kind: 'candles', tables: ['signal_outcomes', 'preset_signals'], tf: '1m', maxPairAgeH: PRIORITY_PAIR_AGE_H },
  { kind: 'candles', tables: ['signal_outcomes', 'preset_signals'], tf: '1m' },
  { kind: 'candles', tables: ['backtest_events'], tf: '1m' },
  { kind: 'label', table: 'preset_signals' },
  { kind: 'label', table: 'signal_outcomes' },
  { kind: 'candles', tables: ['backtest_events', 'signal_outcomes', 'preset_signals'], tf: '5m' },
];

/** true when a candle item belongs to a candle group (tf, table and, for the first rank, the pair age). */
function inCandleGroup(item: CandleItem, g: Extract<WorkGroup, { kind: 'candles' }>): boolean {
  if (item.tf !== g.tf || !g.tables.includes(item.table)) return false;
  if (g.maxPairAgeH === undefined) return true;
  return typeof item.pairAgeH === 'number' && Number.isFinite(item.pairAgeH) && item.pairAgeH < g.maxPairAgeH;
}

/** Category of a work item in WORK_PRIORITY (0-based rank: its FIRST matching group), -1 when it fits none. */
export function workRank(w: WorkItem): number {
  return WORK_PRIORITY.findIndex((g) =>
    g.kind === 'label' ? w.kind === 'label' && w.item.table === g.table : w.kind === 'candles' && inCandleGroup(w.item, g)
  );
}

/**
 * Up to maxRows work items in WORK_PRIORITY order; each group sorted (compareLabelItems / compareCandleItems),
 * duplicates dropped (same table + key for labels; same table + key + tf for candles).
 */
export function mergeWorkQueue(labels: readonly LabelItem[], candles: readonly CandleItem[], maxRows: number): WorkItem[] {
  const limit = Math.max(0, Math.floor(Number.isFinite(maxRows) ? maxRows : 0));
  const seen = new Set<string>();
  const ul = arr(labels).filter((i) => {
    const k = `L:${i.table}:${i.keyValue}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const uc = arr(candles).filter((i) => {
    const k = `C:${i.table}:${i.keyValue}:${i.tf}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const out: WorkItem[] = [];
  const taken = new Set<CandleItem>(); // groups overlap (rank 1 ⊂ rank 2): an item is queued once, at its first rank
  for (const g of WORK_PRIORITY) {
    if (out.length >= limit) break;
    if (g.kind === 'label') {
      const rows = ul.filter((i) => i.table === g.table).sort(compareLabelItems);
      for (const item of rows.slice(0, limit - out.length)) out.push({ kind: 'label', item });
    } else {
      const rows = uc.filter((i) => !taken.has(i) && inCandleGroup(i, g)).sort(compareCandleItems);
      for (const item of rows.slice(0, limit - out.length)) {
        taken.add(item);
        out.push({ kind: 'candles', item });
      }
    }
  }
  return out;
}

/** UPDATE payload after a successful capture (rows written, or GeckoTerminal answered with no candle): done. */
export function candlesDoneUpdate(tf: CaptureTf): Partial<Record<'candles_1m_at' | 'candles_5m_at', null>> {
  return { [candleColumn(tf)]: null };
}

/**
 * UPDATE payload after a failed capture (NOT a 429: on 429 nothing is written and the run stops).
 * 'not_found' / 'invalid' → abandoned (column null); otherwise retried CANDLE_RETRY_MS later until CANDLE_MAX_ATTEMPTS
 * failures, then abandoned. candles_attempts is incremented (capped at 10 000).
 */
export function candlesFailureUpdate(
  tf: CaptureTf,
  attempts: number,
  nowMs: number,
  status: 'not_found' | 'invalid' | 'error',
): Record<string, string | number | null> {
  if (!Number.isFinite(nowMs)) throw new RangeError('candlesFailureUpdate: invalid now');
  const next = Math.min(10_000, Math.max(0, Number.isFinite(attempts) ? Math.floor(attempts) : 0) + 1);
  const abandon = status !== 'error' || next >= CANDLE_MAX_ATTEMPTS;
  return { [candleColumn(tf)]: abandon ? null : new Date(nowMs + CANDLE_RETRY_MS).toISOString(), candles_attempts: next };
}

/** The capture window of an item (null if the detection time is invalid). */
export const itemWindow = (item: Pick<CandleItem, 'tf' | 'detectedAtMs'>) => captureWindow(item.tf, item.detectedAtMs);
