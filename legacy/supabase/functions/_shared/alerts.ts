// Pure alert logic for Web Push notifications (no Deno or network APIs).
// Rules are documented in docs/ARCHITECTURE.md §Notifications push. chore/slim-down: no score, zone, R/R or model gate
// any more; the only alert preset is « Jeune calme » (presets.ts evaluateYoungCalmAlert), which uses the persistence,
// dedup, payload and budget helpers below. send-test-push uses buildTestPayload / mapLimit.
import type { ExitPlan } from './exit-plan.ts';
import { sanitizeText } from './sanitize.ts';
import { isSolanaAddress } from './solana.ts';

/** Subset of a public.tokens row needed to decide and build a notification. */
export interface AlertToken {
  mint: string;
  symbol: string;
  dex_id: string;
  market_cap: number;
  flags: readonly string[];
  mint_authority_disabled: boolean | null;
  freeze_authority_disabled: boolean | null;
  /** Current DexScreener price = entry of the exit plan. Unknown → no plan → no alert. */
  price_usd?: number | null;
  /** Jupiter round trip 0.1 SOL (PERCENT), recorded in alert_log at alert time. */
  roundtrip_cost_pct?: number | null;
  /** RugCheck (enrich-tokens): insider network detected. true = never alerted (safety). */
  insiders_detected?: boolean | null;
  /** RugCheck (enrich-tokens): creator already rugged tokens. true = never alerted (safety). */
  creator_rug_history?: boolean | null;
}

/**
 * Subset of a public.alert_settings row still read by the alerts. Hours are Europe/Paris. The archived columns
 * (min_score, only_in_zone, hide_bonding_curve, min_rr, min_p_x3, max_p_dd50, young_strong_enabled…) are not read.
 */
export interface AlertSettings {
  quiet_start: number;
  quiet_end: number;
  max_per_hour: number;
  /** Daily cap (1-100, default 30), on top of max_per_hour. */
  max_per_day?: number | null;
  /** Usual stake (SOL), recorded in alert_log at alert time. */
  stake_sol?: number | null;
}

export const DEFAULT_STAKE_SOL = 0.1;

const setting = (v: number | null | undefined, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;

/** Effective stake of a user (fallback 0.1 SOL when missing or out of 0.01–100). */
export const stakeSetting = (s: Pick<AlertSettings, 'stake_sol'>): number => setting(s.stake_sol, DEFAULT_STAKE_SOL, 0.01, 100);

// ---------------------------------------------------------------------------------------------------------------
// Persistence: the token was already kept by the previous scan

/** Previous scan state of a mint (latest token_snapshots row with source = 'scan' before this scan). */
export interface PreviousSnapshot {
  /** epoch ms (captured_at) */
  at: number;
}

/** A previous snapshot older than this (or missing) makes the token « not alertable yet ». */
export const PERSISTENCE_MAX_AGE_MS = 5 * 60_000;

/**
 * token_snapshots rows ({ mint, captured_at }) → latest row per mint captured strictly before `beforeMs` (the start of
 * the current scan, so this scan's own snapshots never count). Invalid rows are dropped. The archived score /
 * zone_status columns are NOT required (null in every snapshot written since chore/slim-down).
 */
export function previousSnapshotsFromRows(rows: unknown, beforeMs: number): Map<string, PreviousSnapshot> {
  const out = new Map<string, PreviousSnapshot>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (!isSolanaAddress(r.mint)) continue;
    const at = typeof r.captured_at === 'string' && r.captured_at.length <= 40 ? Date.parse(r.captured_at) : NaN;
    if (!Number.isFinite(at) || at >= beforeMs) continue;
    const cur = out.get(r.mint);
    if (!cur || at > cur.at) out.set(r.mint, { at });
  }
  return out;
}

