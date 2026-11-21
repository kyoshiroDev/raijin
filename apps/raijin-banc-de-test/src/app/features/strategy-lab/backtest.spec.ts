import { describe, expect, it } from 'vitest';
import {
  LAB_MSG,
  LEGACY_RUN_COLUMNS,
  RUN_COLUMNS,
  fraction,
  isActiveRun,
  isMissingColumnError,
  isMissingRelationError,
  narrativeCounts,
  parseDataVersion,
  parseResultRow,
  parseResultRows,
  parseRun,
  rankVariants,
  requestErrorMessage,
  variantName,
} from './backtest';
import { formatCi, formatDrawdown, formatProfitFactor, formatShare, metricLines, resolutionText } from './lab-format';
import { resultRow, runRow, variantRows } from './lab-test-data';

describe('backtest run parsing', () => {
  it('parses a run, its counts and its data_version (counts → shares of the detections)', () => {
    const run = parseRun([runRow()]);
    expect(run).toMatchObject({ id: '7', status: 'done', trigger: 'nightly', nDetections: 600, nVariants: 1920, nDistinctVariants: 1440, progress: 1 });
    expect(run?.data).toEqual({
      detections: 600,
      cutoff: '2026-11-10T00:00:00Z',
      maxDetectedAt: '2026-11-18T22:00:00Z',
      share1m: 0.2,
      share5m: 0.5,
      share15mOnly: 280 / 600,
      shareNone: null,
      events: null,
      pendingCandles: null,
    });
    expect(run?.summaryRaw).toBeNull();
    expect(isActiveRun(run)).toBe(false);
    expect(isActiveRun(parseRun(runRow({ status: 'running' })))).toBe(true);
    expect(isActiveRun(null)).toBe(false);
  });

  it('accepts fraction shares and alternate data_version keys; missing data reads as unknown', () => {
    expect(parseDataVersion({ detections: 10, split_cutoff: '2026-11-01T00:00:00Z', with_1m: 0.3, with_5m: 0.6, only_15m: 0.1 })).toMatchObject({
      detections: 10,
      cutoff: '2026-11-01T00:00:00Z',
      share1m: 0.3,
      share5m: 0.6,
      share15mOnly: 0.1,
    });
    expect(parseDataVersion(null, 5)).toEqual({
      detections: 5,
      cutoff: null,
      maxDetectedAt: null,
      share1m: null,
      share5m: null,
      share15mOnly: null,
      shareNone: null,
      events: null,
      pendingCandles: null,
    });
    // Shape written by the backtest-run worker (counts by finest timeframe, cutoff_at).
    expect(parseDataVersion({ n_detections: 50, resolutions: { '1m': 10, '5m': 20, '15m': 15, none: 5 }, cutoff_at: '2026-11-12T08:00:00.123456+00:00' })).toMatchObject({
      cutoff: '2026-11-12T08:00:00.123456+00:00',
      share1m: 0.2,
      share5m: 0.4,
      share15mOnly: 0.3,
      shareNone: 0.1,
    });
    expect(parseDataVersion({ cutoff: 'not a date', resolutions: { '1m': 'x' } }).cutoff).toBeNull();
  });

  it('reads the lab-v2 events and pending candles (count or per-preset counts) and keeps the raw summary', () => {
    expect(parseDataVersion({ n_detections: 50, n_events: 120, n_pending_candles: 7 })).toMatchObject({ detections: 50, events: 120, pendingCandles: 7 });
    expect(parseDataVersion({ events: '30', pending_candles: { momentum: 2, post_migration: 3, bad: 'x' } })).toMatchObject({ events: 30, pendingCandles: 5 });
    expect(parseDataVersion({ pending_candles: { a: 'x' } }).pendingCandles).toBeNull();
    // Shape written by the lab-v2 backtest worker (finalDataVersion).
    expect(parseDataVersion({ n_detections: 700, events: 90, events_pending: 10 })).toMatchObject({ events: 90, pendingCandles: 10 });
    expect(parseRun(runRow({ summary: { verdict: 'none' } }))?.summaryRaw).toEqual({ verdict: 'none' });
  });

  it('recognises an unreadable column (fallback to the legacy SELECT)', () => {
    for (const code of ['42703', '42501', 'PGRST204']) expect(isMissingColumnError({ code })).toBe(true);
    expect(isMissingColumnError({ code: 'PGRST205' })).toBe(false);
    expect(isMissingColumnError(null)).toBe(false);
    expect(RUN_COLUMNS).toBe(`${LEGACY_RUN_COLUMNS},summary`);
  });

  it('rejects a run without id, with an unknown status or no creation date; progress as fraction or percent', () => {
    for (const over of [{ id: null }, { status: 'paused' }, { created_at: 'yesterday' }]) expect(parseRun(runRow(over))).toBeNull();
    expect(parseRun(null)).toBeNull();
    expect(parseRun([])).toBeNull();
    expect(parseRun(runRow({ progress: 45 }))?.progress).toBe(0.45);
    expect(parseRun(runRow({ progress: 0.3 }))?.progress).toBe(0.3);
    expect(parseRun(runRow({ progress: 4000, trigger: 'cron' }))).toMatchObject({ progress: null, trigger: null });
    expect(fraction(-1)).toBeNull();
  });
});

