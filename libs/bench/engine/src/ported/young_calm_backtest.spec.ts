// feat/young-calm: « Jeune calme » / « Jeune frénésie » backtest presets (detection + event mode, restricted grid) and
// their event replay. Pure, no network. Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregatePreset,
  type BacktestResult,
  buildReport,
  buildRunSummary,
  DETECTION_ROW_BIT,
  detectionFromRow,
  type DetectionInput,
  eventFromRow,
  gridParams,
  GRID_COUNTS,
  isYoungCalmPreset,
  N_COMBOS,
  PRESET_BIT,
  PRESET_FLAGS_MAX,
  PRESET_LABELS,
  PRESET_MODE,
  presetCombos,
  presetFlags,
  presetTrades,
  type TradeRecord,
  YOUNG_CALM_PRESETS,
  YOUNG_COMBOS,
  youngDetectionClass,
  youngDetectionFailures,
} from './backtest';
import {
  EVENT_PRESETS,
  type EventSnapshot,
  MINT_EVENT_PRESETS,
  parseReplayState,
  parseSnapshotRow,
  replayMint,
  type TokenFacts,
  youngCriteriaFailures,
  type YoungPointInTime,
} from './events';
import { accountScan, initialScannerCursor, parseScannerCursor, SNAPSHOT_SELECT } from './event-scanner';

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const POOL = '5AFbwVSQPJf4cgEjq4TajZYyPYUvYktrRN3SahNrPnmv';
const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
const MIN = 60_000;
const H = 3_600_000;

// ---------------------------------------------------------------------------------------------------------------
// Grid and presets

