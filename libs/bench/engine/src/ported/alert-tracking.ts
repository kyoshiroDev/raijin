// Pure logic of the « suivi après alerte » (fix/alerts): alert_log rows as tracked positions. No I/O.
// - alertLogRow: the row written when a single alert is delivered (exit plan, entry state, 7-day window);
// - buildTrackingBatch: which mints scan-tokens must price this scan (paper orders first, then open alert positions,
//   bounded) and which of them are not in the scan's kept set (fetched from DexScreener anyway, 30 per call);
// - trackingSnapshotRow: token_snapshots row (source 'tracking') for those extra mints;
// - trackPosition: max/min/last price and the FIRST hit (target or stop) from a 2-min snapshot price;
// - followUpEligible: follow-up push « Objectif atteint » / « Invalidation touchée » within 48 h of the alert.
// Prices are 2-minute samples of the DexScreener price: a wick between two scans can be missed (documented).
import type { AlertCandidate, AlertSettings, AlertToken } from './alerts';
import { stakeSetting } from './alerts';
import { isSolanaAddress } from './solana';
import type { TokenMetrics } from './types';

export const TRACKING_WINDOW_MS = 7 * 24 * 3_600_000;
export const FOLLOWUP_WINDOW_MS = 48 * 3_600_000;
/** Distinct mints priced per scan for open positions (≤ 4 DexScreener calls of 30). */
export const MAX_TRACKED_MINTS = 100;
/** Open alert_log rows read per scan (newest first). */
export const MAX_OPEN_POSITIONS = 1000;
export const DEX_BATCH = 30;
/** Follow-ups sent per user and per scan (they do not consume the hourly alert budget). */
export const MAX_FOLLOWUPS_PER_USER = 5;

const PRICE_MAX = 1e12;

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && v.length <= 64) {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}
function timeMs(v: unknown): number | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const price = (v: number | null): number | null => (v !== null && v > 0 && v < PRICE_MAX ? v : null);

// ---------------------------------------------------------------------------------------------------------------
// alert_log row at send time

/**
 * Insert row of a delivered single alert (columns of 20261117120000_alert_tracking.sql). entry_score / entry_zone are
 * archived (chore/slim-down): not written, the alert_log_single_has_plan CHECK no longer requires them.
 */
