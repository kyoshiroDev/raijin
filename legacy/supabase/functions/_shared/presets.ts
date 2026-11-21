// Pure alert-preset logic (no Deno or network APIs). chore/slim-down: ONE alert preset is left.
// - 'young_calm' = « Jeune calme » (default and only alert preset): pair < 24 h on pumpswap with a CALM momentum
//   (0 ≤ change1h ≤ 100 %, 0.8 ≤ 1 h buy/sell ratio ≤ 1.3), liquidity ≥ 30 k$, safety (mint / freeze authority
//   disabled, no insiders / creator rug history, top 10 < 25 %, round trip < 5 %, LP ≥ 90 % when known, no « Structure
//   cassée » flag since feat/calm-sl-test). 201 young detections labelled on candles: calm 35–36 % ×2 before −30 %
//   (≈ +11 % / trade), frenzy 26 % (≈ −1 %).
// - 'young_frenzy' = « Jeune frénésie », its control twin (same base rules, opposite momentum): measured in
//   preset_signals and auto-papered in book frenzy_sl30 (feat/calm-sl-test), NEVER alerted.
// Momentum, Strict and « Jeune & fort » were removed (their preset_signals / alert_log rows are archived history).
import {
  type AlertDecision,
  type AlertRejection,
  type AlertToken,
  DEDUP_WINDOW_MS,
  passedPreviousScan,
  type PreviousSnapshot,
} from './alerts.ts';
import { fixedExitPlan } from './exit-plan.ts';
import { isYoungAge, ratio, YOUNG_FRENZY_1H_PCT, YOUNG_MAX_AGE_H, YOUNG_RATIO_MAX } from './flags.ts';
import { isSolanaAddress } from './solana.ts';

export type AlertPreset = 'young_calm';
export const ALERT_PRESETS: readonly AlertPreset[] = ['young_calm'];
export const DEFAULT_ALERT_PRESET: AlertPreset = 'young_calm';
export const ALERT_PRESET_LABELS: Readonly<Record<AlertPreset, string>> = { young_calm: 'Jeune calme' };

/**
 * alert_settings.alert_preset → AlertPreset. Every value maps to 'young_calm' (the archived 'momentum' / 'strict'
 * values of older rows included: those presets no longer exist).
 */
export function parsePreset(_v: unknown): AlertPreset {
  return DEFAULT_ALERT_PRESET;
}

/** Every preset measured in preset_signals (young_frenzy is measured and auto-papered only, never an alert). */
export type SignalPreset = 'young_calm' | 'young_frenzy';
export const SIGNAL_PRESETS: readonly SignalPreset[] = ['young_calm', 'young_frenzy'];
export const SIGNAL_PRESET_LABELS: Readonly<Record<SignalPreset, string>> = {
  young_calm: 'Jeune calme',
  young_frenzy: 'Jeune frénésie',
};

/** Exact SignalPreset or null (no default: a measurement row with an unknown preset is dropped). */
export function parseSignalPreset(v: unknown): SignalPreset | null {
  return typeof v === 'string' && (SIGNAL_PRESETS as readonly string[]).includes(v) ? (v as SignalPreset) : null;
}

/** AlertToken plus the public.tokens columns the young presets need. */
export interface PresetToken extends AlertToken {
  /** tokens.liquidity_usd (DexScreener). Fallback when liquidity_effective_usd is null. */
  liquidity_usd?: number | null;
  /** tokens.liquidity_effective_usd (median DexScreener / GeckoTerminal). */
  liquidity_effective_usd?: number | null;
  /** Price change over 1 h, PERCENT. Unknown → null (never the 0 default of normalize.ts). */
  change_1h?: number | null;
  /** Share of the supply held by the top 10 holders, PERCENT (0–100). */
  top10_pct?: number | null;
  /** tokens.pair_created_at as EPOCH MS (age rule). Unknown → rejected. */
  pair_created_at?: number | null;
  /** DexScreener txns h1. Ratio (buys + 1) / (sells + 1); either unknown → ratio unknown. */
  buys_1h?: number | null;
  sells_1h?: number | null;
  /** tokens.lp_locked_pct (RugCheck), PERCENT 0–100. null = unknown (accepted), known → ≥ 90. */
  lp_locked_pct?: number | null;
  /** DexScreener 1 h volume (USD): ranking of the alert candidates. */
  volume_1h?: number | null;
  /**
   * « Structure cassée » at this scan (structure.ts structureBroken on the scan metrics, feat/calm-sl-test). true →
   * rejected ('structure'); false / unknown → accepted (structureBroken itself answers false on unusable data).
   */
  structure_broken?: boolean | null;
}

