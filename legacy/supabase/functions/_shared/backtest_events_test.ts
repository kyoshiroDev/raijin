// Strategy lab v2 (feat/lab-v2; chore/slim-down: young presets only): event mode, per-preset split, nightly summary.
// Pure, no network.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregatePreset,
  type BacktestResult,
  buildRunSummary,
  chronoCutoff,
  comboIndex,
  buildReport,
  describeVariant,
  DETECTION_ROW_BIT,
  eventFromRow,
  eventTradeRow,
  GRID_COUNTS,
  N_COMBOS,
  parseTradeRow,
  PRESET_BIT,
  PRESET_MODE,
  PRESETS,
  presetSplit,
  presetTrades,
  resultFromRow,
  simulateDetection,
  simulateEvent,
  simulateEventRows,
  type TradeRecord,
  YOUNG_DETECTION_PRESETS,
  YOUNG_EVENT_PRESETS,
} from './backtest.ts';
import { type CandleSeries, mergePath, ohlcvRow } from './candles.ts';
import type { Candle } from './types.ts';

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const T0 = 1_800_000_000; // seconds
const EV = T0 * 1000;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const bars = (from: number, n: number, step: number, price: (i: number) => number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const p = price(i);
    return [from + i * step, p, p * 1.01, p * 0.99, p, 1] as Candle;
  });
// combo of (all_x2, sl 30, breakeven false, no time exit, delay index d: 0 / 2 min; index 2 = 5 min, not simulated)
const X2 = (d: number) => comboIndex(0, 1, 0, 0, d);

describe('presets of a run (chore/slim-down)', () => {
  it('young_calm / young_frenzy in detection mode, young_calm_ev / young_frenzy_ev in event mode, 24 variants', () => {
    assert.deepEqual([...YOUNG_DETECTION_PRESETS], ['young_calm', 'young_frenzy']);
    assert.deepEqual([...YOUNG_EVENT_PRESETS], ['young_calm_ev', 'young_frenzy_ev']);
    assert.equal(PRESETS.length, 4);
    assert.equal(GRID_COUNTS.variants, 24);
    assert.ok(PRESETS.every((p) => PRESET_MODE[p] === ((YOUNG_DETECTION_PRESETS as readonly string[]).includes(p) ? 'detection' : 'event')));
    const bits = PRESETS.map((p) => PRESET_BIT[p]);
    assert.equal(new Set(bits).size, 4);
    assert.ok(bits.every((b) => (b & (b - 1)) === 0));
  });
});

describe('simulateEvent', () => {
  it('entry = close of the first 1-minute candle with open ≥ event_at + delay; same engine as a detection', () => {
    // 1m from the event, price ×2 at minute 30.
    const s1: CandleSeries = { tf: '1m', candles: bars(T0, 360, 60, (i) => (i >= 30 ? 2.2 : 1)) };
    const ev = simulateEvent([s1], EV, 2);
    const det = simulateDetection(mergePath([s1]), EV, 2);
    assert.equal(ev.pending, false);
    assert.deepEqual(Array.from(ev.returns), Array.from(det.returns));
    assert.deepEqual(Array.from(ev.entryIdx), [0, 2, -1]);
    assert.ok(ev.returns[X2(0)] > 90);
  });
  it('no 1-minute candle covering the entry → that delay is not traded; none → pending', () => {
    // Only 5-minute candles: pending, even though simulateDetection would trade.
    const s5: CandleSeries = { tf: '5m', candles: bars(T0, 100, 300, () => 1) };
    const p = simulateEvent([s5], EV, null);
    assert.equal(p.pending, true);
    assert.equal(p.traded, false);
    assert.ok(Array.from(p.returns).every((x) => Number.isNaN(x)));
    assert.equal(simulateDetection(mergePath([s5]), EV, null).traded, true);
    // 1-minute window starting 1 min after the event: delay 0 not covered, delay 2 covered.
    const late: CandleSeries = { tf: '1m', candles: bars(T0 + 60, 300, 60, () => 1) };
    const l = simulateEvent([late, s5], EV, null);
    assert.equal(l.pending, false);
    assert.deepEqual(Array.from(l.entryIdx).map((k) => k >= 0), [false, true, false]);
    assert.ok(Number.isNaN(l.returns[X2(0)]));
    assert.ok(Number.isFinite(l.returns[X2(1)]));
    // Starting 3 min after: no simulated delay (0 / 2) covered → pending.
    assert.equal(simulateEvent([{ tf: '1m', candles: bars(T0 + 180, 300, 60, () => 1) }, s5], EV, null).pending, true);
  });
  it('1-minute window ending before event_at + delay → not covered (no jump to a later window)', () => {
    const early: CandleSeries = { tf: '1m', candles: bars(T0 - 3600, 61, 60, () => 1) }; // ends at T0 + 60
    const later: CandleSeries = { tf: '1m', candles: bars(T0 + 7200, 60, 60, () => 1) };
    const r = simulateEvent([early, later], EV, null);
    assert.deepEqual(Array.from(r.entryIdx).map((k) => k >= 0), [true, false, false]);
  });
  it('after the 1-minute window the 5-minute path continues (time exit counted from the event)', () => {
    const s1: CandleSeries = { tf: '1m', candles: bars(T0, 360, 60, () => 1) };
    const s5: CandleSeries = { tf: '5m', candles: bars(T0, 864, 300, (i) => (i >= 100 ? 2.5 : 1)) };
    const r = simulateEvent([s1, s5], EV, 0);
    assert.ok(r.returns[X2(0)] > 90, 'x2 reached on the 5m part');
  });
  it('simulateEventRows decodes ohlcv_candles rows', () => {
    const row = ohlcvRow({ mint: MINT, pool: PAIR, tf: '1m', candles: bars(T0, 60, 60, () => 1), source: 'backtest_events', detectedAtMs: EV, fetchedAtMs: EV + 1 });
    assert.ok(row);
    const r = simulateEventRows([JSON.parse(JSON.stringify(row))], EV, 1);
    assert.equal(r.pending, false);
  });
});

