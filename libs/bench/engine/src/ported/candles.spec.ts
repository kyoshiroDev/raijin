// Backtest candle storage: capture windows, compact encoding, merged path, capture queue (feat/strategy-lab).
// Pure, no network (fetchCandleWindow is exercised with a mocked fetch).
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_SPEC,
  candlePlan,
  captureWindow,
  cleanCandles,
  decodeOhlcvRow,
  encodeCandles,
  firstAtOrAfter,
  initialCandleSchedule,
  isWindowCovered,
  mergePath,
  ohlcvRow,
  TF_STEP_S,
} from './candles';
import {
  CANDLE_MAX_ATTEMPTS,
  CANDLE_RETRY_MS,
  candleQueueColumns,
  candleScheduleFor,
  candlesDoneUpdate,
  candlesFailureUpdate,
  type CandleItem,
  type CandleTable,
  compareCandleItems,
  LAB_EVENT_PRESETS,
  mergeWorkQueue,
  ONE_MINUTE_MAX_PAIR_AGE_H,
  oneMinuteCandlesWanted,
  pairAgeAtDetectionH,
  parseCandleRow,
  WORK_PRIORITY,
  workRank,
} from './candle-queue';
import type { LabelItem, LabelTable } from './label-queue';
import { setupZodForNode } from './test-support/zod-node';
import type { Candle } from './types';

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const H = 3_600_000;
const DET = Date.UTC(2026, 10, 18, 10, 7, 30);
const iso = (ms: number) => new Date(ms).toISOString();
const cdl = (t: number, o: number, h: number, l: number, c: number, v = 1): Candle => [t, o, h, l, c, v];

describe('captureWindow / candlePlan', () => {
  it('1m: detection floored to the minute, 360 candles, due at detection + 6 h', () => {
    const w = captureWindow('1m', DET);
    assert.ok(w);
    assert.equal(w.fromSec, Date.UTC(2026, 10, 18, 10, 7) / 1000);
    assert.equal(w.toSec - w.fromSec, 360 * 60);
    assert.equal(w.dueAtMs, DET + 6 * H);
    assert.deepEqual(candlePlan(w), { timeframe: 'minute', aggregate: 1, stepSec: 60, fromSec: w.fromSec, toSec: w.toSec, limit: 360 });
  });
  it('5m: floored to 5 minutes, 864 candles (72 h), due at detection + 72 h', () => {
    const w = captureWindow('5m', DET);
    assert.ok(w);
    assert.equal(w.fromSec, Date.UTC(2026, 10, 18, 10, 5) / 1000);
    assert.equal(w.limit, 864);
    assert.equal(w.aggregate, 5);
    assert.equal(w.toSec - w.fromSec, 72 * 3600);
    assert.equal(w.dueAtMs, DET + 72 * H);
    assert.equal(CAPTURE_SPEC['5m'].limit * TF_STEP_S['5m'], 72 * 3600);
  });
  it('invalid time → null', () => {
    assert.equal(captureWindow('1m', Number.NaN), null);
    assert.equal(captureWindow('5m', 0), null);
    assert.equal(initialCandleSchedule(Number.NaN), null);
  });
  it('initialCandleSchedule', () => {
    assert.deepEqual(initialCandleSchedule(DET), { candles_1m_at: iso(DET + 6 * H), candles_5m_at: iso(DET + 72 * H) });
  });
});