export function alertLogRow(
  userId: string,
  notificationId: string,
  token: AlertCandidate<AlertToken>,
  settings: Pick<AlertSettings, 'stake_sol'>,
  nowMs: number,
) {
  const { plan } = token;
  const rt = num(token.roundtrip_cost_pct ?? null);
  const at = new Date(nowMs).toISOString();
  return {
    user_id: userId,
    mint: token.mint,
    notification_id: notificationId,
    kind: 'single' as const,
    entry_price: plan.entry,
    target_price: plan.target,
    stop_price: plan.stop,
    rr: plan.rr,
    entry_roundtrip_pct: rt !== null && rt >= -100 && rt <= 100 ? rt : null,
    stake_sol: stakeSetting(settings),
    max_price: plan.entry,
    min_price: plan.entry,
    last_price: plan.entry,
    last_price_at: at,
    tracking_until: new Date(nowMs + TRACKING_WINDOW_MS).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Open positions

export interface OpenPosition {
  id: number;
  userId: string;
  mint: string;
  sentAt: number;
  entry: number;
  target: number;
  stop: number;
  maxPrice: number | null;
  minPrice: number | null;
  firstHit: 'target' | 'stop' | null;
  followupSentAt: number | null;
}

/** Columns read by scan-tokens (alert_log, tracking_until > now). */
export const OPEN_POSITION_SELECT =
  'id,user_id,mint,sent_at,entry_price,target_price,stop_price,max_price,min_price,first_hit,followup_sent_at';

/** alert_log rows → open positions, validated row by row (invalid rows dropped). */
export function parseOpenPositions(rows: unknown): OpenPosition[] {
  if (!Array.isArray(rows)) return [];
  const out: OpenPosition[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const id = num(r['id']);
    const sentAt = timeMs(r['sent_at']);
    const entry = price(num(r['entry_price']));
    const target = price(num(r['target_price']));
    const stop = price(num(r['stop_price']));
    if (id === null || !Number.isInteger(id) || typeof r['user_id'] !== 'string' || r['user_id'].length > 64) continue;
    if (!isSolanaAddress(r['mint']) || sentAt === null || entry === null || target === null || stop === null) continue;
    if (!(stop < entry && entry < target)) continue;
    const hit = r['first_hit'] === 'target' || r['first_hit'] === 'stop' ? r['first_hit'] : null;
    out.push({
      id,
      userId: r['user_id'],
      mint: r['mint'],
      sentAt,
      entry,
      target,
      stop,
      maxPrice: price(num(r['max_price'])),
      minPrice: price(num(r['min_price'])),
      firstHit: hit,
      followupSentAt: timeMs(r['followup_sent_at']),
    });
  }
  return out;
}

export interface TrackingBatch {
  /** Distinct mints to price this scan (open paper positions, pending paper entries, then alerts newest first), ≤ MAX_TRACKED_MINTS. */
  tracked: string[];
  /** Tracked mints NOT in the scan's kept set: fetched from DexScreener anyway. */
  toFetch: string[];
  /** toFetch in DexScreener /tokens/v1 batches of 30. */
  chunks: string[][];
}

/** Mints that must be priced every scan whatever the scan filters (paper trading, feat/paper-trading). */
export interface ForcedMints {
  /** Mints of open paper positions (TP / SL watch): highest priority. */
  open: readonly string[];
  /** Mints of pending paper entries (fill watch). */
  pending: readonly string[];
}

/**
 * Which mints to price: open paper positions, then pending paper entries, then open alert positions (newest alert
 * first); deduplicated and bounded to `maxMints` in that priority order. Those outside the scan's kept set are fetched.
 */
/**
 * Paper-trading mints get at most this share of the tracking slots in the first pass, so a few full paper books can
 * never push the REAL alert positions out of the tracking (security review M1). Unused slots are refilled after.
 */
export const MAX_PAPER_TRACKING_SHARE = 0.5;

export function buildTrackingBatch(
  positions: readonly OpenPosition[],
  keptMints: ReadonlySet<string>,
  maxMints: number = MAX_TRACKED_MINTS,
  forced: ForcedMints = { open: [], pending: [] },
): TrackingBatch {
  const tracked: string[] = [];
  const seen = new Set<string>();
  const add = (mint: unknown, cap: number = maxMints) => {
    if (tracked.length >= cap || tracked.length >= maxMints) return;
    if (typeof mint !== 'string' || seen.has(mint) || !isSolanaAddress(mint)) return;
    seen.add(mint);
    tracked.push(mint);
  };
  const paperCap = Math.floor(maxMints * MAX_PAPER_TRACKING_SHARE);
  // 1. paper positions (open first, then pending) up to their reserved share;
  for (const m of forced.open) add(m, paperCap);
  for (const m of forced.pending) add(m, paperCap);
  // 2. every alert position (most recent first);
  for (const p of [...positions].sort((a, b) => b.sentAt - a.sentAt)) add(p.mint);
  // 3. remaining slots go back to the paper mints that did not fit.
  for (const m of forced.open) add(m);
  for (const m of forced.pending) add(m);
  const toFetch = tracked.filter((m) => !keptMints.has(m));
  const chunks: string[][] = [];
  for (let i = 0; i < toFetch.length; i += DEX_BATCH) chunks.push(toFetch.slice(i, i + DEX_BATCH));
  return { tracked, toFetch, chunks };
}

// ---------------------------------------------------------------------------------------------------------------
// Tracking snapshots (tokens outside the scan's kept set)

/** Last known tokens row of a tracked mint (its existence is what matters: token_snapshots.mint is a FK). */
export interface LastKnownToken {
  symbol?: unknown;
}

/**
 * token_snapshots row for a tracked mint that failed the scan filters: fresh DexScreener values, source 'tracking'
 * (no score / zone: archived columns, nullable since chore/slim-down). null when the price is unusable or the token
 * row is missing (FK).
 */
export function trackingSnapshotRow(m: TokenMetrics, last: LastKnownToken | undefined) {
  if (!last || price(m.priceUsd) === null) return null;
  const nonNeg = (v: number) => (Number.isFinite(v) && v >= 0 && v < 1e15 ? v : 0);
  return {
    mint: m.mint,
    price_usd: m.priceUsd,
    market_cap: nonNeg(m.marketCap),
    liquidity_usd: nonNeg(m.liquidityUsd),
    volume_24h: nonNeg(m.volume24h),
    dex_id: m.dexId ? m.dexId.slice(0, 32) : null,
    source: 'tracking' as const,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Position update

export interface TrackingPatch {
  id: number;
  max_price: number;
  min_price: number;
  last_price: number;
  last_price_at: string;
  first_hit: 'target' | 'stop' | null;
  first_hit_at: string | null;
}

/**
 * New state of an open position for a sampled price. First hit wins: once first_hit is set it never changes
 * (target if price ≥ target, stop if price ≤ stop; both cannot hold since stop < entry < target).
 * null when the price is unusable (the position is left untouched this scan).
 */
export function trackPosition(pos: OpenPosition, sampledPrice: number, atMs: number): TrackingPatch | null {
  const p = price(sampledPrice);
  if (p === null || !Number.isFinite(atMs)) return null;
  const at = new Date(atMs).toISOString();
  let hit: 'target' | 'stop' | null = null;
  if (pos.firstHit === null) {
    if (p >= pos.target) hit = 'target';
    else if (p <= pos.stop) hit = 'stop';
  }
  return {
    id: pos.id,
    max_price: Math.max(pos.maxPrice ?? p, p),
    min_price: Math.min(pos.minPrice ?? p, p),
    last_price: p,
    last_price_at: at,
    first_hit: hit,
    first_hit_at: hit === null ? null : at,
  };
}

/** Applies trackPosition over successive samples (oldest first): the in-memory equivalent of the scans. */
export function replayPosition(pos: OpenPosition, samples: readonly { price: number; at: number }[]): OpenPosition {
  let cur = pos;
  for (const s of samples) {
    const patch = trackPosition(cur, s.price, s.at);
    if (!patch) continue;
    cur = {
      ...cur,
      maxPrice: patch.max_price,
      minPrice: patch.min_price,
      firstHit: cur.firstHit ?? patch.first_hit,
    };
  }
  return cur;
}

// ---------------------------------------------------------------------------------------------------------------
// Follow-ups

/**
 * A follow-up is due when the position has a first hit, no follow-up was sent yet, and the alert was sent less than
 * 48 h ago. (Quiet hours are checked by the caller per user: a hit during quiet hours is announced after them if
 * still within 48 h; the hourly alert budget is NOT consumed by follow-ups.)
 */
export function followUpEligible(pos: OpenPosition, now: number): boolean {
  if (pos.firstHit === null || pos.followupSentAt !== null) return false;
  const age = now - pos.sentAt;
  return age >= 0 && age < FOLLOWUP_WINDOW_MS;
}