/** A previous scan of the token exists and is ≤ 5 min old (strictly in the past). */
export function passedPreviousScan(prev: PreviousSnapshot | undefined, now: number): boolean {
  if (!prev) return false;
  const age = now - prev.at;
  return age > 0 && age <= PERSISTENCE_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------------------------------------------
// Decisions

export type AlertRejection = 'dedup' | 'not_persistent' | 'no_plan';

export type AlertDecision = { ok: true; plan: ExitPlan } | { ok: false; reason: AlertRejection };

export const DEDUP_WINDOW_MS = 12 * 60 * 60 * 1000;

export type AlertCandidate<T extends AlertToken> = T & { plan: ExitPlan };

/**
 * Angular's service worker (ngsw) only shows a push whose JSON has a `notification` object.
 * `onActionClick.default` makes a click open/focus the app on `url` even when it is closed.
 * `url` is always a relative path built here (never taken from token data).
 */
export interface PushPayload {
  notification: {
    title: string;
    body: string;
    icon: string;
    tag: string;
    data: {
      url: string;
      onActionClick: { default: { operation: 'navigateLastFocusedOrOpen'; url: string } };
    };
  };
}

export const NOTIFICATION_ICON = '/icons/icon-192.png';

function notificationPayload(title: string, body: string, tag: string, url: string): PushPayload {
  return {
    notification: {
      title,
      body,
      icon: NOTIFICATION_ICON,
      tag,
      data: { url, onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url } } },
    },
  };
}

export const BUDGET_WINDOW_MS = 60 * 60 * 1000;
export const MAX_INDIVIDUAL_PER_SCAN = 3;
/** Upper bound of mints logged for one grouped notification (keeps inserts bounded). */
export const MAX_GROUPED_MINTS = 100;
export const MAX_PAYLOAD_BYTES = 3000;
export const ALERT_TIME_ZONE = 'Europe/Paris';

/** Hour of day (0-23) in `timeZone`, DST-aware (Intl, no external lib). */
export function localHour(now: number | Date, timeZone: string = ALERT_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(
    typeof now === 'number' ? new Date(now) : now,
  );
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return Number.isInteger(hour) ? hour % 24 : 0;
}

/**
 * True if `now` falls in the quiet window [quietStart, quietEnd) local time.
 * Windows may wrap midnight (23 -> 7). start === end means "no quiet hours".
 */
export function isQuietHour(
  now: number | Date,
  quietStart: number,
  quietEnd: number,
  timeZone: string = ALERT_TIME_ZONE,
): boolean {
  if (quietStart === quietEnd) return false;
  const h = localHour(now, timeZone);
  return quietStart < quietEnd ? h >= quietStart && h < quietEnd : h >= quietStart || h < quietEnd;
}

/** Notifications still allowed in the current hour (never negative). */
export function budget(maxPerHour: number, sentLastHour: number): number {
  return Math.max(0, Math.floor(maxPerHour) - Math.max(0, Math.floor(sentLastHour)));
}

export interface NotificationPlan<T extends AlertToken> {
  /** One push each. */
  individual: T[];
  /** One push for all of them, or null. `count` = total candidates of this scan. */
  grouped: { count: number; mints: string[] } | null;
  /** Pushes consumed from the hourly budget (individual + 1 if grouped). */
  cost: number;
}

/**
 * Plans the pushes of one scan for one user.
 * - At most 3 individual pushes, and never more than the remaining budget.
 * - If candidates remain beyond the individual ones, ONE grouped push « N nouvelles opportunités »
 *   (N = total candidates). It costs 1 from the budget, so one budget slot is reserved for it.
 * - What must be logged in alert_log: every individual mint, plus every mint in `grouped.mints`
 *   (so none of them is re-notified for 12 h).
 */