describe('compact encoding', () => {
  const t0 = 1_800_000_000;
  const raw = [cdl(t0 + 120, 3, 3, 3, 3), cdl(t0, 1, 2, 0.5, 1.5, 10), cdl(t0 + 60, 1.5, 1.6, 1.4, 1.5, 0)];
  it('cleanCandles: sorted, deduplicated, invalid rows dropped', () => {
    const bad = [cdl(t0 + 180, 0, 1, 1, 1), cdl(t0 + 240, 1, 0.5, 1, 1), [t0 + 300, 1, 1, 1], cdl(t0, 9, 9, 9, 9), 'x', null];
    assert.deepEqual(cleanCandles([...raw, ...bad] as unknown[]).map((c) => c[0]), [t0, t0 + 60, t0 + 120]);
    assert.deepEqual(cleanCandles([...raw, cdl(t0, 9, 9, 9, 9)]).find((c) => c[0] === t0), raw[1], 'first seen wins');
  });
  it('encode → row → decode round trip keeps gaps (offsets)', () => {
    const withGap = [...raw, cdl(t0 + 600, 2, 2.5, 1.9, 2.2, 5)];
    const row = ohlcvRow({ mint: MINT, pool: PAIR, tf: '1m', candles: withGap, source: 'signal_outcomes', detectedAtMs: DET, fetchedAtMs: DET + 6 * H });
    assert.ok(row);
    assert.equal(row.ts_start, iso(t0 * 1000));
    assert.deepEqual(row.ts, [0, 60, 120, 600]);
    assert.equal(row.step_s, 60);
    assert.deepEqual(row.c, [1.5, 1.5, 3, 2.2]);
    assert.equal(row.detected_at, iso(DET));
    const back = decodeOhlcvRow(JSON.parse(JSON.stringify(row)));
    assert.ok(back);
    assert.equal(back.tf, '1m');
    assert.deepEqual(back.candles, cleanCandles(withGap));
  });
  it('decode accepts numeric strings (PostgREST numeric / CLI output) and rejects malformed rows', () => {
    const enc = encodeCandles(raw);
    assert.ok(enc);
    const row = { tf: '5m', step_s: 300, ...enc, o: enc.o.map(String) };
    assert.equal(decodeOhlcvRow(row)?.candles.length, 3);
    assert.equal(decodeOhlcvRow({ ...row, step_s: 60 }), null, 'step does not match tf');
    assert.equal(decodeOhlcvRow({ ...row, tf: '2m' }), null);
    assert.equal(decodeOhlcvRow({ ...row, c: [1] }), null, 'length mismatch');
    assert.equal(decodeOhlcvRow({ ...row, ts_start: 'nope' }), null);
    assert.equal(decodeOhlcvRow({ ...row, h: ['x', 1, 1] }), null);
    assert.equal(decodeOhlcvRow(null), null);
  });
  it('ohlcvRow rejects bad addresses, tf, source, time or empty candles', () => {
    const base = { mint: MINT, pool: PAIR, tf: '1m' as const, candles: raw, source: 'preset_signals' as const, detectedAtMs: DET, fetchedAtMs: DET };
    assert.ok(ohlcvRow(base));
    assert.equal(ohlcvRow({ ...base, mint: 'bad' }), null);
    assert.equal(ohlcvRow({ ...base, pool: '<script>' }), null);
    assert.equal(ohlcvRow({ ...base, tf: '2m' as never }), null);
    assert.equal(ohlcvRow({ ...base, source: 'early_outcomes' as never }), null);
    assert.equal(ohlcvRow({ ...base, detectedAtMs: Number.NaN }), null);
    assert.equal(ohlcvRow({ ...base, candles: [] }), null);
  });
});

