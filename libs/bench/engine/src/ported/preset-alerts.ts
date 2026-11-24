// Alert wiring for scan-tokens (pure: no I/O, no Date.now()). chore/slim-down: one alert preset, « Jeune calme ».
// The predicates live in ./presets.ts; this file adapts them to notify.ts and to the preset_signals measurement table:
//   - per-user candidates: evaluateYoungCalmAlert (persistence over 2 scans, one alert per « Calme » position episode
//     with a 12 h guard when no position was opened, fixed ×2 / ×0.7 plan), best first by 1 h volume (then effective
//     liquidity, then mint); quiet hours and caps are applied by the caller;
//   - budget: distinct notifications (single + grouped) of the last hour and the last 24 h → capBudget;
//   - preset_signals rows: first match per preset per mint at scan time (young_calm and young_frenzy; young_frenzy is
//     never alerted), independent of users and pushes.
import { type AlertCandidate, BUDGET_WINDOW_MS, type PreviousSnapshot } from './alerts';
import {
  type CalmPositionRef,
  capBudget,
  effectiveLiquidity,
  evaluateYoungCalmAlert,
  matchesYoungCalm,
  matchesYoungFrenzy,
  pairAgeHours,
  type PresetToken,
  type SignalPreset,
} from './presets';
import { isSolanaAddress } from './solana';

export const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const orMinusInf = (v: number | null | undefined): number => (finite(v) ? v : -Infinity);

/** Activity order of alert candidates: 1 h volume, then effective liquidity (both descending), then mint. */
export function compareAlertCandidates(a: PresetToken, b: PresetToken): number {
  const v = orMinusInf(b.volume_1h) - orMinusInf(a.volume_1h);
  if (v !== 0 && !Number.isNaN(v)) return v;
  const l = orMinusInf(effectiveLiquidity(b)) - orMinusInf(effectiveLiquidity(a));
  if (l !== 0 && !Number.isNaN(l)) return l;
  return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
}

/** A « Jeune calme » candidate: the token, its fixed plan and the pair age at decision time (hours, null = unknown). */
export type YoungCalmCandidate<T extends PresetToken> = AlertCandidate<T> & { pair_age_h: number | null };

/**
 * « Jeune calme » tokens to notify for one user, best first (compareAlertCandidates), each with its exit plan.
 * `calmPositions`: this user's « Calme » book positions by mint (parseCalmPositions), for the alert guard.
 */
export function selectYoungCalmCandidates<T extends PresetToken>(
  tokens: readonly T[],
  lastNotifiedAt: ReadonlyMap<string, number>,
  now: number,
  previous: ReadonlyMap<string, PreviousSnapshot>,
  calmPositions: ReadonlyMap<string, readonly CalmPositionRef[]> = new Map(),
): YoungCalmCandidate<T>[] {
  const out: YoungCalmCandidate<T>[] = [];
  for (const t of tokens) {
    const d = evaluateYoungCalmAlert(t, lastNotifiedAt.get(t.mint), previous.get(t.mint), now, calmPositions.get(t.mint) ?? []);
    if (d.ok && 'plan' in d) out.push({ ...t, plan: d.plan, pair_age_h: pairAgeHours(t.pair_created_at, now) });
  }
  return out.sort(compareAlertCandidates);
}

/**
 * Books whose positions drive the « Jeune calme » alert guard (the two « Calme » books of feat/calm-sl-test; mirror of
 * paper-engine.ts CALM_BOOKS, checked by a test). The archived calm_all_x2 book does not count.
 */
export const ALERT_GUARD_BOOKS: readonly string[] = ['calm_sl30', 'calm_sl40'];
/** paper_positions rows read per scan for the guard; a full page cannot prove absence → no alert this scan. */
export const ALERT_GUARD_LIMIT = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * paper_positions rows { user_id, book, mint, status, created_at } → user → mint → CalmPositionRef[] (guard books
 * only). null when the read cannot be trusted (not an array, or ≥ limit rows: fail closed, no alert this scan). A row
 * with an invalid user / mint / book is skipped; an unreadable created_at counts as an ACTIVE position created now − ∞
 * only if its status is active (blocks), else it is skipped.
 */
export function parseCalmPositions(
  rows: unknown,
  limit: number = ALERT_GUARD_LIMIT,
): Map<string, Map<string, CalmPositionRef[]>> | null {
  if (!Array.isArray(rows) || rows.length >= limit) return null;
  const out = new Map<string, Map<string, CalmPositionRef[]>>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r['user_id'] !== 'string' || !UUID_RE.test(r['user_id']) || !isSolanaAddress(r['mint'])) continue;
    if (typeof r['book'] !== 'string' || !ALERT_GUARD_BOOKS.includes(r['book'])) continue;
    const active = r['status'] === 'pending' || r['status'] === 'open';
    const t = typeof r['created_at'] === 'string' && r['created_at'].length <= 40 ? Date.parse(r['created_at']) : NaN;
    // Corrupt date on an active position: treat it as belonging to any past alert (blocks); closed one: ignored.
    const createdAtMs = Number.isFinite(t) ? t : active ? -Infinity : NaN;
    if (Number.isNaN(createdAtMs)) continue;
    const byMint = out.get(r['user_id']) ?? new Map<string, CalmPositionRef[]>();
    const list = byMint.get(r['mint']) ?? [];
    list.push({ createdAtMs, active });
    byMint.set(r['mint'], list);
    out.set(r['user_id'], byMint);
  }
  return out;
}

