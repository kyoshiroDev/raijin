// Server catch-up gauge: rpc('backfill_progress') (docs/contracts/lab-v2.md §1), parsed defensively.
// Accepted shapes (the RPC is not frozen yet):
// - a set of rows `{ category, done, total, due_now, last_24h, [rows_per_hour], [eta_hours | eta_at] }`;
// - an object `{ categories: [...rows], rows_per_hour, eta_hours | eta_at }` (or the same as a one-element array).
// Global throughput = the top-level value, else the sum of the per-category values. ETA = the top-level value, else
// the rows due now divided by the measured throughput.
import { count, first, isoDate, num, record } from './backtest';
import { formatInt, formatLabDate } from './lab-format';

export type BackfillCategoryId = 'preset_labels' | 'event_candles' | 'scan_labels' | 'candles_1m' | 'candles_5m';

/** Contract priority order (fallback when the server sends no `priority`), with French labels. */
export const BACKFILL_CATEGORIES: readonly { id: BackfillCategoryId; label: string }[] = [
  { id: 'preset_labels', label: 'Étiquettes presets' },
  { id: 'event_candles', label: 'Bougies des événements' },
  { id: 'scan_labels', label: 'Étiquettes scan' },
  { id: 'candles_1m', label: 'Bougies 1 min (< 48 h)' },
  { id: 'candles_5m', label: 'Bougies 5 min' },
];

export interface BackfillCategory {
  id: BackfillCategoryId;
  label: string;
  done: number;
  total: number;
  dueNow: number | null;
  last24h: number | null;
  /** Backend queue priority (1 = first served); null when not sent. */
  priority: number | null;
}

export interface BackfillProgress {
  categories: BackfillCategory[];
  /** Rows written per hour, measured over the last 6 h; null when unknown. */
  rowsPerHour: number | null;
  dueNow: number;
  /** Hours to clear what is due now; null when unknown (no throughput). */
  etaHours: number | null;
  etaAt: string | null;
}

/**
 * Maps a server category name (any of the plausible spellings) to its id; unknown → null (row ignored). The radar
 * labels are ignored too: the Radar was removed and its queue is no longer processed (slim-down 2026-11-21).
 */
export function categoryId(raw: unknown): BackfillCategoryId | null {
  if (typeof raw !== 'string') return null;
  const s = raw.toLowerCase();
  if (s.includes('radar') || s.includes('early')) return null;
  if (s.includes('preset')) return 'preset_labels';
  if (s.includes('event')) return 'event_candles';
  if (/5\s?m/.test(s)) return 'candles_5m';
  if (/1\s?m/.test(s)) return 'candles_1m';
  if (s.includes('scan')) return 'scan_labels';
  return null;
}

const RATE_KEYS = ['rows_per_hour', 'rows_per_h', 'throughput_per_hour', 'throughput'] as const;
const ETA_H_KEYS = ['eta_hours', 'eta_h'] as const;
const ETA_AT_KEYS = ['eta_at', 'eta'] as const;

function rate(r: Record<string, unknown>): number | null {
  const n = num(first(r, RATE_KEYS));
  return n !== null && n >= 0 ? n : null;
}

/** null when nothing usable (no known category). */
export function parseBackfillProgress(data: unknown): BackfillProgress | null {
  let top: Record<string, unknown> = {};
  let rows: unknown[] = [];
  const single = Array.isArray(data) && data.length === 1 ? record(data[0]) : null;
  const obj = record(data) ?? (single && Array.isArray(single['categories']) ? single : null);
  if (obj) {
    top = obj;
    rows = Array.isArray(obj['categories']) ? obj['categories'] : [];
  } else if (Array.isArray(data)) {
    rows = data;
  }

  const byId = new Map<BackfillCategoryId, BackfillCategory>();
  const rates: number[] = [];
  for (const raw of rows) {
    const r = record(raw);
    const id = categoryId(r?.['category']);
    if (!r || !id || byId.has(id)) continue;
    const total = count(r['total']);
    const done = count(r['done']);
    if (total === null || done === null) continue;
    const label = BACKFILL_CATEGORIES.find((c) => c.id === id)?.label ?? id;
    byId.set(id, {
      id,
      label,
      done: Math.min(done, total),
      total,
      dueNow: count(r['due_now']),
      last24h: count(r['last_24h']),
      priority: num(r['priority']),
    });
    const rr = rate(r);
    if (rr !== null) rates.push(rr);
  }
  if (byId.size === 0) return null;

  const categories = sortByPriority([...byId.values()]);
  const rowsPerHour = rate(top) ?? (rates.length > 0 ? rates.reduce((a, b) => a + b, 0) : null);
  const dueNow = categories.reduce((a, c) => a + (c.dueNow ?? 0), 0);
  const etaTop = num(first(top, ETA_H_KEYS));
  const etaHours =
    etaTop !== null && etaTop >= 0
      ? etaTop
      : dueNow === 0
        ? 0
        : rowsPerHour !== null && rowsPerHour > 0
          ? dueNow / rowsPerHour
          : null;
  return { categories, rowsPerHour, dueNow, etaHours, etaAt: isoDate(first(top, ETA_AT_KEYS)) };
}

/**
 * Backend priority order: categories with a `priority` first (ascending), then the others in the contract order;
 * ties keep the contract order.
 */
export function sortByPriority(categories: readonly BackfillCategory[]): BackfillCategory[] {
  const contract = (c: BackfillCategory) => BACKFILL_CATEGORIES.findIndex((x) => x.id === c.id);
  const prio = (c: BackfillCategory) => c.priority ?? Number.POSITIVE_INFINITY;
  return [...categories].sort((a, b) => prio(a) - prio(b) || contract(a) - contract(b));
}

/** 0–100 share of a category done (100 when there is nothing to do). */
export function donePercent(c: BackfillCategory): number {
  return c.total === 0 ? 100 : Math.round((c.done / c.total) * 100);
}

/** « ≈ 14 h », « ≈ 2 j 3 h », « < 1 h ». */
export function formatEta(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return 'inconnue';
  if (hours < 1) return '< 1 h';
  const h = Math.round(hours);
  if (h < 24) return `≈ ${h} h`;
  const d = Math.floor(h / 24);
  const rest = h % 24;
  return rest === 0 ? `≈ ${d} j` : `≈ ${d} j ${rest} h`;
}

/** Overall line: throughput and ETA (or « à jour »). */
export function backfillSummaryText(p: BackfillProgress): string {
  const rateText =
    p.rowsPerHour === null
      ? 'débit inconnu'
      : `débit mesuré ${formatInt(p.rowsPerHour)} lignes/h (6 h)`;
  if (p.dueNow === 0) return `Rattrapage à jour · ${rateText}.`;
  const at = p.etaAt ? `vers le ${formatLabDate(p.etaAt)}` : null;
  const eta =
    at === null
      ? formatEta(p.etaHours)
      : p.etaHours === null
        ? at
        : `${formatEta(p.etaHours)} (${at})`;
  return `${formatInt(p.dueNow)} lignes dues · ${rateText} · fin estimée ${eta}.`;
}

/** « 120 / 512 · 30 dues · 42 en 24 h ». */
export function categoryText(c: BackfillCategory): string {
  const parts = [`${formatInt(c.done)} / ${formatInt(c.total)}`];
  if (c.dueNow !== null) parts.push(`${formatInt(c.dueNow)} due${c.dueNow > 1 ? 's' : ''}`);
  if (c.last24h !== null) parts.push(`${formatInt(c.last24h)} en 24 h`);
  return parts.join(' · ');
}
