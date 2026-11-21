import { describe, expect, it } from 'vitest';
import { parseRun } from './backtest';
import { parseSummary, summaryView } from './lab-summary';
import { candidateSummary, runRow } from './lab-test-data';

const norm = (s: string) => s.replace(/\s/g, ' ');

describe('lab summary parsing', () => {
  it('parses a candidate summary', () => {
    const s = parseSummary(candidateSummary());
    expect(s).toMatchObject({ verdict: 'candidate', runAt: '2026-11-19T03:10:00Z', nDetections: 600, nEvents: 140 });
    expect(s?.candidate).toEqual({
      key: { preset: 'young_calm', exit: 'all_x2', slPct: 30, breakeven: false, timeExitH: null, delayMin: 2 },
      narrative: 'all',
      test: { trades: 42, avgNetPct: 12.5, ciLow: 2.1, ciHigh: 22.4 },
      train: { trades: 98, avgNetPct: 9.1 },
    });
  });

  it('rejects an absent summary or an unknown verdict; an unreadable candidate keeps the cleaned server text', () => {
    for (const v of [null, undefined, 'none', [], { verdict: 'maybe' }]) expect(parseSummary(v)).toBeNull();
    const s = parseSummary(candidateSummary({ candidate: { preset: 'young_calm' }, text: 'Stratégie‮ candidate\u0000 :  x' }));
    expect(s?.candidate).toBeNull();
    expect(s?.text).toBe('Stratégie candidate : x');
    expect(parseSummary({ verdict: 'candidate', text: 'a'.repeat(400) })?.text).toHaveLength(300);
  });

  it('ignores a summary whose candidate names a preset the lab no longer shows (removed or exploratory, even unreadable)', () => {
    const base = candidateSummary()['candidate'] as Record<string, unknown>;
    for (const preset of ['young_3h_explo', 'post_migration', 'momentum', 'all', 'ai_hype']) {
      expect(parseSummary(candidateSummary({ candidate: { ...base, preset } }))).toBeNull();
    }
    expect(parseSummary(candidateSummary({ candidate: { preset: 'momentum_explo' } }))).toBeNull();
    expect(parseSummary(candidateSummary())?.verdict).toBe('candidate');
  });
});

describe('lab summary banner copy', () => {
  it('says « Aucune stratégie robuste » with the date and the sample size', () => {
    const s = parseSummary({ verdict: 'none', run_at: '2026-11-19T03:10:00Z', n_detections: 600, n_events: 1 });
    expect(s).not.toBeNull();
    if (!s) return;
    const v = summaryView(s);
    expect(v).toMatchObject({ verdict: 'none', title: 'Aucune stratégie robuste', details: [] });
    expect(norm(v.meta)).toBe(norm('Backtest du 19 nov., 04:10 · 600 détections + 1 événement'));
  });

  it('names the candidate in French with test and training figures', () => {
    const s = parseSummary(candidateSummary({ candidate: { ...(candidateSummary()['candidate'] as object), narrative: 'other' } }));
    expect(s).not.toBeNull();
    if (!s) return;
    const v = summaryView(s);
    expect(v.title).toBe('Stratégie candidate : SL −30 % · entrée +2 min · Jeune calme (à la détection) · Hors GTA');
    expect(v.details.map(norm)).toEqual([
      norm('Test : 42 trades, gain moyen net +12,5 %, IC 95 % [+2,1 % ; +22,4 %]'),
      norm('Apprentissage : 98 trades, gain moyen net +9,1 %'),
    ]);
    expect(norm(v.meta)).toContain('600 détections + 140 événements');
  });

  it('falls back on the run for the date and sample, and on the server text for an unreadable candidate', () => {
    const run = parseRun(runRow({ data_version: { n_detections: 600, n_events: 30 } }));
    const s = parseSummary({ verdict: 'candidate', text: 'Stratégie candidate : X' });
    expect(s).not.toBeNull();
    if (!s) return;
    const v = summaryView(s, run);
    expect(v).toMatchObject({ title: 'Stratégie candidate', details: ['Stratégie candidate : X'] });
    expect(norm(v.meta)).toBe(norm('Backtest du 19 nov., 04:10 · 600 détections + 30 événements'));
    const legacy = summaryView({ ...s, verdict: 'none' }, parseRun(runRow()));
    expect(norm(legacy.meta)).toMatch(/600 détections$/);
  });
});