export function planNotifications<T extends AlertToken>(
  candidates: readonly T[],
  remainingBudget: number,
): NotificationPlan<T> {
  const remaining = Math.max(0, Math.floor(remainingBudget));
  if (remaining === 0 || candidates.length === 0) return { individual: [], grouped: null, cost: 0 };

  const fitsIndividually = Math.min(MAX_INDIVIDUAL_PER_SCAN, remaining);
  if (candidates.length <= fitsIndividually) {
    return { individual: [...candidates], grouped: null, cost: candidates.length };
  }
  // Overflow: keep one slot for the grouped push.
  const nIndividual = Math.min(MAX_INDIVIDUAL_PER_SCAN, remaining - 1);
  const individual = candidates.slice(0, nIndividual);
  const rest = candidates.slice(nIndividual, nIndividual + MAX_GROUPED_MINTS);
  return {
    individual,
    grouped: { count: candidates.length, mints: rest.map((t) => t.mint) },
    cost: nIndividual + 1,
  };
}

/** Compact French USD amount (1 decimal below 10, integer above): 850 $, 1,5 k$, 250 k$, 1,2 M$, 3,4 Md$. */
export function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '? $';
  const units: [number, string][] = [
    [1e9, ' Md$'],
    [1e6, ' M$'],
    [1e3, ' k$'],
  ];
  for (const [div, suffix] of units) {
    if (value >= div) {
      const v = value / div;
      const rounded = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
      return `${String(rounded).replace('.', ',')}${suffix}`;
    }
  }
  return `${Math.round(value)} $`;
}

function fitPayload(p: PushPayload): PushPayload {
  const enc = new TextEncoder();
  let out = p;
  while (enc.encode(JSON.stringify(out)).length > MAX_PAYLOAD_BYTES && out.notification.body.length > 0) {
    const body = out.notification.body.slice(0, Math.floor(out.notification.body.length / 2));
    out = { notification: { ...out.notification, body } };
  }
  return out;
}

/**
 * USD price for a push, French decimals, 4 significant digits without exponent: 1,234 $ ; 0,0001234 $ ;
 * 12 345 → 12345 $. Unusable → '? $'.
 */
export function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '? $';
  if (value >= 1000) return `${Math.round(value)} $`;
  const decimals = Math.min(12, Math.max(2, 3 - Math.floor(Math.log10(value))));
  const fixed = value.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
  return `${fixed.replace('.', ',')} $`;
}

/** Signed integer percent with a real minus sign: +20 %, −14 %, 0 %. */
export function formatSignedPct(pct: number): string {
  if (!Number.isFinite(pct)) return '? %';
  const r = Math.round(pct);
  if (r === 0) return '0 %';
  return r > 0 ? `+${r} %` : `\u2212${Math.abs(r)} %`;
}

/** R/R with one French decimal: 1,4. */
export function formatRr(rr: number): string {
  if (!Number.isFinite(rr) || rr < 0) return '?';
  return String(Math.round(rr * 10) / 10).replace('.', ',');
}

/** « Objectif +20 % (0,0012 $) · Stop −14 % (0,00086 $) · R/R 1,4 » */
export function formatPlan(plan: ExitPlan): string {
  return [
    `Objectif ${formatSignedPct(plan.targetPct)} (${formatUsdPrice(plan.target)})`,
    `Stop ${formatSignedPct(plan.stopPct)} (${formatUsdPrice(plan.stop)})`,
    `R/R ${formatRr(plan.rr)}`,
  ].join(' · ');
}

const safeSymbol = (symbol: string): string => sanitizeText(symbol, 16).toUpperCase().slice(0, 16) || '???';

export const DISCLAIMER = 'Aide à la décision, pas un conseil financier.';
/** Label of the only alert preset in push titles. */
export const ALERT_PUSH_LABEL = 'Jeune calme';

/** Pair age for a push: « Paire de 25 min », « Paire de 5 h », unknown → null. */
export function formatPairAge(ageH: number | null | undefined): string | null {
  if (typeof ageH !== 'number' || !Number.isFinite(ageH) || ageH < 0) return null;
  if (ageH < 1) return `Paire de ${Math.max(1, Math.round(ageH * 60))} min`;
  return `Paire de ${Math.round(ageH)} h`;
}

