// scripts/wallet-study-lib.ts (feat/wallet-study). Pure, no network.
// Runs with `node --experimental-strip-types --test scripts/wallet-study-lib_test.ts` (and deno test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dbQueryArgs } from './strategy-lab-lib.ts';
import {
  BUYERS_SQL,
  buildStudyInput,
  candlesSql,
  mintsWithBuyers,
  OUTCOMES_SQL,
  parseBuyers,
  parseOutcomes,
  peakMap,
  YOUNG_CALM_SQL,
  youngCalmMap,
} from './wallet-study-lib.ts';
import { runWalletStudy } from '../supabase/functions/_shared/wallet-study.ts';

const M1 = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXh11pump';
const M2 = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXh12pump';
const W1 = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRwXh11pump';

describe('wallet-study lib', () => {
  it('SQL is read-only (SELECT only) and run with --read-only', () => {
    for (const sql of [OUTCOMES_SQL, BUYERS_SQL, YOUNG_CALM_SQL, candlesSql([M1])]) {
      assert.match(sql.trim(), /^select /i);
      assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|truncate|grant)\b/i);
    }
    const args = dbQueryArgs({ cmd: 'supabase', prefix: [] }, BUYERS_SQL, false);
    assert.ok(args.includes('--read-only'));
    assert.ok(!args.includes('--yes'));
  });
  it('candlesSql keeps only valid mints (no injection), empty when none', () => {
    const sql = candlesSql([M1, "x'); drop table t; --", M2]);
    assert.ok(sql.includes(`'${M1}'`) && sql.includes(`'${M2}'`));
    assert.ok(!sql.includes('drop table'));
    assert.match(sql, /\bv\b from public\.ohlcv_candles/);
    assert.equal(candlesSql(['bad']), '');
  });
  it('parses CLI rows, counts invalid ones', () => {
    const o = parseOutcomes([
      { mint: M1, detected_at: '2026-11-01 00:00:00+00', hit_x3: true, x2_before_sl30: true, sl30_before_x2: false, features: { log_age_h: 1 } },
      { mint: M2, detected_at: '2026-11-01 01:00:00+00', hit_x3: null, x2_before_sl30: true, sl30_before_x2: false, features: {} },
    ]);
    assert.equal(o.rows.length, 1);
    assert.equal(o.invalid, 1);
    const b = parseBuyers([
      { mint: M1, wallet: W1, ts: '2026-10-31 23:00:00+00', sol_amount: 2, rank: 1 },
      { mint: M1, wallet: '<img>', ts: '2026-10-31 23:00:00+00', sol_amount: 2, rank: 1 },
    ]);
    assert.equal(b.rows.length, 1);
    assert.equal(b.invalid, 1);
    assert.deepEqual(mintsWithBuyers(o.rows, b.rows), [M1]);
  });
  it('youngCalmMap keeps the earliest signal per mint; peakMap groups candle rows per mint', () => {
    const yc = youngCalmMap([
      { mint: M1, detected_at: '2026-11-01 02:00:00+00' },
      { mint: M1, detected_at: '2026-11-01 01:00:00+00' },
      { mint: 'bad', detected_at: '2026-11-01 01:00:00+00' },
    ]);
    assert.deepEqual([...yc], [[M1, Date.parse('2026-11-01T01:00:00Z')]]);
    const row = (mint: string, h: number[]) => ({
      mint, tf: '5m', step_s: 300, ts_start: '2026-11-01 00:00:00+00', ts: h.map((_, i) => i * 300),
      o: h.map(() => 1), h, l: h.map(() => 0.5), c: h.map(() => 1), v: h.map(() => 1),
    });
    const p = peakMap([row(M1, [1, 4, 2]), row(M2, [3]), { mint: 'bad' }, null]);
    assert.equal(p.get(M1), Date.parse('2026-11-01T00:05:00Z'));
    assert.equal(p.get(M2), Date.parse('2026-11-01T00:00:00Z'));
    assert.equal(p.size, 2);
  });
  it('builds an input runWalletStudy accepts', () => {
    const r = runWalletStudy(buildStudyInput([], [], new Map(), new Map()), { resamples: 10, robustnessDraws: 1 });
    assert.equal(r.n_tokens.labelled, 0);
    assert.equal(r.verdict.label, 'piste réfutée');
  });
});
