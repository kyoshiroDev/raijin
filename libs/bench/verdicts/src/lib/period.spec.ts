import { periodOf, splitChronologically } from './period';

const at = (id: string, day: number) => ({ id, verdictAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z` });

describe('période et découpage chronologique', () => {
  it('période : bornes min et max, null si vide', () => {
    expect(periodOf([])).toBeNull();
    expect(periodOf([at('b', 9), at('a', 2), at('c', 5)])).toEqual({ from: '2026-10-02T00:00:00.000Z', to: '2026-10-09T00:00:00.000Z' });
  });

  it('les plus anciens en calibration, les plus récents en validation, sans recouvrement', () => {
    const records = [at('j', 10), at('a', 1), at('e', 5), at('c', 3), at('b', 2), at('d', 4), at('f', 6), at('g', 7), at('h', 8), at('i', 9)];
    const split = splitChronologically(records, 0.7);
    expect(split.calibration.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(split.validation.map((r) => r.id)).toEqual(['h', 'i', 'j']);
    expect(Date.parse(split.calibrationPeriod?.to as string)).toBeLessThan(Date.parse(split.validationPeriod?.from as string));
  });

  it('égalité de date départagée par l’identifiant ; part hors ]0, 1[ refusée', () => {
    const split = splitChronologically([at('b', 1), at('a', 1)], 0.5);
    expect(split.calibration.map((r) => r.id)).toEqual(['a']);
    expect(splitChronologically([at('a', 1), at('a', 1)], 0.5).validation).toHaveLength(1);
    expect(() => splitChronologically([], 1)).toThrow(RangeError);
    expect(() => splitChronologically([], 0)).toThrow(RangeError);
    expect(splitChronologically([]).calibrationPeriod).toBeNull();
  });
});