export type PresetRejection =
  | 'invalid_mint'
  | 'dex'
  | 'liquidity'
  | 'safety'
  | 'top10'
  | 'roundtrip'
  | 'age'
  | 'ratio'
  | 'momentum'
  | 'lp'
  | 'structure'
  | 'position_open'
  | AlertRejection;

export type PresetMatch = { ok: true } | { ok: false; reason: PresetRejection };

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** liquidity_effective_usd when known (finite), else liquidity_usd, else null. */
export function effectiveLiquidity(t: PresetToken): number | null {
  if (finite(t.liquidity_effective_usd)) return t.liquidity_effective_usd;
  return finite(t.liquidity_usd) ? t.liquidity_usd : null;
}

/** Common safety thresholds (moved here from the removed Momentum / Jeune & fort presets). */
export const SAFETY_RULES = {
  /** top10_pct must be STRICTLY below this (percent). */
  maxTop10Pct: 25,
  /** roundtrip_cost_pct must be STRICTLY below this (percent). */
  maxRoundtripPct: 5,
} as const;

/**
 * Safety rules of the young presets, first failure in this order: mint AND freeze authority disabled + no insiders +
 * no creator rug history ('safety'); 0 ≤ top10 < maxTop10Pct ('top10'); 0 ≤ roundtrip < maxRoundtripPct
 * ('roundtrip'). Unknown values reject. null = all pass. The front mirrors it (« Sécurité OK / KO »).
 */
export function safetyRejection(
  t: PresetToken,
  maxTop10Pct: number = SAFETY_RULES.maxTop10Pct,
  maxRoundtripPct: number = SAFETY_RULES.maxRoundtripPct,
): 'safety' | 'top10' | 'roundtrip' | null {
  if (t.mint_authority_disabled !== true || t.freeze_authority_disabled !== true) return 'safety';
  if (t.insiders_detected === true || t.creator_rug_history === true) return 'safety';
  if (!(finite(t.top10_pct) && t.top10_pct >= 0 && t.top10_pct < maxTop10Pct)) return 'top10';
  if (!(finite(t.roundtrip_cost_pct) && t.roundtrip_cost_pct >= 0 && t.roundtrip_cost_pct < maxRoundtripPct)) {
    return 'roundtrip';
  }
  return null;
}

/** A pair_created_at up to this far in the future (clock skew) counts as age 0; beyond it the age is unknown. */
export const PAIR_AGE_MAX_SKEW_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

/**
 * Pair age in HOURS at `now` (both epoch ms). null when unknown: missing / non-finite / non-positive creation time, or
 * a creation time more than PAIR_AGE_MAX_SKEW_MS in the future. A slightly future time (skew) gives 0.
 */
export function pairAgeHours(pairCreatedAtMs: number | null | undefined, now: number): number | null {
  if (!finite(pairCreatedAtMs) || pairCreatedAtMs <= 0 || !Number.isFinite(now)) return null;
  const ageMs = now - pairCreatedAtMs;
  if (ageMs < -PAIR_AGE_MAX_SKEW_MS) return null;
  return Math.max(0, ageMs) / HOUR_MS;
}