describe('event rows', () => {
  const row = { id: 7, preset: 'young_calm_ev', mint: MINT, event_at: new Date(EV).toISOString(), roundtrip_pct: '2.5', narrative: 'GTA' };
  it('eventFromRow: validated, roundtrip from the column or conditions', () => {
    const e = eventFromRow(row);
    assert.ok(e);
    assert.equal(e.key, '7');
    assert.equal(e.roundtripPct, 2.5);
    assert.equal(eventFromRow({ ...row, roundtrip_pct: null, conditions: { roundtrip_pct: 1.5 } })?.roundtripPct, 1.5);
    assert.equal(eventFromRow({ ...row, roundtrip_pct: null })?.roundtripPct, null);
    assert.equal(eventFromRow({ ...row, preset: 'young_calm' }), null, 'detection preset');
    assert.equal(eventFromRow({ ...row, mint: '<script>' }), null);
    assert.equal(eventFromRow({ ...row, id: -1 }), null);
    assert.equal(eventFromRow({ ...row, event_at: 'x' }), null);
  });
  it('archived event presets (momentum, post_migration, narrative_leader, *_explo) are not read any more', () => {
    for (const preset of ['momentum', 'young_24h', 'young_3h', 'post_migration', 'narrative_leader', 'momentum_explo']) {
      assert.equal(eventFromRow({ ...row, preset }), null, preset);
    }
  });
  it('eventTradeRow: source backtest_events, single preset bit, parseTradeRow round trip', () => {
    const e = eventFromRow({ ...row, preset: 'young_frenzy_ev' })!;
    const sim = simulateEvent([{ tf: '1m', candles: bars(T0, 60, 60, () => 1) }], EV, e.roundtripPct);
    const tr = JSON.parse(JSON.stringify(eventTradeRow(e, sim, 'train')));
    assert.equal(tr.source, 'backtest_events');
    assert.equal(tr.preset_flags, PRESET_BIT.young_frenzy_ev);
    assert.equal(tr.detected_at, new Date(EV).toISOString());
    assert.equal(tr.narrative, 'gta');
    const back = parseTradeRow(tr);
    assert.ok(back);
    assert.equal(back.source, 'backtest_events');
    assert.equal(presetTrades([back], 'young_frenzy_ev').length, 1);
    assert.equal(presetTrades([back], 'young_frenzy').length, 0);
    assert.equal(parseTradeRow({ ...tr, preset_flags: 1024 }), null, 'detection bit on an event row');
    assert.equal(parseTradeRow({ ...tr, preset_flags: 4096 })?.presetFlags, 4096, 'young_calm_ev event bit');
    assert.equal(parseTradeRow({ ...tr, preset_flags: 8192 | 4096 }), null, 'one event bit per row');
    assert.equal(parseTradeRow({ ...tr, preset_flags: 0 }), null);
  });
});

