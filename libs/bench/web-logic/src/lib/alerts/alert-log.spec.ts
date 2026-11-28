import { describe, expect, it } from 'vitest';
import { ALERT_LOG_COLUMNS, ALERT_LOG_LIMIT, ALERT_TOKEN_COLUMNS, formatAlertTime, isAlertLogRow, mergeAlerts, parseAlertLogRow, parseAlertLogRows, toFiniteNumber, uniqueMints } from './alert-log';

const A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

describe('alert log', () => {
  it('validates rows (mint, date, kind)', () => {
    expect(isAlertLogRow({ id: 1, mint: A, sent_at: '2026-11-16T10:00:00Z', kind: 'single' })).toBe(true);
    expect(isAlertLogRow({ id: 1, mint: 'javascript:alert(1)', sent_at: '2026-11-16T10:00:00Z', kind: 'single' })).toBe(false);
    expect(isAlertLogRow({ id: 1, mint: A, sent_at: 'nope', kind: 'single' })).toBe(false);
    expect(isAlertLogRow({ id: 1, mint: A, sent_at: '2026-11-16T10:00:00Z', kind: 'other' })).toBe(false);
    expect(isAlertLogRow(null)).toBe(false);
  });

  it('joins tokens client-side, newest first, and keeps unknown tokens', () => {
    const rows = [
      { id: 1, mint: A, sent_at: '2026-11-16T08:00:00Z', kind: 'single' },
      { id: 2, mint: B, sent_at: '2026-11-16T09:00:00Z', kind: 'grouped' },
      { id: 3, mint: 'bad', sent_at: '2026-11-16T10:00:00Z', kind: 'single' },
    ];
    const items = mergeAlerts(rows, [{ mint: A, symbol: '<b>AAA</b>', score: 81.6 }, { mint: 'x', symbol: 'X', score: 1 }]);
    expect(items.map((i) => i.id)).toEqual([2, 1]);
    expect(items[0]).toMatchObject({ mint: B, symbol: null, kind: 'grouped' });
    expect(items[1]).toMatchObject({ mint: A, symbol: '<b>AAA</b>' });
    // The token's CURRENT score is never carried onto an alert.
    expect(items.every((i) => !('score' in i))).toBe(true);
  });

  it('selects only the token symbol, not its current score', () => {
    expect(ALERT_TOKEN_COLUMNS).toBe('mint,symbol');
  });

  it('caps the list at 50', () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ id: i, mint: A, sent_at: new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString(), kind: 'single' }));
    const items = mergeAlerts(rows, []);
    expect(items).toHaveLength(ALERT_LOG_LIMIT);
    expect(items[0]!.id).toBe(79);
  });

  it('lists distinct mints', () => {
    expect(
      uniqueMints([
        { id: 1, mint: A, sent_at: '', kind: 'single' },
        { id: 2, mint: A, sent_at: '', kind: 'grouped' },
        { id: 3, mint: B, sent_at: '', kind: 'single' },
      ]),
    ).toEqual([A, B]);
  });

  it('formats the time (today vs earlier)', () => {
    const now = Date.parse('2026-11-16T15:00:00Z');
    expect(formatAlertTime('2026-11-16T14:05:00Z', now, 'UTC')).toBe('14:05');
    expect(formatAlertTime('2026-11-15T09:30:00Z', now, 'UTC')).toBe('15/11 09:30');
    expect(formatAlertTime('nope', now, 'UTC')).toBe('–');
  });
});

