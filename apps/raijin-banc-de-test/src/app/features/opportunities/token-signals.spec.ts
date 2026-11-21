import { describe, expect, it } from 'vitest';
import {
  CALM_RULES,
  FLAG_BROKEN_STRUCTURE,
  FRENZY_RULES,
  SAFETY_RULES,
  YOUNG_MAX_AGE_H,
  buySellRatio,
  isYoung,
  momentumOf,
  pairAgeHours,
  safetyCheck,
  safetyDescription,
} from './token-signals';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** Young (3 h), calm momentum: +40 % in 1 h, ratio (100 + 1) / (100 + 1) = 1. */
const young = { pair_created_at: hoursAgo(3), change_1h: 40, buys_1h: 100, sells_1h: 100 };

const safe = {
  mint_authority_disabled: true,
  freeze_authority_disabled: true,
  top10_pct: 18,
  insiders_detected: false,
  creator_rug_history: false,
  lp_locked_pct: 100,
  roundtrip_cost_pct: 2.5,
  flags: [] as string[],
};

describe('rules (mirror of the backend young_calm / young_frenzy presets)', () => {
  it('keeps the documented thresholds', () => {
    expect(YOUNG_MAX_AGE_H).toBe(24);
    expect(CALM_RULES).toEqual({ minChange1h: 0, maxChange1h: 100, minRatio: 0.8, maxRatio: 1.3 });
    expect(FRENZY_RULES).toEqual({ change1h: 150, ratio: 1.3 });
    expect(SAFETY_RULES).toEqual({ maxTop10Pct: 25, minLpLockedPct: 90, maxRoundtripPct: 5 });
    expect(FLAG_BROKEN_STRUCTURE).toBe('Structure cassée');
  });
});

describe('pairAgeHours / isYoung', () => {
  it('measures the age in hours; unknown, unparsable or future dates → null', () => {
    expect(pairAgeHours(hoursAgo(5), NOW)).toBeCloseTo(5, 6);
    expect(pairAgeHours(null, NOW)).toBeNull();
    expect(pairAgeHours('not a date', NOW)).toBeNull();
    expect(pairAgeHours(new Date(NOW + 60_000).toISOString(), NOW)).toBeNull();
  });

  it('is young strictly below 24 h; an unknown age is not young', () => {
    expect(isYoung({ pair_created_at: hoursAgo(23.99) }, NOW)).toBe(true);
    expect(isYoung({ pair_created_at: hoursAgo(24) }, NOW)).toBe(false);
    expect(isYoung({ pair_created_at: null }, NOW)).toBe(false);
  });
});

describe('buySellRatio', () => {
  it('is (buys + 1) / (sells + 1), null when a count is unknown or negative', () => {
    expect(buySellRatio(0, 0)).toBe(1);
    expect(buySellRatio(129, 99)).toBeCloseTo(1.3, 9);
    expect(buySellRatio(Number.NaN, 3)).toBeNull();
    expect(buySellRatio(3, -1)).toBeNull();
    expect(buySellRatio(null, 3)).toBeNull();
  });
});