describe('mergePath', () => {
  const t0 = 1_800_000_000; // multiple of 900
  const series1m = { tf: '1m' as const, candles: Array.from({ length: 30 }, (_, i) => cdl(t0 + i * 60, 1, 1.1, 0.9, 1)) }; // [t0, t0+30m)
  const series5m = { tf: '5m' as const, candles: Array.from({ length: 24 }, (_, i) => cdl(t0 + i * 300, 2, 2.2, 1.8, 2)) }; // [t0, t0+2h)
  const series15m = { tf: '15m' as const, candles: Array.from({ length: 16 }, (_, i) => cdl(t0 + i * 900, 3, 3.3, 2.7, 3)) }; // [t0, t0+4h)
  it('uses the finest resolution at each instant, without overlap', () => {
    const p = mergePath([series15m, series5m, series1m]);
    assert.equal(p.finest, '1m');
    assert.deepEqual(p.tfs, ['1m', '5m', '15m']);
    // 30 × 1m, then 5m from t0+30m to t0+2h (18), then 15m from t0+2h to t0+4h (8).
    assert.equal(p.n, 30 + 18 + 8);
    for (let i = 1; i < p.n; i++) assert.ok(p.t[i] >= p.end[i - 1], `overlap at ${i}`);
    assert.equal(p.c[29], 1);
    assert.equal(p.c[30], 2);
    assert.equal(p.t[30], t0 + 1800);
    assert.equal(p.c[48], 3);
    assert.equal(p.t[48], t0 + 7200);
  });
  it('a coarse candle straddling a finer span edge is dropped', () => {
    const odd1m = { tf: '1m' as const, candles: Array.from({ length: 7 }, (_, i) => cdl(t0 + i * 60, 1, 1, 1, 1)) }; // ends t0+7m
    const p = mergePath([odd1m, series5m]);
    // 5m candles [t0, t0+5m) and [t0+5m, t0+10m) overlap the 1m span → the first 5m kept starts at t0+10m.
    assert.equal(p.t[7], t0 + 600);
    assert.equal(p.n, 7 + 22);
  });
  it('gaps inside a finer series are not filled by coarser candles', () => {
    const gappy = { tf: '1m' as const, candles: [cdl(t0, 1, 1, 1, 1), cdl(t0 + 1740, 1, 1, 1, 1)] }; // span [t0, t0+30m)
    const p = mergePath([gappy, series5m]);
    assert.equal(p.n, 2 + 18);
    assert.equal(p.t[2], t0 + 1800);
  });
  it('only 15m → finest 15m; empty → n 0', () => {
    assert.equal(mergePath([series15m]).finest, '15m');
    const e = mergePath([]);
    assert.equal(e.n, 0);
    assert.equal(e.finest, null);
  });
  it('two rows of the same tf (two detections of a mint) are merged, duplicates once', () => {
    const a = { tf: '1m' as const, candles: [cdl(t0, 1, 1, 1, 1), cdl(t0 + 60, 1, 1, 1, 1)] };
    const b = { tf: '1m' as const, candles: [cdl(t0 + 60, 9, 9, 9, 9), cdl(t0 + 120, 1, 1, 1, 1)] };
    const p = mergePath([a, b]);
    assert.equal(p.n, 3);
    assert.equal(p.c[1], 1);
  });
  it('firstAtOrAfter', () => {
    const p = mergePath([series1m]);
    assert.equal(firstAtOrAfter(p, t0 - 1), 0);
    assert.equal(firstAtOrAfter(p, t0), 0);
    assert.equal(firstAtOrAfter(p, t0 + 1), 1);
    assert.equal(firstAtOrAfter(p, t0 + 10_000), 30);
  });
});

describe('isWindowCovered', () => {
  it('a window of the same tf detected a few minutes apart covers; hours apart does not', () => {
    const w = captureWindow('1m', DET);
    assert.ok(w);
    assert.equal(isWindowCovered([{ tf: '1m', detected_at: iso(DET - 10 * 60_000) }], w), true);
    assert.equal(isWindowCovered([{ tf: '1m', detected_at: iso(DET - 3 * H) }], w), false);
    assert.equal(isWindowCovered([{ tf: '5m', detected_at: iso(DET) }], w), false);
    assert.equal(isWindowCovered([{ tf: '1m', detected_at: 'x' }], w), false);
  });
});