describe('alert log parser (follow-up columns)', () => {
  const base = { id: 7, mint: A, sent_at: '2026-11-16T10:00:00Z', kind: 'single' };

  it('selects every follow-up column, none of the archived score / Fibonacci ones', () => {
    for (const c of ['entry_price', 'target_price', 'stop_price', 'entry_roundtrip_pct', 'stake_sol', 'max_price', 'min_price', 'last_price', 'last_price_at', 'first_hit', 'first_hit_at', 'followup_sent_at', 'tracking_until']) {
      expect(ALERT_LOG_COLUMNS.split(',')).toContain(c);
    }
    for (const c of ['rr', 'entry_score', 'entry_zone']) expect(ALERT_LOG_COLUMNS.split(',')).not.toContain(c);
  });

  it('fills missing columns with null (rows from before the migration)', () => {
    expect(parseAlertLogRow(base)).toEqual({
      ...base,
      entry_price: null,
      target_price: null,
      stop_price: null,
      entry_roundtrip_pct: null,
      stake_sol: null,
      max_price: null,
      min_price: null,
      last_price: null,
      last_price_at: null,
      first_hit: null,
      first_hit_at: null,
      followup_sent_at: null,
      tracking_until: null,
    });
  });

  it('accepts numbers and numeric strings (Postgres numeric)', () => {
    const r = parseAlertLogRow({
      ...base,
      entry_price: '0.00012',
      target_price: 0.000144,
      stop_price: '0.000096',
      entry_roundtrip_pct: '2.4',
      stake_sol: '0.25',
      max_price: '0.00015',
      min_price: 0.0001,
      last_price: '0.00013',
      last_price_at: '2026-11-16T11:58:00Z',
      first_hit: 'target',
      first_hit_at: '2026-11-16T10:40:00Z',
      followup_sent_at: '2026-11-16T10:41:00Z',
      tracking_until: '2026-11-17T10:00:00Z',
    });
    expect(r).toMatchObject({
      entry_price: 0.00012,
      target_price: 0.000144,
      stop_price: 0.000096,
      entry_roundtrip_pct: 2.4,
      stake_sol: 0.25,
      max_price: 0.00015,
      min_price: 0.0001,
      last_price: 0.00013,
      last_price_at: '2026-11-16T11:58:00Z',
      first_hit: 'target',
      first_hit_at: '2026-11-16T10:40:00Z',
      followup_sent_at: '2026-11-16T10:41:00Z',
      tracking_until: '2026-11-17T10:00:00Z',
    });
  });

  it('nulls malformed values instead of rejecting the row', () => {
    const r = parseAlertLogRow({
      ...base,
      entry_price: 'abc',
      target_price: 0,
      stop_price: -1,
      entry_roundtrip_pct: -3,
      stake_sol: 1000,
      max_price: '',
      last_price: Number.POSITIVE_INFINITY,
      last_price_at: 'yesterday',
      first_hit: 'moon',
      tracking_until: 42,
    });
    expect(r).toMatchObject({
      entry_price: null,
      target_price: null,
      stop_price: null,
      entry_roundtrip_pct: null,
      stake_sol: null,
      max_price: null,
      last_price: null,
      last_price_at: null,
      first_hit: null,
      tracking_until: null,
    });
    expect(parseAlertLogRow({ ...base, first_hit: 'stop' })?.first_hit).toBe('stop');
    expect(parseAlertLogRow({ ...base, entry_roundtrip_pct: 0 })?.entry_roundtrip_pct).toBe(0);
  });

  it('rejects rows that cannot be listed and sorts the rest newest first', () => {
    expect(parseAlertLogRow({ ...base, mint: 'bad' })).toBeNull();
    expect(parseAlertLogRow('nope')).toBeNull();
    const rows = parseAlertLogRows([{ ...base, id: 1 }, { ...base, id: 2, sent_at: '2026-11-16T12:00:00Z' }, null]);
    expect(rows.map((r) => r.id)).toEqual([2, 1]);
  });

  it('converts numeric text strictly', () => {
    expect(toFiniteNumber('1.5')).toBe(1.5);
    expect(toFiniteNumber(' ')).toBeNull();
    expect(toFiniteNumber('1,5')).toBeNull();
    expect(toFiniteNumber(null)).toBeNull();
    expect(toFiniteNumber(true)).toBeNull();
  });
});
