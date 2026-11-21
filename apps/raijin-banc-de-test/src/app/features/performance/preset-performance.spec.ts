import { describe, expect, it } from 'vitest';
import {
  COMPARISON_PRESETS,
  COMPARISON_SEGMENTS,
  SEGMENT_LABEL,
  comparisonRows,
  comparisonView,
  isComparisonSegment,
  isPerfPreset,
  parsePresetRow,
  parsePresetRows,
  presetCardView,
} from './preset-performance';
import { presetRow } from './performance-test-data';

describe('preset performance (performance_by_preset)', () => {
  it('parses a valid row, numerics as text included', () => {
    expect(parsePresetRow(presetRow())).toEqual({
      preset: 'young_calm',
      segment: 'all',
      signals: 50,
      labelled: 40,
      x2_before_sl30: 12,
      sl30_before_x2: 20,
      sim_pnl_sol: 0.364,
      trades: 18,
      paper_pnl_sol: -0.042,
      paper_open: 3,
    });
    expect(parsePresetRow(presetRow({ signals: '50', labelled: '40' }))).toMatchObject({ signals: 50, labelled: 40 });
  });

  it('keeps a null P&L (no book / nothing labelled) and treats missing trade counts as 0', () => {
    const r = parsePresetRow(presetRow({ preset: 'young_frenzy', sim_pnl_sol: null, paper_pnl_sol: null, trades: null, paper_open: undefined }));
    expect(r).toMatchObject({ sim_pnl_sol: null, paper_pnl_sol: null, trades: 0, paper_open: 0 });
  });

  it('ignores the removed presets (momentum, young_strong, strict), unknown presets and the age segments', () => {
    for (const over of [
      { preset: 'momentum' },
      { preset: 'young_strong' },
      { preset: 'strict' },
      { preset: 'yolo' },
      { preset: 'scan' },
      { segment: 'radar' },
      { segment: 'age_lt_3h' },
      { segment: 'age_3_24h' },
      { segment: null },
    ]) {
      expect(parsePresetRow(presetRow(over))).toBeNull();
    }
    expect(isPerfPreset('young_frenzy')).toBe(true);
    expect(isPerfPreset('momentum')).toBe(false);
  });

  it('rejects malformed or inconsistent counts and non-numeric P&L', () => {
    for (const over of [
      { signals: -1 },
      { labelled: 1.5 },
      { labelled: null },
      { x2_before_sl30: 'abc' },
      { labelled: 60 },
      { x2_before_sl30: 25, sl30_before_x2: 20 },
      { trades: -2 },
      { paper_open: 'x' },
      { sim_pnl_sol: 'NaN' },
      { paper_pnl_sol: Infinity },
      { paper_pnl_sol: {} },
    ]) {
      expect(parsePresetRow(presetRow(over))).toBeNull();
    }
    for (const junk of [null, 'row', 42, []]) expect(parsePresetRow(junk)).toBeNull();
  });

  it('parses a list defensively: non-array → [], invalid rows dropped, first duplicate kept', () => {
    expect(parsePresetRows(null)).toEqual([]);
    expect(parsePresetRows({ preset: 'young_calm' })).toEqual([]);
    const rows = parsePresetRows([presetRow(), { junk: true }, presetRow({ signals: 99, labelled: 1, x2_before_sl30: 0, sl30_before_x2: 0 }), presetRow({ segment: 'gta' })]);
    expect(rows.map((r) => `${r.preset}:${r.segment}:${r.signals}`)).toEqual(['young_calm:all:50', 'young_calm:gta:50']);
  });

  it('builds a column for the selected segment: rates over labelled, large only from 30', () => {
    const rows = parsePresetRows([presetRow(), presetRow({ segment: 'gta', signals: 10, labelled: 8, x2_before_sl30: 2, sl30_before_x2: 4 })]);
    const all = presetCardView(rows, 'young_calm', 'all');
    expect(all).toMatchObject({ label: 'Calme', segment: 'all', n: 40, enough: true });
    expect(all.rates.map((r) => [r.key, r.hits, r.rate, r.tone])).toEqual([
      ['x2_before_sl30', 12, 0.3, 'bull'],
      ['sl30_before_x2', 20, 0.5, 'bear'],
    ]);
    const gta = presetCardView(rows, 'young_calm', 'gta');
    expect(gta).toMatchObject({ segment: 'gta', n: 8, enough: false });
    expect(gta.rates[0].rate).toBe(0.25);
    expect(presetCardView(rows, 'young_frenzy', 'all')).toMatchObject({ row: null, rates: [], n: 0 });
  });

  describe('« Calme vs Frénésie »', () => {
    const calm = (over: Record<string, unknown> = {}) => presetRow({ preset: 'young_calm', trades: 7, paper_pnl_sol: '0.2100', paper_open: 2, ...over });
    const frenzy = (over: Record<string, unknown> = {}) =>
      presetRow({ preset: 'young_frenzy', signals: 30, labelled: 25, x2_before_sl30: 6, sl30_before_x2: 15, trades: 4, paper_pnl_sol: '-0.0500', paper_open: 1, ...over });

    it('knows the two columns and the three segments (no age split)', () => {
      expect(COMPARISON_PRESETS.map((p) => [p.id, p.label])).toEqual([
        ['young_calm', 'Calme'],
        ['young_frenzy', 'Frénésie'],
      ]);
      expect(COMPARISON_SEGMENTS.map((s) => SEGMENT_LABEL[s])).toEqual(['Tous', 'GTA', 'Hors GTA']);
      const rows = parsePresetRows([calm(), frenzy(), calm({ segment: 'age_lt_3h' }), frenzy({ segment: 'gta' })]);
      expect(rows.map((r) => `${r.preset}:${r.segment}`)).toEqual(['young_calm:all', 'young_frenzy:all', 'young_frenzy:gta']);
    });

    it('builds both columns for one shared segment (Tous / GTA / Hors GTA, unknown → Tous)', () => {
      const rows = parsePresetRows([calm(), frenzy(), frenzy({ segment: 'gta' })]);
      const all = comparisonView(rows, 'all');
      expect(all.segments.map((s) => s.label)).toEqual(['Tous', 'GTA', 'Hors GTA']);
      expect(all.columns.map((c) => [c.preset, c.label, c.n, c.enough])).toEqual([
        ['young_calm', 'Calme', 40, true],
        ['young_frenzy', 'Frénésie', 25, false],
      ]);
      expect(all.hasData).toBe(true);
      const gta = comparisonView(rows, 'gta');
      expect(gta.columns.map((c) => c.row !== null)).toEqual([false, true]);
      expect(comparisonView(rows, 'age_lt_3h' as never).segment).toBe('all');
      expect(comparisonView([], 'other').hasData).toBe(false);
      expect(isComparisonSegment('age_3_24h')).toBe(false);
    });

    it('formats the table: rates large and coloured only from 30 labelled, « hits / n » otherwise, « — » for a missing column', () => {
      const rows = parsePresetRows([calm(), frenzy(), frenzy({ segment: 'gta', paper_pnl_sol: null })]);
      const table = comparisonRows(comparisonView(rows, 'all'));
      expect(table.map((r) => r.key)).toEqual(['labelled', 'x2_before_sl30', 'sl30_before_x2', 'trades', 'paper_pnl', 'paper_open']);
      const byKey = (k: string) => table.find((r) => r.key === k)?.cells ?? [];
      expect(byKey('labelled').map((c) => [c.text, c.sub])).toEqual([
        ['40', 'sur 50'],
        ['25', 'sur 30'],
      ]);
      expect(byKey('x2_before_sl30')).toEqual([
        { text: '30,0 %', sub: '12 / 40', muted: false, tone: 'bull' },
        { text: '6 / 25', sub: '24,0 %', muted: true, tone: null },
      ]);
      expect(byKey('sl30_before_x2')[0]).toMatchObject({ text: '50,0 %', tone: 'bear' });
      expect(byKey('trades').map((c) => c.text)).toEqual(['7', '4']);
      expect(byKey('paper_pnl').map((c) => c.text)).toEqual(['+0,21 SOL', '−0,05 SOL']);
      expect(byKey('paper_open').map((c) => c.text)).toEqual(['2', '1']);

      const gta = comparisonRows(comparisonView(rows, 'gta'));
      expect(gta.every((r) => r.cells[0].text === '—' && r.cells[0].muted)).toBe(true);
      expect(gta.find((r) => r.key === 'paper_pnl')?.cells[1].text).toBe('Aucun portefeuille');
    });
  });
});
