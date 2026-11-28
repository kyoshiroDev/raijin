// Alert wiring of scan-tokens (« Jeune calme » candidates, caps, preset_signals rows). Pure, no network.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PreviousSnapshot } from './alerts';
import {
  ALERT_GUARD_LIMIT,
  cleanNarrative,
  parseCalmPositions,
  compareAlertCandidates,
  presetSignalRows,
  type PresetSignalToken,
  selectYoungCalmCandidates,
  sentCounts,
  userAlertBudget,
} from './preset-alerts';

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const MINT2 = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT3 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const H = 3_600_000;

/** A token matching « Jeune calme »: pumpswap, pair 3 h, +20 % 1 h, ratio 111/101, liq 35 k$, safe, LP burnt. */
function calmTok(over: Partial<PresetSignalToken> = {}): PresetSignalToken {
  return {
    mint: MINT,
    symbol: 'TST',
    dex_id: 'pumpswap',
    market_cap: 200_000,
    flags: [],
    mint_authority_disabled: true,
    freeze_authority_disabled: true,
    price_usd: 0.001,
    roundtrip_cost_pct: 2,
    insiders_detected: false,
    creator_rug_history: false,
    liquidity_usd: 25_000,
    liquidity_effective_usd: 35_000,
    change_1h: 20,
    top10_pct: 15,
    pair_address: PAIR,
    pair_created_at: NOW - 3 * H,
    buys_1h: 110,
    sells_1h: 100,
    lp_locked_pct: 100,
    volume_1h: 50_000,
    ...over,
  };
}
const prev = (): PreviousSnapshot => ({ at: NOW - 120_000 });

describe('selectYoungCalmCandidates', () => {
  it('×2 / ×0.7 plan, pair age, persistence required, frenzy never selected', () => {
    const tokens = [calmTok(), calmTok({ mint: MINT2, change_1h: 300 })];
    const previous = new Map([[MINT, prev()], [MINT2, prev()]]);
    const out = selectYoungCalmCandidates(tokens, new Map(), NOW, previous);
    assert.deepEqual(out.map((t) => t.mint), [MINT]);
    assert.equal(out[0].plan.rr, 3.333);
    assert.equal(out[0].plan.target, 0.002);
    assert.equal(out[0].pair_age_h, 3);
    assert.deepEqual(selectYoungCalmCandidates(tokens, new Map(), NOW, new Map()), []);
  });
  it('dedup 12 h on the last alert of the mint', () => {
    const previous = new Map([[MINT, prev()]]);
    assert.deepEqual(selectYoungCalmCandidates([calmTok()], new Map([[MINT, NOW - H]]), NOW, previous), []);
  });
  it('best first by 1 h volume, then effective liquidity, then mint (the score is gone)', () => {
    const tokens = [
      calmTok({ mint: MINT, volume_1h: 10_000 }),
      calmTok({ mint: MINT2, volume_1h: 90_000 }),
      calmTok({ mint: MINT3, volume_1h: 10_000, liquidity_effective_usd: 80_000 }),
    ];
    const previous = new Map(tokens.map((t) => [t.mint, prev()]));
    assert.deepEqual(selectYoungCalmCandidates(tokens, new Map(), NOW, previous).map((t) => t.mint), [MINT2, MINT3, MINT]);
    assert.ok(compareAlertCandidates(calmTok({ volume_1h: null }), calmTok({ mint: MINT2, volume_1h: 1 })) > 0);
  });
});

describe('alert guard inputs (feat/calm-sl-test)', () => {
  const U1 = '11111111-1111-4111-8111-111111111111';
  const U2 = '22222222-2222-4222-8222-222222222222';
  it('parseCalmPositions: calm books only, active = pending / open, by user then mint', () => {
    const m = parseCalmPositions([
      { user_id: U1, book: 'calm_sl30', mint: MINT, status: 'open', created_at: new Date(NOW - H).toISOString() },
      { user_id: U1, book: 'calm_sl40', mint: MINT, status: 'closed', created_at: new Date(NOW - H).toISOString() },
      { user_id: U1, book: 'frenzy_sl30', mint: MINT, status: 'open', created_at: new Date(NOW).toISOString() },
      { user_id: U1, book: 'calm_all_x2', mint: MINT, status: 'open', created_at: new Date(NOW).toISOString() },
      { user_id: U2, book: 'calm_sl30', mint: MINT2, status: 'pending', created_at: new Date(NOW).toISOString() },
      { user_id: 'nope', book: 'calm_sl30', mint: MINT, status: 'open', created_at: new Date(NOW).toISOString() },
      { user_id: U2, book: 'calm_sl30', mint: 'bad', status: 'open', created_at: new Date(NOW).toISOString() },
      null,
    ]);
    assert.ok(m);
    assert.deepEqual(m.get(U1)?.get(MINT), [{ createdAtMs: NOW - H, active: true }, { createdAtMs: NOW - H, active: false }]);
    assert.deepEqual(m.get(U2)?.get(MINT2), [{ createdAtMs: NOW, active: true }]);
    assert.equal(m.size, 2);
  });
  it('parseCalmPositions fails closed (not an array / full page); corrupt date: active blocks, closed ignored', () => {
    assert.equal(parseCalmPositions(null), null);
    assert.equal(parseCalmPositions(new Array(ALERT_GUARD_LIMIT).fill({})), null);
    const m = parseCalmPositions([
      { user_id: U1, book: 'calm_sl30', mint: MINT, status: 'open', created_at: 'garbage' },
      { user_id: U1, book: 'calm_sl30', mint: MINT2, status: 'closed', created_at: 'garbage' },
    ]);
    assert.deepEqual(m?.get(U1)?.get(MINT), [{ createdAtMs: -Infinity, active: true }]);
    assert.equal(m?.get(U1)?.get(MINT2), undefined);
  });
  it('selectYoungCalmCandidates: blocked while the calm position of the last alert is open, alertable once closed', () => {
    const previous = new Map([[MINT, prev()]]);
    const last = new Map([[MINT, NOW - 3 * H]]);
    const open = new Map([[MINT, [{ createdAtMs: NOW - 3 * H + 5_000, active: true }]]]);
    const closed = new Map([[MINT, [{ createdAtMs: NOW - 3 * H + 5_000, active: false }]]]);
    assert.deepEqual(selectYoungCalmCandidates([calmTok()], last, NOW, previous, open), []);
    assert.deepEqual(selectYoungCalmCandidates([calmTok()], last, NOW, previous, closed).map((t) => t.mint), [MINT]);
    assert.deepEqual(selectYoungCalmCandidates([calmTok({ structure_broken: true })], new Map(), NOW, previous), []);
  });
});

