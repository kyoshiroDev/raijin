// Strategy lab backtest engine (feat/strategy-lab; chore/slim-down: young_calm / young_frenzy presets, 6 combos). Pure,
// no network. Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregatePreset,
  aggregateRun,
  bootstrapMeanCi,
  buildReport,
  chronoCutoff,
  comboIndex,
  COMBOS,
  computeMetrics,
  dataVersion,
  decodeFlags,
  DEFAULT_ROUNDTRIP_PCT,
  DETECTION_ROW_BIT,
  detectionFromRow,
  DISTINCT_COMBOS,
  encodeFlags,
  GRID_COUNTS,
  gridParams,
  isStoredDetection,
  mulberry32,
  N_COMBOS,
  netPct,
  narrativeGroup,
  parseTradeRow,
  PRESET_BIT,
  PRESETS,
  presetFlags,
  presetTrades,
  roundtripPct,
  simulateDetection,
  simulateRows,
  simulateTrade,
  splitOf,
  tradeRow,
  type DetectionInput,
  type TradeRecord,
  YOUNG_COMBOS,
} from './backtest';
import { mergePath, ohlcvRow } from './candles';
import type { Candle } from './types';

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const T0 = 1_800_000_000; // seconds, multiple of 900
const DET = T0 * 1000;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

/** 1-minute path from [o, h, l, c] tuples, the first candle opening at T0 (= the detection). */
const path1m = (bars: [number, number, number, number][], tf: '1m' | '5m' | '15m' = '1m') => {
  const step = tf === '1m' ? 60 : tf === '5m' ? 300 : 900;
  return mergePath([{ tf, candles: bars.map(([o, h, l, c], i) => [T0 + i * step, o, h, l, c, 1] as Candle) }]);
};
const flat = (n: number, p = 1): [number, number, number, number][] => Array.from({ length: n }, () => [p, p, p, p]);
const S = (slPct = 30, delayMin = 0) => ({ slPct, delayMin });
/** Fees of an all_x2 trade on 0.1 SOL: 2 × 0.0002 SOL = 0.4 %. */
const TX = 0.4;

describe('grid (chore/slim-down)', () => {
  it('4 presets × 6 combos (all_x2 × SL 20 / 30 / 40 × no breakeven × no time exit × delay 0 / 2) = 24 variants', () => {
    assert.deepEqual([...PRESETS], ['young_calm', 'young_frenzy', 'young_calm_ev', 'young_frenzy_ev']);
    assert.equal(YOUNG_COMBOS.length, 6);
    assert.ok(YOUNG_COMBOS.every((c) => c.exit === 'all_x2' && !c.breakeven && c.timeExitH === null && c.distinct));
    assert.deepEqual([...new Set(YOUNG_COMBOS.map((c) => c.slPct))], [20, 30, 40]);
    assert.deepEqual([...new Set(YOUNG_COMBOS.map((c) => c.delayMin))].sort(), [0, 2]);
    assert.deepEqual(GRID_COUNTS, { combos: 384, distinctCombos: 288, variants: 24, distinctVariants: 24 });
    const p = gridParams();
    assert.equal(p.n_variants, 24);
    assert.deepEqual(p.sl_pcts, [20, 30, 40]);
    assert.deepEqual(p.delays_min, [0, 2]);
    assert.deepEqual(p.exits, ['all_x2']);
    assert.ok(!('exploratory_presets' in p));
  });
  it('the 384-slot storage layout is unchanged (backtest_trades.returns CHECK, archived runs readable)', () => {
    assert.equal(N_COMBOS, 384);
    assert.equal(COMBOS.length, 384);
    assert.equal(DISTINCT_COMBOS.length, 288);
    assert.ok(COMBOS.every((c, i) => c.index === i));
    assert.equal(comboIndex(0, 0, 0, 0, 0), 0);
    assert.equal(comboIndex(3, 3, 1, 3, 2), 383);
  });
  it('preset bits (backtest_trades CHECK): detection rows 1 | 1024 / 2048, event rows 4096 / 8192', () => {
    assert.equal(DETECTION_ROW_BIT, 1);
    assert.deepEqual(PRESET_BIT, { young_calm: 1024, young_frenzy: 2048, young_calm_ev: 4096, young_frenzy_ev: 8192 });
  });
});

