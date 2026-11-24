// 6 h sparkline (tokens.spark_6h): bucketing, forward fill, too few points, window cut, rounding, payload split.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSparkline, type SparkPoint, sparkColumns, splitBySpark } from './sparkline';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const M = 60_000;
const H = 60 * M;
const START = NOW - 6 * H;
const A = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const B = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/** One point per 15-min bucket i (at the middle of it). */
const pt = (i: number, price: number, offsetMin = 7): SparkPoint => ({ at: START + i * 15 * M + offsetMin * M, price });

describe('buildSparkline', () => {
  it('one value per 15-min bucket over 6 h (24 buckets)', () => {
    const points = Array.from({ length: 24 }, (_, i) => pt(i, i + 1));
    assert.deepEqual(buildSparkline(points, NOW), Array.from({ length: 24 }, (_, i) => i + 1));
  });

  it('keeps the LAST price of each bucket, whatever the input order', () => {
    const points = [pt(0, 2, 10), pt(0, 1, 2), pt(1, 3), pt(2, 4), pt(3, 5, 1), pt(3, 6, 14)];
    assert.deepEqual(buildSparkline(points, START + 60 * M, 60 * M, 4), [2, 3, 4, 6]);
  });

  it('forward-fills gaps and drops leading empty buckets', () => {
    const points = [pt(10, 1), pt(11, 2), pt(15, 3), pt(23, 4)];
    const s = buildSparkline(points, NOW);
    assert.ok(s);
    assert.equal(s.length, 14); // buckets 10..23
    assert.deepEqual(s, [1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4]);
  });

  it('null with fewer than 4 valid points in the window', () => {
    assert.equal(buildSparkline([pt(1, 1), pt(2, 2), pt(3, 3)], NOW), null);
    assert.equal(buildSparkline([], NOW), null);
    // invalid prices / times do not count
    assert.equal(buildSparkline([pt(1, 1), pt(2, 2), pt(3, 3), pt(4, 0), pt(5, -1), pt(6, Number.NaN), pt(7, 1e12), { at: Number.NaN, price: 1 }], NOW), null);
  });

  it('cuts at the window: older and future points are ignored', () => {
    const points = [{ at: START - M, price: 99 }, pt(20, 1), pt(21, 2), pt(22, 3), { at: NOW + M, price: 77 }];
    assert.equal(buildSparkline(points, NOW), null); // only 3 inside
    const s = buildSparkline([...points, { at: NOW, price: 4 }], NOW);
    assert.deepEqual(s, [1, 2, 3, 4]); // the point at nowMs falls in the last bucket
    assert.deepEqual(buildSparkline([{ at: START, price: 5 }, pt(1, 6), pt(2, 7), pt(3, 8)], NOW)?.slice(0, 4), [5, 6, 7, 8]);
  });

  it('rounds to 6 significant digits and stays > 0 for tiny prices', () => {
    const s = buildSparkline([pt(0, 0.0000123456789), pt(1, 1234567.89), pt(2, 1.23456789), pt(3, 0.1)], START + 60 * M, 60 * M, 4);
    assert.deepEqual(s, [0.0000123457, 1234570, 1.23457, 0.1]);
  });

  it('never throws on hostile input and rejects invalid arguments', () => {
    const bad = [null, 3, { at: 'x', price: 1 }] as unknown as SparkPoint[];
    assert.equal(buildSparkline(bad, NOW), null);
    assert.equal(buildSparkline(null as unknown as SparkPoint[], NOW), null);
    // values that a real (float32) column would store as 0 or as 1e12 are rejected like the constraint does
    assert.equal(buildSparkline([pt(0, 1e-50), pt(1, 999_999_999_999), pt(2, 1), pt(3, 1)], NOW), null);
    const ok = Array.from({ length: 8 }, (_, i) => pt(i, 1));
    assert.equal(buildSparkline(ok, Number.NaN), null);
    assert.equal(buildSparkline(ok, NOW, 0), null);
    assert.equal(buildSparkline(ok, NOW, 6 * H, 0), null);
    assert.equal(buildSparkline(ok, NOW, 6 * H, 49), null);
    assert.equal(buildSparkline(ok, NOW, 6 * H, 2.5), null);
    assert.equal(buildSparkline(ok, NOW, 6 * H, 48)?.length, 48); // 48 buckets is the maximum (forward-filled)
  });
});

describe('sparkColumns', () => {
  const history = new Map([[A, [{ t: NOW - 50 * M, price: 1 }, { t: NOW - 35 * M, price: null }, { t: NOW - 20 * M, price: 2 }, { t: NOW - 5 * M, price: 3 }]]]);

  it('history + current price as the last point, only for requested mints', () => {
    const cols = sparkColumns([{ mint: A, price: 4 }, { mint: B, price: 9 }], history, new Set([A]), NOW);
    assert.deepEqual([...cols.keys()], [A]);
    const s = cols.get(A);
    assert.ok(s);
    assert.equal(s.at(-1), 4);
    assert.deepEqual(s, [1, 1, 2, 4]); // buckets 20..23: 1, (null price skipped → ffill) 1, 2, then 3 replaced by 4 (same bucket)
  });

  it('requested mint without enough history → null entry (written as null)', () => {
    const cols = sparkColumns([{ mint: B, price: 9 }], history, new Set([A, B]), NOW);
    assert.ok(cols.has(B));
    assert.equal(cols.get(B), null);
  });

  it('history read failed → no entry at all', () => {
    assert.equal(sparkColumns([{ mint: A, price: 4 }], history, null, NOW).size, 0);
  });
});

describe('splitBySpark (upsert payload)', () => {
  const rows = [{ mint: A, score: 80 }, { mint: B, score: 60 }];

  it('spark_6h only on rows that have an entry; the others do not carry the key', () => {
    const { withSpark, without } = splitBySpark(rows, new Map([[A, [1, 2, 3, 4]]]));
    assert.deepEqual(withSpark, [{ mint: A, score: 80, spark_6h: [1, 2, 3, 4] }]);
    assert.deepEqual(without, [{ mint: B, score: 60 }]);
    assert.equal('spark_6h' in without[0], false);
  });

  it('a null entry is written explicitly as null', () => {
    const { withSpark } = splitBySpark(rows, new Map([[B, null]]));
    assert.deepEqual(withSpark, [{ mint: B, score: 60, spark_6h: null }]);
  });

  it('no spark computed → no row carries spark_6h', () => {
    const { withSpark, without } = splitBySpark(rows, new Map());
    assert.equal(withSpark.length, 0);
    assert.deepEqual(without, rows);
  });
});
