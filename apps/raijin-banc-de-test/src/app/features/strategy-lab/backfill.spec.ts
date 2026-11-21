import { describe, expect, it } from 'vitest';
import { backfillSummaryText, categoryId, categoryText, donePercent, formatEta, parseBackfillProgress } from './backfill';

const rows = [
  { category: 'scan_labels', done: 1000, total: 1392, due_now: 392, last_24h: 300, rows_per_hour: 12 },
  { category: 'radar_labels', done: 5000, total: 6392, due_now: 1392, last_24h: 400, rows_per_hour: 18 },
  { category: 'preset_labels', done: 40, total: 40, due_now: 0, last_24h: 10 },
  { category: 'candles_1m', done: '12', total: '20', due_now: 8, last_24h: null },
  { category: 'unknown_queue', done: 1, total: 2, due_now: 1, last_24h: 1 },
];

describe('backfill progress parsing', () => {
  it('maps the category spellings of the server to the contract categories', () => {
    expect(categoryId('scan_labels')).toBe('scan_labels');
    // Radar removed: its labels queue is ignored.
    expect(categoryId('labels_radar')).toBeNull();
    expect(categoryId('radar_labels')).toBeNull();
    expect(categoryId('early_outcomes')).toBeNull();
    expect(categoryId('preset_signals_labels')).toBe('preset_labels');
    expect(categoryId('event_candles')).toBe('event_candles');
    expect(categoryId('candles_1m_lt48h')).toBe('candles_1m');
    expect(categoryId('candles_5m')).toBe('candles_5m');
    expect(categoryId('other')).toBeNull();
    expect(categoryId(3)).toBeNull();
  });

  it('parses a row set: contract order, unknown and radar categories dropped, throughput summed, ETA = due / throughput', () => {
    const p = parseBackfillProgress(rows);
    expect(p?.categories.map((c) => c.id)).toEqual(['preset_labels', 'scan_labels', 'candles_1m']);
    expect(p?.categories[2]).toEqual({ id: 'candles_1m', label: 'Bougies 1 min (< 48 h)', done: 12, total: 20, dueNow: 8, last24h: null, priority: null });
    expect(p?.rowsPerHour).toBe(12);
    expect(p?.dueNow).toBe(392 + 8);
    expect(p?.etaHours).toBeCloseTo((392 + 8) / 12);
    expect(p?.etaAt).toBeNull();
  });

  it('parses an object with top-level throughput and ETA (also wrapped in a one-element array)', () => {
    const obj = { categories: [rows[0], rows[2]], rows_per_hour: 25, eta_hours: 70, eta_at: '2026-11-22T20:00:00Z' };
    for (const data of [obj, [obj]]) {
      const p = parseBackfillProgress(data);
      expect(p).toMatchObject({ rowsPerHour: 25, etaHours: 70, etaAt: '2026-11-22T20:00:00Z' });
      expect(p?.categories).toHaveLength(2);
    }
  });

  it('orders the categories by the backend priority when sent (others after, in contract order)', () => {
    const p = parseBackfillProgress([
      { category: 'preset_labels', done: 1, total: 2, due_now: 1, priority: 3 },
      { category: 'candles_1m', done: 1, total: 2, due_now: 1, priority: '1' },
      { category: 'candles_5m', done: 1, total: 2, due_now: 1 },
      { category: 'scan_labels', done: 1, total: 2, due_now: 1, priority: 2 },
      { category: 'event_candles', done: 1, total: 2, due_now: 1 },
    ]);
    expect(p?.categories.map((c) => [c.id, c.priority])).toEqual([
      ['candles_1m', 1],
      ['scan_labels', 2],
      ['preset_labels', 3],
      ['event_candles', null],
      ['candles_5m', null],
    ]);
    const obj = parseBackfillProgress({ categories: [{ category: 'candles_5m', done: 0, total: 1, priority: 1 }, { category: 'preset_labels', done: 0, total: 1, priority: 2 }] });
    expect(obj?.categories.map((c) => c.id)).toEqual(['candles_5m', 'preset_labels']);
  });

  it('caps done at total, ETA 0 when nothing is due, unknown ETA without throughput, null when unusable', () => {
    const p = parseBackfillProgress([{ category: 'event_candles', done: 12, total: 10, due_now: 0, last_24h: 3 }]);
    expect(p?.categories[0].done).toBe(10);
    expect(p?.etaHours).toBe(0);
    expect(p?.rowsPerHour).toBeNull();
    expect(parseBackfillProgress([{ category: 'scan_labels', done: 1, total: 5, due_now: 4 }])?.etaHours).toBeNull();
    expect(parseBackfillProgress([{ category: 'scan_labels', done: 'x', total: 5 }])).toBeNull();
    expect(parseBackfillProgress(null)).toBeNull();
    expect(parseBackfillProgress([])).toBeNull();
    expect(parseBackfillProgress({ categories: 'no' })).toBeNull();
  });
});

describe('backfill formatting', () => {
  it('formats percentages, ETA and the category line in French', () => {
    expect(donePercent({ id: 'scan_labels', label: '', done: 1, total: 3, dueNow: null, last24h: null, priority: null })).toBe(33);
    expect(donePercent({ id: 'scan_labels', label: '', done: 0, total: 0, dueNow: null, last24h: null, priority: null })).toBe(100);
    expect([formatEta(null), formatEta(0.4), formatEta(13.6), formatEta(48), formatEta(51)]).toEqual(['inconnue', '< 1 h', '≈ 14 h', '≈ 2 j', '≈ 2 j 3 h']);
    expect(categoryText({ id: 'scan_labels', label: '', done: 1000, total: 1392, dueNow: 392, last24h: 300, priority: null }).replace(/\s/g, ' ')).toBe(
      '1 000 / 1 392 · 392 dues · 300 en 24 h'.replace(/\s/g, ' '),
    );
    expect(categoryText({ id: 'scan_labels', label: '', done: 1, total: 2, dueNow: 1, last24h: null, priority: null })).toBe('1 / 2 · 1 due');
  });

  it('summarises throughput and ETA, or says the catch-up is up to date', () => {
    const p = parseBackfillProgress(rows);
    expect(p).not.toBeNull();
    if (!p) return;
    const text = backfillSummaryText(p).replace(/\s/g, ' ');
    expect(text).toContain('lignes dues');
    expect(text).toContain('débit mesuré 12 lignes/h (6 h)');
    expect(text).toContain(`fin estimée ${formatEta(400 / 12)}`);
    expect(backfillSummaryText({ ...p, dueNow: 0, rowsPerHour: null })).toBe('Rattrapage à jour · débit inconnu.');
    expect(backfillSummaryText({ ...p, etaHours: null, etaAt: '2026-11-22T20:00:00Z' })).toContain('fin estimée vers le 22 nov.');
  });
});
