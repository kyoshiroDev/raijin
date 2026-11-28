// backtest-run worker state machine (feat/strategy-lab). Pure, no network.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregatePreset,
  type BacktestResult,
  chronoCutoff,
  DISTINCT_COMBOS,
  N_COMBOS,
  NARRATIVES,
  parseTradeRow,
  PRESET_BIT,
  presetCombos,
  PRESETS,
  YOUNG_CALM_PRESETS,
} from './backtest.ts';
import {
  advanceAggregate,
  AGG_CHUNK_COMBOS,
  AGG_CHUNKS,
  AGG_TOTAL_STEPS,
  aggregateStep,
  CANDLE_RETENTION_MS,
  chunkHasCombos,
  cutoffIndex,
  dedupeTradeRows,
  DETECTION_TABLES,
  finalDataVersion,
  initialCursor,
  KEEP_RESULTS_RUNS,
  KEEP_TRADES_RUNS,
  keysetFilter,
  nextTable,
  parseCursor,
  presetFlagValues,
  progressOf,
  recordDetection,
  recordEvent,
  confirmatoryEvents,
  resultRow,
  retentionCutoffs,
  sameSlice,
  TRADE_KEY_COLUMNS,
} from './backtest-worker.ts';

const NOW = Date.parse('2026-11-19T03:40:00.000Z');
const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';

describe('initialCursor / parseCursor', () => {
  it('starts in simulate on the first table with a 30-day window ending now', () => {
    const c = initialCursor(NOW, 1234);
    assert.equal(c.phase, 'simulate');
    assert.equal(c.table, 0);
    assert.equal(DETECTION_TABLES[c.table], 'signal_outcomes');
    assert.equal(Date.parse(c.until), NOW);
    assert.equal(NOW - Date.parse(c.since), CANDLE_RETENTION_MS);
    assert.equal(c.total, 1234);
    assert.deepEqual(c.res, { '1m': 0, '5m': 0, '15m': 0, none: 0 });
  });

  it('rejects an invalid now and normalises a bad total', () => {
    assert.throws(() => initialCursor(Number.NaN, 1), RangeError);
    assert.equal(initialCursor(NOW, -5).total, 0);
    assert.equal(initialCursor(NOW, Number.NaN).total, 0);
  });

  it('round-trips through JSON (jsonb column)', () => {
    const c = initialCursor(NOW, 10);
    recordDetection(c, '2026-11-01T10:00:00.123456+00:00', MINT, '1m');
    c.errors = 2;
    const back = parseCursor(JSON.parse(JSON.stringify(c)));
    assert.deepEqual(back, c);
  });

  it('returns null for absent or malformed cursors', () => {
    const good = JSON.parse(JSON.stringify(initialCursor(NOW, 1)));
    assert.equal(parseCursor(null), null);
    assert.equal(parseCursor([]), null);
    assert.equal(parseCursor({ ...good, v: 2 }), null);
    assert.equal(parseCursor({ ...good, phase: 'nope' }), null);
    assert.equal(parseCursor({ ...good, since: 'x' }), null);
    assert.equal(parseCursor({ ...good, table: -1 }), null);
    assert.equal(parseCursor({ ...good, table: 9 }), null);
    assert.equal(parseCursor({ ...good, preset: PRESETS.length + 1 }), null);
    assert.equal(parseCursor({ ...good, res: { ...good.res, '1m': 1.5 } }), null);
    assert.equal(parseCursor({ ...good, after: { detected_at: 'bad', key: MINT } }), null);
    assert.equal(parseCursor({ ...good, after: { detected_at: '2026-11-01T00:00:00Z', key: '' } }), null);
    assert.equal(parseCursor({ ...good, cutoff: 12 }), null);
  });
});