describe('fees', () => {
  it('roundtrip: unknown → 3 %, clamped to [0, 100], numeric strings accepted', () => {
    assert.equal(roundtripPct(null), DEFAULT_ROUNDTRIP_PCT);
    assert.equal(roundtripPct(undefined), 3);
    assert.equal(roundtripPct(Number.NaN), 3);
    assert.equal(roundtripPct(-2), 0);
    assert.equal(roundtripPct(150), 100);
    assert.equal(roundtripPct('4.5'), 4.5);
  });
  it('netPct = gross − roundtrip − 0.2 % per transaction (1 buy + 1 per leg)', () => {
    near(netPct(1, 3, 1), 100 - 3 - 0.4);
    near(netPct(0, 3, 3), -3 - 0.8);
    near(netPct(-0.3, 0, 2), -30 - 0.6);
  });
});

describe('simulateTrade (all_x2)', () => {
  it('entry = close of the first candle opening ≥ detection; TP ×2 filled at the level', () => {
    const p = path1m([[1, 1, 1, 1], [1, 2.5, 0.9, 2.2]]);
    const r = simulateTrade(p, DET, 0, S());
    assert.ok(r);
    assert.equal(r.entryIdx, 0);
    near(r.grossPct, 100);
    near(r.netPct, 100 - TX);
    near(r.netSol, (100 - TX) / 1000);
    assert.equal(r.openAtEnd, false);
  });
  it('same candle reaches TP and SL → SL first', () => {
    const p = path1m([[1, 1, 1, 1], [1, 2.5, 0.6, 1.2]]);
    near(simulateTrade(p, DET, 0, S())!.grossPct, -30);
    near(simulateTrade(p, DET, 0, S(20))!.grossPct, -20);
  });
  it('SL filled at min(stop level, close): a close below the stop exits at the close', () => {
    const below = path1m([[1, 1, 1, 1], [0.9, 0.9, 0.5, 0.6]]);
    near(simulateTrade(below, DET, 0, S())!.grossPct, -40);
    const wick = path1m([[1, 1, 1, 1], [0.9, 0.95, 0.5, 0.9]]);
    near(simulateTrade(wick, DET, 0, S())!.grossPct, -30);
    near(simulateTrade(wick, DET, 0, S(40))!.grossPct, -40);
  });
  it('entry delay picks the first candle opening ≥ detection + delay (0 / 2 min simulated)', () => {
    const p = path1m([[1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3], [4, 4, 4, 4], [5, 5, 5, 5], [6, 6, 6, 6], [7, 7, 7, 7], [8, 8, 8, 8]]);
    const det = DET + 30_000; // 30 s after the open of candle 0
    assert.equal(simulateTrade(p, det, 0, S(30, 0))!.entryIdx, 1);
    assert.equal(simulateTrade(p, det, 0, S(30, 2))!.entryIdx, 3);
    const sim = simulateDetection(p, det, 0);
    assert.deepEqual([...sim.entryIdx], [1, 3, -1], 'the 5 min delay of the layout is no longer simulated');
  });
  it('no candle after the detection (+ delay) → no trade', () => {
    const p = path1m(flat(3));
    assert.equal(simulateTrade(p, DET + 3 * 60_000, 0, S()), null);
    const sim = simulateDetection(p, DET + 10 * 60_000, 0);
    assert.equal(sim.traded, false);
    assert.ok([...sim.returns].every((x) => Number.isNaN(x)));
    assert.equal(simulateDetection(mergePath([]), DET, 0).traded, false);
  });
  it('end of data without exit → sold at the last close, open_at_end', () => {
    const p = path1m([[1, 1, 1, 1], [1, 1.3, 0.9, 1.2], [1.2, 1.4, 1.1, 1.25]]);
    const r = simulateTrade(p, DET, null, S())!;
    assert.equal(r.openAtEnd, true);
    near(r.grossPct, 25);
    near(r.netPct, 25 - 3 - TX, 1e-9);
  });
  it('invalid stop → null', () => {
    assert.equal(simulateTrade(path1m(flat(3)), DET, 0, S(0)), null);
    assert.equal(simulateTrade(path1m(flat(3)), DET, 0, S(100)), null);
  });
});

