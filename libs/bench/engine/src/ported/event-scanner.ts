// Incremental event scanner of backtest-run (feat/lab-v2, docs/contracts/lab-v2.md §2). Pure: no I/O, no Date.now(),
// no zod. The replay itself (young_calm_ev / young_frenzy_ev criteria) lives in ./events.ts (scanner-quant); this
// file only decides WHAT one worker call reads and writes:
//   - keyset position on token_snapshots (captured_at, id), stored in public.backtest_event_state (key 'cursor');
//   - complete 2-minute scan buckets only (completePrefix): the last bucket of a page is processed only when it cannot
//     grow any more (a scan pass is replayed whole, so the cursor never splits one);
//   - per-mint replay states (events.ts ReplayState, key = mint) and token facts (public.tokens, static or current
//     values used by the pump.fun by-construction rule only);
//   - backtest_events insert rows (an event without a valid pool cannot get candles: dropped and counted).
// Writes are ordered events → mint states → cursor: a call that dies half-way replays the same snapshots, the
// duplicate events are ignored by the unique (preset, mint) and the mint states skip what they already replayed.
import {
  type BacktestEvent,
  DATA_GAPS,
  type DataGap,
  type EventPreset,
  EVENT_PRESETS,
  GAP_PRESETS,
  type GapPreset,
  type TokenFacts,
} from './events';
import { isSolanaAddress } from './solana';

/**
 * token_snapshots columns read by the scanner (point-in-time columns of migrations 20261119100000 and, feat/young-calm,
 * 20261120010000: buys_1h, sells_1h, liquidity_effective_usd, lp_locked_pct — the migration must be applied first).
 */
export const SNAPSHOT_SELECT =
  'id, mint, captured_at, source, price_usd, market_cap, liquidity_usd, dex_id, holder_count, ' +
  'mint_authority_disabled, freeze_authority_disabled, top10_pct, insiders_detected, roundtrip_cost_pct, change_1h, ' +
  'buys_1h, sells_1h, liquidity_effective_usd, lp_locked_pct';
/** public.tokens columns of the facts. */
export const FACTS_SELECT = 'mint, pair_address, pair_created_at, narrative, mint_authority_disabled, freeze_authority_disabled';

/** Budget of the scanner inside one backtest-run call. */
export const SCANNER_BUDGET = {
  /** Snapshots per page (PostgREST max rows). */
  pageSize: 1000,
  /** Pages per call at most. */
  maxPages: 4,
  /** Mints per `in (…)` read (keeps the URL short). */
  inChunk: 100,
  /** Rows per upsert. */
  upsertChunk: 500,
  /** Lease of the call on the scanner (seconds). */
  leaseS: 55,
  /** No new page after this many ms of wall time (pg_net waits 55 s). */
  wallMs: 25_000,
  /** Synchronous compute budget of the call (ms). */
  computeMs: 1_000,
} as const;

/** A bucket is complete when its end is this far in the past (one scan insert = one captured_at). */
export const BUCKET_GRACE_MS = 60_000;
/** Scan passes are grouped by floor(captured_at / SCAN_BUCKET_MS) (the scan runs every 2 minutes). */
export const SCAN_BUCKET_MS = 2 * 60_000;
const scanBucket = (atMs: number): number => Math.floor(atMs / SCAN_BUCKET_MS);
/** The scanner counts as caught up for this long after a call that reached the tail (run gating). */
export const CAUGHT_UP_TTL_MS = 10 * 60_000;
/** A queued run waits for the scanner at most this long after its creation, then starts anyway. */
export const RUN_WAIT_MAX_MS = 2 * 3_600_000;

export interface ScannerCursor {
  v: 1;
  /** Last snapshot processed: raw captured_at string as returned by PostgREST (µs kept) and id. */
  at: string | null;
  id: number | null;
  /** Snapshots processed since the first pass started. */
  snapshots: number;
  /** Events inserted per preset (duplicates ignored by the database are not counted). */
  events: Partial<Record<EventPreset, number>>;
  /** Diagnostics: mints whose preset was blocked ONLY by missing data, per gap. */
  gaps: Partial<Record<GapPreset, Partial<Record<DataGap, number>>>>;
  /** Events dropped for lack of a valid pool. */
  noPool: number;
  /** ISO time of the last call that reached the tail of token_snapshots, null = never (first pass running). */
  caughtUpAt: string | null;
}

export const initialScannerCursor = (): ScannerCursor => ({
  v: 1,
  at: null,
  id: null,
  snapshots: 0,
  events: {},
  gaps: {},
  noPool: 0,
  caughtUpAt: null,
});

const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const nonNegInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const CRITERIA: readonly GapPreset[] = GAP_PRESETS;
const GAPS: readonly DataGap[] = DATA_GAPS;