// ---------------------------------------------------------------------------------------------------------------
// young_calm — « Jeune calme » / young_frenzy — « Jeune frénésie » (docs/contracts/young-calm.md)
//
// Ratio = (buys_1h + 1) / (sells_1h + 1) = flags.ts ratio() = features.buy_sell_ratio_1h, the definition the figures
// were measured on. young_calm: persistence 2 scans, one alert per position episode (calmAlertGuard, 12 h guard when no
// position was opened), caps 4/h – 30/day, plan ×2 / ×0.7 (exit-plan.ts).

/** Base rules shared by young_calm and young_frenzy (age, dex, liquidity, cost, safety, LP). */
export const YOUNG_BASE_RULES = {
  dexId: 'pumpswap',
  /** Pair age must be STRICTLY below this (hours). */
  maxPairAgeH: YOUNG_MAX_AGE_H,
  /** Inclusive, USD (effective liquidity, else DexScreener liquidity: effectiveLiquidity()). */
  minLiquidity: 30_000,
  maxRoundtripPct: SAFETY_RULES.maxRoundtripPct,
  maxTop10Pct: SAFETY_RULES.maxTop10Pct,
  /** lp_locked_pct, when KNOWN, must be ≥ this (percent; pumpswap LP is burnt at migration). Unknown → accepted. */
  minLpLockedPct: 90,
} as const;

/** « Jeune calme »: base rules + calm momentum (all bounds INCLUSIVE). */
export const YOUNG_CALM_RULES = {
  ...YOUNG_BASE_RULES,
  minChange1h: 0,
  maxChange1h: 100,
  minRatio: 0.8,
  maxRatio: YOUNG_RATIO_MAX,
} as const;

/** « Jeune frénésie »: base rules + frenzy momentum: change1h > frenzyChange1h OR ratio > frenzyRatio (STRICT). */
export const YOUNG_FRENZY_RULES = {
  ...YOUNG_BASE_RULES,
  frenzyChange1h: YOUNG_FRENZY_1H_PCT,
  frenzyRatio: YOUNG_RATIO_MAX,
} as const;

/**
 * 1 h buy/sell ratio (buys + 1) / (sells + 1), or null when either count is unknown (missing, non-finite, negative).
 */
export function youngRatio(buys: number | null | undefined, sells: number | null | undefined): number | null {
  if (!finite(buys) || !finite(sells) || buys < 0 || sells < 0) return null;
  return ratio(buys, sells);
}

export type YoungMomentum = 'calm' | 'frenzy' | 'neither' | 'unknown';

/**
 * Momentum class of a young token from change1h (PERCENT) and the 1 h ratio. Either unknown → 'unknown'.
 * calm   = minChange1h ≤ change1h ≤ maxChange1h AND minRatio ≤ ratio ≤ maxRatio;
 * frenzy = change1h > frenzyChange1h OR ratio > frenzyRatio (disjoint from calm);
 * neither = the rest (e.g. negative 1 h, ratio < 0.8, change1h 100–150 %).
 * Also used by the backtest (features at detection, snapshot values) so the thresholds live in one place.
 */
export function youngMomentumClass(change1h: number | null | undefined, r: number | null | undefined): YoungMomentum {
  if (!finite(change1h) || !finite(r)) return 'unknown';
  const c = YOUNG_CALM_RULES;
  if (change1h >= c.minChange1h && change1h <= c.maxChange1h && r >= c.minRatio && r <= c.maxRatio) return 'calm';
  const f = YOUNG_FRENZY_RULES;
  if (change1h > f.frenzyChange1h || r > f.frenzyRatio) return 'frenzy';
  return 'neither';
}

/** LP rule: unknown (null / non-finite) → accepted; known → ≥ minLpLockedPct. */
export const youngLpOk = (lpLockedPct: number | null | undefined): boolean =>
  !finite(lpLockedPct) || lpLockedPct >= YOUNG_BASE_RULES.minLpLockedPct;

