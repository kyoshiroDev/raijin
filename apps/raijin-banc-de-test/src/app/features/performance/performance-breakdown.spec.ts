import { describe, expect, it } from 'vitest';
import {
  bucketLabel,
  bucketView,
  formatMultiple,
  parseBreakdownRow,
  parseBreakdownRows,
  parseCount,
  parseRangeBucket,
  sampleNote,
  sortBuckets,
  sourceView,
  type BreakdownRow,
} from './performance-breakdown';
import { breakdownRow } from './performance-test-data';

const parsed = (over: Record<string, unknown> = {}): BreakdownRow => {
  const r = parseBreakdownRow(breakdownRow(over));
  if (!r) throw new Error('invalid test row');
  return r;
};

describe('parsing', () => {
  it('parses counts sent as numbers or numeric text, and the median multiple', () => {
    const r = parseBreakdownRow(breakdownRow({ n: '40', n_final: '30', x2: 12 }));
    expect(r).toEqual({
      source: 'scan',
      dimension: 'all',
      bucket: 'all',
      n: 40,
      n_final: 30,
      x2: 12,
      x3: 6,
      x2_before_sl30: 10,
      sl30_before_x2: 20,
      dd50_first: 8,
      median_max_multiple: 1.45,
    });
    expect(parseBreakdownRow(breakdownRow({ median_max_multiple: null }))?.median_max_multiple).toBeNull();
    expect(parseBreakdownRow(breakdownRow({ median_max_multiple: '0' }))?.median_max_multiple).toBeNull();
  });

  it('parseCount accepts non-negative integers only', () => {
    expect(parseCount(3)).toBe(3);
    expect(parseCount('12')).toBe(12);
    for (const bad of [-1, 1.5, '1.5', '', ' ', 'abc', null, undefined, Number.NaN, Infinity]) expect(parseCount(bad)).toBeNull();
  });

  it('drops unknown sources / dimensions, empty buckets, missing counts and inconsistent counts', () => {
    expect(parseBreakdownRow(breakdownRow({ source: 'preset:yolo' }))).toBeNull();
    // Removed sources (Radar, old presets) and the removed entry-zone dimension are ignored.
    for (const source of ['radar', 'preset:momentum', 'preset:strict']) expect(parseBreakdownRow(breakdownRow({ source }))).toBeNull();
    expect(parseBreakdownRow(breakdownRow({ dimension: 'zone', bucket: 'in' }))).toBeNull();
    expect(parseBreakdownRow(breakdownRow({ dimension: 'score' }))).toBeNull();
    expect(parseBreakdownRow(breakdownRow({ bucket: '' }))).toBeNull();
    expect(parseBreakdownRow(breakdownRow({ bucket: 42 }))).toBeNull();
    expect(parseBreakdownRow(breakdownRow({ x3: null }))).toBeNull();
    expect(parseBreakdownRow(breakdownRow({ x2: 41 }))).toBeNull();
    expect(parseBreakdownRow(breakdownRow({ n_final: 41 }))).toBeNull();
    expect(parseBreakdownRow(breakdownRow({ x2_before_sl30: 21, sl30_before_x2: 20 }))).toBeNull();
    expect(parseBreakdownRow(null)).toBeNull();
    expect(parseBreakdownRows([breakdownRow(), { junk: true }, 7])).toHaveLength(1);
    expect(parseBreakdownRows(null)).toEqual([]);
  });

  it('keeps hostile bucket text as plain data (never interpreted)', () => {
    const hostile = '<img src=x onerror=alert(1)>\u202E';
    expect(bucketLabel('dex', hostile)).toBe(hostile);
  });
});

describe('labels', () => {
  it('labels DEX and the overview in French', () => {
    expect(bucketLabel('dex', 'pumpswap')).toBe('PumpSwap');
    expect(bucketLabel('dex', 'other')).toBe('Autres');
    expect(bucketLabel('dex', 'mystery')).toBe('mystery');
    expect(bucketLabel('all', 'all')).toBe('Ensemble');
  });

  it('labels MC / liquidity ranges from the backend bucket names', () => {
    expect(bucketLabel('mc', '<50k')).toBe('< 50 k$');
    expect(bucketLabel('mc', '50k-100k')).toBe('50 k$–100 k$');
    expect(bucketLabel('mc', '100k-1M')).toBe('100 k$–1 M$');
    expect(bucketLabel('mc', '>1M')).toBe('> 1 M$');
    expect(bucketLabel('liq', '>=50k')).toBe('≥ 50 k$');
    expect(bucketLabel('liq', 'lt20k')).toBe('< 20 k$');
    expect(bucketLabel('liq', 'gte1m')).toBe('≥ 1 M$');
    expect(bucketLabel('liq', '1.5m+')).toBe('≥ 1,5 M$');
    expect(bucketLabel('liq', 'weird')).toBe('weird');
    expect(parseRangeBucket('<=10k')).toBeNull();
  });
});