describe('simulation bookkeeping', () => {
  it('records the keyset position, resolutions and the newest traded detection', () => {
    const c = initialCursor(NOW, 3);
    recordDetection(c, '2026-11-02T00:00:00+00:00', 'a', '5m');
    recordDetection(c, '2026-11-03T00:00:00+00:00', 'b', null);
    recordDetection(c, '2026-11-01T00:00:00+00:00', 'c', '15m');
    assert.equal(c.read, 3);
    assert.deepEqual(c.res, { '1m': 0, '5m': 1, '15m': 1, none: 1 });
    assert.deepEqual(c.after, { detected_at: '2026-11-01T00:00:00+00:00', key: 'c' });
    // The untraded detection (no candle) does not move max.
    assert.equal(c.max, '2026-11-02T00:00:00.000Z');
  });

  it('walks the tables then switches to the split', () => {
    const c = initialCursor(NOW, 0);
    c.after = { detected_at: '2026-11-01T00:00:00Z', key: MINT };
    nextTable(c);
    assert.equal(c.phase, 'simulate');
    assert.equal(DETECTION_TABLES[c.table], 'preset_signals');
    assert.equal(c.after, null);
    nextTable(c);
    assert.equal(c.phase, 'simulate');
    assert.equal(DETECTION_TABLES[c.table], 'backtest_events');
    nextTable(c);
    assert.equal(c.phase, 'split');
  });

  it('progress grows monotonically through the phases and stays in [0, 1]', () => {
    const c = initialCursor(NOW, 100);
    const seen = [progressOf(c)];
    for (let i = 0; i < 100; i++) recordDetection(c, '2026-11-01T00:00:00Z', String(i + 1), '1m');
    seen.push(progressOf(c));
    nextTable(c);
    nextTable(c);
    nextTable(c);
    seen.push(progressOf(c));
    c.phase = 'aggregate';
    for (let s = 0; s < AGG_TOTAL_STEPS; s++) {
      seen.push(progressOf(c));
      advanceAggregate(c);
    }
    seen.push(progressOf(c));
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `step ${i}`);
    assert.equal(seen[0], 0);
    assert.ok(seen[1] < 0.8 + 1e-9);
    assert.equal(seen[seen.length - 1], 1);
    // More detections than estimated: never above the simulation share.
    const d = initialCursor(NOW, 1);
    for (let i = 0; i < 5; i++) recordDetection(d, '2026-11-01T00:00:00Z', String(i + 1), null);
    assert.ok(progressOf(d) <= 0.8);
  });
});

describe('cutoffIndex', () => {
  it('reproduces backtest.ts chronoCutoff for every size', () => {
    for (let n = 0; n <= 60; n++) {
      const ts = Array.from({ length: n }, (_, i) => 1_000 + i * 7);
      const engine = chronoCutoff(ts);
      const idx = cutoffIndex(n);
      if (engine === null) assert.equal(idx, null, `n=${n}`);
      else assert.equal(ts[idx as number], engine, `n=${n}`);
    }
  });

  it('70 % train for a large sample', () => {
    assert.equal(cutoffIndex(1000), 700);
    assert.equal(cutoffIndex(1), null);
    assert.equal(cutoffIndex(2.5), null);
  });
});

describe('keysetFilter', () => {
  it('builds the PostgREST or= filter after (detected_at, key), µs kept', () => {
    assert.equal(keysetFilter(null, 'mint'), null);
    assert.equal(
      keysetFilter({ detected_at: '2026-11-01T10:00:00.123456+00:00', key: MINT }, 'mint'),
      `detected_at.gt."2026-11-01T10:00:00.123456+00:00",and(detected_at.eq."2026-11-01T10:00:00.123456+00:00",mint.gt.${MINT})`,
    );
    assert.equal(
      keysetFilter({ detected_at: '2026-11-01T10:00:00Z', key: '42' }, 'id'),
      'detected_at.gt."2026-11-01T10:00:00Z",and(detected_at.eq."2026-11-01T10:00:00Z",id.gt.42)',
    );
  });

  it('refuses a key that could inject filter syntax', () => {
    assert.equal(keysetFilter({ detected_at: '2026-11-01T10:00:00Z', key: 'a,b' }, 'mint'), null);
    assert.equal(keysetFilter({ detected_at: '2026-11-01T10:00:00Z', key: 'x)' }, 'mint'), null);
    // Quotes in the timestamp are stripped.
    assert.ok(!keysetFilter({ detected_at: '2026-11-01T10:00:00Z"', key: '1' }, 'id')?.includes('Z""'));
  });
});

describe('presetFlagValues', () => {
  it('detection presets: odd detection bitsets with the bit; event presets: their single bit', () => {
    // Detection bits: DETECTION_ROW_BIT 1, young_calm 1024, young_frenzy 2048 (calm and frenzy never together, but the
    // IN list does not need to know that).
    assert.deepEqual(presetFlagValues('young_calm'), [1025, 3073]);
    assert.deepEqual(presetFlagValues('young_frenzy'), [2049, 3073]);
    assert.deepEqual(presetFlagValues('young_calm_ev'), [PRESET_BIT.young_calm_ev]);
    assert.deepEqual(presetFlagValues('young_frenzy_ev'), [8192]);
    assert.ok(PRESETS.every((p) => presetFlagValues(p).length > 0));
  });
});