export interface SentCounts {
  lastHour: number;
  last24h: number;
}

/**
 * alert_log rows { notification_id, sent_at } (kinds single + grouped, the caller filters) → distinct notifications
 * sent in the last hour and in the last 24 h. A grouped push = one notification however many mints it logged.
 */
export function sentCounts(rows: readonly { notification_id: unknown; sent_at: unknown }[], now: number): SentCounts {
  const hour = new Set<string>();
  const day = new Set<string>();
  for (const r of rows) {
    if (typeof r.notification_id !== 'string' || typeof r.sent_at !== 'string' || r.sent_at.length > 40) continue;
    const t = Date.parse(r.sent_at);
    if (!Number.isFinite(t)) continue;
    const age = now - t;
    if (age < 0 || age >= DAY_WINDOW_MS) continue;
    day.add(r.notification_id);
    if (age < BUDGET_WINDOW_MS) hour.add(r.notification_id);
  }
  return { lastHour: hour.size, last24h: day.size };
}

/** Pushes still allowed for this user now: min(hourly remaining, daily remaining) (capBudget of presets.ts). */
export function userAlertBudget(
  settings: { max_per_hour?: number | null; max_per_day?: number | null },
  counts: SentCounts,
): number {
  const perHour = finite(settings.max_per_hour) ? settings.max_per_hour : undefined;
  const perDay = finite(settings.max_per_day) ? settings.max_per_day : undefined;
  return capBudget(counts.lastHour, counts.last24h, perHour, perDay);
}

// ---------------------------------------------------------------------------------------------------------------
// preset_signals

/** Token row of the scan (tokens upsert row + RugCheck flags + round trip) as read by presetSignalRows. */
export interface PresetSignalToken extends PresetToken {
  pair_address?: string | null;
  /** tokens.narrative (e.g. 'GTA'); recorded as preset_signals.narrative. Hostile-text safe: [A-Z0-9_]{1,24} only. */
  narrative?: string | null;
}

export interface PresetSignalInsert {
  preset: SignalPreset;
  mint: string;
  pair_address: string;
  detected_at: string;
  entry_price: number;
  entry_mc: number | null;
  entry_liq_eff: number | null;
  /** Archived (Fibonacci zones removed): always null for new rows. */
  entry_zone: null;
  entry_dex_id: string | null;
  entry_change_1h: number | null;
  entry_roundtrip_pct: number | null;
  /** Narrative at detection (tokens.narrative), null when none / not a clean label. */
  narrative: string | null;
  /** Pair age at detection, HOURS (0–100 000, 3 decimals), null when pair_created_at is unknown. */
  pair_age_h: number | null;
}

const NARRATIVE_RE = /^[A-Z0-9_]{1,24}$/;
/** tokens.narrative → a clean label or null (the narratives of features.ts are upper-case keywords). */
export const cleanNarrative = (v: unknown): string | null =>
  typeof v === 'string' && NARRATIVE_RE.test(v) ? v : null;

const inRange = (v: number | null | undefined, min: number, max: number): number | null =>
  finite(v) && v >= min && v <= max ? v : null;

/**
 * preset_signals rows of this scan: one per (preset, matching token) for young_calm / young_frenzy (matchesYoungCalm /
 * matchesYoungFrenzy at nowMs), values bounded to the table CHECKs (else null; unusable mint / pool / price → no row).
 * The insert uses ignoreDuplicates on (preset, mint): only the first match of a mint per preset is kept. narrative and
 * pair_age_h are recorded on every row.
 */
export function presetSignalRows(tokens: readonly PresetSignalToken[], nowMs: number): PresetSignalInsert[] {
  if (!Number.isFinite(nowMs)) return [];
  const detectedAt = new Date(nowMs).toISOString();
  const out: PresetSignalInsert[] = [];
  for (const t of tokens) {
    const price = inRange(t.price_usd, Number.MIN_VALUE, 1e12 - 1);
    if (!isSolanaAddress(t.mint) || !isSolanaAddress(t.pair_address) || price === null) continue;
    const presets: SignalPreset[] = [];
    if (matchesYoungCalm(t, nowMs).ok) presets.push('young_calm');
    if (matchesYoungFrenzy(t, nowMs).ok) presets.push('young_frenzy');
    if (presets.length === 0) continue;
    const age = pairAgeHours(t.pair_created_at, nowMs);
    const pairAgeH = age !== null && age <= 100_000 ? Math.round(age * 1000) / 1000 : null;
    const narrative = cleanNarrative(t.narrative);
    const dex = typeof t.dex_id === 'string' && /^[a-z0-9_-]{1,32}$/.test(t.dex_id) ? t.dex_id : null;
    for (const preset of presets) {
      out.push({
        preset,
        mint: t.mint,
        pair_address: t.pair_address,
        detected_at: detectedAt,
        entry_price: price,
        entry_mc: inRange(t.market_cap, 0, 1e15 - 1),
        entry_liq_eff: inRange(effectiveLiquidity(t), 0, 1e13 - 1),
        entry_zone: null,
        entry_dex_id: dex,
        entry_change_1h: inRange(t.change_1h, -100, 1e9 - 1),
        entry_roundtrip_pct: inRange(t.roundtrip_cost_pct, -100, 100),
        narrative,
        pair_age_h: pairAgeH,
      });
    }
  }
  return out;
}