describe('simulateDetection', () => {
  /** Seeded random walk with spikes, mixed 1m / 5m / 15m. */
  function randomRows(seed: number, n1 = 360, n5 = 864, n15 = 672) {
    const rand = mulberry32(seed);
    let p = 1;
    const mk = (step: number, n: number, start: number) =>
      Array.from({ length: n }, (_, i) => {
        const o = p;
        p = Math.max(1e-6, p * (1 + (rand() - 0.5) * 0.12));
        const h = Math.max(o, p) * (1 + rand() * (rand() < 0.03 ? 1.2 : 0.05));
        const l = Math.min(o, p) * (1 - rand() * 0.06);
        return [start + i * step, o, h, l, p, 1] as Candle;
      });
    const c1 = mk(60, n1, T0);
    const c5 = mk(300, n5, T0);
    const c15 = mk(900, n15, T0);
    return [
      ohlcvRow({ mint: MINT, pool: PAIR, tf: '1m', candles: c1, source: 'signal_outcomes', detectedAtMs: DET, fetchedAtMs: DET })!,
      ohlcvRow({ mint: MINT, pool: PAIR, tf: '5m', candles: c5, source: 'signal_outcomes', detectedAtMs: DET, fetchedAtMs: DET })!,
      ohlcvRow({ mint: MINT, pool: PAIR, tf: '15m', candles: c15, source: 'signal_outcomes', detectedAtMs: DET, fetchedAtMs: DET })!,
    ];
  }
  it('matches simulateTrade for the 6 grid combos; every other slot of the layout stays NaN (random paths)', () => {
    const grid = new Set(YOUNG_COMBOS.map((c) => c.index));
    for (const seed of [1, 2, 3]) {
      const rows = randomRows(seed);
      const sim = simulateRows(rows, DET + 17_000, 4);
      assert.equal(sim.finest, '1m');
      assert.equal(sim.traded, true);
      const path = mergePath(rows.map((r) => ({ tf: r.tf, candles: r.ts.map((t, i) => [Date.parse(r.ts_start) / 1000 + t, r.o[i], r.h[i], r.l[i], r.c[i], r.v[i]] as Candle) })));
      for (const c of YOUNG_COMBOS) {
        const t = simulateTrade(path, DET + 17_000, 4, c);
        assert.ok(t, `combo ${c.index}`);
        near(sim.returns[c.index], t.netPct, 1e-3);
        assert.equal(sim.openAtEnd[c.index] === 1, t.openAtEnd, `open flag combo ${c.index}`);
      }
      for (let i = 0; i < N_COMBOS; i++) if (!grid.has(i)) assert.ok(Number.isNaN(sim.returns[i]), `slot ${i}`);
    }
  });
  // Timing is unstable on shared CI runners (1 674 ms seen on GitHub with --parallel=3): the correctness of every
  // simulation is always checked; the strict 1 500 ms bound only runs with PERF=1, otherwise a wide guard (well under
  // the 30 s wall budget of a worker call) only catches a pathological regression. The computed code is unchanged.
  it('is fast: 40 detections of ~1 900 candles well under the worker budget', () => {
    const rows = Array.from({ length: 40 }, (_, i) => randomRows(100 + i));
    const t = performance.now();
    const sims = rows.map((r) => simulateRows(r, DET, 3));
    const ms = performance.now() - t;
    const grid = new Set(YOUNG_COMBOS.map((c) => c.index));
    for (const sim of sims) {
      assert.equal(sim.returns.length, N_COMBOS);
      for (let i = 0; i < N_COMBOS; i++) if (!grid.has(i)) assert.ok(Number.isNaN(sim.returns[i]), `slot ${i}`);
    }
    const limit = process.env['PERF'] === '1' ? 1_500 : 15_000;
    assert.ok(ms < limit, `${ms.toFixed(0)} ms (limit ${limit} ms)`);
  });
});

