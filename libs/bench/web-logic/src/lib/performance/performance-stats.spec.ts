import { describe, expect, it } from 'vitest';
import { MIN_SAMPLE_FOR_RATE, formatHits, formatRate, hasEnoughSample } from './performance-stats';

describe('formatting', () => {
  it('formats rates in French, « — » when unknown', () => {
    expect(formatRate(0.084)).toBe('8,4 %');
    expect(formatRate(0)).toBe('0,0 %');
    expect(formatRate(null)).toBe('—');
  });
});

describe('minimum sample for a rate', () => {
  it('exports MIN_SAMPLE_FOR_RATE = 30', () => {
    expect(MIN_SAMPLE_FOR_RATE).toBe(30);
  });

  it('is enough from 30 rows upwards', () => {
    expect(hasEnoughSample(29)).toBe(false);
    expect(hasEnoughSample(30)).toBe(true);
    expect(hasEnoughSample(0)).toBe(false);
    expect(hasEnoughSample(Number.NaN)).toBe(false);
  });

  it('formats « hits / n »', () => {
    expect(formatHits(3, 29)).toBe('3 / 29');
    expect(formatHits(0, 0)).toBe('0 / 0');
  });
});