describe('candle queue', () => {
  const NOW = DET + 100 * H;
  const row = (over: Record<string, unknown> = {}) => ({
    mint: MINT, pair_address: PAIR, detected_at: iso(DET), candles_1m_at: iso(DET + 6 * H), candles_5m_at: iso(DET + 72 * H), candles_attempts: 0, ...over,
  });
  it('columns', () => {
    assert.equal(candleQueueColumns('signal_outcomes'), 'mint, pair_address, detected_at, pair_age_h, candles_1m_at, candles_5m_at, candles_attempts');
    assert.ok(candleQueueColumns('preset_signals').startsWith('id, '));
  });
  it('parseCandleRow returns the due timeframes only', () => {
    assert.deepEqual(parseCandleRow('signal_outcomes', row(), NOW).map((i) => i.tf), ['1m', '5m']);
    assert.deepEqual(parseCandleRow('signal_outcomes', row(), DET + 10 * H).map((i) => i.tf), ['1m']);
    assert.deepEqual(parseCandleRow('signal_outcomes', row({ candles_1m_at: null }), NOW).map((i) => i.tf), ['5m']);
    const p = parseCandleRow('preset_signals', row({ id: '42' }), NOW);
    assert.equal(p[0].keyColumn, 'id');
    assert.equal(p[0].keyValue, 42);
    assert.deepEqual(parseCandleRow('preset_signals', row(), NOW), [], 'preset row without id');
    assert.deepEqual(parseCandleRow('signal_outcomes', row({ mint: 'bad' }), NOW), []);
    assert.deepEqual(parseCandleRow('signal_outcomes', row({ detected_at: 'x' }), NOW), []);
    assert.deepEqual(parseCandleRow('early_outcomes' as never, row(), NOW), []);
    assert.equal(parseCandleRow('signal_outcomes', row({ pair_age_h: '5.5' }), NOW)[0].pairAgeH, 5.5);
    assert.equal(parseCandleRow('preset_signals', row({ id: 1, pair_age_h: 2 }), NOW)[0].pairAgeH, 2);
    assert.equal(parseCandleRow('signal_outcomes', row({ pair_age_h: null }), NOW)[0].pairAgeH, null);
    assert.equal(parseCandleRow('signal_outcomes', row({ pair_age_h: -1 }), NOW)[0].pairAgeH, null);
    assert.equal(parseCandleRow('backtest_events', row({ id: 1, pair_age_h: 2 }), NOW)[0].pairAgeH, null, 'events: no rank 1');
  });
  const ci = (table: CandleTable, key: string | number, dueH: number, tf: '1m' | '5m' = '1m', pairAgeH: number | null = null): CandleItem => ({
    table, keyColumn: table === 'signal_outcomes' ? 'mint' : 'id', keyValue: key, mint: MINT, pairAddress: PAIR, detectedAtMs: DET, attempts: 0, tf,
    dueAtMs: DET + dueH * H, pairAgeH,
  });
  const li = (table: LabelTable, key: string | number): LabelItem => ({
    table, keyColumn: table === 'preset_signals' ? 'id' : 'mint', keyValue: key, mint: MINT, pairAddress: PAIR, detectedAtMs: DET, entryPrice: 1,
    attempts: 0, labelledAtMs: null, nextLabelAtMs: null,
  });
  it('compareCandleItems: oldest due, then 1m before 5m', () => {
    const items = [ci('signal_outcomes', 'b', 5, '5m'), ci('signal_outcomes', 'a', 5, '1m'), ci('signal_outcomes', 'c', 1, '5m')];
    assert.deepEqual(items.sort(compareCandleItems).map((i) => i.keyValue), ['c', 'a', 'b']);
  });
  it('mergeWorkQueue (feat/calm-sl-test): young detection 1m > other detection 1m > event 1m > preset labels > scan labels > 5m', () => {
    assert.deepEqual(WORK_PRIORITY.map((g) => (g.kind === 'label' ? `label:${g.table}` : `candles:${g.tf}:${g.tables.join('+')}${g.maxPairAgeH !== undefined ? `:<${g.maxPairAgeH}h` : ''}`)), [
      'candles:1m:signal_outcomes+preset_signals:<24h',
      'candles:1m:signal_outcomes+preset_signals',
      'candles:1m:backtest_events',
      'label:preset_signals',
      'label:signal_outcomes',
      'candles:5m:backtest_events+signal_outcomes+preset_signals',
    ]);
    const q = mergeWorkQueue(
      [li('early_outcomes' as never, 'r'), li('signal_outcomes', 's'), li('preset_signals', 1)],
      [
        ci('signal_outcomes', 's', 1, '5m'), ci('signal_outcomes', 's', 1), ci('preset_signals', 2, 0), ci('preset_signals', 2, 0),
        ci('backtest_events', 9, 3), ci('backtest_events', 9, 3, '5m'),
      ],
      20,
    );
    assert.deepEqual(q.map((w) => `${w.kind}:${w.item.table}:${w.kind === 'candles' ? w.item.tf : ''}`), [
      'candles:preset_signals:1m', 'candles:signal_outcomes:1m', 'candles:backtest_events:1m', 'label:preset_signals:',
      'label:signal_outcomes:', 'candles:signal_outcomes:5m', 'candles:backtest_events:5m',
    ]);
    assert.deepEqual(q.map(workRank), [1, 1, 2, 3, 4, 5, 5]);
    // Absolute priority of the detections < 24 h: even a later due time, queued first and only once.
    const young = mergeWorkQueue(
      [li('preset_signals', 1)],
      [ci('signal_outcomes', 'old', 0, '1m', 30), ci('preset_signals', 7, 50, '1m', 2), ci('signal_outcomes', 'unk', 1), ci('signal_outcomes', 'y', 40, '1m', 23.9)],
      10,
    );
    assert.deepEqual(young.map((w) => String(w.item.keyValue)), ['y', '7', 'old', 'unk', '1']);
    assert.deepEqual(young.map(workRank), [0, 0, 1, 1, 3]);
    assert.equal(mergeWorkQueue([], [ci('signal_outcomes', 'a', 0, '1m', 30), ci('preset_signals', 3, 99, '1m', 1)], 1)[0].item.keyValue, 3);
    assert.equal(workRank({ kind: 'candles', item: ci('backtest_events', 1, 0, '1m', 1) }), 2, 'events never first rank');
    assert.equal(workRank({ kind: 'candles', item: ci('signal_outcomes', 1, 0, '5m', 1) }), 5, '5 minutes stay last');
    // A single slot: detection 1m beats every label, an event 1m beats the preset labels, a scan label beats 5m.
    assert.equal(mergeWorkQueue([li('preset_signals', 1)], [ci('signal_outcomes', 's', 1)], 1)[0].kind, 'candles');
    assert.equal(mergeWorkQueue([li('preset_signals', 1)], [ci('backtest_events', 9, 1)], 1)[0].kind, 'candles');
    assert.equal(mergeWorkQueue([li('signal_outcomes', 'r')], [ci('signal_outcomes', 's', 1, '5m')], 1)[0].kind, 'label');
    assert.deepEqual(LAB_EVENT_PRESETS, ['young_calm_ev', 'young_frenzy_ev']);
    const two = mergeWorkQueue([li('signal_outcomes', 's'), li('preset_signals', 1)], [], 2);
    assert.deepEqual(two.map((w) => w.item.table), ['preset_signals', 'signal_outcomes']);
    assert.deepEqual(mergeWorkQueue([li('preset_signals', 1)], [], 0), []);
  });
  it('backtest_events rows: aliased columns, key id', () => {
    assert.equal(candleQueueColumns('backtest_events'), 'id, mint, pair_address:pool, detected_at:event_at, candles_1m_at, candles_5m_at, candles_attempts');
    const p = parseCandleRow('backtest_events', row({ id: 5 }), NOW);
    assert.equal(p.length, 2);
    assert.equal(p[0].keyColumn, 'id');
    assert.equal(p[0].keyValue, 5);
    assert.deepEqual(parseCandleRow('backtest_events', row(), NOW), []);
  });
  it('no 1-minute candles for pairs ≥ 48 h at the detection (unknown age kept, events always); 5 minutes always', () => {
    assert.equal(ONE_MINUTE_MAX_PAIR_AGE_H, 48);
    assert.equal(oneMinuteCandlesWanted(47.9), true);
    assert.equal(oneMinuteCandlesWanted(48), false);
    assert.equal(oneMinuteCandlesWanted(null), true);
    assert.equal(pairAgeAtDetectionH(DET - 2 * H, DET), 2);
    assert.equal(pairAgeAtDetectionH(DET + 60_000, DET), 0);
    assert.equal(pairAgeAtDetectionH(DET + 3_600_000, DET), null);
    assert.equal(pairAgeAtDetectionH(null, DET), null);
    const now = DET + H;
    assert.deepEqual(candleScheduleFor('signal_outcomes', DET, DET - 10 * H, now), { candles_1m_at: iso(DET + 6 * H), candles_5m_at: iso(DET + 72 * H) });
    assert.deepEqual(candleScheduleFor('preset_signals', DET, DET - 72 * H, now), { candles_1m_at: null, candles_5m_at: iso(DET + 72 * H) });
    assert.deepEqual(candleScheduleFor('signal_outcomes', DET, null, now), { candles_1m_at: iso(DET + 6 * H), candles_5m_at: iso(DET + 72 * H) });
    assert.deepEqual(candleScheduleFor('backtest_events', DET, DET - 500 * H, now), { candles_1m_at: iso(DET + 6 * H), candles_5m_at: iso(DET + 72 * H) });
    assert.deepEqual(candleScheduleFor('signal_outcomes', DET, DET - H, DET + 31 * 24 * H), { candles_1m_at: null, candles_5m_at: null });
    assert.equal(candleScheduleFor('signal_outcomes', Number.NaN, null, now), null);
  });
  it('updates: done → null; failure → retry 1 h, abandoned on not_found / invalid or after max attempts', () => {
    assert.deepEqual(candlesDoneUpdate('1m'), { candles_1m_at: null });
    assert.deepEqual(candlesDoneUpdate('5m'), { candles_5m_at: null });
    assert.deepEqual(candlesFailureUpdate('1m', 0, NOW, 'error'), { candles_1m_at: iso(NOW + CANDLE_RETRY_MS), candles_attempts: 1 });
    assert.deepEqual(candlesFailureUpdate('5m', 2, NOW, 'not_found'), { candles_5m_at: null, candles_attempts: 3 });
    assert.deepEqual(candlesFailureUpdate('5m', 0, NOW, 'invalid'), { candles_5m_at: null, candles_attempts: 1 });
    assert.deepEqual(candlesFailureUpdate('1m', CANDLE_MAX_ATTEMPTS - 1, NOW, 'error'), { candles_1m_at: null, candles_attempts: CANDLE_MAX_ATTEMPTS });
    assert.throws(() => candlesFailureUpdate('1m', 0, Number.NaN, 'error'), RangeError);
  });
});