describe('detections and preset filters', () => {
  const scanRow = (over: Record<string, unknown> = {}, features: Record<string, unknown> = {}) => ({
    mint: MINT, detected_at: new Date(DET).toISOString(), entry_mc: '500000', entry_liq_eff: 60_000, entry_zone: 'wait',
    entry_dex_id: 'pumpswap', entry_roundtrip_pct: 2.5, narrative: 'GTA',
    features: { change_1h: 12, log_age_h: Math.log1p(5), roundtrip_cost_pct: 9, ...features }, ...over,
  });
  it('signal_outcomes row: age from log_age_h, roundtrip column first, narrative', () => {
    const d = detectionFromRow('signal_outcomes', scanRow())!;
    assert.equal(d.key, MINT);
    assert.equal(d.entryMc, 500_000);
    near(d.pairAgeH!, 5, 1e-9);
    assert.equal(d.roundtripPct, 2.5);
    assert.equal(narrativeGroup(d.narrative), 'gta');
    assert.equal(detectionFromRow('signal_outcomes', scanRow({ entry_roundtrip_pct: null }))!.roundtripPct, 9);
    assert.equal(detectionFromRow('signal_outcomes', scanRow({ mint: '<b>' })), null);
    assert.equal(detectionFromRow('signal_outcomes', scanRow({ detected_at: 'x' })), null);
  });
  it('preset_signals row needs an id; uses entry_change_1h and pair_age_h', () => {
    const row = { ...scanRow(), id: 7, entry_change_1h: 3, pair_age_h: 2, features: undefined, narrative: null };
    const d = detectionFromRow('preset_signals', row)!;
    assert.equal(d.key, '7');
    assert.equal(d.change1h, 3);
    assert.equal(d.pairAgeH, 2);
    assert.equal(narrativeGroup(d.narrative), 'other');
    assert.equal(detectionFromRow('preset_signals', { ...row, id: undefined }), null);
  });
  it('flags (detection mode): DETECTION_ROW_BIT always, young bits only for « Jeune calme / frénésie » candidates', () => {
    const f = (over: Record<string, unknown> = {}, features: Record<string, unknown> = {}) =>
      detectionFromRow('signal_outcomes', scanRow(over, features))!;
    // Reference row: 5 h pumpswap pair, liq 60 k$, change 12 %, ratio unknown → no young class.
    assert.equal(presetFlags(f()), DETECTION_ROW_BIT);
    assert.equal(isStoredDetection(f()), false, 'no preset reads it: not stored');
    const calm = f({}, { buy_sell_ratio_1h: 1.1 });
    assert.equal(presetFlags(calm), DETECTION_ROW_BIT | PRESET_BIT.young_calm);
    assert.equal(isStoredDetection(calm), true);
    assert.equal(presetFlags(f({}, { buy_sell_ratio_1h: 2 })), DETECTION_ROW_BIT | PRESET_BIT.young_frenzy);
    assert.equal(presetFlags(f({ entry_mc: 5_000_000 }, { buy_sell_ratio_1h: 1.1 })), DETECTION_ROW_BIT | PRESET_BIT.young_calm, 'MC is not a rule');
  });
});

describe('split', () => {
  it('chronoCutoff: 70 % oldest = train, same cutoff whatever the input order', () => {
    const ts = Array.from({ length: 10 }, (_, i) => DET + i * 1000);
    const c = chronoCutoff([...ts].reverse());
    assert.equal(c, DET + 7000);
    assert.equal(ts.filter((t) => splitOf(t, c!) === 'train').length, 7);
    assert.equal(chronoCutoff([DET]), null);
    assert.equal(chronoCutoff([DET, DET + 1]), DET + 1);
  });
  it('dataVersion: resolution shares, cutoff, max time', () => {
    const dv = dataVersion([
      { detectedAtMs: DET, finest: '1m' },
      { detectedAtMs: DET + 1, finest: '15m' },
      { detectedAtMs: DET + 2, finest: '5m' },
      { detectedAtMs: DET + 3, finest: null },
    ]);
    assert.deepEqual(dv.resolutions, { '1m': 1, '5m': 1, '15m': 1, none: 1 });
    assert.equal(dv.n_detections, 4);
    assert.equal(dv.cutoff_at, new Date(DET + 3).toISOString());
    assert.equal(dv.max_detected_at, new Date(DET + 3).toISOString());
    assert.equal(dv.train + dv.test, 4);
  });
});

describe('metrics', () => {
  it('win rate, averages, profit factor, drawdown (0.1 SOL per trade), streak, open_at_end', () => {
    const m = computeMetrics([10, -20, -5, 30, -10, Number.NaN], [0, 0, 1, 0, 1, 1]);
    assert.equal(m.trades, 5);
    near(m.win_rate!, 0.4);
    near(m.avg_win_pct!, 20);
    near(m.avg_loss_pct!, -35 / 3);
    near(m.avg_net_pct!, 1);
    near(m.avg_net_sol!, 0.001);
    near(m.profit_factor!, 40 / 35);
    near(m.max_drawdown_sol, 0.025); // peak +0.01 → −0.015
    assert.equal(m.worst_losing_streak, 2);
    assert.equal(m.open_at_end, 2);
  });
  it('no loss → profit factor null; no trade → nulls and zeros', () => {
    assert.equal(computeMetrics([5, 0, 3]).profit_factor, null);
    assert.equal(computeMetrics([5, 0, 3]).worst_losing_streak, 0);
    const z = computeMetrics([]);
    assert.deepEqual(z, {
      trades: 0, win_rate: null, avg_win_pct: null, avg_loss_pct: null, avg_net_pct: null, avg_net_sol: null, profit_factor: null,
      max_drawdown_sol: 0, worst_losing_streak: 0, open_at_end: 0,
    });
  });
  it('drawdown counts from 0 when the first trades lose', () => {
    near(computeMetrics([-10, -10, 50]).max_drawdown_sol, 0.02);
  });
});

