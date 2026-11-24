import { proportion } from '@raijin/bench-verdicts';
import { describe, expect, it } from 'vitest';
import { formatCount, formatDeltaPoints, formatInterval, formatLift, formatPct, formatPeriod } from './verdict-quality-format';

const nbsp = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

describe('verdict-quality-format', () => {
  it('pourcentages, intervalles et effectifs en fr-FR', () => {
    expect(nbsp(formatPct(0.351))).toBe('35,1 %');
    expect(formatPct(null)).toBe('—');
    expect(nbsp(formatInterval(proportion(5, 10)))).toBe('IC 95 % : 23,7 – 76,3 %');
    expect(formatInterval(proportion(0, 0))).toBe('IC 95 % : —');
    expect(formatCount(proportion(3, 40))).toBe('3 / 40');
  });

  it('écarts en points, lift, période', () => {
    expect(nbsp(formatDeltaPoints(0.04))).toBe('+4,0 pts');
    expect(nbsp(formatDeltaPoints(-0.012))).toBe('-1,2 pt');
    expect(nbsp(formatDeltaPoints(0))).toBe('0,0 pt');
    expect(formatDeltaPoints(null)).toBe('—');
    expect(formatLift(null)).toBe('non classé');
    expect(formatLift(2.5)).toBe('×2,50');
    expect(nbsp(formatPeriod({ from: '2026-09-01T00:36:03.973Z', to: '2026-10-20T22:16:46.945Z' }))).toBe('1 sept. 2026 – 20 oct. 2026');
    expect(formatPeriod(null)).toBe('aucune donnée');
  });
});
