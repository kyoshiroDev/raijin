import { describe, expect, it } from 'vitest';
import { formatDecimalFr, fractionToPercent, parseDecimalInput, percentToFraction } from './decimal';

describe('decimal utils', () => {
  it('parses dot or French comma decimals, NaN for junk', () => {
    expect(parseDecimalInput('2,5')).toBe(2.5);
    expect(parseDecimalInput(' 30 ')).toBe(30);
    expect(parseDecimalInput('.5')).toBe(0.5);
    for (const bad of ['', 'abc', '-1', '1,2,3', '1e3']) expect(parseDecimalInput(bad)).toBeNaN();
  });

  it('converts percent ↔ fraction without binary noise', () => {
    expect(percentToFraction(29)).toBe(0.29);
    expect(percentToFraction(35.5)).toBe(0.355);
    expect(percentToFraction(Number.NaN)).toBeNaN();
    expect(fractionToPercent(0.29)).toBe(29);
    expect(fractionToPercent(0.25)).toBe(25);
    expect(fractionToPercent(0.355)).toBe(35.5);
  });

  it('formats in French', () => {
    expect(formatDecimalFr(2.5)).toBe('2,5');
    expect(formatDecimalFr(3)).toBe('3');
    expect(formatDecimalFr(Number.NaN)).toBe('');
  });
});
