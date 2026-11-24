// Merged labelling queue of label-outcomes (fix/measurement-and-criteria, fix/label-checkpoints). Pure: no I/O, no
// Date.now(). Two tables share the same label columns: signal_outcomes (main scan, key mint) and preset_signals (preset
// matches, key id). chore/slim-down: the radar queue (early_outcomes, archived) is no longer read. GeckoTerminal
// tolerates only ~3–5 requests per run from the Edge IP, so each run labels ~4 rows: the queue decides which ones.
// Checkpoints: each row carries next_label_at (nextLabelAt below): detection + 12 h, then detection + 7 days (horizon),
// then every 6 h while still pending past the horizon or after a failure; null once final. label-outcomes only reads
// pending rows with next_label_at <= now (a null checkpoint counts as due only for a never-labelled row).
// Order inside a table: oldest checkpoint first, then oldest detection. Priority between tables: preset_signals, then
// signal_outcomes.
import { parseQueueRow, type QueueItem } from './x3-rows';

export type LabelTable = 'signal_outcomes' | 'preset_signals';
export const LABEL_TABLES: readonly LabelTable[] = ['signal_outcomes', 'preset_signals'];

export interface LabelItem extends QueueItem {
  table: LabelTable;
  /** Row key for the UPDATE: mint for the outcome tables, id for preset_signals. */
  keyColumn: 'mint' | 'id';
  keyValue: string | number;
  /** epoch ms of labelled_at, null = never labelled. */
  labelledAtMs: number | null;
  /** epoch ms of next_label_at, null = no checkpoint (treated as due first). */
  nextLabelAtMs: number | null;
}

const BASE_COLUMNS = 'mint, pair_address, detected_at, entry_price, label_attempts, labelled_at, next_label_at';
/** select() list per table. */
export function labelQueueColumns(table: LabelTable): string {
  return table === 'preset_signals' ? `id, ${BASE_COLUMNS}` : BASE_COLUMNS;
}

function timeMs(v: unknown): number | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** A pending row of `table` → validated item, or null (invalid mint/pool/price/time or preset id). */
export function parseLabelRow(table: LabelTable, row: unknown): LabelItem | null {
  const q = parseQueueRow(row);
  if (!q) return null;
  const r = row as Record<string, unknown>;
  const labelledAtMs = r['labelled_at'] === null || r['labelled_at'] === undefined ? null : timeMs(r['labelled_at']);
  if (r['labelled_at'] !== null && r['labelled_at'] !== undefined && labelledAtMs === null) return null;
  const nextLabelAtMs = r['next_label_at'] === null || r['next_label_at'] === undefined ? null : timeMs(r['next_label_at']);
  if (r['next_label_at'] !== null && r['next_label_at'] !== undefined && nextLabelAtMs === null) return null;
  if (table === 'preset_signals') {
    const id = typeof r['id'] === 'number' ? r['id'] : typeof r['id'] === 'string' && /^\d{1,18}$/.test(r['id']) ? Number(r['id']) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return { ...q, table, keyColumn: 'id', keyValue: id, labelledAtMs, nextLabelAtMs };
  }
  return { ...q, table, keyColumn: 'mint', keyValue: q.mint, labelledAtMs, nextLabelAtMs };
}