/**
 * Base predicate of young_calm / young_frenzy, first failure in this order: valid mint; pair age < 24 h ('age',
 * unknown rejects); dex pumpswap; effective liquidity ≥ 30 k$ ('liquidity'); safety / top10 / roundtrip
 * (safetyRejection); LP locked ≥ 90 % when known ('lp'); no « Structure cassée » ('structure', feat/calm-sl-test:
 * part of the « Sécurité OK » of the preset, applied to the frenzy control too so both share the same base filters).
 */
function matchesYoungBase(t: PresetToken, now: number): PresetMatch {
  const no = (reason: PresetRejection): PresetMatch => ({ ok: false, reason });
  const r = YOUNG_BASE_RULES;
  if (!t || !isSolanaAddress(t.mint)) return no('invalid_mint');
  if (!isYoungAge(pairAgeHours(t.pair_created_at, now))) return no('age');
  if (t.dex_id !== r.dexId) return no('dex');
  const liq = effectiveLiquidity(t);
  if (!(liq !== null && liq >= r.minLiquidity)) return no('liquidity');
  const unsafe = safetyRejection(t, r.maxTop10Pct, r.maxRoundtripPct);
  if (unsafe) return no(unsafe);
  if (!youngLpOk(t.lp_locked_pct)) return no('lp');
  if (t.structure_broken === true) return no('structure');
  return { ok: true };
}

/** Momentum check of the young presets: unknown ratio → 'ratio', unknown change1h → 'momentum'. */
function youngMomentum(t: PresetToken, want: 'calm' | 'frenzy'): PresetMatch {
  const r = youngRatio(t.buys_1h, t.sells_1h);
  if (r === null) return { ok: false, reason: 'ratio' };
  if (!finite(t.change_1h)) return { ok: false, reason: 'momentum' };
  if (youngMomentumClass(t.change_1h, r) === want) return { ok: true };
  if (want === 'calm') {
    const c = YOUNG_CALM_RULES;
    return t.change_1h < c.minChange1h || t.change_1h > c.maxChange1h
      ? { ok: false, reason: 'momentum' }
      : { ok: false, reason: 'ratio' };
  }
  return { ok: false, reason: 'momentum' };
}

/**
 * « Jeune calme » predicate (token level): matchesYoungBase (structure rule included), then 0 ≤ change1h ≤ 100
 * ('momentum') and 0.8 ≤ ratio ≤ 1.3 ('ratio'). No score, zone or MC rule.
 */
export function matchesYoungCalm(t: PresetToken, now: number): PresetMatch {
  const base = matchesYoungBase(t, now);
  return base.ok ? youngMomentum(t, 'calm') : base;
}

/**
 * « Jeune frénésie » predicate (token level): matchesYoungBase, then change1h > 150 OR ratio > 1.3 (both must be
 * known: unknown ratio → 'ratio', unknown change1h → 'momentum'). NEVER an alert: auto-paper and measurement only.
 */
export function matchesYoungFrenzy(t: PresetToken, now: number): PresetMatch {
  const base = matchesYoungBase(t, now);
  return base.ok ? youngMomentum(t, 'frenzy') : base;
}

// ---------------------------------------------------------------------------------------------------------------
// One alert per position episode (feat/calm-sl-test)

/** A « Calme » book position (calm_sl30 / calm_sl40) of the alerted user on the mint. */
export interface CalmPositionRef {
  /** paper_positions.created_at, epoch ms. */
  createdAtMs: number;
  /** status pending or open. */
  active: boolean;
}

/**
 * An alert and the auto-paper positions of the same signal are written in the same scan (alerts first, positions a few
 * seconds later), or a scan or two apart (first-sight match: positions at once, the alert needs the persistence scan).
 * An alert sent up to this long before a position belongs to that position's episode.
 */
export const ALERT_EPISODE_SLACK_MS = 15 * 60_000;