describe('per-preset chronological split', () => {
  let seq = 0;
  const mint = () => (MINT.slice(0, 38) + String(++seq).padStart(6, '1').replace(/0/g, 'z')).slice(0, 44);
  const rec = (i: number, flags: number, v: number, split: 'train' | 'test' = 'train', source: TradeRecord['source'] = 'signal_outcomes'): TradeRecord => ({
    source, mint: mint(), detectedAtMs: EV + i * 1000, split, presetFlags: flags, narrative: 'other',
    returns: Float32Array.from({ length: N_COMBOS }, () => v),
  });
  it('the cutoff of a preset is computed on its own trades (stored split ignored)', () => {
    // young_calm: 10 detections at t = 0..9; young_calm_ev events only at t = 100..109.
    const det = Array.from({ length: 10 }, (_, i) => rec(i, DETECTION_ROW_BIT | PRESET_BIT.young_calm, 1));
    const evs = Array.from({ length: 10 }, (_, i) => rec(100 + i, PRESET_BIT.young_calm_ev, 1, 'train', 'backtest_events'));
    const trades = [...det, ...evs];
    const ps = presetSplit(trades, 'young_calm_ev');
    assert.deepEqual(ps, { trades: 10, train: 7, test: 3, cutoff_at: new Date(EV + 107_000).toISOString() });
    const rows = aggregatePreset(trades, 'young_calm_ev', { minTestTrades: 1 });
    const t = rows.find((r) => r.split === 'test' && r.narrative === 'all')!;
    assert.equal(t.trades, 3);
    const a = aggregatePreset(trades, 'young_calm', { minTestTrades: 1 }).find((r) => r.split === 'test' && r.narrative === 'all')!;
    assert.equal(a.trades, 3);
  });
  it('detection mode unchanged: identical rows to the stored split when it equals the preset cutoff', () => {
    let s = 11;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const list = Array.from({ length: 80 }, (_, i) => {
      const r = rec(i, DETECTION_ROW_BIT | (i % 3 ? PRESET_BIT.young_calm : PRESET_BIT.young_frenzy), 0);
      r.returns = Float32Array.from({ length: N_COMBOS }, () => Math.round((rnd() * 40 - 15) * 1e4) / 1e4);
      return r;
    });
    for (const preset of YOUNG_DETECTION_PRESETS) {
      const own = presetTrades(list, preset);
      const cutoff = chronoCutoff(own.map((t) => t.detectedAtMs))!;
      const stored = list.map((t) => ({ ...t, split: t.detectedAtMs >= cutoff ? 'test' as const : 'train' as const }));
      assert.deepEqual(aggregatePreset(list, preset, { minTestTrades: 5 }), aggregatePreset(stored, preset, { split: 'stored', minTestTrades: 5 }));
    }
  });
});

