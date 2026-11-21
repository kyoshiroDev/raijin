// Backtest events (feat/lab-v2; chore/slim-down: young_calm_ev / young_frenzy_ev only). Pure, no network.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorityAt,
  change1hAt,
  EVENT_PRESETS,
  type EventSnapshot,
  initialReplayState,
  isPumpFunMint,
  MINT_EVENT_PRESETS,
  parseReplayState,
  parseSnapshotRow,
  replayMint,
  type TokenFacts,
} from './events.ts';

const PUMP = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
const PUMP2 = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PUMP3 = 'EMJe37WNwbuVBVbF9iJshdiag5DjYhPG1ZELEJBWpump';
const OTHER = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const POOL = '5AFbwVSQPJf4cgEjq4TajZYyPYUvYktrRN3SahNrPnmv';
const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
const MIN = 60_000;

const facts = (over: Partial<TokenFacts> = {}): TokenFacts => ({
  mint: PUMP,
  pool: POOL,
  pairCreatedAtMs: T0 - 2 * 3_600_000,
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
  change1h: 12,
  // « Jeune calme » point-in-time columns: ratio 1.0, effective liquidity 40 k$, LP unknown.
  buys1h: 100,
  sells1h: 100,
  liquidityEffectiveUsd: 40_000,
  lpLockedPct: null,
  ...over,
});
/** A snapshot whose momentum is « neither » (negative 1 h): no event. */
const neither = (minutes: number, over: Partial<EventSnapshot> = {}) => snap(minutes, { change1h: -5, ...over });

describe('event presets after chore/slim-down', () => {
  it('only young_calm_ev / young_frenzy_ev, all decided per mint', () => {
    assert.deepEqual(EVENT_PRESETS, ['young_calm_ev', 'young_frenzy_ev']);
    assert.deepEqual(MINT_EVENT_PRESETS, EVENT_PRESETS);
  });
});

describe('parseSnapshotRow', () => {
  it('parses a CLI row (numeric strings, ISO time) and tolerates missing point-in-time columns', () => {
    const s = parseSnapshotRow({
      id: '42',
      captured_at: '2026-11-19T10:00:00.123456+00:00',
      price_usd: '0.001',
      market_cap: '400000',
      liquidity_usd: 30000,
      zone_status: 'wait',
      dex_id: 'pumpswap',
      holder_count: 12,
      source: 'scan',
    });
    assert.ok(s);
    assert.equal(s.id, 42);
    assert.equal(s.capturedAtMs, Date.parse('2026-11-19T10:00:00.123Z'));
    assert.equal(s.marketCap, 400_000);
    assert.equal(s.top10Pct, null);
    assert.equal(s.mintAuthorityDisabled, null);
    assert.equal(s.change1h, null);
  });
  it('accepts epoch ms, rejects invalid id / time, drops out-of-range values', () => {
    assert.equal(parseSnapshotRow({ id: 1, captured_at: T0 })?.capturedAtMs, T0);
    assert.equal(parseSnapshotRow({ id: 0, captured_at: T0 }), null);
    assert.equal(parseSnapshotRow({ id: 1, captured_at: 'nope' }), null);
    const s = parseSnapshotRow({ id: 1, captured_at: T0, top10_pct: 140, zone_status: '<b>', dex_id: 'a b', roundtrip_cost_pct: -1 });
    assert.ok(s);
    assert.equal(s.top10Pct, null);
    assert.ok(!('zoneStatus' in s), 'the archived zone is not read');
    assert.equal(s.dexId, null);
    assert.equal(s.roundtripCostPct, null);
    assert.equal(s.source, 'scan');
  });
});