/**
 * Alert guard of one (user, mint), replacing the plain 12 h dedup:
 * - 'position_open': a calm position is still pending / open AND an alert was already sent for its episode (an alert at
 *   or after createdAt − ALERT_EPISODE_SLACK_MS): ONE alert per token while the previous virtual position is not closed;
 * - 'dedup': an alert < 12 h ago (future-dated counts as recent) and NO calm position was opened for it (none created at
 *   or after that alert − slack): the 12 h guard is kept when no position was opened (no auto_paper, cooldown, balance…);
 * - null: alertable. A position opened for the last alert and now closed lifts the 12 h guard.
 * Invalid position rows (non-finite time) are ignored by the caller's parser, not here.
 */
export function calmAlertGuard(
  lastNotifiedAt: number | undefined,
  positions: readonly CalmPositionRef[],
  now: number,
): 'position_open' | 'dedup' | null {
  if (lastNotifiedAt === undefined || !Number.isFinite(lastNotifiedAt)) return null;
  const slack = ALERT_EPISODE_SLACK_MS;
  if (positions.some((p) => p.active && lastNotifiedAt >= p.createdAtMs - slack)) return 'position_open';
  const openedForIt = positions.some((p) => p.createdAtMs >= lastNotifiedAt - slack);
  if (!openedForIt && now - lastNotifiedAt < DEDUP_WINDOW_MS) return 'dedup';
  return null;
}

/**
 * Full young_calm decision of one token for one user (quiet hours and caps are the caller's job), in order:
 * 1. matchesYoungCalm(token, now) (its reason);
 * 2. alert guard (calmAlertGuard): 'position_open' while the calm position of the previous alert is pending / open,
 *    'dedup' for 12 h after an alert that opened no position (DEDUP_WINDOW_MS). Without `positions` (= []) this is
 *    the former plain 12 h dedup;
 * 3. persistence: a previous scan ≤ 5 min old exists → else 'not_persistent';
 * 4. exit plan ×2 / ×0.7 (fixedExitPlan(price_usd)), null → 'no_plan'.
 */
export function evaluateYoungCalmAlert(
  token: PresetToken,
  lastNotifiedAt: number | undefined,
  previous: PreviousSnapshot | undefined,
  now: number,
  positions: readonly CalmPositionRef[] = [],
): AlertDecision | { ok: false; reason: PresetRejection } {
  const m = matchesYoungCalm(token, now);
  if (!m.ok) return m;
  const guard = calmAlertGuard(lastNotifiedAt, positions, now);
  if (guard) return { ok: false, reason: guard };
  if (!passedPreviousScan(previous, now)) return { ok: false, reason: 'not_persistent' };
  const plan = fixedExitPlan(token.price_usd);
  return plan ? { ok: true, plan } : { ok: false, reason: 'no_plan' };
}

// ---------------------------------------------------------------------------------------------------------------
// Caps

export const ALERT_CAP_PER_HOUR = 4;
export const ALERT_CAP_PER_DAY = 30;

const count = (v: number): number => (v > 0 ? Math.floor(v) : 0); // NaN / negative → 0, +Infinity stays (→ budget 0)
const cap = (v: number, fallback: number): number => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback);

/**
 * Alerts still allowed now = min(hourly remaining, daily remaining), never negative. Invalid counts
 * (NaN, negative) count as 0 sent; invalid caps (NaN, negative) fall back to the defaults.
 */
export function capBudget(
  sentLastHour: number,
  sentLast24h: number,
  maxPerHour: number = ALERT_CAP_PER_HOUR,
  maxPerDay: number = ALERT_CAP_PER_DAY,
): number {
  const hour = cap(maxPerHour, ALERT_CAP_PER_HOUR) - count(sentLastHour);
  const day = cap(maxPerDay, ALERT_CAP_PER_DAY) - Math.max(count(sentLast24h), count(sentLastHour));
  return Math.max(0, Math.min(hour, day));
}