describe('caps: 4 per hour and 30 per day', () => {
  const row = (id: string, minutesAgo: number) => ({ notification_id: id, sent_at: new Date(NOW - minutesAgo * 60_000).toISOString() });

  it('counts distinct notifications (a grouped push logs many mints but counts once)', () => {
    const rows = [row('g', 10), row('g', 10), row('g', 10), row('a', 30), row('b', 90), row('c', 23 * 60), row('old', 25 * 60)];
    assert.deepEqual(sentCounts(rows, NOW), { lastHour: 2, last24h: 4 });
    assert.deepEqual(sentCounts([{ notification_id: 1, sent_at: 'x' }], NOW), { lastHour: 0, last24h: 0 });
  });

  it('budget = min(hourly remaining, daily remaining)', () => {
    assert.equal(userAlertBudget({ max_per_hour: 4, max_per_day: 30 }, { lastHour: 1, last24h: 10 }), 3);
    assert.equal(userAlertBudget({ max_per_hour: 4, max_per_day: 30 }, { lastHour: 0, last24h: 29 }), 1);
    assert.equal(userAlertBudget({ max_per_hour: 4, max_per_day: 30 }, { lastHour: 2, last24h: 30 }), 0);
    assert.equal(userAlertBudget({ max_per_hour: 4, max_per_day: 30 }, { lastHour: 4, last24h: 4 }), 0);
    assert.equal(userAlertBudget({}, { lastHour: 0, last24h: 0 }), 4);
    assert.equal(userAlertBudget({ max_per_hour: null, max_per_day: null }, { lastHour: 0, last24h: 28 }), 2);
  });
});

describe('presetSignalRows (young_calm / young_frenzy only)', () => {
  it('young_calm match → one row with bounded entry values, entry_zone null (archived)', () => {
    const rows = presetSignalRows([calmTok({ narrative: 'GTA' })], NOW);
    assert.deepEqual(rows, [{
      preset: 'young_calm',
      mint: MINT,
      pair_address: PAIR,
      detected_at: new Date(NOW).toISOString(),
      entry_price: 0.001,
      entry_mc: 200_000,
      entry_liq_eff: 35_000,
      entry_zone: null,
      entry_dex_id: 'pumpswap',
      entry_change_1h: 20,
      entry_roundtrip_pct: 2,
      narrative: 'GTA',
      pair_age_h: 3,
    }]);
  });
  it('young_frenzy when the momentum is frenzy (never both); old pair → no row (Momentum / Strict removed)', () => {
    assert.deepEqual(presetSignalRows([calmTok({ change_1h: 200 })], NOW).map((r) => r.preset), ['young_frenzy']);
    assert.deepEqual(presetSignalRows([calmTok({ buys_1h: 300 })], NOW).map((r) => r.preset), ['young_frenzy']);
    assert.deepEqual(presetSignalRows([calmTok({ pair_created_at: NOW - 30 * H })], NOW), []);
    assert.deepEqual(presetSignalRows([calmTok({ dex_id: 'raydium' })], NOW), []);
  });
  it('skips invalid tokens and sanitises out-of-range values to null', () => {
    assert.equal(presetSignalRows([calmTok({ pair_address: 'nope' })], NOW).length, 0);
    assert.equal(presetSignalRows([calmTok({ price_usd: 0 })], NOW).length, 0);
    assert.equal(presetSignalRows([calmTok()], Number.NaN).length, 0);
    const odd = presetSignalRows([calmTok({ roundtrip_cost_pct: 4.5, narrative: '<b>GTA</b>' })], NOW);
    assert.equal(odd.length, 1);
    assert.equal(odd[0].narrative, null);
  });
  it('cleanNarrative keeps clean upper-case labels only', () => {
    assert.equal(cleanNarrative('GTA'), 'GTA');
    assert.equal(cleanNarrative('AI_AGENT'), 'AI_AGENT');
    assert.equal(cleanNarrative('gta'), null);
    assert.equal(cleanNarrative('‮GTA'), null);
    assert.equal(cleanNarrative(null), null);
  });
});
