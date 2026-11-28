// scripts/young-calm-replay-lib.ts (feat/young-calm). Pure, no network.
// Runs with `node --experimental-strip-types --test scripts/young-calm-replay-lib_test.ts` (and deno test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplayReport, replayRow } from './young-calm-replay-lib.ts';

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let n = 0;
const mint = () => {
  n++;
  return 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXh' + B58[Math.floor(n / 58) % 58] + B58[n % 58] + 'pump';
};
const row = (over: Record<string, unknown> = {}, feat: Record<string, unknown> = {}) => ({
  mint: mint(),
  detected_at: new Date(T0).toISOString(),
  entry_mc: 300_000,
  entry_liq_eff: 40_000,
  entry_zone: 'wait',
  entry_dex_id: 'pumpswap',
  entry_roundtrip_pct: 2,
  features: JSON.stringify({ change_1h: 30, log_age_h: Math.log1p(4), buy_sell_ratio_1h: 1.1, lp_locked_pct: 100, ...feat }),
  narrative: 'GTA',
  created_ms: null,
  mad: true,
  fad: true,
  top10: 12,
  ins: false,
  crh: false,
  lp_now: 100,
  x2: null,
  sl: null,
  ...over,
});

describe('young-calm replay lib', () => {
  it('parses a CLI row (features as JSON text), falls back to tokens.pair_created_at for the age', () => {
    const r = replayRow(row())!;
    assert.equal(r.momentum, 'calm');
    assert.deepEqual(r.failures, []);
    assert.equal(r.safetyNow, 'ok');
    assert.equal(r.group, 'gta');
    assert.equal(r.label, null);
    const aged = replayRow(row({ created_ms: T0 - 30 * 3_600_000 }, { log_age_h: null }))!;
    assert.deepEqual(aged.failures, ['age']);
    assert.equal(replayRow({ mint: 'bad' }), null);
    assert.equal(replayRow(row({ top10: null }))!.safetyNow, 'unknown');
    assert.equal(replayRow(row({ fad: false }))!.safetyNow, 'fail');
    assert.equal(replayRow(row({ x2: true, sl: false }))!.label, 'x2');
    assert.equal(replayRow(row({ x2: false, sl: false }))!.label, 'neither');
  });
  it('report: candidates per day / narrative, exclusions, LP removals, outcomes', () => {
    const rows = [
      row({ x2: true, sl: false }),
      row({ narrative: null, x2: false, sl: true }),
      row({ top10: 40 }), // calm, current safety fails
      row({}, { lp_locked_pct: 10 }), // removed by LP only
      row({}, { change_1h: 300 }), // frenzy
      row({ entry_dex_id: 'raydium' }),
      row({ detected_at: new Date(T0 + 86_400_000).toISOString(), lp_now: 20 }),
    ].map((r) => replayRow(r)!);
    const rep = buildReplayReport(rows, T0 - 3_600_000, T0 + 2 * 86_400_000);
    assert.equal(rep.detections, 7);
    assert.equal(rep.young, 7);
    assert.equal(rep.exclusions_young.dex, 1);
    assert.equal(rep.exclusions_young.lp, 1);
    const c = rep.young_calm;
    assert.equal(c.sans_securite.total, 4);
    assert.deepEqual(c.sans_securite.per_day, { '2026-11-19': 3, '2026-11-20': 1, '2026-11-21': 0 });
    assert.equal(c.sans_securite.gta, 3);
    assert.deepEqual(c.sans_securite.outcome, { labelled: 2, x2_before_sl30: 1, sl30_before_x2: 1, neither: 0, x2_rate: 0.5 });
    assert.equal(c.avec_securite_connue_biais.total, 3);
    assert.equal(c.avec_securite_connue_biais.safety_fail_dropped, 1);
    assert.deepEqual(c.lp_rule_removes, { at_detection: 1, with_current_lp: 1 });
    assert.equal(rep.young_frenzy.sans_securite.total, 1);
    assert.equal(rep.momentum_young_all.frenzy.n, 1);
  });
});
