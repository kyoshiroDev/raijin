import { describe, expect, it } from 'vitest';
import { DEFAULT_STAKE_SOL, formatSol, isValidStake, parseStakeInput, parseStakeValue } from './stake';

describe('stake utils', () => {
  it('defaults to 0.05 SOL', () => {
    expect(DEFAULT_STAKE_SOL).toBe(0.05);
  });

  it('parses user input with a French comma or a dot', () => {
    expect(parseStakeInput('0,25')).toBe(0.25);
    expect(parseStakeInput('0.25')).toBe(0.25);
    expect(parseStakeInput(' 2 ')).toBe(2);
    expect(parseStakeInput(',5')).toBe(0.5);
    expect(parseStakeInput('1,')).toBe(1);
  });

  it('returns NaN for malformed input', () => {
    for (const bad of ['', 'abc', '1,2,3', '1.2.3', '-1', '1e2', '0x1', '1;2']) {
      expect(parseStakeInput(bad)).toBeNaN();
    }
  });

  it('validates the 0.01–100 range', () => {
    expect(isValidStake(0.01)).toBe(true);
    expect(isValidStake(100)).toBe(true);
    expect(isValidStake(0.005)).toBe(false);
    expect(isValidStake(101)).toBe(false);
    expect(isValidStake(Number.NaN)).toBe(false);
    expect(isValidStake('1')).toBe(false);
  });

  it('parses database values (number or numeric text)', () => {
    expect(parseStakeValue(0.5)).toBe(0.5);
    expect(parseStakeValue('0.50')).toBe(0.5);
    expect(parseStakeValue('')).toBeNull();
    expect(parseStakeValue(null)).toBeNull();
    expect(parseStakeValue(1000)).toBeNull();
  });

  it('formats in French', () => {
    expect(formatSol(0.1)).toBe('0,1');
    expect(formatSol(0.25)).toBe('0,25');
    expect(formatSol(2)).toBe('2');
  });
});