/**
 * Individual « Jeune calme » notification. Token strings are hostile: re-sanitised and capped here.
 *   title « ⚡ RAIJIN · Jeune calme · SYMBOL »
 *   body  « Paire de 5 h · Objectif +100 % (…) · Stop −30 % (…) · R/R 3,3 · MC 450 k$ · 2 first flags · disclaimer »
 */
export function buildPayload(token: AlertToken, plan?: ExitPlan | null, pairAgeH?: number | null): PushPayload {
  const symbol = safeSymbol(token.symbol);
  const flags = (Array.isArray(token.flags) ? token.flags : [])
    .slice(0, 2)
    .map((f) => sanitizeText(f, 48))
    .filter((f) => f.length > 0);
  const age = formatPairAge(pairAgeH);
  const parts = [
    ...(age ? [age] : []),
    ...(plan ? [formatPlan(plan)] : []),
    `MC ${formatCompactUsd(token.market_cap)}`,
    ...flags,
    DISCLAIMER,
  ];
  const validMint = isSolanaAddress(token.mint);
  return fitPayload(
    notificationPayload(
      `⚡ RAIJIN · ${ALERT_PUSH_LABEL} · ${symbol}`,
      parts.join(' · '),
      validMint ? `raijin-${token.mint}` : 'raijin',
      validMint ? `/token/${token.mint}` : '/',
    ),
  );
}

/**
 * Follow-up of a tracked alert: « ✅ Objectif atteint · SYMBOL +20 % » or « 🛑 Invalidation touchée · SYMBOL −14 % ».
 * The percentage is the hit level vs the entry (target or stop of the plan), not the current price.
 * Distinct tag (raijin-followup-{mint}) so it does not replace the original alert on the device.
 */
export function buildFollowUpPayload(
  mint: string,
  symbol: string,
  hit: 'target' | 'stop',
  entry: number,
  level: number,
): PushPayload {
  const sym = safeSymbol(symbol);
  const pct = entry > 0 && Number.isFinite(entry) && Number.isFinite(level) ? (level / entry - 1) * 100 : NaN;
  const title = hit === 'target'
    ? `✅ Objectif atteint · ${sym} ${formatSignedPct(pct)}`
    : `🛑 Invalidation touchée · ${sym} ${formatSignedPct(pct)}`;
  const body = hit === 'target'
    ? `Prix ${formatUsdPrice(level)} atteint depuis l'alerte. ${DISCLAIMER}`
    : `Prix ${formatUsdPrice(level)} touché depuis l'alerte. ${DISCLAIMER}`;
  const validMint = isSolanaAddress(mint);
  return fitPayload(
    notificationPayload(
      title,
      body,
      validMint ? `raijin-followup-${mint}` : 'raijin-followup',
      validMint ? `/token/${mint}` : '/',
    ),
  );
}

export function buildGroupedPayload(count: number): PushPayload {
  const n = Math.max(0, Math.floor(count));
  return notificationPayload(
    `⚡ RAIJIN · ${n} nouvelles opportunités`,
    `Ouvre Raijin pour voir la liste. ${DISCLAIMER}`,
    'raijin-grouped',
    '/',
  );
}

export function buildTestPayload(): PushPayload {
  return notificationPayload(
    '⚡ RAIJIN · Notification de test',
    'Les notifications fonctionnent sur cet appareil.',
    'raijin-test',
    '/settings',
  );
}

/** Runs `fn` over `items` with at most `concurrency` in flight. Items not started before `deadline` (epoch ms) are skipped (result undefined). */
export async function mapLimit<I, O>(
  items: readonly I[],
  concurrency: number,
  fn: (item: I, index: number) => Promise<O>,
  deadline: number = Number.POSITIVE_INFINITY,
  clock: () => number = Date.now,
): Promise<(O | undefined)[]> {
  const results: (O | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      if (clock() >= deadline) continue;
      results[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}
