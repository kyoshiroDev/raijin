// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEDUP_WINDOW_MS, type PreviousSnapshot } from './alerts';
import { STOP_MULTIPLE, TARGET_MULTIPLE } from './exit-plan';
import {
  ALERT_EPISODE_SLACK_MS,
  calmAlertGuard,
  ALERT_CAP_PER_DAY,
  ALERT_CAP_PER_HOUR,
  ALERT_PRESET_LABELS,
  ALERT_PRESETS,
  capBudget,
  DEFAULT_ALERT_PRESET,
  effectiveLiquidity,
  evaluateYoungCalmAlert,
  matchesYoungCalm,
  matchesYoungFrenzy,
  PAIR_AGE_MAX_SKEW_MS,
  pairAgeHours,
  parsePreset,
  parseSignalPreset,
  type PresetToken,
  SAFETY_RULES,
  safetyRejection,
  SIGNAL_PRESET_LABELS,
  SIGNAL_PRESETS,
  YOUNG_BASE_RULES,
  YOUNG_CALM_RULES,
  YOUNG_FRENZY_RULES,
  youngLpOk,
  youngMomentumClass,
  youngRatio,
} from './presets';
import { FLAG_ZONE_BROKEN, ratio, YOUNG_FRENZY_1H_PCT, YOUNG_MAX_AGE_H, YOUNG_RATIO_MAX } from './flags';

const MINT = 'So11111111111111111111111111111111111111112';
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const H = 3_600_000;

/** A safe pumpswap token (base of the young fixtures). */
const tok = (o: Partial<PresetToken> = {}): PresetToken => ({
  mint: MINT,
  symbol: 'TEST',
  dex_id: 'pumpswap',
  market_cap: 200_000,
  flags: [],
  mint_authority_disabled: true,
  freeze_authority_disabled: true,
  price_usd: 1,
  roundtrip_cost_pct: 2,
  liquidity_usd: 30_000,
  liquidity_effective_usd: 25_000,
  change_1h: 5,
  top10_pct: 15,
  insiders_detected: false,
  creator_rug_history: false,
  ...o,
});

describe('presets after chore/slim-down', () => {
  it('one alert preset (young_calm), whatever the stored value', () => {
    assert.deepEqual(ALERT_PRESETS, ['young_calm']);
    assert.equal(DEFAULT_ALERT_PRESET, 'young_calm');
    assert.equal(ALERT_PRESET_LABELS.young_calm, 'Jeune calme');
    for (const v of ['young_calm', 'momentum', 'strict', 'young_strong', null, undefined, 42]) assert.equal(parsePreset(v), 'young_calm');
  });
  it('signal presets: young_calm and young_frenzy only', () => {
    assert.deepEqual(SIGNAL_PRESETS, ['young_calm', 'young_frenzy']);
    assert.equal(SIGNAL_PRESET_LABELS.young_frenzy, 'Jeune frénésie');
    assert.equal(parseSignalPreset('young_frenzy'), 'young_frenzy');
    for (const v of ['momentum', 'strict', 'young_strong', 'YOUNG_CALM', undefined]) assert.equal(parseSignalPreset(v), null);
  });
  it('effectiveLiquidity: effective value, else DexScreener, else null', () => {
    assert.equal(effectiveLiquidity(tok()), 25_000);
    assert.equal(effectiveLiquidity(tok({ liquidity_effective_usd: null })), 30_000);
    assert.equal(effectiveLiquidity(tok({ liquidity_effective_usd: null, liquidity_usd: null })), null);
  });
  it('safetyRejection: authorities, insiders / creator rug, top 10 < 25 %, round trip < 5 % (unknown rejects)', () => {
    assert.equal(safetyRejection(tok()), null);
    assert.equal(safetyRejection(tok({ mint_authority_disabled: null })), 'safety');
    assert.equal(safetyRejection(tok({ creator_rug_history: true })), 'safety');
    assert.equal(safetyRejection(tok({ top10_pct: 25 })), 'top10');
    assert.equal(safetyRejection(tok({ top10_pct: null })), 'top10');
    assert.equal(safetyRejection(tok({ roundtrip_cost_pct: 5 })), 'roundtrip');
    assert.equal(safetyRejection(tok({ roundtrip_cost_pct: -1 })), 'roundtrip');
  });
});