describe('ordering', () => {
  const rows = (dimension: BreakdownRow['dimension'], buckets: [string, number][]) =>
    buckets.map(([bucket, n]) => ({ dimension, bucket, n }));

  it('sorts MC and liquidity ascending, « < x » before « x–y », « ≥ / > » last, unknown at the end', () => {
    const mc = sortBuckets(rows('mc', [['>1M', 1], ['100k-1M', 1], ['zzz', 1], ['<50k', 1], ['50k-100k', 1]]));
    expect(mc.map((r) => r.bucket)).toEqual(['<50k', '50k-100k', '100k-1M', '>1M', 'zzz']);
    const liq = sortBuckets(rows('liq', [['>=50k', 1], ['10k-20k', 1], ['<10k', 1], ['20k-50k', 1]]));
    expect(liq.map((r) => r.bucket)).toEqual(['<10k', '10k-20k', '20k-50k', '>=50k']);
  });

  it('sorts DEX by sample size, « other » last', () => {
    expect(sortBuckets(rows('dex', [['other', 99], ['raydium', 5], ['pumpswap', 40], ['orca', 5]])).map((r) => r.bucket)).toEqual([
      'pumpswap',
      'orca',
      'raydium',
      'other',
    ]);
  });

  it('does not mutate its input', () => {
    const input = rows('mc', [['>1M', 1], ['<50k', 1]]);
    sortBuckets(input);
    expect(input.map((r) => r.bucket)).toEqual(['>1M', '<50k']);
  });
});

describe('bucket view and small-sample rule', () => {
  it('computes the four rates on n (labelled rows), with hits', () => {
    const v = bucketView(parsed());
    expect(v.rates.map((r) => [r.key, r.hits, r.rate])).toEqual([
      ['x2', 12, 0.3],
      ['x2_before_sl30', 10, 0.25],
      ['sl30_before_x2', 20, 0.5],
      ['x3', 6, 0.15],
    ]);
    expect(v.dd50).toMatchObject({ hits: 8, rate: 0.2 });
    expect(v).toMatchObject({ n: 40, nFinal: 30, enough: true, medianMultiple: 1.45 });
  });

  it('is « enough » from n = 30 only; rates are null when n = 0', () => {
    expect(bucketView(parsed({ n: 29, n_final: 0, x2: 0, x3: 0, x2_before_sl30: 0, sl30_before_x2: 0, dd50_first: 0 })).enough).toBe(false);
    expect(bucketView(parsed({ n: 30 })).enough).toBe(true);
    const empty = bucketView(parsed({ n: 0, n_final: 0, x2: 0, x3: 0, x2_before_sl30: 0, sl30_before_x2: 0, dd50_first: 0 }));
    expect(empty.rates.every((r) => r.rate === null)).toBe(true);
  });

  it('writes the sample note', () => {
    expect(sampleNote(12)).toBe('n = 12, échantillon trop petit');
    expect(sampleNote(29)).toBe('n = 29, échantillon trop petit');
    expect(sampleNote(30)).toBe('n = 30');
    expect(sampleNote(1500)).toBe('n = 1 500');
  });

  it('formats the median multiple', () => {
    expect(formatMultiple(1.85)).toBe('×1,85');
    expect(formatMultiple(2)).toBe('×2,0');
    expect(formatMultiple(null)).toBe('—');
  });
});

describe('source view', () => {
  const rows = parseBreakdownRows([
    breakdownRow(),
    breakdownRow({ dimension: 'mc', bucket: '>1M', n: 10, n_final: 5, x2: 1, x3: 0, x2_before_sl30: 1, sl30_before_x2: 2, dd50_first: 0 }),
    breakdownRow({ dimension: 'mc', bucket: '<50k', n: 30 }),
  ]);

  it('returns the overview and every dimension in order (DEX, MC, liquidity), buckets sorted', () => {
    const v = sourceView(rows, 'scan');
    expect(v.overall?.n).toBe(40);
    expect(v.dimensions.map((d) => d.id)).toEqual(['dex', 'mc', 'liq']);
    expect(v.dimensions[1].buckets.map((b) => b.bucket)).toEqual(['<50k', '>1M']);
    expect(v.dimensions[0].buckets).toEqual([]);
  });

  it('has no overview without rows', () => {
    expect(sourceView([], 'scan').overall).toBeNull();
  });
});