/** Oldest checkpoint first (a null checkpoint first of all), then oldest detection, then table / key (stable). */
export function compareLabelItems(a: LabelItem, b: LabelItem): number {
  const na = a.nextLabelAtMs ?? Number.NEGATIVE_INFINITY;
  const nb = b.nextLabelAtMs ?? Number.NEGATIVE_INFINITY;
  if (na !== nb) return na < nb ? -1 : 1;
  if (a.detectedAtMs !== b.detectedAtMs) return a.detectedAtMs - b.detectedAtMs;
  if (a.table !== b.table) return a.table < b.table ? -1 : 1;
  const ka = String(a.keyValue);
  const kb = String(b.keyValue);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Table priority of the merge: presets first, then the main scan. */
export const LABEL_PRIORITY: readonly LabelTable[] = ['preset_signals', 'signal_outcomes'];

/**
 * Up to `maxRows` items in labelling order. Duplicates (same table + key) are dropped. Tables in LABEL_PRIORITY order
 * (each sorted by compareLabelItems): signal_outcomes gets the slots left by preset_signals.
 */
export function mergeLabelQueue(items: readonly LabelItem[], maxRows: number): LabelItem[] {
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    const k = `${i.table}:${i.keyValue}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const limit = Math.max(0, Math.floor(maxRows));
  const out: LabelItem[] = [];
  for (const table of LABEL_PRIORITY) {
    if (out.length >= limit) break;
    const rows = unique.filter((i) => i.table === table).sort(compareLabelItems);
    out.push(...rows.slice(0, limit - out.length));
  }
  return out;
}

const H12_MS = 12 * 3_600_000;
const HORIZON_MS = 7 * 24 * 3_600_000;
const RETRY_MS = 6 * 3_600_000;

/**
 * Checkpoint written with every label UPDATE (next_label_at). final → null; failure → now + 6 h; before detection
 * + 12 h → detection + 12 h; before detection + 7 days → detection + 7 days; past the horizon and still pending (no
 * candle) → now + 6 h. Invalid detection time → now + 6 h (never null for a pending row, so it cannot get stuck);
 * invalid now → RangeError.
 */
export function nextLabelAt(detectedAtMs: number, nowMs: number, status: 'pending' | 'final', ok: boolean): string | null {
  if (status === 'final') return null;
  const iso = (ms: number) => new Date(ms).toISOString();
  if (!Number.isFinite(nowMs)) throw new RangeError('nextLabelAt: invalid now');
  if (!ok || !Number.isFinite(detectedAtMs)) return iso(nowMs + RETRY_MS);
  if (nowMs < detectedAtMs + H12_MS) return iso(detectedAtMs + H12_MS);
  if (nowMs < detectedAtMs + HORIZON_MS) return iso(detectedAtMs + HORIZON_MS);
  return iso(nowMs + RETRY_MS);
}

/** `payload` (labelUpdate / labelFailureUpdate) + its next_label_at. A payload without status is a pending row. */
export function withNextLabelAt<T extends { status?: 'pending' | 'final' }>(
  payload: T,
  detectedAtMs: number,
  nowMs: number,
  ok: boolean,
): T & { next_label_at: string | null } {
  return { ...payload, next_label_at: nextLabelAt(detectedAtMs, nowMs, payload.status ?? 'pending', ok) };
}

/** Pacing of label-outcomes: one GeckoTerminal request every 12 s, ~20 s pause after a 429, budgets as before. */
export const LABEL_PACE = {
  spacingMs: 12_000,
  retryAfter429Ms: 20_000,
  stopNewMs: 45_000,
  abortMs: 50_000,
} as const;

/**
 * Pacing of label-outcomes on the 2-minute cron (lab-v2 §1: one call every 2 min on odd minutes, offset from the scan
 * which also calls GeckoTerminal every 2 min): at most 5 GeckoTerminal requests per call, one every 8 s, NO retry
 * after a 429 (the first 429 stops the call and pauses the queue until the next call), no new request after 40 s,
 * abort at 50 s (the call must end well before the next one).
 */
export const LABEL_PACE_2MIN = {
  spacingMs: 8_000,
  maxRequests: 5,
  retryOn429: false,
  retryAfter429Ms: 0,
  stopNewMs: 40_000,
  abortMs: 50_000,
} as const;

export interface LabelPace {
  spacingMs: number;
  retryAfter429Ms: number;
  stopNewMs: number;
  abortMs: number;
  /** Requests per call at most (absent = no cap besides the time budget). */
  maxRequests?: number;
  /** false = the first 429 stops the call (absent = retry once, LABEL_PACE behaviour). */
  retryOn429?: boolean;
}

/**
 * After a 429 on a row: stop when the pace forbids retries (LABEL_PACE_2MIN); else retry it once after
 * `retryAfter429Ms` if that retry can still start before `stopNewMs` (offsets from the run start); otherwise (or after
 * the retry also got a 429) stop the run. Never a row failure.
 */
export function onRateLimited(alreadyRetried: boolean, elapsedMs: number, pace: LabelPace = LABEL_PACE): 'retry' | 'stop' {
  if (pace.retryOn429 === false || alreadyRetried || !Number.isFinite(elapsedMs)) return 'stop';
  return elapsedMs + pace.retryAfter429Ms < pace.stopNewMs ? 'retry' : 'stop';
}

/** A new GeckoTerminal request may start: under the request cap (if any) and before stopNewMs. */
export function canStartRequest(requestsMade: number, elapsedMs: number, pace: LabelPace = LABEL_PACE_2MIN): boolean {
  if (!Number.isFinite(requestsMade) || !Number.isFinite(elapsedMs)) return false;
  if (pace.maxRequests !== undefined && requestsMade >= pace.maxRequests) return false;
  return elapsedMs < pace.stopNewMs;
}
