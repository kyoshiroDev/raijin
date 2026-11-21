import { describe, expect, it } from 'vitest';
import {
  MAX_DANGERS,
  MAX_DANGER_LENGTH,
  MAX_NARRATIVE_LENGTH,
  MAX_SPARK_POINTS,
  TOKEN_COLUMNS,
  cleanDanger,
  isTokenRow,
  parseSpark,
  parseTokenRow,
  toOptionalBoolean,
  toOptionalNumber,
} from './token';

const base = { mint: 'So11111111111111111111111111111111111111112', symbol: 'AAA', flags: [] };

describe('TOKEN_COLUMNS (cross-source enrichment)', () => {
  it('selects every new column', () => {
    const cols = TOKEN_COLUMNS.split(',');
    for (const c of [
      'liquidity_dex_usd', 'liquidity_jup_usd', 'liquidity_gecko_usd', 'liquidity_effective_usd', 'liquidity_divergence',
      'roundtrip_cost_pct', 'roundtrip_fee_pct', 'buy_impact_pct', 'lp_locked_pct', 'rugcheck_score', 'rugcheck_dangers',
      'price_jup_usd', 'price_gecko_usd', 'data_confidence', 'quote_at', 'rugcheck_at', 'enriched_at',
    ]) {
      expect(cols).toContain(c);
    }
    expect(new Set(cols).size).toBe(cols.length);
  });
});

describe('toOptionalNumber', () => {
  it('maps null/absent to null, keeps finite numbers, converts numeric strings', () => {
    expect(toOptionalNumber(null)).toBeNull();
    expect(toOptionalNumber(undefined)).toBeNull();
    expect(toOptionalNumber(12.5)).toBe(12.5);
    expect(toOptionalNumber('12.5')).toBe(12.5);
    expect(toOptionalNumber(' 0.35 ')).toBe(0.35);
    expect(toOptionalNumber('1e3')).toBe(1000);
    expect(toOptionalNumber('-2')).toBe(-2);
  });
  it('flags junk as invalid (undefined)', () => {
    for (const bad of ['', ' ', 'abc', '12abc', '0x10', 'NaN', 'Infinity', Number.NaN, Number.POSITIVE_INFINITY, true, {}, []]) {
      expect(toOptionalNumber(bad)).toBeUndefined();
    }
  });
});