describe('bootstrap', () => {
  const values = Array.from({ length: 80 }, (_, i) => ((i * 37) % 23) - 10);
  it('deterministic with a fixed seed, different with another seed', () => {
    const a = bootstrapMeanCi(values);
    const b = bootstrapMeanCi(values);
    assert.deepEqual(a, b);
    assert.notDeepEqual(bootstrapMeanCi(values, 1000, 7), a);
    const mean = values.reduce((s, x) => s + x, 0) / values.length;
    assert.ok(a && a.low < mean && mean < a.high);
  });
  it('constant values → degenerate interval; fewer than 2 values → null', () => {
    assert.deepEqual(bootstrapMeanCi([4, 4, 4]), { low: 4, high: 4 });
    assert.equal(bootstrapMeanCi([1]), null);
    assert.equal(bootstrapMeanCi([1, Number.NaN]), null);
  });
  it('mulberry32 is reproducible and in [0, 1)', () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const x = r1();
      assert.equal(x, r2());
      assert.ok(x >= 0 && x < 1);
    }
  });
});

describe('trade rows', () => {
  it('flags hex round trip', () => {
    const f = new Uint8Array(N_COMBOS);
    f[0] = 1;
    f[5] = 1;
    f[383] = 1;
    const hex = encodeFlags(f);
    assert.equal(hex.length, 96);
    assert.deepEqual(decodeFlags(hex), f);
    assert.equal(decodeFlags('zz'), null);
  });
  it('tradeRow → JSON → parseTradeRow', () => {
    const d: DetectionInput = {
      source: 'signal_outcomes', key: MINT, mint: MINT, detectedAtMs: DET, entryMc: 400_000, entryLiqEff: 50_000, entryZone: null,
      entryDexId: 'pumpswap', change1h: 5, roundtripPct: 2, pairAgeH: 1, narrative: 'GTA', buySellRatio1h: 1, lpLockedPct: null,
      insiders: null, creatorRug: null,
    };
    const sim = simulateDetection(path1m([[1, 1, 1, 1], [1, 2.5, 0.9, 2]]), DET, 2);
    const row = JSON.parse(JSON.stringify(tradeRow(d, sim, 'test')));
    assert.equal(row.preset_flags, DETECTION_ROW_BIT | PRESET_BIT.young_calm);
    assert.equal(row.narrative, 'gta');
    assert.equal(row.returns.length, 384);
    const back = parseTradeRow(row)!;
    assert.equal(back.split, 'test');
    const c0 = YOUNG_COMBOS[0].index;
    near(Number(back.returns[c0]), sim.returns[c0], 1e-3);
    assert.ok(Number.isNaN(Number(back.returns[383])), 'slot outside the grid: not simulated');
    assert.equal(parseTradeRow({ ...row, returns: [1] }), null);
    assert.equal(parseTradeRow({ ...row, split: 'x' }), null);
    assert.equal(parseTradeRow({ ...row, open_at_end: 'bad' }), null);
  });
});

