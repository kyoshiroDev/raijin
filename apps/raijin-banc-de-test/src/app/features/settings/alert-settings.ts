// Mirrors alert_settings as served by the bench API (`alertSettingsSchema` of @raijin/bench-contracts).
// Hours are Europe/Paris. The API re-checks every range.
// Archived columns (slim-down 2026-11-21), no longer read nor written: min_score, only_in_zone, min_p_x3, max_p_dd50,
// min_rr, paper_default_strategy, auto_paper_parallel, early_enabled, early_min_score, young_strong_enabled.
import type { PushSubscriptionRequest } from '@raijin/shared-contracts';
import { DEFAULT_PAPER_SL_PCT, SL_PCT_LIMITS, isValidSlPct, parseSlPct } from '../../shared/models/paper';
import { DEFAULT_STAKE_SOL, isValidStake, parseStakeValue } from '../../shared/utils/stake';

/** The only alert profile left: « Jeune calme » (fixed backend criteria, set server-side). */
export const ALERT_PRESET = 'young_calm';

/** User-editable preferences (everything but `enabled`, which the notification switch owns). */
export interface AlertPreferences {
  hide_bonding_curve: boolean;
  quiet_start: number;
  quiet_end: number;
  max_per_hour: number;
  /** Daily cap on alerts (1–100). */
  max_per_day: number;
  /** Usual stake in SOL (0.01–100), used to estimate the round-trip cost and as the paper trade stake. */
  stake_sol: number;
  /** SIMULATION: every alert sent opens a paper trade « tout à ×2 » (off by default). */
  auto_paper: boolean;
  /** Default stop of the paper trades, integer percent below the entry (1–90). */
  paper_sl_pct: number;
}

export interface AlertSettings extends AlertPreferences {
  enabled: boolean;
}

export const ALERT_SETTINGS_COLUMNS = 'enabled,hide_bonding_curve,quiet_start,quiet_end,max_per_hour,max_per_day,stake_sol,auto_paper,paper_sl_pct';

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: false,
  hide_bonding_curve: true,
  quiet_start: 23,
  quiet_end: 7,
  max_per_hour: 4,
  max_per_day: 30,
  stake_sol: DEFAULT_STAKE_SOL,
  auto_paper: false,
  paper_sl_pct: DEFAULT_PAPER_SL_PCT,
};

export const ALERT_LIMITS = {
  quiet_start: { min: 0, max: 23 },
  quiet_end: { min: 0, max: 23 },
  max_per_hour: { min: 1, max: 20 },
  max_per_day: { min: 1, max: 100 },
} as const;

export type AlertField = keyof typeof ALERT_LIMITS;
export type AlertErrors = Partial<Record<AlertField | 'stake_sol' | 'paper_sl_pct', string>>;

export const STAKE_ERROR = 'La mise doit être comprise entre 0,01 et 100 SOL.';
export const PAPER_SL_ERROR = `Le stop par défaut doit être un entier entre ${SL_PCT_LIMITS.min} et ${SL_PCT_LIMITS.max} %.`;

const ERROR_TEXT: Record<AlertField, string> = {
  quiet_start: 'L’heure de début doit être un entier entre 0 et 23.',
  quiet_end: 'L’heure de fin doit être un entier entre 0 et 23.',
  max_per_hour: 'Le maximum par heure doit être un entier entre 1 et 20.',
  max_per_day: 'Le maximum par jour doit être un entier entre 1 et 100.',
};

function inRange(value: unknown, field: AlertField): value is number {
  const { min, max } = ALERT_LIMITS[field];
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Client-side validation; empty object = valid. */
export function validateAlertPreferences(p: AlertPreferences): AlertErrors {
  const errors: AlertErrors = {};
  for (const field of Object.keys(ALERT_LIMITS) as AlertField[]) {
    if (!inRange(p[field], field)) errors[field] = ERROR_TEXT[field];
  }
  if (!isValidStake(p.stake_sol)) errors.stake_sol = STAKE_ERROR;
  if (!isValidSlPct(p.paper_sl_pct)) errors.paper_sl_pct = PAPER_SL_ERROR;
  return errors;
}

/** Exactly the editable preferences (never `enabled`, never an archived column). */
export function preferencesOf(p: AlertPreferences): AlertPreferences {
  return {
    hide_bonding_curve: p.hide_bonding_curve,
    quiet_start: p.quiet_start,
    quiet_end: p.quiet_end,
    max_per_hour: p.max_per_hour,
    max_per_day: p.max_per_day,
    stake_sol: p.stake_sol,
    auto_paper: p.auto_paper,
    paper_sl_pct: p.paper_sl_pct,
  };
}

/** Defensive parse of an API row; unknown or out-of-range values fall back to the defaults. */
export function parseAlertSettings(row: unknown): AlertSettings {
  if (typeof row !== 'object' || row === null) return { ...DEFAULT_ALERT_SETTINGS };
  const r = row as Partial<Record<keyof AlertSettings, unknown>>;
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const num = (field: AlertField) => (inRange(r[field], field) ? (r[field] as number) : DEFAULT_ALERT_SETTINGS[field]);
  return {
    enabled: bool(r.enabled, DEFAULT_ALERT_SETTINGS.enabled),
    hide_bonding_curve: bool(r.hide_bonding_curve, DEFAULT_ALERT_SETTINGS.hide_bonding_curve),
    quiet_start: num('quiet_start'),
    quiet_end: num('quiet_end'),
    max_per_hour: num('max_per_hour'),
    max_per_day: num('max_per_day'),
    stake_sol: parseStakeValue(r.stake_sol) ?? DEFAULT_STAKE_SOL,
    auto_paper: r.auto_paper === true,
    paper_sl_pct: parseSlPct(r.paper_sl_pct) ?? DEFAULT_PAPER_SL_PCT,
  };
}

/** « 23 h → 7 h », or « aucune » when start = end (no quiet hours, same rule as the backend). */
export function quietHoursLabel(start: number, end: number): string {
  return start === end ? 'aucune' : `${start} h → ${end} h`;
}

/** Body of `POST /api/push/subscriptions` (`PushSubscriptionRequest`) from `PushSubscription.toJSON()`; null if a field is missing. */
export function subscriptionRow(json: PushSubscriptionJSON): PushSubscriptionRequest | null {
  const endpoint = json.endpoint;
  const p256dh = json.keys?.['p256dh'];
  const auth = json.keys?.['auth'];
  if (!endpoint || !p256dh || !auth) return null;
  const expirationTime = typeof json.expirationTime === 'number' && Number.isInteger(json.expirationTime) && json.expirationTime >= 0 ? json.expirationTime : null;
  return { endpoint, expirationTime, keys: { p256dh, auth } };
}