describe('parseTokenRow', () => {
  it('fills absent enrichment columns with null / [] (rows written before the migration)', () => {
    const row = parseTokenRow(base);
    expect(row).not.toBeNull();
    expect(row?.liquidity_effective_usd).toBeNull();
    expect(row?.roundtrip_cost_pct).toBeNull();
    expect(row?.data_confidence).toBeNull();
    expect(row?.enriched_at).toBeNull();
    expect(row?.rugcheck_dangers).toEqual([]);
  });

  it('keeps finite numbers and converts numeric strings (Realtime may send numeric as text)', () => {
    const row = parseTokenRow({
      ...base,
      liquidity_jup_usd: '6850',
      liquidity_gecko_usd: 7_100,
      liquidity_effective_usd: '6850.5',
      liquidity_divergence: '0.62',
      roundtrip_cost_pct: '2.4',
      roundtrip_fee_pct: 0.5,
      lp_locked_pct: '100',
      data_confidence: 'medium',
      enriched_at: '2026-11-16T12:00:00Z',
    });
    expect(row?.liquidity_jup_usd).toBe(6850);
    expect(row?.liquidity_gecko_usd).toBe(7100);
    expect(row?.liquidity_effective_usd).toBe(6850.5);
    expect(row?.liquidity_divergence).toBe(0.62);
    expect(row?.roundtrip_cost_pct).toBe(2.4);
    expect(row?.lp_locked_pct).toBe(100);
    expect(row?.data_confidence).toBe('medium');
    expect(row?.enriched_at).toBe('2026-11-16T12:00:00Z');
  });

  it('rejects non-numeric values, unknown confidence levels and malformed dangers', () => {
    expect(parseTokenRow({ ...base, roundtrip_cost_pct: 'abc' })).toBeNull();
    expect(parseTokenRow({ ...base, liquidity_effective_usd: Number.NaN })).toBeNull();
    expect(parseTokenRow({ ...base, liquidity_divergence: {} })).toBeNull();
    expect(parseTokenRow({ ...base, data_confidence: 'certain' })).toBeNull();
    expect(parseTokenRow({ ...base, rugcheck_dangers: 'Mutable metadata' })).toBeNull();
    expect(parseTokenRow({ ...base, rugcheck_dangers: ['ok', 42] })).toBeNull();
    expect(parseTokenRow({ ...base, enriched_at: 12 })).toBeNull();
    expect(parseTokenRow({ ...base, mint: 'not-a-mint' })).toBeNull();
    expect(parseTokenRow(null)).toBeNull();
  });

  it('treats RugCheck dangers as hostile text: strips control/bidi chars, caps length and count', () => {
    const long = 'x'.repeat(200);
    const row = parseTokenRow({
      ...base,
      rugcheck_dangers: [
        '<img src=x onerror=alert(1)>',
        'Low\u202eLP\u2066 locked\u0000\n',
        long,
        '   ',
        'Mutable metadata',
        'Mutable metadata',
        'Freeze authority',
        'Sixth',
        'Seventh',
      ],
    });
    const dangers = row?.rugcheck_dangers ?? [];
    expect(dangers).toHaveLength(MAX_DANGERS);
    expect(dangers[0]).toBe('<img src=x onerror=alert(1)>'); // kept as text, rendered by interpolation only
    expect(dangers[1]).toBe('LowLP locked');
    expect(Array.from(dangers[2])).toHaveLength(MAX_DANGER_LENGTH);
    expect(dangers[2].endsWith('…')).toBe(true);
    expect(dangers).toEqual(['<img src=x onerror=alert(1)>', 'LowLP locked', dangers[2], 'Mutable metadata', 'Freeze authority']);
    const unsafe = (c: number) => c < 0x20 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    for (const d of dangers) expect(Array.from(d).some((ch) => unsafe(ch.charCodeAt(0)))).toBe(false);
  });

  it('cleanDanger strips U+061C (Arabic letter mark) and U+FFF9–U+FFFB (interlinear annotation controls)', () => {
    expect(cleanDanger('Fr\u061Ceeze')).toBe('Freeze');
    expect(cleanDanger('\uFFF9Mint\uFFFA auth\uFFFB')).toBe('Mint auth');
    // Visible neighbours are kept.
    expect(cleanDanger('a\u061Bb\uFFFCc')).toBe('a\u061Bb\uFFFCc');
  });
  it('cleanDanger caps at 40 characters', () => {
    expect(MAX_DANGER_LENGTH).toBe(40);
    expect(cleanDanger('a'.repeat(40))).toBe('a'.repeat(40));
    expect(cleanDanger('a'.repeat(41))).toBe(`${'a'.repeat(39)}…`);
  });
});

describe('isTokenRow (strict guard on new columns)', () => {
  it('accepts null/absent or finite numbers, known confidence levels, string dangers', () => {
    expect(isTokenRow(base)).toBe(true);
    expect(isTokenRow({ ...base, roundtrip_cost_pct: 2.4, data_confidence: 'high', rugcheck_dangers: ['a'] })).toBe(true);
    expect(isTokenRow({ ...base, data_confidence: null, liquidity_gecko_usd: null })).toBe(true);
  });
  it('rejects strings for numeric columns (use parseTokenRow to convert them)', () => {
    expect(isTokenRow({ ...base, roundtrip_cost_pct: '2.4' })).toBe(false);
    expect(isTokenRow({ ...base, data_confidence: 'HIGH' })).toBe(false);
  });
});