describe('aggregation and validation', () => {
  let mintSeq = 0;
  const mintOf = () => {
    const s = String(++mintSeq).padStart(6, '1').replace(/0/g, 'z');
    return (MINT.slice(0, 38) + s).slice(0, 44);
  };
  const rec = (i: number, split: 'train' | 'test', value: (combo: number) => number, over: Partial<TradeRecord> = {}): TradeRecord => ({
    source: 'signal_outcomes', mint: mintOf(), detectedAtMs: DET + i * 1000, split, presetFlags: DETECTION_ROW_BIT | PRESET_BIT.young_calm, narrative: 'other',
    returns: Float32Array.from({ length: N_COMBOS }, (_, c) => value(c)), ...over,
  });
  it('36 rows per preset (6 combos × 3 narratives × 2 splits); aggregateRun covers the 4 presets', () => {
    const trades = [rec(0, 'train', () => 1), rec(1, 'test', () => 1)];
    const rows = aggregatePreset(trades, 'young_calm');
    assert.equal(rows.length, 36);
    assert.ok(rows.every((r) => r.exit === 'all_x2' && !r.breakeven && r.time_exit_h === null && [20, 30, 40].includes(r.sl_pct) && [0, 2].includes(r.delay_min)));
    assert.equal(aggregateRun(trades).length, 4 * 36);
  });
  it('retained needs avg > 0 in train AND test with ≥ 30 test trades; robust needs the CI to exclude 0', () => {
    const steady = [...Array.from({ length: 50 }, (_, i) => rec(i, 'train', () => 5)), ...Array.from({ length: 30 }, (_, i) => rec(100 + i, 'test', () => 5))];
    const rows = aggregatePreset(steady, 'young_calm', { split: 'stored' });
    const t = rows.find((r) => r.split === 'test' && r.narrative === 'all')!;
    assert.equal(t.retained, true);
    assert.equal(t.robust, true);
    assert.equal(t.ci_contains_zero, false);
    near(t.ci_low!, 5, 1e-5);
    const tr = rows.find((r) => r.split === 'train' && r.narrative === 'all')!;
    assert.equal(tr.retained, true);
    assert.equal(tr.ci_low, null);
    // Only 29 test trades → not retained.
    const few = aggregatePreset([...steady.slice(0, 50), ...steady.slice(51)], 'young_calm', { split: 'stored' }).find((r) => r.split === 'test' && r.narrative === 'all')!;
    assert.equal(few.retained, false);
    assert.equal(few.ci_low, null);
    // Positive mean but noisy → retained, CI contains 0 → not robust.
    const noisy = [
      ...Array.from({ length: 40 }, (_, i) => rec(i, 'train', () => (i % 2 ? 30 : -28))),
      ...Array.from({ length: 40 }, (_, i) => rec(100 + i, 'test', () => (i % 2 ? 30 : -28))),
    ];
    const n = aggregatePreset(noisy, 'young_calm', { split: 'stored' }).find((r) => r.split === 'test' && r.narrative === 'all')!;
    assert.equal(n.retained, true);
    assert.equal(n.ci_contains_zero, true);
    assert.equal(n.robust, false);
    // Negative in train → not retained.
    const flip = [...Array.from({ length: 40 }, (_, i) => rec(i, 'train', () => -1)), ...Array.from({ length: 40 }, (_, i) => rec(100 + i, 'test', () => 5))];
    assert.equal(aggregatePreset(flip, 'young_calm', { split: 'stored' }).some((r) => r.retained), false);
  });
  it('preset filter, one trade per mint (earliest matching detection), narrative groups', () => {
    const a = rec(2, 'train', () => 1, { presetFlags: DETECTION_ROW_BIT | PRESET_BIT.young_frenzy, narrative: 'gta' });
    const dup = { ...rec(1, 'train', () => 9), mint: a.mint }; // earlier detection of the same mint, young_calm only
    const b = rec(3, 'test', () => 2);
    const empty = rec(0, 'train', () => Number.NaN);
    const calm = presetTrades([a, dup, b, empty], 'young_calm');
    assert.deepEqual(calm.map((t) => t.detectedAtMs), [dup.detectedAtMs, b.detectedAtMs]);
    assert.deepEqual(presetTrades([a, dup, b], 'young_frenzy'), [a]);
    const rows = aggregatePreset([a, dup, b], 'young_frenzy');
    assert.equal(rows.find((r) => r.split === 'train' && r.narrative === 'gta')!.trades, 1);
    assert.equal(rows.find((r) => r.split === 'train' && r.narrative === 'other')!.trades, 0);
  });
  it('buildReport: retained ranking by test average, robust count, multiple-comparison warning', () => {
    const best = YOUNG_COMBOS[0].index;
    const steady = [...Array.from({ length: 40 }, (_, i) => rec(i, 'train', (c) => (c === best ? 5 : -1))), ...Array.from({ length: 40 }, (_, i) => rec(100 + i, 'test', (c) => (c === best ? 5 : -1)))];
    const results = aggregatePreset(steady, 'young_calm', { split: 'stored' });
    const rep = buildReport(results, dataVersion(steady.map((t) => ({ detectedAtMs: t.detectedAtMs, finest: '1m' }))));
    assert.equal(rep.retained, 1);
    assert.equal(rep.robust, 1);
    assert.equal(rep.top[0].variant.exit, 'all_x2');
    near(rep.top[0].test.avg_net_pct!, 5, 1e-5);
    near(rep.top[0].train.avg_net_pct!, 5, 1e-5);
    assert.match(rep.warning, /hasard/);
    assert.equal(rep.n_variants, 24);
    assert.equal(rep.n_distinct_variants, 24);
    assert.equal(rep.top[0].variant.preset, 'young_calm');
    assert.match(buildReport([], rep.data_version).warning, /Aucune variante robuste/);
  });
});