describe('young-calm presets: grid, bits, labels (chore/slim-down: the only presets of the lab)', () => {
  it('4 presets, 6 combos each (all_x2 × SL 20/30/40 × no breakeven × no time exit × delay 0/2), 24 in total', () => {
    assert.deepEqual([...YOUNG_CALM_PRESETS], ['young_calm', 'young_frenzy', 'young_calm_ev', 'young_frenzy_ev']);
    assert.equal(YOUNG_COMBOS.length, 6);
    assert.ok(YOUNG_COMBOS.every((c) => c.exit === 'all_x2' && !c.breakeven && c.timeExitH === null && c.distinct));
    assert.deepEqual([...new Set(YOUNG_COMBOS.map((c) => c.slPct))], [20, 30, 40]);
    assert.deepEqual([...new Set(YOUNG_COMBOS.map((c) => c.delayMin))].sort(), [0, 2]);
    assert.equal(GRID_COUNTS.variants, 24);
    assert.ok(YOUNG_CALM_PRESETS.every((p) => isYoungCalmPreset(p) && presetCombos(p).length === 6));
    const p = gridParams();
    assert.ok(p.notes.some((n) => n.includes('Jeune calme') && n.includes('24')));
  });
  it('bits 1024 / 2048 (detection) and 4096 / 8192 (event), within the smallint CHECK', () => {
    assert.deepEqual(YOUNG_CALM_PRESETS.map((p) => PRESET_BIT[p]), [1024, 2048, 4096, 8192]);
    assert.equal(PRESET_FLAGS_MAX, 16383);
    assert.deepEqual(YOUNG_CALM_PRESETS.map((p) => PRESET_MODE[p]), ['detection', 'detection', 'event', 'event']);
    assert.equal(PRESET_LABELS.young_calm_ev, 'Jeune calme (événement)');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Detection mode

const LOG_AGE = (h: number) => Math.log1p(h);
const soRow = (over: Record<string, unknown> = {}, feat: Record<string, unknown> = {}) => ({
  mint: MINT,
  detected_at: new Date(T0).toISOString(),
  entry_mc: 400_000,
  entry_liq_eff: 45_000,
  entry_zone: 'wait',
  entry_dex_id: 'pumpswap',
  entry_roundtrip_pct: 2.5,
  narrative: 'GTA',
  features: { change_1h: 40, log_age_h: LOG_AGE(5), buy_sell_ratio_1h: 1.1, lp_locked_pct: 100, rug_insiders: 0, rug_creator_bad: 0, ...feat },
  ...over,
});
const det = (over: Record<string, unknown> = {}, feat: Record<string, unknown> = {}): DetectionInput =>
  detectionFromRow('signal_outcomes', soRow(over, feat))!;

describe('detection mode: young_calm / young_frenzy from the features at detection', () => {
  it('reads the ratio, LP and RugCheck flags from the features (preset_signals: unknown)', () => {
    const d = det();
    assert.equal(d.buySellRatio1h, 1.1);
    assert.equal(d.lpLockedPct, 100);
    assert.equal(d.insiders, false);
    assert.equal(d.creatorRug, false);
    assert.ok(Math.abs((d.pairAgeH ?? 0) - 5) < 1e-9);
    const ps = detectionFromRow('preset_signals', { ...soRow(), id: 7, entry_change_1h: 40, pair_age_h: 5 })!;
    assert.equal(ps.buySellRatio1h, null);
    assert.deepEqual(youngDetectionFailures(ps), ['momentum_unknown']);
    assert.equal(presetFlags(ps), DETECTION_ROW_BIT);
  });
  it('calm → bit 1024, frenzy → bit 2048, neither → none (thresholds of presets.ts)', () => {
    assert.equal(youngDetectionClass(det()), 'calm');
    assert.equal(presetFlags(det()), DETECTION_ROW_BIT | PRESET_BIT.young_calm);
    assert.equal(presetFlags(det({}, { change_1h: 200 })) & (1024 | 2048), 2048);
    assert.equal(presetFlags(det({}, { buy_sell_ratio_1h: 1.31 })) & (1024 | 2048), 2048);
    assert.equal(presetFlags(det({}, { change_1h: 120 })) & (1024 | 2048), 0, '100–150 %: neither');
    assert.equal(presetFlags(det({}, { change_1h: -5 })) & (1024 | 2048), 0);
    assert.equal(presetFlags(det({}, { buy_sell_ratio_1h: 0.7 })) & (1024 | 2048), 0);
  });
  it('base rules: age < 24 h, pumpswap, liquidity ≥ 30 k$, roundtrip < 5 % when known, no rug flag, LP ≥ 90 % when known', () => {
    assert.deepEqual(youngDetectionFailures(det()), []);
    assert.deepEqual(youngDetectionFailures(det({}, { log_age_h: LOG_AGE(24.01) })), ['age']);
    assert.deepEqual(youngDetectionFailures(det({}, { log_age_h: null })), ['age']);
    assert.deepEqual(youngDetectionFailures(det({ entry_dex_id: 'raydium' })), ['dex']);
    assert.deepEqual(youngDetectionFailures(det({ entry_liq_eff: 29_999 })), ['liquidity']);
    assert.deepEqual(youngDetectionFailures(det({ entry_liq_eff: null })), ['liquidity']);
    assert.deepEqual(youngDetectionFailures(det({ entry_roundtrip_pct: 5 })), ['roundtrip']);
    // Unknown at detection for ~all signal_outcomes rows (measured later by enrich-tokens): accepted.
    assert.deepEqual(youngDetectionFailures(det({ entry_roundtrip_pct: null }, { roundtrip_cost_pct: null })), []);
    assert.deepEqual(youngDetectionFailures(det({}, { rug_insiders: 1 })), ['rug']);
    assert.deepEqual(youngDetectionFailures(det({}, { rug_creator_bad: 1 })), ['rug']);
    assert.deepEqual(youngDetectionFailures(det({}, { lp_locked_pct: 50 })), ['lp']);
    assert.deepEqual(youngDetectionFailures(det({}, { lp_locked_pct: null, rug_insiders: null })), [], 'unknown LP / rug accepted');
    assert.deepEqual(youngDetectionFailures(det({ entry_dex_id: 'orca', entry_liq_eff: 1 }, { buy_sell_ratio_1h: null })), ['dex', 'liquidity', 'momentum_unknown']);
    assert.equal(presetFlags(det({ entry_dex_id: 'orca' }, { change_1h: 300 })) & (1024 | 2048), 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Aggregation on the restricted grid, report, summary

let seq = 0;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const mintOf = () => {
  const n = ++seq;
  return MINT.slice(0, 40) + B58[Math.floor(n / 58) % 58] + B58[n % 58] + 'pp';
};
const rec = (i: number, flags: number, v: number, source: TradeRecord['source'] = 'signal_outcomes'): TradeRecord => ({
  source,
  mint: mintOf(),
  detectedAtMs: T0 + i * 1000,
  split: 'train',
  presetFlags: flags,
  narrative: i % 2 ? 'gta' : 'other',
  returns: Float32Array.from({ length: N_COMBOS }, () => v),
});

describe('aggregation of the young-calm presets', () => {
  it('only the 6 combos × 3 narratives × 2 splits = 36 rows per preset; trades selected by the preset bit', () => {
    const trades = [
      ...Array.from({ length: 10 }, (_, i) => rec(i, 1 | 1024, 5)),
      ...Array.from({ length: 6 }, (_, i) => rec(20 + i, 1 | 2048, -3)),
      ...Array.from({ length: 4 }, (_, i) => rec(40 + i, 4096, 7, 'backtest_events')),
    ];
    for (const p of YOUNG_CALM_PRESETS) {
      const rows = aggregatePreset(trades, p);
      assert.equal(rows.length, 36, p);
      assert.ok(rows.every((r) => r.exit === 'all_x2' && [20, 30, 40].includes(r.sl_pct) && !r.breakeven && r.time_exit_h === null));
    }
    assert.equal(presetTrades(trades, 'young_calm').length, 10);
    assert.equal(presetTrades(trades, 'young_frenzy').length, 6);
    assert.equal(presetTrades(trades, 'young_calm_ev').length, 4);
    assert.equal(presetTrades(trades, 'young_frenzy_ev').length, 0);
    const allTest = aggregatePreset(trades, 'young_calm').filter((r) => r.narrative === 'all');
    assert.equal(allTest.find((r) => r.split === 'train')!.trades + allTest.find((r) => r.split === 'test')!.trades, 10);
  });

  const res = (over: Partial<BacktestResult>): BacktestResult => ({
    preset: 'young_calm', exit: 'all_x2', sl_pct: 30, breakeven: false, time_exit_h: null, delay_min: 2, narrative: 'all', split: 'test',
    trades: 40, win_rate: 0.4, avg_win_pct: 90, avg_loss_pct: -32, avg_net_pct: 11, avg_net_sol: 0.011, profit_factor: 1.7,
    max_drawdown_sol: 0.2, worst_losing_streak: 5, open_at_end: 0, ci_low: 2, ci_high: 20, ci_contains_zero: false,
    retained: true, robust: true, ...over,
  });
  const meta = { run_at: '2026-11-20T03:40:00.000Z', n_detections: 300, n_events: 40 };

  it('a robust young-calm variant can be the candidate; the 24 variants are announced in the text', () => {
    const s = buildRunSummary([res({}), res({ split: 'train', trades: 90, avg_net_pct: 9 })], meta);
    assert.equal(s.verdict, 'candidate');
    assert.equal(s.candidate?.preset, 'young_calm');
    assert.match(s.text, /Jeune calme \(détection\), tout vendre à ×2, stop −30 %, sans sortie au temps, délai 2 min/);
    assert.match(s.text, /24 variantes testées \(Jeune calme \/ frénésie\)/);
  });
  it('buildReport counts the young presets in retained / robust / top; archived presets are not candidates', () => {
    const dv = { n_detections: 0, resolutions: { '1m': 0, '5m': 0, '15m': 0, none: 0 }, cutoff_at: null, max_detected_at: null, train: 0, test: 0 };
    const r = buildReport([res({}), res({ preset: 'young_frenzy_ev', robust: false })], dv);
    assert.equal(r.retained, 2);
    assert.equal(r.robust, 1);
    assert.equal(r.n_variants, 24);
    assert.equal(buildRunSummary([res({ preset: 'momentum_explo' as never, avg_net_pct: 50 })], meta).verdict, 'none');
  });
  it('eventFromRow accepts the two young-calm event presets', () => {
    const row = { id: 5, preset: 'young_calm_ev', mint: MINT, event_at: new Date(T0).toISOString(), roundtrip_pct: 2, narrative: 'GTA' };
    assert.equal(eventFromRow(row)?.preset, 'young_calm_ev');
    assert.equal(eventFromRow({ ...row, preset: 'young_frenzy_ev' })?.preset, 'young_frenzy_ev');
    assert.equal(eventFromRow({ ...row, preset: 'young_calm' }), null, 'detection preset is not an event preset');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Event mode (events.ts)

const facts = (over: Partial<TokenFacts> = {}): TokenFacts => ({
  mint: MINT,
  pool: POOL,
  pairCreatedAtMs: T0 - 2 * H,
  narrative: 'GTA',
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  ...over,
});
let nextId = 1;
const snap = (minutes: number, over: Partial<EventSnapshot> = {}): EventSnapshot => ({
  id: nextId++,
  capturedAtMs: T0 + minutes * MIN,
  source: 'scan',
  priceUsd: 0.0005,
  marketCap: 500_000,
  liquidityUsd: 40_000,
  dexId: 'pumpswap',
  holderCount: 1000,
  mintAuthorityDisabled: null,
  freezeAuthorityDisabled: null,
  top10Pct: 18,
  insidersDetected: null,
  roundtripCostPct: 2,
  change1h: 30,
  buys1h: 110,
  sells1h: 100,
  liquidityEffectiveUsd: 35_000,
  lpLockedPct: null,
  ...over,
});
const ypit = (over: Partial<YoungPointInTime> = {}): YoungPointInTime => ({
  marketCap: 500_000,
  liquidityUsd: 40_000,
  dexId: 'pumpswap',
  change1h: 30,
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  insidersDetected: null,
  top10Pct: 10,
  roundtripCostPct: 2,
  pairAgeH: 2,
  liquidityEffectiveUsd: 35_000,
  buys1h: 110,
  sells1h: 100,
  lpLockedPct: null,
  ...over,
});

describe('youngCriteriaFailures (point-in-time snapshot values)', () => {
  it('calm reference passes; frenzy fails on momentum only', () => {
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit()), []);
    assert.deepEqual(youngCriteriaFailures('young_frenzy_ev', ypit()), ['momentum']);
    assert.deepEqual(youngCriteriaFailures('young_frenzy_ev', ypit({ change1h: 200 })), []);
    assert.deepEqual(youngCriteriaFailures('young_frenzy_ev', ypit({ buys1h: 300 })), []);
  });
  it('unknown ratio / effective liquidity / change_1h / top10 / authority are data gaps (excluded); unknown roundtrip accepted (lab-v2)', () => {
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ buys1h: null })), ['ratio_unknown']);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ liquidityEffectiveUsd: null })), ['liquidity_eff_unknown']);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ change1h: null })), ['change_1h_unknown']);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ roundtripCostPct: null })), []);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ top10Pct: null })), ['top10_unknown']);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ freezeAuthorityDisabled: null })), ['safety_unknown']);
  });
  it('market / safety failures', () => {
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ dexId: 'raydium' })), ['dex']);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ pairAgeH: 24 })), ['age']);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ pairAgeH: null })), ['age']);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ liquidityEffectiveUsd: 29_000 })), ['liquidity']);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ insidersDetected: true })), ['safety']);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ top10Pct: 30 })), ['top10']);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ roundtripCostPct: 6 })), ['roundtrip']);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ lpLockedPct: 80 })), ['lp']);
    assert.deepEqual(youngCriteriaFailures('young_calm_ev', ypit({ lpLockedPct: 100 })), []);
  });
});

