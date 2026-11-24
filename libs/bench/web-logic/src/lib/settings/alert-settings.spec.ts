import { alertPreferencesSchema } from '@raijin/bench-contracts';
import { pushSubscriptionRequestSchema } from '@raijin/shared-contracts';
import { describe, expect, it } from 'vitest';
import {
  ALERT_PRESET,
  ALERT_SETTINGS_COLUMNS,
  DEFAULT_ALERT_SETTINGS,
  PAPER_SL_ERROR,
  parseAlertSettings,
  preferencesOf,
  quietHoursLabel,
  subscriptionRow,
  validateAlertPreferences,
  type AlertPreferences,
} from './alert-settings';

const VALID: AlertPreferences = preferencesOf(DEFAULT_ALERT_SETTINGS);

/** Columns archived by the slim-down (2026-11-21): never read, never written. */
const ARCHIVED = [
  'min_score', 'only_in_zone', 'min_p_x3', 'max_p_dd50', 'min_rr', 'paper_default_strategy', 'auto_paper_parallel',
  'early_enabled', 'early_min_score', 'young_strong_enabled',
];

describe('alert settings', () => {
  it('has the documented defaults (bonding curves hidden, 23 h → 7 h, 4/h, 30/day, 0.05 SOL, stop 30 %, disabled)', () => {
    expect(DEFAULT_ALERT_SETTINGS).toEqual({
      enabled: false,
      hide_bonding_curve: true,
      quiet_start: 23,
      quiet_end: 7,
      max_per_hour: 4,
      max_per_day: 30,
      stake_sol: 0.05,
      auto_paper: false,
      paper_sl_pct: 30,
    });
  });

  it('selects only the live columns, none of the archived ones', () => {
    expect(ALERT_SETTINGS_COLUMNS.split(',')).toEqual([
      'enabled', 'hide_bonding_curve', 'quiet_start', 'quiet_end', 'max_per_hour', 'max_per_day', 'stake_sol', 'auto_paper', 'paper_sl_pct',
    ]);
    for (const c of ARCHIVED) expect(ALERT_SETTINGS_COLUMNS.split(',')).not.toContain(c);
  });

  it('accepts the bounds', () => {
    expect(validateAlertPreferences(VALID)).toEqual({});
    expect(validateAlertPreferences({ ...VALID, quiet_start: 0, quiet_end: 23, max_per_hour: 1, max_per_day: 1 })).toEqual({});
    expect(validateAlertPreferences({ ...VALID, quiet_start: 23, quiet_end: 0, max_per_hour: 20, max_per_day: 100 })).toEqual({});
  });

  it('rejects out-of-range, fractional and NaN values', () => {
    expect(Object.keys(validateAlertPreferences({ ...VALID, quiet_start: 24 }))).toEqual(['quiet_start']);
    expect(Object.keys(validateAlertPreferences({ ...VALID, quiet_end: 7.5 }))).toEqual(['quiet_end']);
    expect(Object.keys(validateAlertPreferences({ ...VALID, max_per_hour: 0 }))).toEqual(['max_per_hour']);
    expect(Object.keys(validateAlertPreferences({ ...VALID, max_per_hour: 21 }))).toEqual(['max_per_hour']);
    expect(Object.keys(validateAlertPreferences({ ...VALID, max_per_hour: Number.NaN }))).toEqual(['max_per_hour']);
    expect(Object.keys(validateAlertPreferences({ ...VALID, max_per_day: 101 }))).toEqual(['max_per_day']);
    expect(Object.keys(validateAlertPreferences({ ...VALID, max_per_day: 2.5 }))).toEqual(['max_per_day']);
  });

  it('builds a body with exactly the editable columns, accepted by the strict contract (never enabled, never archived)', () => {
    const payload = preferencesOf({ ...DEFAULT_ALERT_SETTINGS, enabled: true, min_score: 80 } as AlertPreferences);
    expect(Object.keys(payload).sort()).toEqual(
      ['hide_bonding_curve', 'quiet_start', 'quiet_end', 'max_per_hour', 'max_per_day', 'stake_sol', 'auto_paper', 'paper_sl_pct'].sort(),
    );
    expect(alertPreferencesSchema.safeParse(payload).success).toBe(true);
    expect(ALERT_PRESET).toBe('young_calm');
    for (const c of [...ARCHIVED, 'enabled', 'alert_preset']) expect(c in payload).toBe(false);
  });

  it('auto-paper: off by default, part of the payload, parsed strictly', () => {
    expect(DEFAULT_ALERT_SETTINGS.auto_paper).toBe(false);
    expect(preferencesOf({ ...VALID, auto_paper: true }).auto_paper).toBe(true);
    expect(parseAlertSettings({ auto_paper: true }).auto_paper).toBe(true);
    for (const v of ['true', 1, null, undefined]) expect(parseAlertSettings({ auto_paper: v }).auto_paper).toBe(false);
  });

  it('paper trading: parses and validates the default stop (integer 1–90 %)', () => {
    expect(parseAlertSettings({ paper_sl_pct: '25' }).paper_sl_pct).toBe(25);
    expect(parseAlertSettings({ paper_sl_pct: 95 }).paper_sl_pct).toBe(30);
    expect(validateAlertPreferences({ ...VALID, paper_sl_pct: 1 })).toEqual({});
    expect(validateAlertPreferences({ ...VALID, paper_sl_pct: 90 })).toEqual({});
    for (const v of [0, 91, 12.5, Number.NaN]) {
      expect(validateAlertPreferences({ ...VALID, paper_sl_pct: v }).paper_sl_pct).toBe(PAPER_SL_ERROR);
    }
  });

  it('parses rows defensively and ignores archived columns', () => {
    expect(parseAlertSettings(null)).toEqual(DEFAULT_ALERT_SETTINGS);
    const parsed = parseAlertSettings({ enabled: true, min_score: 55, max_per_hour: 99, max_per_day: '12', alert_preset: 'strict', hide_bonding_curve: 'no' });
    expect(parsed).toEqual({ ...DEFAULT_ALERT_SETTINGS, enabled: true });
    expect('min_score' in parsed).toBe(false);
    expect(parseAlertSettings({ max_per_day: 12 }).max_per_day).toBe(12);
  });

  it('validates the stake (0.01–100 SOL)', () => {
    expect(validateAlertPreferences({ ...VALID, stake_sol: 0.01 })).toEqual({});
    expect(validateAlertPreferences({ ...VALID, stake_sol: 100 })).toEqual({});
    expect(validateAlertPreferences({ ...VALID, stake_sol: 0.25 })).toEqual({});
    for (const bad of [0.005, 0, -1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Object.keys(validateAlertPreferences({ ...VALID, stake_sol: bad }))).toEqual(['stake_sol']);
    }
  });

  it('parses stake_sol from a row (number or numeric text), defaulting to 0.05', () => {
    expect(parseAlertSettings({ stake_sol: 0.5 }).stake_sol).toBe(0.5);
    expect(parseAlertSettings({ stake_sol: '2.5' }).stake_sol).toBe(2.5);
    expect(parseAlertSettings({ stake_sol: 500 }).stake_sol).toBe(0.05);
    expect(parseAlertSettings({ stake_sol: 'abc' }).stake_sol).toBe(0.05);
  });

  it('labels quiet hours', () => {
    expect(quietHoursLabel(23, 7)).toBe('23 h → 7 h');
    expect(quietHoursLabel(5, 5)).toBe('aucune');
  });
});

describe('subscriptionRow', () => {
  const json: PushSubscriptionJSON = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'P'.repeat(87), auth: 'A'.repeat(22) } };

  it('maps toJSON() to the PushSubscriptionRequest body (no user agent sent)', () => {
    const row = subscriptionRow({ ...json, expirationTime: null });
    expect(row).toEqual({ endpoint: json.endpoint, expirationTime: null, keys: { p256dh: 'P'.repeat(87), auth: 'A'.repeat(22) } });
    expect(pushSubscriptionRequestSchema.safeParse(row).success).toBe(true);
  });

  it('rejects incomplete subscriptions', () => {
    expect(subscriptionRow({ endpoint: json.endpoint })).toBeNull();
    expect(subscriptionRow({ keys: json.keys })).toBeNull();
  });
});