const zodReady = setupZodForNode();
const G = require('./gecko-history') as typeof import('./gecko-history');

describe('fetchCandleWindow (mocked fetch)', { skip: !zodReady && 'zod not found in node_modules/.pnpm' }, () => {
  const g = G as NonNullable<typeof G>;
  const w = captureWindow('5m', DET);
  assert.ok(w);
  const plan = candlePlan(w);
  const respond = (status: number, body: unknown) => {
    const urls: string[] = [];
    const fetchFn = (u: string): Promise<Response> => {
      urls.push(u);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    };
    return { urls, fetchFn };
  };
  it('one request, aggregate 5, limit 864, before_timestamp = window end; keeps candles inside the window', async () => {
    const rows = [[w.toSec, 1, 1, 1, 1, 1], [w.toSec - 300, 1, 2, 0.5, 1.5, 3], [w.fromSec, 1, 1, 1, 1, 1], [w.fromSec - 300, 1, 1, 1, 1, 1]];
    const m = respond(200, { data: { attributes: { ohlcv_list: rows } } });
    const h = await g.fetchCandleWindow(PAIR, MINT, plan, { fetchFn: m.fetchFn });
    assert.equal(h.status, 'ok');
    assert.equal(h.calls, 1);
    assert.deepEqual(h.candles.map((c) => c[0]), [w.fromSec, w.toSec - 300]);
    const u = new URL(m.urls[0]);
    assert.equal(u.hostname, 'api.geckoterminal.com');
    assert.ok(u.pathname.endsWith(`/pools/${PAIR}/ohlcv/minute`));
    assert.equal(u.searchParams.get('aggregate'), '5');
    assert.equal(u.searchParams.get('limit'), '864');
    assert.equal(u.searchParams.get('before_timestamp'), String(w.toSec));
    assert.equal(u.searchParams.get('token'), MINT);
  });
  it('429 / 404 / invalid input', async () => {
    assert.equal((await g.fetchCandleWindow(PAIR, MINT, plan, { fetchFn: respond(429, {}).fetchFn })).status, 'rate_limited');
    assert.equal((await g.fetchCandleWindow(PAIR, MINT, plan, { fetchFn: respond(404, {}).fetchFn })).status, 'not_found');
    const m = respond(200, {});
    const bad = await g.fetchCandleWindow('bad', MINT, plan, { fetchFn: m.fetchFn });
    assert.equal(bad.status, 'invalid');
    assert.equal(m.urls.length, 0);
    assert.equal((await g.fetchCandleWindow(PAIR, MINT, plan, { fetchFn: respond(200, { nope: 1 }).fetchFn })).status, 'error');
  });
});