describe('parseTokenRow — narrative and RugCheck history columns', () => {
  it('selects the narrative / RugCheck columns and none of the archived ones (score, Fibonacci, ×3 model)', () => {
    const cols = TOKEN_COLUMNS.split(',');
    for (const c of ['narrative', 'narrative_rank', 'insiders_detected', 'creator_rug_history']) expect(cols).toContain(c);
    for (const c of [
      'score', 'zone_status', 'zone_source', 'zone_low', 'zone_high', 'invalidation', 'tp1', 'tp2',
      'p_x3', 'p_dd50', 'rr', 'model_version', 'model_calibrated',
    ]) {
      expect(cols).not.toContain(c);
    }
    expect(new Set(cols).size).toBe(cols.length);
  });

  it('accepts a row without score (archived column, no longer written) or with a null one', () => {
    expect(parseTokenRow(base)).not.toBeNull();
    expect(parseTokenRow({ ...base, score: null })).not.toBeNull();
    expect(isTokenRow(base)).toBe(true);
  });

  it('defaults absent columns to null (rows written before the migration)', () => {
    expect(parseTokenRow(base)).toMatchObject({ narrative: null, narrative_rank: null, insiders_detected: null, creator_rug_history: null });
  });

  it('accepts numeric strings for the rank and booleans', () => {
    const row = parseTokenRow({ ...base, narrative_rank: '2', insiders_detected: false, creator_rug_history: true });
    expect(row).toMatchObject({ narrative_rank: 2, insiders_detected: false, creator_rug_history: true });
  });

  it('never rejects a token for junk display values: they become null', () => {
    const row = parseTokenRow({ ...base, narrative_rank: 0, insiders_detected: {}, creator_rug_history: 'maybe' });
    expect(row).not.toBeNull();
    expect(row).toMatchObject({ narrative_rank: null, insiders_detected: null, creator_rug_history: null });
    expect(parseTokenRow({ ...base, narrative_rank: 1.5 })?.narrative_rank).toBeNull();
  });

  it('treats the narrative as hostile text: bidi/control chars stripped, capped, empty → null', () => {
    expect(parseTokenRow({ ...base, narrative: 'G\u202ET\u2066A\n' })?.narrative).toBe('GTA');
    expect(parseTokenRow({ ...base, narrative: '<script>x</script>' })?.narrative).toBe('<script>x</script>');
    const long = parseTokenRow({ ...base, narrative: 'n'.repeat(100) })?.narrative ?? '';
    expect(Array.from(long)).toHaveLength(MAX_NARRATIVE_LENGTH);
    expect(long.endsWith('…')).toBe(true);
    expect(parseTokenRow({ ...base, narrative: ' \u200B ' })?.narrative).toBeNull();
  });

  it('toOptionalBoolean maps booleans, Postgres text booleans and counts', () => {
    expect(toOptionalBoolean(true)).toBe(true);
    expect(toOptionalBoolean('t')).toBe(true);
    expect(toOptionalBoolean('false')).toBe(false);
    expect(toOptionalBoolean(3)).toBe(true);
    expect(toOptionalBoolean(0)).toBe(false);
    for (const v of [null, undefined, 'yes', {}, Number.NaN]) expect(toOptionalBoolean(v)).toBeNull();
  });
});

describe('spark_6h (6 h sparkline)', () => {
  it('is selected by TOKEN_COLUMNS', () => {
    expect(TOKEN_COLUMNS.split(',')).toContain('spark_6h');
  });

  it('parses arrays of numbers or numeric strings, null when absent', () => {
    expect(parseTokenRow({ ...base, spark_6h: [1.5, 2, 2.5] })?.spark_6h).toEqual([1.5, 2, 2.5]);
    expect(parseTokenRow({ ...base, spark_6h: ['0.000000001', '1.2e-9'] })?.spark_6h).toEqual([0.000000001, 1.2e-9]);
    expect(parseTokenRow({ ...base })?.spark_6h).toBeNull();
    expect(parseTokenRow({ ...base, spark_6h: null })?.spark_6h).toBeNull();
  });

  it('accepts a Postgres array literal', () => {
    expect(parseSpark('{1.1,1.2,1.3}')).toEqual([1.1, 1.2, 1.3]);
    expect(parseSpark('{}')).toBeNull();
  });

  it('drops junk points without rejecting the token, null under 2 usable points', () => {
    const t = parseTokenRow({ ...base, spark_6h: [1, 'x', null, -2, 0, Number.NaN, 3] });
    expect(t).not.toBeNull();
    expect(t?.spark_6h).toEqual([1, 3]);
    expect(parseTokenRow({ ...base, spark_6h: [1] })?.spark_6h).toBeNull();
    expect(parseTokenRow({ ...base, spark_6h: 'garbage' })?.spark_6h).toBeNull();
    expect(parseTokenRow({ ...base, spark_6h: { 0: 1, 1: 2 } })?.spark_6h).toBeNull();
  });

  it(`keeps only the ${MAX_SPARK_POINTS} most recent points (last = current price)`, () => {
    const many = Array.from({ length: 60 }, (_, i) => i + 1);
    const spark = parseSpark(many);
    expect(spark).toHaveLength(MAX_SPARK_POINTS);
    expect(spark?.[0]).toBe(13);
    expect(spark?.at(-1)).toBe(60);
  });

  it('isTokenRow rejects a non-numeric sparkline but accepts null / absent', () => {
    expect(isTokenRow({ ...base, spark_6h: ['1', '2'] })).toBe(false);
    expect(isTokenRow({ ...base, spark_6h: [1, 2] })).toBe(true);
    expect(isTokenRow({ ...base, spark_6h: null })).toBe(true);
    expect(isTokenRow({ ...base })).toBe(true);
  });

  it('parseSpark refuses oversized inputs before parsing them', () => {
    expect(parseSpark(Array.from({ length: 4 * 48 + 1 }, () => 1))).toBeNull();
    expect(parseSpark('{' + '1,'.repeat(1100) + '1}')).toBeNull();
    expect(parseSpark([1, 2, 3])).toEqual([1, 2, 3]);
  });

});