describe('buildRunSummary', () => {
  const res = (over: Partial<BacktestResult>): BacktestResult => ({
    preset: 'young_calm', exit: 'all_x2', sl_pct: 30, breakeven: false, time_exit_h: null, delay_min: 2, narrative: 'all', split: 'test',
    trades: 42, win_rate: 0.5, avg_win_pct: 50, avg_loss_pct: -30, avg_net_pct: 8.06, avg_net_sol: 0.008, profit_factor: 1.4,
    max_drawdown_sol: 0.3, worst_losing_streak: 4, open_at_end: 0, ci_low: 1.2, ci_high: 15, ci_contains_zero: false,
    retained: true, robust: true, ...over,
  });
  const meta = { run_at: '2026-11-20T03:40:00Z', n_detections: 412, n_events: 37 };
  it('no robust variant → verdict none, French text with date and sample', () => {
    const s = buildRunSummary([res({ robust: false })], meta);
    assert.equal(s.verdict, 'none');
    assert.equal(s.candidate, undefined);
    assert.equal(s.run_at, '2026-11-20T03:40:00.000Z');
    assert.equal(s.n_detections, 412);
    assert.equal(s.n_events, 37);
    assert.match(s.text, /^Aucune stratégie robuste/);
    assert.match(s.text, /20\/11\/2026 03:40 UTC/);
    assert.match(s.text, /412 détections et 37 événements, 24 variantes testées/);
    assert.match(s.text, /Backtest ≠ résultat futur/);
  });
  it('candidate: best robust test average, narrative all first, with its train metrics', () => {
    const results = [
      res({}), res({ split: 'train', trades: 98, avg_net_pct: 5.3, ci_low: null, ci_high: null, ci_contains_zero: null }),
      res({ preset: 'young_frenzy_ev', avg_net_pct: 3 }),
      res({ narrative: 'other', avg_net_pct: 30 }),
    ];
    const s = buildRunSummary(results, meta);
    assert.equal(s.verdict, 'candidate');
    assert.deepEqual(s.candidate, {
      preset: 'young_calm', exit: 'all_x2', sl_pct: 30, breakeven: false, time_exit_h: null, delay_min: 2, narrative: 'all',
      test: { trades: 42, avg_net_pct: 8.06, ci_low: 1.2, ci_high: 15 }, train: { trades: 98, avg_net_pct: 5.3 },
    });
    assert.match(s.text, /^Stratégie candidate : Jeune calme \(détection\), tout vendre à ×2, stop −30 %, sans sortie au temps, délai 2 min \(tous narratifs\)/);
    assert.match(s.text, /Test : 42 trades, \+8,1 % net moyen par trade \(IC 95 % \+1,2 % à \+15,0 %\) ; apprentissage : 98 trades, \+5,3 %/);
    assert.match(s.text, /hasard/);
  });
  it("falls back to 'other'; GTA-only robust is signalled, never a candidate", () => {
    const other = buildRunSummary([res({ narrative: 'other' })], meta);
    assert.equal(other.candidate?.narrative, 'other');
    const gta = buildRunSummary([res({ narrative: 'gta' })], meta);
    assert.equal(gta.verdict, 'none');
    assert.match(gta.text, /seulement sur le narratif GTA/);
    assert.match(gta.text, /sans sortie au temps/);
  });
  it('describeVariant mentions breakeven only for multi-leg exits', () => {
    assert.match(describeVariant(res({ exit: 'thirds_x2_x3_x4', breakeven: true })), /breakeven oui/, 'archived rows still described');
    assert.doesNotMatch(describeVariant(res({})), /breakeven/);
  });
  it('resultFromRow reads a backtest_results row (time_exit_h 0 → null) and feeds the summary', () => {
    const r = resultFromRow({
      preset: 'young_frenzy_ev', exit: 'all_x2', sl_pct: 40, breakeven: false, time_exit_h: 0, delay_min: 2, narrative: 'all',
      split: 'test', trades: 31, avg_net_pct: '4.2', ci_low: 0.5, ci_high: 8, ci_contains_zero: false, retained: true, robust: true,
    });
    assert.ok(r);
    assert.equal(r.time_exit_h, null);
    assert.equal(r.avg_net_pct, 4.2);
    assert.equal(buildRunSummary([r], meta).candidate?.preset, 'young_frenzy_ev');
    assert.equal(resultFromRow({ preset: 'x' }), null);
    assert.equal(resultFromRow({ ...r, time_exit_h: 0, preset: 'post_migration' }), null, 'archived preset');
    assert.equal(resultFromRow({ ...r, time_exit_h: 3 }), null);
  });
  it('rows of archived presets are ignored even when robust (never a candidate)', () => {
    const archived = res({ preset: 'momentum' as never, avg_net_pct: 99 });
    assert.equal(buildRunSummary([archived], meta).verdict, 'none');
    const mixed = buildRunSummary([archived, res({ preset: 'young_calm_ev', avg_net_pct: 2 })], meta);
    assert.equal(mixed.candidate?.preset, 'young_calm_ev');
  });
  it('buildReport: retained / robust / top over the young presets', () => {
    const rows = [res({ preset: 'young_calm' }), res({ preset: 'young_frenzy', robust: false })];
    const dv = { n_detections: 0, resolutions: { '1m': 0, '5m': 0, '15m': 0, none: 0 }, cutoff_at: null, max_detected_at: null, train: 0, test: 0 };
    const rep = buildReport(rows, dv);
    assert.equal(rep.retained, 2);
    assert.equal(rep.robust, 1);
    assert.deepEqual(rep.top.map((t) => t.variant.preset).sort(), ['young_calm', 'young_frenzy']);
    assert.equal(rep.n_variants, 24);
  });
});