describe('events in the cursor (lab-v2)', () => {
  it('recordEvent counts traded / pending events; v1 cursors parse with 0', () => {
    const c = initialCursor(NOW, 3);
    recordEvent(c, '2026-11-01T00:00:00Z', '1', { traded: true, finest: '1m', pending: false });
    recordEvent(c, '2026-11-01T00:01:00Z', '2', { traded: false, finest: null, pending: true });
    recordEvent(c, '2026-11-01T00:02:00Z', '3', null);
    assert.equal(c.events, 1);
    assert.equal(c.pending, 2);
    assert.equal(c.read, 3);
    assert.deepEqual(c.after, { detected_at: '2026-11-01T00:02:00Z', key: '3' });
    assert.equal(c.res['1m'], 0, 'events never count as detections');
    assert.equal(c.eres['1m'], 1);
    const dv = finalDataVersion(c);
    assert.equal(dv.n_detections, 0);
    assert.equal(dv.events, 1);
    assert.equal(dv.events_pending, 2);
    assert.deepEqual(dv.event_resolutions, { '1m': 1, '5m': 0, '15m': 0, none: 0 });
    const raw = JSON.parse(JSON.stringify(c));
    assert.deepEqual(parseCursor(raw), c);
    delete raw.events;
    delete raw.pending;
    delete raw.eres;
    const v1 = parseCursor(raw);
    assert.equal(v1?.events, 0);
    assert.equal(v1?.pending, 0);
    assert.equal(parseCursor({ ...raw, pending: -1 }), null);
    assert.equal(v1?.xevents, 0);
    assert.equal(v1?.xpending, 0);
  });
  it('legacy exploratory counters of an in-flight cursor still parse and are excluded from n_events; 24 variants', () => {
    const c = initialCursor(NOW, 3);
    recordEvent(c, '2026-11-01T00:00:00Z', '1', { traded: true, finest: '1m', pending: false });
    recordEvent(c, '2026-11-01T00:01:00Z', '2', { traded: true, finest: '1m', pending: false });
    const raw = { ...JSON.parse(JSON.stringify(c)), xevents: 1, xpending: 0 };
    const back = parseCursor(raw)!;
    assert.equal(back.xevents, 1);
    assert.equal(confirmatoryEvents(back), 1);
    assert.equal(confirmatoryEvents(c), 2);
    assert.equal(parseCursor({ ...raw, xevents: 3 }), null, 'more exploratory than events');
    const dv = finalDataVersion(c);
    assert.equal(dv.n_variants, 24);
    assert.equal(dv.n_distinct_variants, 24);
    assert.ok(!('events_exploratory' in dv) && !('n_exploratory_variants' in dv));
  });
  it('keysetFilter on event_at', () => {
    assert.equal(
      keysetFilter({ detected_at: '2026-11-01T10:00:00Z', key: '42' }, 'id', 'event_at'),
      'event_at.gt."2026-11-01T10:00:00Z",and(event_at.eq."2026-11-01T10:00:00Z",id.gt.42)',
    );
  });
});

describe('resultRow', () => {
  const base: BacktestResult = {
    preset: 'all',
    exit: 'thirds_x2_x3_x4',
    sl_pct: 30,
    breakeven: true,
    time_exit_h: null,
    delay_min: 2,
    narrative: 'gta',
    split: 'test',
    trades: 40,
    win_rate: 0.425,
    avg_win_pct: 61.23456789,
    avg_loss_pct: -28.5,
    avg_net_pct: 4.2,
    avg_net_sol: 0.0042,
    profit_factor: 1.3,
    max_drawdown_sol: 0.12,
    worst_losing_streak: 6,
    open_at_end: 1,
    ci_low: -1.5,
    ci_high: 9.8,
    ci_contains_zero: true,
    retained: true,
    robust: false,
  };

  it('maps a BacktestResult to the table row (no time exit = 0)', () => {
    const r = resultRow(7, base);
    assert.equal(r.run_id, 7);
    assert.equal(r.time_exit_h, 0);
    assert.equal(r.avg_win_pct, 61.234568);
    assert.equal(r.ci_contains_zero, true);
    assert.equal(resultRow(7, { ...base, time_exit_h: 6 }).time_exit_h, 6);
  });

  it('nulls non-finite metrics and out-of-range profit factors', () => {
    const r = resultRow(1, { ...base, profit_factor: Number.POSITIVE_INFINITY, win_rate: null, ci_low: Number.NaN });
    assert.equal(r.profit_factor, null);
    assert.equal(r.win_rate, null);
    assert.equal(r.ci_low, null);
    assert.equal(resultRow(1, { ...base, profit_factor: 2e9 }).profit_factor, null);
  });
});