describe('point-in-time values', () => {
  it('pump.fun rule: address ends with pump AND first dex pumpfun / pumpswap', () => {
    assert.equal(isPumpFunMint(PUMP, 'pumpfun'), true);
    assert.equal(isPumpFunMint(PUMP, 'pumpswap'), true);
    assert.equal(isPumpFunMint(PUMP, 'raydium'), false);
    assert.equal(isPumpFunMint(OTHER, 'pumpfun'), false);
    assert.equal(isPumpFunMint(PUMP, null), false);
  });
  it('authority: revoked by construction only when currently revoked; else snapshot; else unknown', () => {
    assert.deepEqual(authorityAt(null, true, true), { value: true, by: 'pumpfun_construction' });
    assert.deepEqual(authorityAt(false, true, true), { value: true, by: 'pumpfun_construction' });
    assert.deepEqual(authorityAt(null, false, true), { value: null, by: null });
    assert.deepEqual(authorityAt(true, null, false), { value: true, by: 'snapshot' });
    assert.deepEqual(authorityAt(null, true, false), { value: null, by: null });
  });
  it('change_1h: snapshot value first, else the 50–70 min reference closest to 60 min', () => {
    assert.deepEqual(change1hAt(5, 1, T0, []), { value: 5, by: 'snapshot' });
    const hist: [number, number, number | null, number | null, string | null][] = [
      [1, T0 - 72 * MIN, 0.1, null, null], // too old
      [2, T0 - 65 * MIN, 0.5, null, null],
      [3, T0 - 58 * MIN, 0.8, null, null], // closest to 60 min
      [4, T0 - 45 * MIN, 0.9, null, null], // too recent
    ];
    const r = change1hAt(null, 1, T0, hist);
    assert.equal(r.by, 'derived');
    assert.ok(Math.abs((r.value as number) - 25) < 1e-9);
    assert.deepEqual(change1hAt(null, 1, T0, [[1, T0 - 40 * MIN, 0.5, null, null]]), { value: null, by: null });
    assert.deepEqual(change1hAt(null, null, T0, hist), { value: null, by: null });
  });
});

