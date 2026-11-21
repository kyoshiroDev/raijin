import { describe, expect, it } from 'vitest';
import { formatCount, formatEur, formatPercentFr, formatSignedPercentFr, formatSignedSol, formatSolAmount, formatSolEur, formatUpdatedAgo } from './format';

describe('formatUpdatedAgo', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms);

  it('handles missing or invalid dates', () => {
    expect(formatUpdatedAgo(null, now)).toBe('Pas encore de données');
    expect(formatUpdatedAgo(undefined, now)).toBe('Pas encore de données');
    expect(formatUpdatedAgo('not a date', now)).toBe('Pas encore de données');
  });

  it('says « à l’instant » under one minute (and for clock skew in the future)', () => {
    expect(formatUpdatedAgo(ago(0), now)).toBe('Mis à jour à l’instant');
    expect(formatUpdatedAgo(ago(59_999), now)).toBe('Mis à jour à l’instant');
    expect(formatUpdatedAgo(new Date(now + 120_000), now)).toBe('Mis à jour à l’instant');
  });

  it('counts whole minutes, then hours, then days', () => {
    expect(formatUpdatedAgo(ago(60_000), now)).toBe('Mis à jour il y a 1 min');
    expect(formatUpdatedAgo(ago(12 * 60_000 + 30_000), now)).toBe('Mis à jour il y a 12 min');
    expect(formatUpdatedAgo(ago(59 * 60_000), now)).toBe('Mis à jour il y a 59 min');
    expect(formatUpdatedAgo(ago(60 * 60_000), now)).toBe('Mis à jour il y a 1 h');
    expect(formatUpdatedAgo(ago(47 * 3_600_000), now)).toBe('Mis à jour il y a 47 h');
    expect(formatUpdatedAgo(ago(72 * 3_600_000), now)).toBe('Mis à jour il y a 3 j');
  });

  it('accepts a custom prefix (« Enrichi il y a X min »)', () => {
    expect(formatUpdatedAgo('2026-11-16T11:55:00Z', now, 'Enrichi')).toBe('Enrichi il y a 5 min');
    expect(formatUpdatedAgo('2026-11-16T12:00:00Z', now, 'Enrichi')).toBe('Enrichi à l’instant');
  });

  it('accepts ISO strings (updated_at)', () => {
    expect(formatUpdatedAgo('2026-11-16T11:55:00Z', now)).toBe('Mis à jour il y a 5 min');
  });
});

describe('formatCount', () => {
  it('formats counts in French and rejects junk', () => {
    expect(formatCount(1234567).replace(/\s/g, ' ')).toBe('1 234 567');
    expect(formatCount(null)).toBe('–');
    expect(formatCount(Number.NaN)).toBe('–');
    expect(formatCount(-1)).toBe('–');
  });
});

describe('formatPercentFr', () => {
  it('uses a French decimal comma and one decimal', () => {
    expect(formatPercentFr(2.44)).toBe('2,4 %');
    expect(formatPercentFr(8)).toBe('8,0 %');
    expect(formatPercentFr(null)).toBe('–');
    expect(formatPercentFr(Number.NaN)).toBe('–');
  });
});

describe('formatSignedPercentFr', () => {
  it('signs gains and losses with a French decimal comma', () => {
    expect(formatSignedPercentFr(20)).toBe('+20,0 %');
    expect(formatSignedPercentFr(-12.46)).toBe('−12,5 %');
    expect(formatSignedPercentFr(0.04)).toBe('0,0 %');
    expect(formatSignedPercentFr(-0.04)).toBe('0,0 %');
  });
  it('is « – » when unknown', () => {
    expect(formatSignedPercentFr(null)).toBe('–');
    expect(formatSignedPercentFr(Number.NaN)).toBe('–');
  });
});

describe('formatSolAmount', () => {
  it('uses up to 4 decimals under 0.01 SOL', () => {
    expect(formatSolAmount(0.0013)).toBe('0,0013');
    expect(formatSolAmount(0.00204)).toBe('0,002');
    expect(formatSolAmount(0.0002)).toBe('0,0002');
    expect(formatSolAmount(0.00999)).toBe('0,01');
  });
  it('uses up to 3 decimals from 0.01 SOL', () => {
    expect(formatSolAmount(0.01)).toBe('0,01');
    expect(formatSolAmount(0.01234)).toBe('0,012');
    expect(formatSolAmount(0.1256)).toBe('0,126');
    expect(formatSolAmount(1.5)).toBe('1,5');
  });
  it('shows « < 0,0001 » for dust, 0 for zero, « – » when unknown or negative', () => {
    expect(formatSolAmount(0.00004)).toBe('< 0,0001');
    expect(formatSolAmount(0)).toBe('0');
    expect(formatSolAmount(null)).toBe('–');
    expect(formatSolAmount(Number.NaN)).toBe('–');
    expect(formatSolAmount(-0.1)).toBe('–');
  });
});

describe('formatEur', () => {
  it('formats with 2 decimals and a French comma', () => {
    expect(formatEur(0.1944)).toBe('0,19 €');
    expect(formatEur(12)).toBe('12,00 €');
    expect(formatEur(0.001)).toBe('< 0,01 €');
    expect(formatEur(0)).toBe('0,00 €');
    expect(formatEur(null)).toBe('–');
  });
});

describe('formatSolEur', () => {
  it('adds the € equivalent in parentheses when the rate is known', () => {
    // 0.0013 SOL × 160 €/SOL = 0.208 €
    expect(formatSolEur(0.0013, 160)).toBe('0,0013 SOL (≈ 0,21 €)');
    expect(formatSolEur(0.125, 140)).toBe('0,125 SOL (≈ 17,50 €)');
  });
  it('omits the € part without a valid rate', () => {
    for (const rate of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatSolEur(0.0013, rate)).toBe('0,0013 SOL');
    }
  });
  it('is « – » when the amount is unknown', () => {
    expect(formatSolEur(null, 150)).toBe('–');
  });
});

describe('formatSignedSol', () => {
  it('signs SOL amounts with a true minus sign, French comma', () => {
    expect(formatSignedSol(0.05)).toBe('+0,05 SOL');
    expect(formatSignedSol(-0.0123)).toBe('−0,012 SOL');
    expect(formatSignedSol(-0.0013)).toBe('−0,0013 SOL');
    expect(formatSignedSol(0)).toBe('0 SOL');
    expect(formatSignedSol(null)).toBe('–');
    expect(formatSignedSol(Number.NaN)).toBe('–');
  });
});