describe('capBudget', () => {
  it('defaults 4/h and 30/day', () => {
    assert.equal(ALERT_CAP_PER_HOUR, 4);
    assert.equal(ALERT_CAP_PER_DAY, 30);
    assert.equal(capBudget(0, 0), 4);
    assert.equal(capBudget(3, 10), 1);
    assert.equal(capBudget(4, 10), 0);
    assert.equal(capBudget(9, 10), 0);
  });
  it('daily cap binds', () => {
    assert.equal(capBudget(0, 28), 2);
    assert.equal(capBudget(0, 30), 0);
    assert.equal(capBudget(1, 40), 0);
  });
  it('custom caps', () => {
    assert.equal(capBudget(1, 1, 10, 100), 9);
    assert.equal(capBudget(0, 0, 0, 30), 0);
    assert.equal(capBudget(0, 0, 4, 0), 0);
    assert.equal(capBudget(0, 0, 2.9, 30), 2);
  });
  it('clamps invalid inputs safely', () => {
    assert.equal(capBudget(Number.NaN, Number.NaN), 4);
    assert.equal(capBudget(-5, -5), 4);
    assert.equal(capBudget(1.9, 0), 3);
    // the last hour is part of the last 24 h: an inconsistent 24 h count never gives more room
    assert.equal(capBudget(3, 0, 4, 3), 0);
    // invalid caps fall back to the defaults, never to unlimited
    assert.equal(capBudget(0, 0, Number.NaN, Number.NaN), 4);
    assert.equal(capBudget(0, 29, -1, Number.POSITIVE_INFINITY), 1);
    assert.equal(capBudget(Number.POSITIVE_INFINITY, 0), 0);
  });
});