describe('finalDataVersion', () => {
  it('counts every detection read and the train / test parts of the traded ones', () => {
    const c = initialCursor(NOW, 4);
    recordDetection(c, '2026-11-01T00:00:00Z', '1', '1m');
    recordDetection(c, '2026-11-02T00:00:00Z', '2', '5m');
    recordDetection(c, '2026-11-03T00:00:00Z', '3', '15m');
    recordDetection(c, '2026-11-04T00:00:00Z', '4', null);
    c.traded = 3;
    c.test = 1;
    c.cutoff = '2026-11-03T00:00:00+00:00';
    const dv = finalDataVersion(c);
    assert.equal(dv.n_detections, 4);
    assert.deepEqual(dv.resolutions, { '1m': 1, '5m': 1, '15m': 1, none: 1 });
    assert.equal(dv.train, 2);
    assert.equal(dv.test, 1);
    assert.equal(dv.cutoff_at, '2026-11-03T00:00:00+00:00');
    assert.equal(dv.max_detected_at, '2026-11-03T00:00:00.000Z');
  });
});

describe('retentionCutoffs', () => {
  it('keeps the trades of the last 3 runs and the results of the last 14', () => {
    assert.deepEqual(retentionCutoffs([1, 2, 3]), { tradesBelow: null, resultsBelow: null });
    assert.deepEqual(retentionCutoffs([4, 1, 3, 2]), { tradesBelow: 2, resultsBelow: null });
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    const r = retentionCutoffs(ids);
    assert.equal(r.tradesBelow, 20 - KEEP_TRADES_RUNS + 1);
    assert.equal(r.resultsBelow, 20 - KEEP_RESULTS_RUNS + 1);
    // Garbage and duplicates ignored.
    assert.deepEqual(retentionCutoffs([5, 5, -1, 1.5, 4, 3, 2]), { tradesBelow: 3, resultsBelow: null });
  });
});