describe('backtest result parsing', () => {
  it('parses a row (numerics as text, win rate fraction or percent, time exit 0 = none)', () => {
    const row = parseResultRow(resultRow({ win_rate: '45', time_exit_h: 0 }));
    expect(row?.key).toEqual({ preset: 'young_calm', exit: 'all_x2', slPct: 30, breakeven: false, timeExitH: null, delayMin: 2 });
    expect(row?.metrics).toMatchObject({ trades: 42, winRate: 0.45, avgNetPct: 12.5, profitFactor: 1.85, ciContainsZero: false, openAtEnd: 1 });
    expect(row).toMatchObject({ narrative: 'all', split: 'test', retained: true, robust: true });
  });

  it('drops rows with an unknown or removed preset / exit, an unknown narrative or split, or invalid parameters', () => {
    for (const over of [
      { preset: 'yolo' },
      { preset: 'momentum' },
      { preset: 'young_3h' },
      { preset: 'all' },
      { preset: 'post_migration' },
      { preset: 'momentum_explo' },
      { exit: 'all_x10' },
      { exit: 'half_x2_rest_x3' },
      { exit: 'thirds_x2_x3_x4' },
      { exit: 'all_x1_5' },
      { exploratory: true },
      { narrative: 'ai' },
      { split: 'validation' },
      { sl_pct: 0 },
      { sl_pct: 'abc' },
      { delay_min: -2 },
      { breakeven: 'maybe' },
      { trades: null },
      { time_exit_h: -1 },
    ]) {
      expect(parseResultRow(resultRow(over))).toBeNull();
    }
    expect(parseResultRows([resultRow(), null, 'x', resultRow({ preset: '<script>' })])).toHaveLength(1);
    expect(parseResultRows({})).toEqual([]);
  });
});

describe('variant names (French)', () => {
  const key = (over: Partial<Parameters<typeof variantName>[0]> = {}) =>
    ({ preset: 'young_calm', exit: 'all_x2', slPct: 30, breakeven: false, timeExitH: null, delayMin: 0, ...over }) as Parameters<typeof variantName>[0];

  it('names the SL and the entry delay (the exit is always « tout à ×2 »)', () => {
    expect(variantName(key({ slPct: 20 }))).toBe('SL −20 % · entrée immédiate · Jeune calme (à la détection)');
    expect(variantName(key({ slPct: 40, delayMin: 2, preset: 'young_frenzy_ev' }))).toBe('SL −40 % · entrée +2 min · Jeune frénésie (événement)');
  });

  it('names the four presets (detection and event modes) and parses them', () => {
    expect(variantName(key({ preset: 'young_calm' }))).toMatch(/· Jeune calme \(à la détection\)$/);
    expect(variantName(key({ preset: 'young_frenzy' }))).toMatch(/· Jeune frénésie \(à la détection\)$/);
    expect(variantName(key({ preset: 'young_calm_ev' }))).toMatch(/· Jeune calme \(événement\)$/);
    expect(variantName(key({ preset: 'young_frenzy_ev' }))).toMatch(/· Jeune frénésie \(événement\)$/);
    for (const preset of ['young_calm', 'young_frenzy', 'young_calm_ev', 'young_frenzy_ev']) {
      expect(parseResultRow(resultRow({ preset }))?.key.preset).toBe(preset);
    }
  });

  it('still names a breakeven or a time exit if a row ever has one (never misread)', () => {
    expect(variantName(key({ breakeven: true, timeExitH: 6 }))).toBe('SL −30 % · entrée immédiate · BE · sortie 6 h · Jeune calme (à la détection)');
  });
});