/**
 * backtest_event_state.state of key 'cursor' → ScannerCursor, or null when absent / malformed (restart from scratch).
 * Counters of presets / gaps that no longer exist (removed by chore/slim-down) are dropped, not rejected: the keyset
 * position is kept.
 */
export function parseScannerCursor(raw: unknown): ScannerCursor | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1) return null;
  if (r['at'] !== null && !isIso(r['at'])) return null;
  const id = r['id'] === null ? null : nonNegInt(r['id']);
  if (r['id'] !== null && (id === null || id <= 0)) return null;
  if ((r['at'] === null) !== (r['id'] === null)) return null;
  const snapshots = nonNegInt(r['snapshots']);
  const noPool = nonNegInt(r['noPool'] ?? 0);
  if (snapshots === null || noPool === null) return null;
  if (r['caughtUpAt'] !== null && r['caughtUpAt'] !== undefined && !isIso(r['caughtUpAt'])) return null;
  const events: ScannerCursor['events'] = {};
  const ev = r['events'] ?? {};
  if (typeof ev !== 'object' || ev === null || Array.isArray(ev)) return null;
  for (const [k, v] of Object.entries(ev)) {
    const n = nonNegInt(v);
    if (n === null) return null;
    if ((EVENT_PRESETS as readonly string[]).includes(k)) events[k as EventPreset] = n;
  }
  const gaps: ScannerCursor['gaps'] = {};
  const gp = r['gaps'] ?? {};
  if (typeof gp !== 'object' || gp === null || Array.isArray(gp)) return null;
  for (const [k, v] of Object.entries(gp)) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    if (!(CRITERIA as readonly string[]).includes(k)) continue;
    const per: Partial<Record<DataGap, number>> = {};
    for (const [g, n] of Object.entries(v)) {
      const c = nonNegInt(n);
      if (!(GAPS as readonly string[]).includes(g) || c === null) return null;
      per[g as DataGap] = c;
    }
    gaps[k as GapPreset] = per;
  }
  return {
    v: 1,
    at: (r['at'] as string | null) ?? null,
    id,
    snapshots,
    events,
    gaps,
    noPool,
    caughtUpAt: (r['caughtUpAt'] as string | null | undefined) ?? null,
  };
}

/** PostgREST keyset filter (or=…) of the snapshots after the cursor in (captured_at, id) order; null = from the start. */
export function snapshotKeyset(c: Pick<ScannerCursor, 'at' | 'id'>): string | null {
  if (c.at === null || c.id === null) return null;
  if (!Number.isSafeInteger(c.id) || c.id <= 0 || !isIso(c.at)) return null;
  const at = c.at.replace(/"/g, '');
  return `captured_at.gt."${at}",and(captured_at.eq."${at}",id.gt.${c.id})`;
}

/**
 * How many leading rows of a chronological page may be processed now, so that every 2-minute bucket processed is
 * complete (a scan pass is never split by the cursor):
 *   - the rows of the page's last bucket are kept for the next call, unless that bucket ended BUCKET_GRACE_MS ago
 *     (it cannot grow any more: a scan inserts its snapshots at once with captured_at = now()) and the page is not
 *     full (a full page may stop in the middle of it);
 *   - a full page made of ONE bucket is processed whole (never stalls; such a bucket is unrealistic: ~130 snapshots
 *     per scan).
 * `tail` = the page reached the end of the data (nothing left to read after the processed rows, apart from the
 * incomplete bucket).
 */
export function completePrefix(capturedAtMs: readonly number[], pageFull: boolean, nowMs: number): { count: number; tail: boolean } {
  const n = capturedAtMs.length;
  if (n === 0) return { count: 0, tail: !pageFull };
  const last = scanBucket(capturedAtMs[n - 1]!);
  const lastEnd = (last + 1) * SCAN_BUCKET_MS;
  if (!pageFull && Number.isFinite(nowMs) && lastEnd + BUCKET_GRACE_MS <= nowMs) return { count: n, tail: true };
  let k = n;
  while (k > 0 && scanBucket(capturedAtMs[k - 1]!) === last) k--;
  if (k === 0 && pageFull) return { count: n, tail: false };
  return { count: k, tail: !pageFull };
}

/** Run gating: the scanner reached the tail recently (a queued run may start with every event recorded). */
export function scannerCaughtUp(c: Pick<ScannerCursor, 'caughtUpAt'> | null, nowMs: number): boolean {
  if (!c || c.caughtUpAt === null) return false;
  const t = Date.parse(c.caughtUpAt);
  return Number.isFinite(t) && nowMs - t <= CAUGHT_UP_TTL_MS && t <= nowMs + 60_000;
}

/** A queued run may start: scanner caught up, or the run has waited RUN_WAIT_MAX_MS (scanner stuck / failing). */
export function runMayStart(c: Pick<ScannerCursor, 'caughtUpAt'> | null, runCreatedAtMs: number, nowMs: number): boolean {
  if (scannerCaughtUp(c, nowMs)) return true;
  return Number.isFinite(runCreatedAtMs) && nowMs - runCreatedAtMs >= RUN_WAIT_MAX_MS;
}

const DEX_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * A public.tokens row (FACTS_SELECT) → events.ts TokenFacts, or null (invalid mint). firstDexSeen = the DEX of the
 * token's first detection (signal_outcomes.entry_dex_id: the dex of its first snapshot), when known.
 */
export function tokenFactsFromRow(row: unknown, firstDexSeen: unknown = null): TokenFacts | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (!isSolanaAddress(r['mint'])) return null;
  const created = typeof r['pair_created_at'] === 'string' && r['pair_created_at'].length <= 40 ? Date.parse(r['pair_created_at']) : NaN;
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  const facts: TokenFacts = {
    mint: r['mint'],
    pool: isSolanaAddress(r['pair_address']) ? r['pair_address'] : null,
    pairCreatedAtMs: Number.isFinite(created) ? created : null,
    narrative: typeof r['narrative'] === 'string' && r['narrative'].length <= 24 ? r['narrative'] : null,
    mintAuthorityDisabled: bool(r['mint_authority_disabled']),
    freezeAuthorityDisabled: bool(r['freeze_authority_disabled']),
  };
  if (typeof firstDexSeen === 'string' && DEX_RE.test(firstDexSeen)) facts.firstDexSeen = firstDexSeen;
  return facts;
}

