import { describe, expect, it } from 'vitest';
import type { AlertLogRow } from './alert-log';
import { ALERT_STATUS, alertCells, alertOutcomeLine, alertPlan, alertStatus, formatMultiple, priceAge } from './alert-view';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const row = (over: Partial<AlertLogRow> = {}): AlertLogRow => ({
  id: 1,
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  sent_at: '2026-11-17T10:00:00Z',
  kind: 'single',
  entry_price: 2,
  target_price: 2.4,
  stop_price: 1.6,
  entry_roundtrip_pct: 2,
  stake_sol: 0.1,
  max_price: 2.2,
  min_price: 1.9,
  last_price: 2.1,
  last_price_at: '2026-11-17T11:57:00Z',
  first_hit: null,
  first_hit_at: null,
  followup_sent_at: null,
  tracking_until: '2026-11-18T10:00:00Z',
  ...over,
});

describe('alertStatus (follow-up badge)', () => {
  it('reports the first hit, even after the end of tracking', () => {
    expect(alertStatus(row({ first_hit: 'target' }), NOW)).toBe('target');
    expect(alertStatus(row({ first_hit: 'stop', tracking_until: '2026-11-10T00:00:00Z' }), NOW)).toBe('stop');
  });

  it('is « En cours » until tracking_until, then « Suivi terminé »', () => {
    expect(alertStatus(row(), NOW)).toBe('open');
    expect(alertStatus(row({ tracking_until: null }), NOW)).toBe('open');
    expect(alertStatus(row({ tracking_until: new Date(NOW).toISOString() }), NOW)).toBe('open');
    expect(alertStatus(row({ tracking_until: new Date(NOW - 1).toISOString() }), NOW)).toBe('ended');
  });

  it('has a text label for every status (not colour-only)', () => {
    expect(ALERT_STATUS.target.label).toBe('Objectif touché');
    expect(ALERT_STATUS.stop.label).toBe('Stop touché');
    expect(ALERT_STATUS.open.label).toBe('En cours');
    expect(ALERT_STATUS.ended.label).toBe('Suivi terminé');
    expect(ALERT_STATUS.target.className).toContain('text-bull');
    expect(ALERT_STATUS.stop.className).toContain('text-bear');
  });

  it('keeps « En cours » and « Suivi terminé » grey (no outcome yet)', () => {
    expect(ALERT_STATUS.open.className).toContain('text-muted');
    expect(ALERT_STATUS.ended.className).toContain('text-muted');
    expect(ALERT_STATUS.open.icon).toBe('clock');
  });
});

describe('alertCells', () => {
  it('shows prices with the % from entry and the age of the current price', () => {
    expect(alertCells(row(), NOW)).toEqual([
      { label: 'Prix à l’alerte', value: '$2.000', sub: null, tone: null },
      { label: 'Plus haut', value: '$2.200', sub: '+10,0 %', tone: null },
      { label: 'Plus bas', value: '$1.900', sub: '−5,0 %', tone: null },
      { label: 'Prix actuel', value: '$2.100', sub: '+5,0 % · il y a 3 min', tone: null },
      { label: 'Objectif', value: '$2.400', sub: '+20,0 %', tone: 'bull' },
      { label: 'Stop', value: '$1.600', sub: '−20,0 %', tone: 'bear' },
    ]);
  });

  it('shows « – » for unknown prices and derives a missing target/stop from the ×2 / ×0.7 plan', () => {
    const cells = alertCells(row({ max_price: null, min_price: null, last_price: null, last_price_at: null, target_price: null, stop_price: null }), NOW);
    expect(cells[1]).toEqual({ label: 'Plus haut', value: '–', sub: null, tone: null });
    expect(cells[3]).toEqual({ label: 'Prix actuel', value: '–', sub: null, tone: null });
    expect(cells[4]!.sub).toBe('+100,0 %');
    expect(cells[5]!.sub).toBe('−30,0 %');
  });

  it('alertPlan: stored columns first, ×2 / ×0.7 for a missing one, null without an entry price', () => {
    expect(alertPlan({ entry_price: 2, target_price: 2.4, stop_price: 1.6 })).toEqual({ target: 2.4, stop: 1.6 });
    expect(alertPlan({ entry_price: 2, target_price: null, stop_price: null })).toEqual({ target: 4, stop: 1.4 });
    expect(alertPlan({ entry_price: null, target_price: 2.4, stop_price: 1.6 })).toBeNull();
  });

  it('formats the price age', () => {
    expect(priceAge('2026-11-17T11:59:30Z', NOW)).toBe('à l’instant');
    expect(priceAge(null, NOW)).toBeNull();
    expect(priceAge('nope', NOW)).toBeNull();
  });
});

describe('alert outcome line', () => {
  it('formats multiples with 2 decimals in French, null when a price is unknown', () => {
    expect(formatMultiple(2.2, 2)).toBe('×1,10');
    expect(formatMultiple(1, 2)).toBe('×0,50');
    expect(formatMultiple(6.3, 2)).toBe('×3,15');
    expect(formatMultiple(null, 2)).toBeNull();
    expect(formatMultiple(2, null)).toBeNull();
  });

  it('reads « entry → plus haut max (×) → actuel last (×) » from the alert columns', () => {
    expect(alertOutcomeLine(row())).toBe('$2.000 → plus haut $2.200 (×1,10) → actuel $2.100 (×1,05)');
    expect(alertOutcomeLine(row({ last_price: 1.5 }))).toBe('$2.000 → plus haut $2.200 (×1,10) → actuel $1.500 (×0,75)');
  });

  it('shows « – » without a multiple for unknown prices, and nothing for a legacy row', () => {
    expect(alertOutcomeLine(row({ max_price: null, last_price: null }))).toBe('$2.000 → plus haut – → actuel –');
    expect(alertOutcomeLine(row({ entry_price: null }))).toBeNull();
  });
});