describe('replayMint: young_calm_ev (incremental replay)', () => {
  it('fires once, at the FIRST snapshot where the conditions hold', () => {
    const rows = [neither(0), snap(2), snap(4)];
    const r = replayMint(facts(), rows, null);
    assert.deepEqual(r.events.map((e) => e.preset), ['young_calm_ev']);
    const e = r.events[0];
    assert.equal(e.entry_snapshot_id, rows[1].id);
    assert.equal(e.event_at, new Date(T0 + 2 * MIN).toISOString());
    assert.equal(e.pool, POOL);
    assert.equal(e.narrative, 'GTA');
    assert.equal(e.roundtrip_known, true);
    assert.equal(e.roundtrip_pct, 2);
    assert.equal(e.conditions.mint_authority_by, 'pumpfun_construction');
    assert.equal(r.processed, 3);
    assert.deepEqual(r.state.fired, ['young_calm_ev']);
  });
  it('is incremental: a second call with overlapping rows does not refire nor replay', () => {
    const rows = [snap(0), snap(2)];
    const a = replayMint(facts(), rows, null);
    const state = parseReplayState(JSON.parse(JSON.stringify(a.state)));
    assert.ok(state);
    const b = replayMint(facts(), [...rows, snap(4)], state);
    assert.equal(b.processed, 1);
    assert.equal(b.events.length, 0);
  });
  it('incremental replay = one-shot replay (same events, same state)', () => {
    const rows = Array.from({ length: 40 }, (_, i) => snap(i * 2, { change1h: null, priceUsd: 0.0004 + i * 0.00001 }));
    const one = replayMint(facts(), rows, null);
    let st = null;
    const evs = [];
    for (let i = 0; i < rows.length; i += 7) {
      const r = replayMint(facts(), rows.slice(0, i + 7), st ? parseReplayState(JSON.parse(JSON.stringify(st))) : null);
      evs.push(...r.events);
      st = r.state;
    }
    assert.deepEqual(evs, one.events);
    assert.deepEqual(st, one.state);
    // change_1h was derived from the snapshot 50–70 min earlier: needs ≥ 50 min of history.
    assert.ok(one.events.length > 0);
    assert.equal(one.events[0].conditions.change_1h_by, 'derived');
    assert.ok(Date.parse(one.events[0].event_at) >= T0 + 50 * MIN);
  });
  it('excludes when top10 is unknown (data gap reported)', () => {
    const r = replayMint(facts(), [snap(0, { top10Pct: null }), snap(2, { top10Pct: null })], null);
    assert.equal(r.events.length, 0);
    assert.deepEqual(r.gaps.young_calm_ev, ['top10_unknown']);
  });
  it('non pump.fun mint without snapshot authorities → safety_unknown; with snapshot values → fires', () => {
    const f = facts({ mint: OTHER });
    const r = replayMint(f, [snap(0)], null);
    assert.equal(r.events.length, 0);
    assert.deepEqual(r.gaps.young_calm_ev, ['safety_unknown']);
    const ok = replayMint(f, [snap(0, { mintAuthorityDisabled: true, freezeAuthorityDisabled: true })], null);
    assert.equal(ok.events.length, 1);
    assert.equal(ok.events[0].conditions.mint_authority_by, 'snapshot');
  });
  it('pump.fun rule needs the current value revoked and a pump.fun first dex', () => {
    assert.equal(replayMint(facts({ freezeAuthorityDisabled: null }), [snap(0)], null).events.length, 0);
    assert.equal(replayMint(facts({ firstDexSeen: 'raydium' }), [snap(0)], null).events.length, 0);
    // First dex comes from the first replayed snapshot when not given.
    assert.equal(replayMint(facts(), [snap(0, { dexId: 'raydium' }), snap(2)], null).events.length, 0);
  });
  it('change_1h unknown → condition false (gap), tracking snapshots never fire', () => {
    const r = replayMint(facts(), [snap(0, { change1h: null })], null);
    assert.equal(r.events.length, 0);
    assert.deepEqual(r.gaps.young_calm_ev, ['change_1h_unknown']);
    assert.equal(replayMint(facts(), [snap(0, { source: 'tracking' })], null).events.length, 0);
  });
  it('roundtrip unknown: still fires, roundtrip_known false', () => {
    const r = replayMint(facts(), [snap(0, { roundtripCostPct: null })], null);
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].roundtrip_known, false);
    assert.equal(r.events[0].roundtrip_pct, null);
  });
  it('the pair age is computed at the snapshot time (past fact)', () => {
    const late = facts({ pairCreatedAtMs: T0 - 23.9 * 3_600_000 });
    assert.equal(replayMint(late, [neither(0), snap(10)], null).events.length, 0, '24.07 h at the snapshot');
    assert.equal(replayMint(late, [snap(0)], null).events.length, 1, '23.9 h at the snapshot');
  });
  it('invalid mint → nothing; unsorted input is sorted', () => {
    assert.equal(replayMint(facts({ mint: 'bad' }), [snap(0)], null).processed, 0);
    const a = neither(0);
    const b = snap(2);
    const r = replayMint(facts(), [b, a], null);
    assert.equal(r.events[0].entry_snapshot_id, b.id);
  });
  it('state is JSON-serialisable and survives parseReplayState; removed presets are dropped, not rejected', () => {
    const r = replayMint(facts(), [snap(0), snap(2)], null);
    assert.deepEqual(parseReplayState(JSON.parse(JSON.stringify(r.state))), r.state);
    assert.equal(parseReplayState(null), null);
    assert.equal(parseReplayState({ v: 2 }), null);
    // States stored before chore/slim-down may list archived presets: the cursor is kept, the presets are dropped.
    assert.deepEqual(parseReplayState({ ...initialReplayState(), fired: ['momentum', 'post_migration', 'young_calm_ev'] })?.fired, ['young_calm_ev']);
    assert.equal(parseReplayState({ ...initialReplayState(), fired: [42] }), null);
    assert.equal(parseReplayState({ ...initialReplayState(), hist: [[1, 2]] }), null);
    assert.equal(parseReplayState({ ...initialReplayState(), migrationBy: 'x' }), null);
    const { migrationBy: _drop, ...old } = initialReplayState();
    assert.equal(parseReplayState(old)?.migrationBy, null, 'states written before migrationBy');
  });
  it('history is bounded to the last 75 min', () => {
    const rows = Array.from({ length: 100 }, (_, i) => neither(i * 2));
    const r = replayMint(facts(), rows, null);
    assert.ok(r.state.hist.length <= 38);
    assert.ok(r.state.hist[0][1] >= T0 + 198 * MIN - 75 * MIN);
  });
});
