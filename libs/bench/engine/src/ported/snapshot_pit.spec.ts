// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { knownChange1h, knownTxns1h, pointInTimeColumns, TXNS_1H_MAX, youngPointInTimeColumns } from './snapshot-pit';

describe('pointInTimeColumns', () => {
  it('copies the values known at scan time', () => {
    assert.deepEqual(
      pointInTimeColumns({
        mint_authority_disabled: true,
        freeze_authority_disabled: false,
        top10_pct: 22.5,
        insiders_detected: false,
        roundtrip_cost_pct: 2.4,
        change_1h: 35,
      }),
      {
        mint_authority_disabled: true,
        freeze_authority_disabled: false,
        top10_pct: 22.5,
        insiders_detected: false,
        roundtrip_cost_pct: 2.4,
        change_1h: 35,
      },
    );
  });

  it('unknown values stay null (never guessed)', () => {
    assert.deepEqual(pointInTimeColumns(undefined), {
      mint_authority_disabled: null,
      freeze_authority_disabled: null,
      top10_pct: null,
      insiders_detected: null,
      roundtrip_cost_pct: null,
      change_1h: null,
    });
    assert.equal(pointInTimeColumns({ mint_authority_disabled: 'true' }).mint_authority_disabled, null);
    assert.equal(pointInTimeColumns({ top10_pct: '20' }).top10_pct, null);
  });

  it('rejects values outside the Postgres checks', () => {
    assert.equal(pointInTimeColumns({ top10_pct: 100.01 }).top10_pct, null);
    assert.equal(pointInTimeColumns({ top10_pct: -1 }).top10_pct, null);
    assert.equal(pointInTimeColumns({ top10_pct: 100 }).top10_pct, 100);
    assert.equal(pointInTimeColumns({ roundtrip_cost_pct: -100.5 }).roundtrip_cost_pct, null);
    assert.equal(pointInTimeColumns({ roundtrip_cost_pct: 100 }).roundtrip_cost_pct, 100);
    assert.equal(pointInTimeColumns({ change_1h: -100 }).change_1h, -100);
    assert.equal(pointInTimeColumns({ change_1h: -100.1 }).change_1h, null);
    assert.equal(pointInTimeColumns({ change_1h: 1e9 }).change_1h, null);
    assert.equal(pointInTimeColumns({ change_1h: Number.NaN }).change_1h, null);
    assert.equal(pointInTimeColumns({ change_1h: Number.POSITIVE_INFINITY }).change_1h, null);
  });
});

describe('youngPointInTimeColumns', () => {
  it('copies the young-calm values known at scan time', () => {
    assert.deepEqual(
      youngPointInTimeColumns({ buys_1h: 120, sells_1h: 100, liquidity_effective_usd: 31_500.5, lp_locked_pct: 100 }),
      { buys_1h: 120, sells_1h: 100, liquidity_effective_usd: 31_500.5, lp_locked_pct: 100 },
    );
    assert.deepEqual(youngPointInTimeColumns({ buys_1h: 0, sells_1h: 0, liquidity_effective_usd: 0, lp_locked_pct: 0 }), {
      buys_1h: 0,
      sells_1h: 0,
      liquidity_effective_usd: 0,
      lp_locked_pct: 0,
    });
  });

  it('unknown or out-of-bounds values become null (each like its CHECK)', () => {
    const none = { buys_1h: null, sells_1h: null, liquidity_effective_usd: null, lp_locked_pct: null };
    assert.deepEqual(youngPointInTimeColumns(undefined), none);
    assert.deepEqual(youngPointInTimeColumns(null), none);
    assert.deepEqual(
      youngPointInTimeColumns({ buys_1h: -1, sells_1h: 1.5, liquidity_effective_usd: 1e13, lp_locked_pct: 100.01 }),
      none,
    );
    assert.deepEqual(
      youngPointInTimeColumns({ buys_1h: TXNS_1H_MAX + 1, sells_1h: '12', liquidity_effective_usd: -1, lp_locked_pct: -0.1 }),
      none,
    );
    assert.deepEqual(
      youngPointInTimeColumns({ buys_1h: Number.NaN, sells_1h: Infinity, liquidity_effective_usd: Number.NaN, lp_locked_pct: '90' }),
      none,
    );
    assert.equal(youngPointInTimeColumns({ buys_1h: TXNS_1H_MAX }).buys_1h, TXNS_1H_MAX);
  });
});

describe('knownTxns1h', () => {
  it('both counts present → kept', () => {
    assert.deepEqual(knownTxns1h({ txns: { h1: { buys: 12, sells: 9 } } }), { buys: 12, sells: 9 });
    assert.deepEqual(knownTxns1h({ txns: { h1: { buys: 0, sells: 0 } } }), { buys: 0, sells: 0 });
  });

  it('one missing / invalid → both unknown (never the 0 default)', () => {
    const none = { buys: null, sells: null };
    assert.deepEqual(knownTxns1h({ txns: { h1: { buys: 12 } } }), none);
    assert.deepEqual(knownTxns1h({ txns: { h1: { sells: 3 } } }), none);
    assert.deepEqual(knownTxns1h({ txns: {} }), none);
    assert.deepEqual(knownTxns1h({}), none);
    assert.deepEqual(knownTxns1h(null), none);
    assert.deepEqual(knownTxns1h(undefined), none);
    assert.deepEqual(knownTxns1h({ txns: { h1: { buys: -1, sells: 2 } } }), none);
    assert.deepEqual(knownTxns1h({ txns: { h1: { buys: 1.5, sells: 2 } } }), none);
  });
});

describe('knownChange1h', () => {
  it('present and in bounds → kept (0 included when DexScreener sent 0)', () => {
    assert.equal(knownChange1h({ priceChange: { h1: 42.5 } }), 42.5);
    assert.equal(knownChange1h({ priceChange: { h1: 0 } }), 0);
    assert.equal(knownChange1h({ priceChange: { h1: -100 } }), -100);
  });

  it('missing / invalid → null (never the 0 default)', () => {
    assert.equal(knownChange1h({ priceChange: {} }), null);
    assert.equal(knownChange1h({}), null);
    assert.equal(knownChange1h(null), null);
    assert.equal(knownChange1h(undefined), null);
    assert.equal(knownChange1h({ priceChange: { h1: Number.NaN } }), null);
    assert.equal(knownChange1h({ priceChange: { h1: -100.5 } }), null);
    assert.equal(knownChange1h({ priceChange: { h1: 1e9 } }), null);
  });
});
