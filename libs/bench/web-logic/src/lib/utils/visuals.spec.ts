import { describe, expect, it } from 'vitest';
import {
  avatarBackground,
  avatarLetter,
  formatPriceCompact,
  mintHue,
  signedPctInt,
  sparklineGeometry,
} from './visuals';

describe('signedPctInt', () => {
  it('formats signed integer percentages with the true minus sign', () => {
    expect(signedPctInt(45.4)).toBe('+45 %');
    expect(signedPctInt(-30.2)).toBe('−30 %');
    expect(signedPctInt(0.2)).toBe('0 %');
  });
});

describe('sparklineGeometry', () => {
  it('maps the points into the box (oldest left, highest top) with a closed area', () => {
    const g = sparklineGeometry([1, 2, 3], 100, 32, 2);
    expect(g?.points).toBe('0,30 50,16 100,2');
    expect(g?.area).toBe('M0,32 L0,30 L50,16 L100,2 L100,32 Z');
    expect(g?.up).toBe(true);
    expect(g?.changePct).toBeCloseTo(200, 5);
  });

  it('is red (down) when the last point is below the first, green when equal', () => {
    expect(sparklineGeometry([3, 4, 2])?.up).toBe(false);
    expect(sparklineGeometry([2, 5, 2])?.up).toBe(true);
  });

  it('draws a flat series mid-height', () => {
    expect(sparklineGeometry([5, 5], 100, 32)?.points).toBe('0,16 100,16');
  });

  it('returns null without at least 2 usable points', () => {
    expect(sparklineGeometry(null)).toBeNull();
    expect(sparklineGeometry([])).toBeNull();
    expect(sparklineGeometry([1])).toBeNull();
    expect(sparklineGeometry([1, Number.NaN, -2, 0])).toBeNull();
  });
});

describe('avatar fallback', () => {
  const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  it('derives a deterministic hue from the mint', () => {
    const h = mintHue(MINT);
    expect(h).not.toBeNull();
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
    expect(mintHue(MINT)).toBe(h);
    expect(avatarBackground(MINT)).toBe(`hsl(${h} 45% 24%)`);
    expect(mintHue('So11111111111111111111111111111111111111112')).not.toBe(h);
    expect(mintHue('')).toBeNull();
    expect(avatarBackground('')).toBeNull();
  });

  it('takes the first letter / digit / emoji of a hostile symbol, « ? » when there is none', () => {
    expect(avatarLetter('bonk')).toBe('B');
    expect(avatarLetter('<img src=x onerror=alert(1)>')).toBe('I');
    expect(avatarLetter('$<>')).toBe('?');
    expect(avatarLetter('')).toBe('?');
    expect(avatarLetter('  9gag')).toBe('9');
    expect(avatarLetter('🐸PEPE')).toBe('🐸');
    expect(avatarLetter('éclair')).toBe('É');
  });
});

describe('formatPriceCompact', () => {
  it('folds the leading zeros of tiny prices into a subscript count (4 significant digits)', () => {
    expect(formatPriceCompact(0.000000001234)).toBe('$0.0₈1234');
    expect(formatPriceCompact(0.0000000016)).toBe('$0.0₈16');
    expect(formatPriceCompact(0.00001)).toBe('$0.0₄1');
    expect(formatPriceCompact(0.000099999)).toBe('$0.0₃1'); // rounding carries over to 0.0001
    expect(formatPriceCompact(1.5e-14)).toBe('$0.0₁₃15');
  });

  it('keeps regular prices as formatPrice and unknown as « – »', () => {
    expect(formatPriceCompact(0.0234)).toBe('$0.02340');
    expect(formatPriceCompact(0.0001)).toBe('$0.0001000');
    expect(formatPriceCompact(12.3456)).toBe('$12.346');
    expect(formatPriceCompact(0)).toBe('–');
    expect(formatPriceCompact(null)).toBe('–');
    expect(formatPriceCompact(Number.NaN)).toBe('–');
  });
});