/** public.backtest_events insert payload (candle queue columns are set by the database trigger). */
export interface EventInsertRow extends Omit<BacktestEvent, 'pool'> {
  pool: string;
}

/**
 * Events → insert rows. An event without a valid pool (no candle can be captured) is dropped and counted; the
 * conditions object keeps scalar values only and is capped (the column holds ≤ 4 KB).
 */
export function eventInsertRows(events: readonly BacktestEvent[]): { rows: EventInsertRow[]; noPool: number } {
  const rows: EventInsertRow[] = [];
  let noPool = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || !isSolanaAddress(e.mint)) continue;
    if (!isSolanaAddress(e.pool)) {
      noPool++;
      continue;
    }
    if (!(typeof e.price_at_event === 'number' && e.price_at_event > 0 && e.price_at_event < 1e12)) continue;
    const conditions: Record<string, string | number | boolean | null> = {};
    let size = 2;
    for (const [k, v] of Object.entries(e.conditions ?? {})) {
      if (!/^[a-z0-9_]{1,40}$/.test(k)) continue;
      let val: string | number | boolean | null;
      if (v === null || typeof v === 'boolean') val = v;
      else if (typeof v === 'number') val = Number.isFinite(v) ? v : null;
      else if (typeof v === 'string') val = v.slice(0, 80);
      else continue;
      size += k.length + 24 + (typeof val === 'string' ? val.length : 0);
      if (size > 3000) break;
      conditions[k] = val;
    }
    rows.push({ ...e, pool: e.pool, conditions });
  }
  return { rows, noPool };
}

/** Adds the per-preset events inserted and the data-gap diagnostics of one call to the cursor. */
export function accountScan(
  c: ScannerCursor,
  inserted: readonly { preset: unknown }[],
  gaps: readonly Partial<Record<GapPreset, readonly DataGap[]>>[],
): void {
  for (const r of Array.isArray(inserted) ? inserted : []) {
    const p = r?.preset;
    if (typeof p === 'string' && (EVENT_PRESETS as readonly string[]).includes(p)) {
      c.events[p as EventPreset] = (c.events[p as EventPreset] ?? 0) + 1;
    }
  }
  for (const g of Array.isArray(gaps) ? gaps : []) {
    for (const preset of CRITERIA) {
      const list: unknown = g?.[preset];
      if (!Array.isArray(list)) continue;
      const per = (c.gaps[preset] ??= {});
      for (const gap of list as unknown[]) {
        if (typeof gap === 'string' && (GAPS as readonly string[]).includes(gap)) per[gap as DataGap] = (per[gap as DataGap] ?? 0) + 1;
      }
    }
  }
}

/** Serialised size above which a mint state is trimmed (the column accepts ≤ 32 KB, jsonb overhead included). */
export const MAX_STATE_CHARS = 20_000;

/**
 * A replay state small enough for backtest_event_state (a too-large row would fail the whole upsert and stall the
 * scanner): the oldest history entries are dropped until the JSON fits. Practically never needed (≈ 40–80 entries
 * of ≈ 60 chars over the 75-min history window).
 */
export function boundedState<T extends { hist: unknown[] }>(state: T): T {
  if (JSON.stringify(state).length <= MAX_STATE_CHARS) return state;
  const hist = [...state.hist];
  let out: T = { ...state, hist };
  while (hist.length > 0 && JSON.stringify(out).length > MAX_STATE_CHARS) {
    hist.splice(0, Math.max(1, Math.ceil(hist.length / 10)));
    out = { ...state, hist };
  }
  return out;
}