describe('replayMint: young_calm_ev / young_frenzy_ev events', () => {
  it('parseSnapshotRow reads the four feat/young-calm columns (out of range → null)', () => {
    const s = parseSnapshotRow({
      id: 9, captured_at: new Date(T0).toISOString(), buys_1h: '12', sells_1h: 3, liquidity_effective_usd: '31000.5', lp_locked_pct: 100,
    })!;
    assert.deepEqual([s.buys1h, s.sells1h, s.liquidityEffectiveUsd, s.lpLockedPct], [12, 3, 31000.5, 100]);
    const bad = parseSnapshotRow({ id: 9, captured_at: new Date(T0).toISOString(), buys_1h: -1, sells_1h: 1.5, liquidity_effective_usd: -2, lp_locked_pct: 101 })!;
    assert.deepEqual([bad.buys1h, bad.sells1h, bad.liquidityEffectiveUsd, bad.lpLockedPct], [null, null, null, null]);
    const old = parseSnapshotRow({ id: 9, captured_at: new Date(T0).toISOString() })!;
    assert.deepEqual([old.buys1h, old.sells1h, old.liquidityEffectiveUsd, old.lpLockedPct], [null, null, null, null]);
    for (const c of ['buys_1h', 'sells_1h', 'liquidity_effective_usd', 'lp_locked_pct']) assert.ok(SNAPSHOT_SELECT.includes(c));
  });
  it('first snapshot where the calm conditions hold → one young_calm_ev event; later frenzy → one young_frenzy_ev', () => {
    const snaps = [
      snap(0, { buys1h: null }), // ratio unknown (pre-deploy snapshot): excluded
      snap(2), // calm
      snap(4), // calm again: no second event
      snap(6, { change1h: 220, priceUsd: 0.001 }), // frenzy
    ];
    const r = replayMint(facts(), snaps, null);
    const young = r.events.filter((e) => e.preset === 'young_calm_ev' || e.preset === 'young_frenzy_ev');
    assert.deepEqual(young.map((e) => [e.preset, e.entry_snapshot_id]), [
      ['young_calm_ev', snaps[1].id],
      ['young_frenzy_ev', snaps[3].id],
    ]);
    const calm = young[0];
    assert.equal(calm.liquidity, 35_000);
    assert.equal(calm.conditions.buy_sell_ratio_1h, 1.099); // 111 / 101
    assert.equal(calm.conditions.liquidity_source, 'snapshot_liquidity_effective_usd');
    assert.equal(calm.conditions.mint_authority_by, 'pumpfun_construction');
    assert.ok(r.state.fired.includes('young_calm_ev') && r.state.fired.includes('young_frenzy_ev'));
    // The state round-trips with the new presets; a replay from it fires nothing again.
    const back = parseReplayState(JSON.parse(JSON.stringify(r.state)));
    assert.ok(back);
    assert.equal(replayMint(facts(), [snap(8), snap(10, { change1h: 300 })], back).events.filter((e) => e.preset.startsWith('young_c') || e.preset.startsWith('young_f')).length, 0);
  });
  it('tracking rows, old pairs and unknown effective liquidity never fire; data gaps are reported', () => {
    const tracking = replayMint(facts(), [snap(0, { source: 'tracking' })], null);
    assert.equal(tracking.events.filter((e) => e.preset === 'young_calm_ev').length, 0);
    const old = replayMint(facts({ pairCreatedAtMs: T0 - 30 * H }), [snap(0)], null);
    assert.equal(old.events.filter((e) => e.preset === 'young_calm_ev').length, 0);
    const gap = replayMint(facts(), [snap(0, { liquidityEffectiveUsd: null })], null);
    assert.equal(gap.events.filter((e) => e.preset === 'young_calm_ev').length, 0);
    assert.deepEqual(gap.gaps.young_calm_ev, ['liquidity_eff_unknown']);
  });
  it('the event presets are registered for the scanner; its cursor accepts their counts and gaps', () => {
    assert.ok(EVENT_PRESETS.includes('young_calm_ev') && EVENT_PRESETS.includes('young_frenzy_ev'));
    assert.ok(MINT_EVENT_PRESETS.includes('young_calm_ev'));
    const c = initialScannerCursor();
    accountScan(c, [{ preset: 'young_calm_ev' }, { preset: 'young_frenzy_ev' }], [{ young_calm_ev: ['ratio_unknown'] }]);
    assert.deepEqual(c.events, { young_calm_ev: 1, young_frenzy_ev: 1 });
    assert.deepEqual(c.gaps, { young_calm_ev: { ratio_unknown: 1 } });
    assert.deepEqual(parseScannerCursor(JSON.parse(JSON.stringify(c))), c);
  });
});