describe('worker chunking', () => {
  it('comboRange + sliced returns (returnsOffset) give the same rows as the full aggregation', async () => {
    const { comboIndexSpan, DISTINCT_COMBOS: D } = await import('./backtest');
    const rand = mulberry32(5);
    const mints = Array.from({ length: 70 }, (_, i) => MINT.slice(0, 40) + String(1000 + i).replace(/0/g, 'z'));
    const full = mints.map((mint, i) => {
      const returns = Float32Array.from({ length: N_COMBOS }, () => Math.round((rand() - 0.4) * 400) / 10);
      const open = new Uint8Array(N_COMBOS).map(() => (rand() < 0.1 ? 1 : 0));
      return { source: 'signal_outcomes', mint, detected_at: new Date(DET + i * 1000).toISOString(), split: i < 35 ? 'train' : 'test', preset_flags: 1025,
        narrative: 'other', returns: Array.from(returns), open_at_end: encodeFlags(open) };
    });
    const ref = aggregatePreset(full.map((r) => parseTradeRow(r)!), 'young_calm');
    // The chunk of 48 distinct combos that holds the 6 grid combos (all_x2 = the first exit of the layout).
    const range: [number, number] = [0, 48];
    const span = comboIndexSpan(range)!;
    assert.equal(span[0], D[0].index);
    assert.ok(YOUNG_COMBOS.every((c) => c.index >= span[0] && c.index <= span[1]));
    const sliced = full.map((r) => parseTradeRow({ ...r, returns: r.returns.slice(span[0], span[1] + 1) }, span[0])!);
    const part = aggregatePreset(sliced, 'young_calm', { comboRange: range, returnsOffset: span[0], narratives: ['all', 'other'] });
    assert.equal(part.length, 6 * 2 * 2);
    for (const row of part) {
      const twin = ref.find((r) => r.exit === row.exit && r.sl_pct === row.sl_pct && r.breakeven === row.breakeven && r.time_exit_h === row.time_exit_h &&
        r.delay_min === row.delay_min && r.narrative === row.narrative && r.split === row.split)!;
      assert.deepEqual(row, twin);
    }
    assert.equal(comboIndexSpan([5, 5]), null);
  });
  it('cached and uncached bootstrap draws give identical intervals', async () => {
    const { BootstrapDraws } = await import('./backtest');
    const v = Array.from({ length: 50 }, (_, i) => Math.sin(i) * 10);
    assert.deepEqual(bootstrapMeanCi(v, 1000, 3, new BootstrapDraws(1000, 3)), bootstrapMeanCi(v, 1000, 3));
  });
});

describe('bootstrap reference', () => {
  it('equals a naive percentile bootstrap driven by mulberry32(seed)', () => {
    const v = [3, -7, 12, 0.5, -2, 9, 4, -11, 6, 1];
    const rand = mulberry32(BOOT_SEED);
    const means: number[] = [];
    for (let b = 0; b < 1000; b++) {
      let s = 0;
      for (let i = 0; i < v.length; i++) s += v[Math.floor(rand() * v.length)];
      means.push(s / v.length);
    }
    means.sort((a, b) => a - b);
    const q = (p: number) => {
      const pos = (means.length - 1) * p;
      const lo = Math.floor(pos);
      return means[lo] + (means[Math.ceil(pos)] - means[lo]) * (pos - lo);
    };
    const ci = bootstrapMeanCi(v, 1000, BOOT_SEED)!;
    near(ci.low, q(0.025), 1e-12);
    near(ci.high, q(0.975), 1e-12);
  });
});
const BOOT_SEED = 20261119;