describe('aggregation chunks', () => {
  it('walks preset → combo range → narrative: 1 chunk × 3 narratives per preset (4 presets) = 12 steps', () => {
    assert.equal(AGG_CHUNKS, Math.ceil(DISTINCT_COMBOS.length / AGG_CHUNK_COMBOS));
    const full = PRESETS.length - YOUNG_CALM_PRESETS.length;
    assert.equal(full, 0);
    assert.equal(AGG_TOTAL_STEPS, YOUNG_CALM_PRESETS.length * NARRATIVES.length);
    assert.equal(AGG_TOTAL_STEPS, 12);
    // The 6 grid combos (all_x2, SL 20 / 30 / 40, no breakeven, no time exit, delay 0 / 2) all sit in the first chunk.
    for (const p of YOUNG_CALM_PRESETS) {
      assert.deepEqual(Array.from({ length: AGG_CHUNKS }, (_, k) => chunkHasCombos(p, k)), [true, false, false, false, false, false]);
    }
    const c = initialCursor(NOW, 0);
    c.phase = 'aggregate';
    const covered = new Map<string, number>();
    let steps = 0;
    let prev = null as ReturnType<typeof aggregateStep>;
    let reads = 0;
    const inGrid = (preset: string, idx: number) =>
      presetCombos(preset as (typeof PRESETS)[number]).some((x) => x.index === idx);
    for (let step = aggregateStep(c); step !== null; step = aggregateStep(c)) {
      steps++;
      if (!sameSlice(prev, step)) reads++;
      prev = step;
      const [lo, hi] = step.span;
      for (let i = step.comboRange[0]; i < step.comboRange[1]; i++) {
        const idx = DISTINCT_COMBOS[i].index;
        if (!inGrid(step.preset, idx)) continue;
        assert.ok(idx >= lo && idx <= hi);
        const k = `${step.preset}|${step.narrative}|${idx}`;
        covered.set(k, (covered.get(k) ?? 0) + 1);
      }
      // A chunk is a whole number of delay triples.
      assert.equal((step.comboRange[1] - step.comboRange[0]) % 3, 0);
      advanceAggregate(c);
    }
    assert.equal(steps, AGG_TOTAL_STEPS);
    // One slice read per (preset, range), reused by 3 narratives; young-calm presets: one range only.
    assert.equal(reads, full * AGG_CHUNKS + YOUNG_CALM_PRESETS.length);
    assert.equal(covered.size, YOUNG_CALM_PRESETS.length * 6 * NARRATIVES.length);
    assert.ok([...covered.values()].every((n) => n === 1));
    assert.equal(c.preset, PRESETS.length);
    assert.equal(progressOf(c), 1);
  });

  it('persists the chunk position through the cursor', () => {
    const c = initialCursor(NOW, 0);
    c.phase = 'aggregate';
    for (let i = 0; i < 17; i++) advanceAggregate(c);
    const back = parseCursor(JSON.parse(JSON.stringify(c)));
    assert.deepEqual(back, c);
    assert.deepEqual(aggregateStep(back!), aggregateStep(c));
    const raw = JSON.parse(JSON.stringify(c));
    assert.equal(parseCursor({ ...raw, chunk: AGG_CHUNKS }), null);
    assert.equal(parseCursor({ ...raw, narr: 3 }), null);
  });

  it('chunked aggregation on returns slices equals the full aggregation', () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const mints = ['D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump', 'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'];
    const rows = Array.from({ length: 120 }, (_, k) => {
      const noTradeDelay = k % 7 === 0 ? 2 : -1; // some detections without an entry at one delay
      return {
        source: k % 5 ? 'signal_outcomes' : 'preset_signals',
        mint: mints[k % 4].slice(0, 40) + String(1000 + k).slice(-4).replace(/0/g, 'z'),
        detected_at: new Date(NOW - (200 - k) * 3_600_000).toISOString(),
        split: k < 84 ? 'train' : 'test',
        preset_flags: k % 3 ? 1025 : 2049,
        narrative: k % 4 ? 'other' : 'gta',
        returns: Array.from({ length: N_COMBOS }, (_, i) => (i % 3 === noTradeDelay ? null : Math.round((rnd() * 60 - 25) * 1e4) / 1e4)),
        open_at_end: '0'.repeat(96),
      };
    });
    const full = rows.map((r) => parseTradeRow(r)).filter((t) => t !== null);
    assert.equal(full.length, rows.length);
    for (const preset of ['young_calm', 'young_frenzy'] as const) {
      const expected = aggregatePreset(full, preset, { minTestTrades: 5 });
      assert.equal(expected.length, 36);
      const got: BacktestResult[] = [];
      const c = initialCursor(NOW, 0);
      c.phase = 'aggregate';
      c.preset = PRESETS.indexOf(preset);
      for (let s = 0; s < NARRATIVES.length; s++) {
        const step = aggregateStep(c)!;
        const sliced = rows
          .filter((r) => (r.preset_flags & PRESET_BIT[preset]) !== 0)
          .map((r) => parseTradeRow({ ...r, returns: r.returns.slice(step.span[0], step.span[1] + 1) }, step.span[0]))
          .filter((t) => t !== null);
        got.push(...aggregatePreset(sliced, preset, {
          narratives: [step.narrative], comboRange: step.comboRange, returnsOffset: step.span[0], minTestTrades: 5,
        }));
        advanceAggregate(c);
      }
      const key = (r: BacktestResult) => `${r.exit}|${r.sl_pct}|${r.breakeven}|${r.time_exit_h}|${r.delay_min}|${r.narrative}|${r.split}`;
      const byKey = new Map(got.map((r) => [key(r), r]));
      assert.equal(byKey.size, expected.length);
      for (const e of expected) assert.deepEqual(byKey.get(key(e)), e, key(e));
    }
  });
});

describe('dedupeTradeRows (regression: runs 5 and 6 failed on « ON CONFLICT DO UPDATE … a second time »)', () => {
  const base = { run_id: 5, source: 'preset_signals', mint: 'So11111111111111111111111111111111111111112', detected_at: '2026-11-20T00:28:36.000Z', preset_flags: 1 };
  it('keeps one row per primary key within a batch (two presets matched the same mint in the same scan)', () => {
    const rows = [{ ...base, returns: [1] }, { ...base, returns: [2] }, { ...base, preset_flags: 17, returns: [3] }];
    const out = dedupeTradeRows(rows);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].returns, [1]); // first kept
    assert.equal(out[1].preset_flags, 17);
  });
  it('rows differing by any key column are kept', () => {
    const rows = [base, { ...base, detected_at: '2026-11-20T00:30:36.000Z' }, { ...base, source: 'signal_outcomes' }, { ...base, run_id: 6 }];
    assert.equal(dedupeTradeRows(rows).length, 4);
  });
  it('the key columns are the backtest_trades primary key', () => {
    assert.deepEqual([...TRADE_KEY_COLUMNS], ['run_id', 'source', 'mint', 'detected_at', 'preset_flags']);
  });
});