describe('pairAgeHours', () => {
  it('hours since creation, 0 within the skew tolerance, null when unknown or far in the future', () => {
    assert.equal(pairAgeHours(NOW - 90 * 60_000, NOW), 1.5);
    assert.equal(pairAgeHours(NOW, NOW), 0);
    assert.equal(pairAgeHours(NOW + PAIR_AGE_MAX_SKEW_MS, NOW), 0);
    assert.equal(pairAgeHours(NOW + PAIR_AGE_MAX_SKEW_MS + 1, NOW), null);
    assert.equal(pairAgeHours(null, NOW), null);
    assert.equal(pairAgeHours(undefined, NOW), null);
    assert.equal(pairAgeHours(Number.NaN, NOW), null);
    assert.equal(pairAgeHours(0, NOW), null);
    assert.equal(pairAgeHours(NOW - H, Number.NaN), null);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// young_calm — « Jeune calme » / young_frenzy — « Jeune frénésie » (feat/young-calm)

/** A token passing every young_calm rule: pumpswap, pair 6 h, +30 % 1 h, ratio 1.0, liq 40 k$, safe, LP unknown. */
const calm = (o: Partial<PresetToken> = {}): PresetToken =>
  tok({
    pair_created_at: NOW - 6 * H,
    change_1h: 30,
    buys_1h: 100,
    sells_1h: 100,
    liquidity_effective_usd: 40_000,
    liquidity_usd: 45_000,
    lp_locked_pct: null,
    ...o,
  });
const cReason = (t: PresetToken, now = NOW): string => {
  const m = matchesYoungCalm(t, now);
  return m.ok ? 'ok' : m.reason;
};
const fReason = (t: PresetToken, now = NOW): string => {
  const m = matchesYoungFrenzy(t, now);
  return m.ok ? 'ok' : m.reason;
};

describe('young_calm / young_frenzy rules (no duplicated thresholds)', () => {
  it('thresholds come from flags.ts and SAFETY_RULES (no duplicated values)', () => {
    assert.equal(YOUNG_BASE_RULES.maxPairAgeH, YOUNG_MAX_AGE_H);
    assert.equal(YOUNG_CALM_RULES.maxRatio, YOUNG_RATIO_MAX);
    assert.equal(YOUNG_FRENZY_RULES.frenzyRatio, YOUNG_RATIO_MAX);
    assert.equal(YOUNG_FRENZY_RULES.frenzyChange1h, YOUNG_FRENZY_1H_PCT);
    assert.equal(YOUNG_BASE_RULES.dexId, 'pumpswap');
    assert.equal(YOUNG_BASE_RULES.minLiquidity, 30_000);
    assert.equal(YOUNG_BASE_RULES.maxRoundtripPct, 5);
    assert.equal(YOUNG_BASE_RULES.maxTop10Pct, 25);
    assert.equal(YOUNG_BASE_RULES.minLpLockedPct, 90);
    assert.deepEqual([YOUNG_CALM_RULES.minChange1h, YOUNG_CALM_RULES.maxChange1h, YOUNG_CALM_RULES.minRatio], [0, 100, 0.8]);
    assert.deepEqual([SAFETY_RULES.maxRoundtripPct, SAFETY_RULES.maxTop10Pct], [5, 25]);
    assert.deepEqual([TARGET_MULTIPLE, STOP_MULTIPLE], [2, 0.7]);
  });
  it('youngRatio = flags.ts ratio(), unknown counts → null', () => {
    assert.equal(youngRatio(129, 99), ratio(129, 99));
    assert.equal(youngRatio(129, 99), 1.3);
    for (const [b, s] of [[null, 1], [1, undefined], [Number.NaN, 1], [-1, 3], [1, Number.POSITIVE_INFINITY]] as const) {
      assert.equal(youngRatio(b, s), null);
    }
  });
  it('youngMomentumClass: calm / frenzy / neither / unknown, inclusive calm bounds, strict frenzy bounds', () => {
    assert.equal(youngMomentumClass(0, 0.8), 'calm');
    assert.equal(youngMomentumClass(100, 1.3), 'calm');
    assert.equal(youngMomentumClass(-0.01, 1), 'neither');
    assert.equal(youngMomentumClass(100.01, 1), 'neither');
    assert.equal(youngMomentumClass(150, 1), 'neither');
    assert.equal(youngMomentumClass(150.01, 1), 'frenzy');
    assert.equal(youngMomentumClass(5, 1.3001), 'frenzy');
    assert.equal(youngMomentumClass(-40, 2), 'frenzy');
    assert.equal(youngMomentumClass(30, 0.79), 'neither');
    assert.equal(youngMomentumClass(null, 1), 'unknown');
    assert.equal(youngMomentumClass(10, Number.NaN), 'unknown');
  });
  it('LP: unknown accepted, known must be ≥ 90 %', () => {
    assert.equal(youngLpOk(null), true);
    assert.equal(youngLpOk(undefined), true);
    assert.equal(youngLpOk(90), true);
    assert.equal(youngLpOk(89.99), false);
    assert.equal(youngLpOk(0), false);
  });
});

describe('matchesYoungCalm', () => {
  it('the reference token matches', () => {
    assert.equal(cReason(calm()), 'ok');
  });
  it('ignores MC and the « Structure cassée » flag (not young_calm rules yet: phase 2)', () => {
    assert.equal(cReason(calm({ market_cap: 5_000_000, flags: [FLAG_ZONE_BROKEN] })), 'ok');
  });
  it('age strictly < 24 h, unknown rejects', () => {
    assert.equal(cReason(calm({ pair_created_at: NOW - 23.99 * H })), 'ok');
    assert.equal(cReason(calm({ pair_created_at: NOW - 24 * H })), 'age');
    assert.equal(cReason(calm({ pair_created_at: null })), 'age');
    assert.equal(cReason(calm({ pair_created_at: undefined })), 'age');
  });
  it('mint and dex', () => {
    assert.equal(cReason(calm({ mint: 'nope' })), 'invalid_mint');
    assert.equal(cReason(calm({ dex_id: 'raydium' })), 'dex');
  });
  it('liquidity ≥ 30 k$ on the effective value, falling back to liquidity_usd', () => {
    assert.equal(cReason(calm({ liquidity_effective_usd: 30_000 })), 'ok');
    assert.equal(cReason(calm({ liquidity_effective_usd: 29_999, liquidity_usd: 100_000 })), 'liquidity');
    assert.equal(cReason(calm({ liquidity_effective_usd: null, liquidity_usd: 30_000 })), 'ok');
    assert.equal(cReason(calm({ liquidity_effective_usd: null, liquidity_usd: null })), 'liquidity');
  });
  it('safety: authorities, insiders, creator rug; top10 < 25 %; roundtrip < 5 % (unknown rejects)', () => {
    assert.equal(cReason(calm({ freeze_authority_disabled: null })), 'safety');
    assert.equal(cReason(calm({ mint_authority_disabled: false })), 'safety');
    assert.equal(cReason(calm({ insiders_detected: true })), 'safety');
    assert.equal(cReason(calm({ creator_rug_history: true })), 'safety');
    assert.equal(cReason(calm({ insiders_detected: null, creator_rug_history: null })), 'ok');
    assert.equal(cReason(calm({ top10_pct: 25 })), 'top10');
    assert.equal(cReason(calm({ top10_pct: null })), 'top10');
    assert.equal(cReason(calm({ roundtrip_cost_pct: 5 })), 'roundtrip');
    assert.equal(cReason(calm({ roundtrip_cost_pct: null })), 'roundtrip');
    assert.equal(cReason(calm({ roundtrip_cost_pct: 4.99 })), 'ok');
  });
  it('LP locked when known ≥ 90 %', () => {
    assert.equal(cReason(calm({ lp_locked_pct: 100 })), 'ok');
    assert.equal(cReason(calm({ lp_locked_pct: 90 })), 'ok');
    assert.equal(cReason(calm({ lp_locked_pct: 50 })), 'lp');
  });
  it('momentum 0 ≤ change1h ≤ 100 and 0.8 ≤ ratio ≤ 1.3 (inclusive), unknown rejects', () => {
    assert.equal(cReason(calm({ change_1h: 0 })), 'ok');
    assert.equal(cReason(calm({ change_1h: 100 })), 'ok');
    assert.equal(cReason(calm({ change_1h: -0.1 })), 'momentum');
    assert.equal(cReason(calm({ change_1h: 100.1 })), 'momentum');
    assert.equal(cReason(calm({ change_1h: null })), 'momentum');
    assert.equal(cReason(calm({ buys_1h: 129, sells_1h: 99 })), 'ok'); // 1.3
    assert.equal(cReason(calm({ buys_1h: 130, sells_1h: 99 })), 'ratio'); // 1.31
    assert.equal(cReason(calm({ buys_1h: 79, sells_1h: 99 })), 'ok'); // 0.8
    assert.equal(cReason(calm({ buys_1h: 78, sells_1h: 99 })), 'ratio');
    assert.equal(cReason(calm({ buys_1h: null })), 'ratio');
    assert.equal(cReason(calm({ sells_1h: undefined })), 'ratio');
  });
});

describe('matchesYoungFrenzy', () => {
  it('same base rules, opposite momentum (change1h > 150 OR ratio > 1.3)', () => {
    assert.equal(fReason(calm()), 'momentum');
    assert.equal(fReason(calm({ change_1h: 150.5 })), 'ok');
    assert.equal(fReason(calm({ change_1h: 150 })), 'momentum');
    assert.equal(fReason(calm({ buys_1h: 130, sells_1h: 99 })), 'ok');
    assert.equal(fReason(calm({ change_1h: -20, buys_1h: 300, sells_1h: 100 })), 'ok');
    assert.equal(fReason(calm({ change_1h: 400, buys_1h: null })), 'ratio');
    assert.equal(fReason(calm({ change_1h: null, buys_1h: 300 })), 'momentum');
  });
  it('base rules are shared', () => {
    const f = { change_1h: 200 };
    assert.equal(fReason(calm({ ...f, pair_created_at: NOW - 30 * H })), 'age');
    assert.equal(fReason(calm({ ...f, dex_id: 'meteora' })), 'dex');
    assert.equal(fReason(calm({ ...f, liquidity_effective_usd: 10_000 })), 'liquidity');
    assert.equal(fReason(calm({ ...f, top10_pct: 40 })), 'top10');
    assert.equal(fReason(calm({ ...f, lp_locked_pct: 10 })), 'lp');
  });
  it('a token is never both calm and frenzy', () => {
    for (const c of [-50, 0, 50, 100, 120, 150, 151, 500]) {
      for (const [b, s] of [[50, 100], [79, 99], [100, 100], [129, 99], [130, 99], [400, 50]]) {
        const t = calm({ change_1h: c, buys_1h: b, sells_1h: s });
        assert.ok(!(matchesYoungCalm(t, NOW).ok && matchesYoungFrenzy(t, NOW).ok), `${c} ${b}/${s}`);
      }
    }
  });
});

describe('evaluateYoungCalmAlert (main pipeline, plan ×2 / ×0.7)', () => {
  const prev: PreviousSnapshot = { at: NOW - 2 * 60_000 };
  it('match + persistent + no recent alert → ×2 / ×0.7 plan', () => {
    const d = evaluateYoungCalmAlert(calm(), undefined, prev, NOW);
    assert.equal(d.ok, true);
    if (d.ok && 'plan' in d) {
      assert.equal(d.plan.target, 2);
      assert.equal(d.plan.stop, 0.7);
      assert.equal(d.plan.rr, 3.333);
    }
  });
  it('rejections: predicate, dedup 12 h, persistence, plan', () => {
    assert.deepEqual(evaluateYoungCalmAlert(calm({ change_1h: 200 }), undefined, prev, NOW), { ok: false, reason: 'momentum' });
    assert.deepEqual(evaluateYoungCalmAlert(calm(), NOW - DEDUP_WINDOW_MS + 1, prev, NOW), { ok: false, reason: 'dedup' });
    assert.equal(evaluateYoungCalmAlert(calm(), NOW - DEDUP_WINDOW_MS, prev, NOW).ok, true);
    assert.deepEqual(evaluateYoungCalmAlert(calm(), undefined, undefined, NOW), { ok: false, reason: 'not_persistent' });
    assert.deepEqual(evaluateYoungCalmAlert(calm(), undefined, { at: NOW - 10 * 60_000 }, NOW), { ok: false, reason: 'not_persistent' });
    assert.deepEqual(evaluateYoungCalmAlert(calm({ price_usd: null }), undefined, prev, NOW), { ok: false, reason: 'no_plan' });
  });
});

describe('« Structure cassée » excluded (feat/calm-sl-test)', () => {
  it('a broken structure rejects calm AND the frenzy control (same base filters); false / unknown pass', () => {
    assert.equal(cReason(calm({ structure_broken: true })), 'structure');
    assert.equal(fReason(calm({ structure_broken: true, change_1h: 200 })), 'structure');
    assert.equal(cReason(calm({ structure_broken: false })), 'ok');
    assert.equal(cReason(calm({ structure_broken: null })), 'ok');
    assert.equal(cReason(calm()), 'ok');
    assert.equal(fReason(calm({ change_1h: 200, structure_broken: false })), 'ok');
  });
  it('the structure rule comes after the safety / LP rules (first failure reported)', () => {
    assert.equal(cReason(calm({ structure_broken: true, lp_locked_pct: 10 })), 'lp');
    assert.equal(cReason(calm({ structure_broken: true, change_1h: 500 })), 'structure', 'before momentum');
  });
});

describe('calmAlertGuard: one alert per « Calme » position episode (feat/calm-sl-test)', () => {
  const S = ALERT_EPISODE_SLACK_MS;
  const pos = (createdAtMs: number, active: boolean) => ({ createdAtMs, active });
  it('no previous alert → alertable, even with an active position (its episode has had no alert yet)', () => {
    assert.equal(calmAlertGuard(undefined, [], NOW), null);
    assert.equal(calmAlertGuard(undefined, [pos(NOW - 4 * 60_000, true)], NOW), null);
  });
  it('normal path: alert, position opened seconds later in the same scan → blocked while it is pending / open', () => {
    const alert = NOW - 3 * H;
    assert.equal(calmAlertGuard(alert, [pos(alert + 5_000, true)], NOW), 'position_open');
    assert.equal(calmAlertGuard(alert, [pos(alert + 5_000, true)], NOW + 5 * 24 * H), 'position_open', 'no time limit');
    // closed (TP or stop) → the 12 h guard is lifted: a new signal can alert again
    assert.equal(calmAlertGuard(alert, [pos(alert + 5_000, false)], NOW), null);
  });
  it('first-sight path: position opened one scan BEFORE the alert belongs to the same episode', () => {
    const p = pos(NOW - 2 * H, true);
    assert.equal(calmAlertGuard(NOW - 2 * H + 2 * 60_000, [p], NOW), 'position_open');
    assert.equal(calmAlertGuard(NOW - 2 * H + 2 * 60_000, [{ ...p, active: false }], NOW), null);
  });
  it('alert long after an older open position (alert came during it) → still blocked', () => {
    assert.equal(calmAlertGuard(NOW - H, [pos(NOW - 10 * H, true)], NOW), 'position_open');
  });
  it('a new position opened for a later signal that had no alert → that signal may alert once', () => {
    const alert = NOW - 20 * H;
    assert.equal(calmAlertGuard(alert, [pos(alert + 1_000, false), pos(NOW - 10 * 60_000, true)], NOW), null);
  });
  it('no position opened for the last alert → 12 h guard kept (future-dated counts as recent)', () => {
    assert.equal(calmAlertGuard(NOW - H, [], NOW), 'dedup');
    assert.equal(calmAlertGuard(NOW - DEDUP_WINDOW_MS + 1, [], NOW), 'dedup');
    assert.equal(calmAlertGuard(NOW - DEDUP_WINDOW_MS, [], NOW), null);
    assert.equal(calmAlertGuard(NOW + 60_000, [], NOW), 'dedup');
    // only older (closed) positions, before the alert − slack: they do not count as « opened for it »
    assert.equal(calmAlertGuard(NOW - H, [pos(NOW - H - S - 1, false)], NOW), 'dedup');
    assert.equal(calmAlertGuard(NOW - H, [pos(NOW - H - S, false)], NOW), null);
  });
  it('evaluateYoungCalmAlert applies the guard before persistence', () => {
    const prev: PreviousSnapshot = { at: NOW - 2 * 60_000 };
    assert.deepEqual(evaluateYoungCalmAlert(calm(), NOW - H, prev, NOW, [pos(NOW - H + 1_000, true)]), { ok: false, reason: 'position_open' });
    assert.equal(evaluateYoungCalmAlert(calm(), NOW - H, prev, NOW, [pos(NOW - H + 1_000, false)]).ok, true);
    assert.deepEqual(evaluateYoungCalmAlert(calm(), NOW - H, undefined, NOW, [pos(NOW - H + 1_000, true)]), { ok: false, reason: 'position_open' });
    assert.deepEqual(evaluateYoungCalmAlert(calm({ structure_broken: true }), undefined, prev, NOW), { ok: false, reason: 'structure' });
  });
});