describe('momentumOf', () => {
  it('« Calme »: young, 0 ≤ change1h ≤ 100 and 0.8 ≤ ratio ≤ 1.3 (bounds inclusive)', () => {
    expect(momentumOf(young, NOW)).toBe('calm');
    expect(momentumOf({ ...young, change_1h: 0 }, NOW)).toBe('calm');
    expect(momentumOf({ ...young, change_1h: 100 }, NOW)).toBe('calm');
    expect(momentumOf({ ...young, buys_1h: 129, sells_1h: 99 }, NOW)).toBe('calm'); // ratio 1.3
    expect(momentumOf({ ...young, buys_1h: 79, sells_1h: 99 }, NOW)).toBe('calm'); // ratio 0.8
  });

  it('« Frénésie »: young and (change1h > 150 or ratio > 1.3), strict', () => {
    expect(momentumOf({ ...young, change_1h: 151 }, NOW)).toBe('frenzy');
    expect(momentumOf({ ...young, buys_1h: 140, sells_1h: 99 }, NOW)).toBe('frenzy'); // ratio 1.41
    expect(momentumOf({ ...young, change_1h: -10, buys_1h: 200, sells_1h: 10 }, NOW)).toBe('frenzy');
    expect(momentumOf({ ...young, change_1h: 150 }, NOW)).toBeNull(); // 100–150 % and calm ratio: neither
  });

  it('nothing for neither, an old or unknown age, or unknown numbers', () => {
    expect(momentumOf({ ...young, change_1h: -5 }, NOW)).toBeNull();
    expect(momentumOf({ ...young, buys_1h: 50, sells_1h: 99 }, NOW)).toBeNull(); // ratio 0.51
    expect(momentumOf({ ...young, pair_created_at: hoursAgo(30) }, NOW)).toBeNull();
    expect(momentumOf({ ...young, pair_created_at: hoursAgo(30), change_1h: 500 }, NOW)).toBeNull();
    expect(momentumOf({ ...young, pair_created_at: null }, NOW)).toBeNull();
    expect(momentumOf({ ...young, change_1h: Number.NaN }, NOW)).toBeNull();
    expect(momentumOf({ ...young, buys_1h: Number.NaN }, NOW)).toBeNull();
  });
});

describe('safetyCheck', () => {
  it('requires a known round-trip cost under 5 % (security review: unsellable tokens)', () => {
    expect(safetyCheck({ ...safe, roundtrip_cost_pct: null })).toEqual({ ok: false, failures: ['Coût aller-retour inconnu'] });
    expect(safetyCheck({ ...safe, roundtrip_cost_pct: 5 }).ok).toBe(false);
    expect(safetyCheck({ ...safe, roundtrip_cost_pct: 4.99 }).ok).toBe(true);
  });

  it('is OK when every rule holds; an unknown LP is accepted', () => {
    expect(safetyCheck(safe)).toEqual({ ok: true, failures: [] });
    expect(safetyCheck({ ...safe, lp_locked_pct: null, insiders_detected: null, creator_rug_history: null }).ok).toBe(true);
    expect(safetyCheck({ ...safe, lp_locked_pct: 90 }).ok).toBe(true);
    expect(safetyCheck({ ...safe, top10_pct: 24.9 }).ok).toBe(true);
    expect(safetyCheck({ ...safe, flags: ['RugCheck : Low liquidity'] }).ok).toBe(true);
  });

  it('explains every failure, in checking order', () => {
    const check = safetyCheck({
      mint_authority_disabled: false,
      freeze_authority_disabled: null,
      top10_pct: 40,
      insiders_detected: true,
      creator_rug_history: true,
      lp_locked_pct: 12,
      roundtrip_cost_pct: 7,
      flags: [FLAG_BROKEN_STRUCTURE],
    });
    expect(check.ok).toBe(false);
    expect(check.failures).toEqual([
      'Mint authority active',
      'Freeze authority inconnue',
      'Top 10 holders à 40,0 % (max 25 %)',
      'Insiders détectés (RugCheck)',
      'Créateur avec des rugs passés (RugCheck)',
      'LP verrouillée à 12,0 % (min 90 %)',
      'Coût aller-retour à 7,0 % (max 5 %)',
      'Structure cassée',
    ]);
  });

  it('fails on the 25 % boundary and on an unknown top 10 (the preset rejects unknown values)', () => {
    expect(safetyCheck({ ...safe, top10_pct: 25 }).failures).toEqual(['Top 10 holders à 25,0 % (max 25 %)']);
    expect(safetyCheck({ ...safe, top10_pct: null }).failures).toEqual(['Top 10 holders inconnu']);
    expect(safetyCheck({ ...safe, lp_locked_pct: 89.9 }).failures).toEqual(['LP verrouillée à 89,9 % (min 90 %)']);
  });
});

describe('safetyDescription', () => {
  it('reads the reasons as text (never colour only)', () => {
    expect(safetyDescription(safetyCheck(safe))).toMatch(/^Sécurité OK : /);
    expect(safetyDescription(safetyCheck({ ...safe, mint_authority_disabled: false, flags: [FLAG_BROKEN_STRUCTURE] }))).toBe(
      'Sécurité KO : Mint authority active ; Structure cassée.',
    );
  });
});