describe('variant ranking', () => {
  const rows = parseResultRows([
    ...variantRows(),
    ...variantRows({ sl_pct: 20, robust: false, ci_contains_zero: true, avg_net_pct: 20, avg_net_sol: 0.02 }),
    ...variantRows({ preset: 'young_frenzy', avg_net_pct: 3 }),
    ...variantRows({ narrative: 'gta', avg_net_pct: 40 }),
    ...variantRows({ preset: 'momentum', avg_net_pct: 80 }), // removed preset: ignored
    resultRow({ preset: 'young_calm_ev', retained: false, avg_net_pct: 99 }),
    resultRow({ sl_pct: 40, split: 'train' }),
  ]);

  it('keeps the retained variants of the narrative, train and test side by side, best test avg net first', () => {
    const ranked = rankVariants(rows, 'all');
    expect(ranked.map((v) => [v.key.slPct, v.key.preset, v.test?.avgNetPct ?? null])).toEqual([
      [20, 'young_calm', 20],
      [30, 'young_calm', 12.5],
      [30, 'young_frenzy', 3],
      [40, 'young_calm', null],
    ]);
    expect(ranked[1].train?.avgNetPct).toBe(9.1);
    expect(ranked[1].robust).toBe(true);
    expect(ranked[0].robust).toBe(false);
    expect(ranked[3].test).toBeNull();
    expect(new Set(ranked.map((v) => v.id)).size).toBe(4);
  });

  it('filters by narrative and counts retained / robust variants per narrative', () => {
    expect(rankVariants(rows, 'gta').map((v) => v.test?.avgNetPct)).toEqual([40]);
    expect(rankVariants(rows, 'other')).toEqual([]);
    expect(narrativeCounts(rows)).toEqual({ all: { retained: 4, robust: 3 }, gta: { retained: 1, robust: 1 }, other: { retained: 0, robust: 0 } });
  });
});

describe('laboratory errors', () => {
  it('recognises a missing table or function', () => {
    for (const code of ['PGRST205', '42P01', 'PGRST202', '42883']) expect(isMissingRelationError({ code })).toBe(true);
    expect(isMissingRelationError({ code: '42501' })).toBe(false);
    expect(isMissingRelationError(null)).toBe(false);
  });

  it('shows the French refusal raised by the RPC, a generic message otherwise', () => {
    expect(requestErrorMessage({ code: '23514', message: 'Un backtest est déjà en cours.' })).toBe('Un backtest est déjà en cours.');
    expect(requestErrorMessage({ code: 'P0001', message: 'Réessayez après 21:05.' })).toBe('Réessayez après 21:05.');
    expect(requestErrorMessage({ code: 'P0001', message: 'x'.repeat(300) })).toBe(LAB_MSG.requestFailed);
    expect(requestErrorMessage({ code: '42501', message: 'permission denied for table backtest_runs' })).toBe(LAB_MSG.requestFailed);
    expect(requestErrorMessage({ code: 'PGRST202' })).toBe(LAB_MSG.unavailable);
    expect(requestErrorMessage('boom')).toBe(LAB_MSG.requestFailed);
  });
});

describe('laboratory formatting', () => {
  it('formats shares, profit factor, interval and drawdown in French', () => {
    expect(formatShare(0.2)).toBe('20 %');
    expect(formatShare(null)).toBe('–');
    expect(formatProfitFactor(1.854)).toBe('1,85');
    expect(formatProfitFactor(null)).toBe('–');
    expect(formatCi(2.1, 22.4)).toBe('[+2,1 % ; +22,4 %]');
    expect(formatCi(-1, null)).toBe('–');
    expect(formatDrawdown(0.35)).toBe('−0,35 SOL');
    expect(formatDrawdown(0)).toBe('aucune');
  });

  it('builds the train vs test lines, colouring the signed test values', () => {
    const [v] = rankVariants(parseResultRows(variantRows()), 'all');
    const lines = metricLines(v.train, v.test);
    expect(lines.map((l) => l.key)).toEqual(['trades', 'win', 'net', 'sol', 'pf', 'dd', 'streak']);
    const by = Object.fromEntries(lines.map((l) => [l.key, l]));
    expect([by['trades'].train, by['trades'].test]).toEqual(['98', '42']);
    expect(by['win'].test).toBe('45,0 %');
    expect([by['net'].train, by['net'].test, by['net'].testSign]).toEqual(['+9,1 %', '+12,5 %', 1]);
    expect(by['sol'].test).toBe('+0,013 SOL');
    expect(by['streak'].test).toBe('5 trades');
    expect(metricLines(null, null).every((l) => l.train === '–' && l.test === '–')).toBe(true);
    const test = v.test;
    if (!test) throw new Error('test metrics expected');
    const noLoss = metricLines(null, { ...test, profitFactor: null, avgLossPct: null });
    expect(noLoss.find((l) => l.key === 'pf')?.test).toBe('∞ (aucune perte)');
    expect(
      resolutionText({ detections: 10, cutoff: null, maxDetectedAt: null, share1m: 0.2, share5m: 0.4, share15mOnly: 0.3, shareNone: 0.1, events: null, pendingCandles: null }),
    ).toBe('Résolution la plus fine des bougies : 1 min pour 20 % des détections, 5 min pour 40 %, 15 min seulement pour 30 %, aucune bougie pour 10 %.');
  });
});
