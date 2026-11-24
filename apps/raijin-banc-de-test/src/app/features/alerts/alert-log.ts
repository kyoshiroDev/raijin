import { isSolanaAddress } from '../../shared/utils/solana-address';
import { parseStakeValue } from '../../shared/utils/stake';

// Mirrors public.alert_log (select-only for the owner) and the token columns shown next to it.
// The archived score / Fibonacci columns (entry_score, entry_zone, rr) are not read any more (slim-down 2026-11-21).
/** Rows listed on the screen. */
export const ALERT_LOG_LIMIT = 50;
/** Rows fetched: enough to cover the 7-day simulation window, not only the listed ones. */
export const ALERT_FETCH_LIMIT = 300;
export const ALERT_LOG_COLUMNS = [
  'id', 'mint', 'sent_at', 'kind',
  'entry_price', 'target_price', 'stop_price', 'entry_roundtrip_pct', 'stake_sol',
  'max_price', 'min_price', 'last_price', 'last_price_at', 'first_hit', 'first_hit_at', 'followup_sent_at', 'tracking_until',
].join(',');
export const ALERT_TOKEN_COLUMNS = 'mint,symbol';

export type AlertKind = 'single' | 'grouped';
export type AlertFirstHit = 'target' | 'stop';

/** Minimal shape required for a row to be listed. */
export interface AlertLogBase {
  id: number;
  mint: string;
  sent_at: string;
  kind: AlertKind;
}

/** Normalised row: unknown, malformed or non-positive values become null. */
export interface AlertLogRow extends AlertLogBase {
  entry_price: number | null;
  target_price: number | null;
  stop_price: number | null;
  /** Round-trip cost in PERCENT for a 0.1 SOL quote at alert time. */
  entry_roundtrip_pct: number | null;
  stake_sol: number | null;
  max_price: number | null;
  min_price: number | null;
  last_price: number | null;
  last_price_at: string | null;
  first_hit: AlertFirstHit | null;
  first_hit_at: string | null;
  followup_sent_at: string | null;
  tracking_until: string | null;
}

export interface AlertTokenInfo {
  mint: string;
  symbol: string;
}

export interface AlertItem extends AlertLogRow {
  /** Null when the token is no longer in `tokens`. Hostile text: interpolate only. */
  symbol: string | null;
}

/** Postgres numeric comes back as a number or a numeric string. */
export function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function toPositive(value: unknown): number | null {
  const n = toFiniteNumber(value);
  return n !== null && n > 0 ? n : null;
}

function toNonNegative(value: unknown): number | null {
  const n = toFiniteNumber(value);
  return n !== null && n >= 0 ? n : null;
}

function toIsoDate(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/** `bigint` id: a number, or its text as served by the bench API (`rowIdSchema`). */
function alertId(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function isAlertLogRow(value: unknown): value is AlertLogBase {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Record<keyof AlertLogBase, unknown>>;
  return (
    alertId(v.id) !== null &&
    isSolanaAddress(v.mint) &&
    typeof v.sent_at === 'string' &&
    Number.isFinite(Date.parse(v.sent_at)) &&
    (v.kind === 'single' || v.kind === 'grouped')
  );
}

/** Null when the row cannot be listed; otherwise every optional column is null-tolerant. */
export function parseAlertLogRow(value: unknown): AlertLogRow | null {
  if (!isAlertLogRow(value)) return null;
  const v = value as AlertLogBase & Partial<Record<keyof AlertLogRow, unknown>>;
  return {
    id: alertId(v.id) ?? 0,
    mint: v.mint,
    sent_at: v.sent_at,
    kind: v.kind,
    entry_price: toPositive(v.entry_price),
    target_price: toPositive(v.target_price),
    stop_price: toPositive(v.stop_price),
    entry_roundtrip_pct: toNonNegative(v.entry_roundtrip_pct),
    stake_sol: parseStakeValue(v.stake_sol),
    max_price: toPositive(v.max_price),
    min_price: toPositive(v.min_price),
    last_price: toPositive(v.last_price),
    last_price_at: toIsoDate(v.last_price_at),
    first_hit: v.first_hit === 'target' || v.first_hit === 'stop' ? v.first_hit : null,
    first_hit_at: toIsoDate(v.first_hit_at),
    followup_sent_at: toIsoDate(v.followup_sent_at),
    tracking_until: toIsoDate(v.tracking_until),
  };
}

/** Valid rows, newest first (all of them: the simulation needs the whole window). */
export function parseAlertLogRows(rows: readonly unknown[]): AlertLogRow[] {
  return rows
    .map(parseAlertLogRow)
    .filter((r): r is AlertLogRow => r !== null)
    .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));
}

export function isAlertTokenInfo(value: unknown): value is AlertTokenInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Record<keyof AlertTokenInfo, unknown>>;
  return isSolanaAddress(v.mint) && typeof v.symbol === 'string';
}

/** Valid rows, newest first, at most ALERT_LOG_LIMIT, joined with their token when known. */
export function mergeAlerts(rows: readonly unknown[], tokens: readonly unknown[]): AlertItem[] {
  const byMint = new Map<string, AlertTokenInfo>();
  for (const t of tokens) if (isAlertTokenInfo(t)) byMint.set(t.mint, t);
  return parseAlertLogRows(rows)
    .slice(0, ALERT_LOG_LIMIT)
    .map((r) => ({ ...r, symbol: byMint.get(r.mint)?.symbol ?? null }));
}

/** Distinct mints, in order (for the tokens lookup). */
export function uniqueMints(rows: readonly AlertLogBase[]): string[] {
  return [...new Set(rows.map((r) => r.mint))];
}

/** « 14:05 » today, « 15/11 14:05 » otherwise (device time zone unless given). */
export function formatAlertTime(iso: string, now = Date.now(), timeZone?: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '–';
  const day = new Intl.DateTimeFormat('fr-FR', { timeZone, day: '2-digit', month: '2-digit' });
  const time = new Intl.DateTimeFormat('fr-FR', { timeZone, hour: '2-digit', minute: '2-digit' }).format(at);
  return day.format(at) === day.format(new Date(now)) ? time : `${day.format(at)} ${time}`;
}
