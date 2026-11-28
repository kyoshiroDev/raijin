// Incremental event scanner of backtest-run (feat/lab-v2). Pure, no network.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BacktestEvent } from './events';
import {
  accountScan,
  BUCKET_GRACE_MS,
  CAUGHT_UP_TTL_MS,
  completePrefix,
  eventInsertRows,
  initialScannerCursor,
  parseScannerCursor,
  RUN_WAIT_MAX_MS,
  runMayStart,
  scannerCaughtUp,
  snapshotKeyset,
  tokenFactsFromRow,
} from './event-scanner';

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const POOL = 'So11111111111111111111111111111111111111112';
const B = 120_000; // bucket
const T0 = 29_000_000 * B; // bucket-aligned instant

const event = (over: Partial<BacktestEvent> = {}): BacktestEvent => ({
  preset: 'young_calm_ev',
  mint: MINT,
  pool: POOL,
  event_at: new Date(T0).toISOString(),
  entry_snapshot_id: 42,
  price_at_event: 0.0012,
  mc: 400_000,
  liquidity: 50_000,
  narrative: 'GTA',
  pair_age_h: 5,
  roundtrip_known: true,
  roundtrip_pct: 2.1,
  conditions: { change_1h: 12, change_1h_by: 'snapshot' },
  ...over,
});

describe('scanner cursor', () => {
  it('round-trips through JSON and starts from scratch', () => {
    const c = initialScannerCursor();
    assert.equal(snapshotKeyset(c), null);
    c.at = '2026-11-19T10:00:00.123456+00:00';
    c.id = 77;
    c.snapshots = 3;
    c.events.young_calm_ev = 2;
    c.gaps.young_frenzy_ev = { top10_unknown: 4 };
    c.caughtUpAt = '2026-11-19T10:01:00.000Z';
    assert.deepEqual(parseScannerCursor(JSON.parse(JSON.stringify(c))), c);
  });

  it('rejects malformed cursors (restart from scratch)', () => {
    const good = JSON.parse(JSON.stringify(initialScannerCursor()));
    assert.equal(parseScannerCursor(null), null);
    assert.equal(parseScannerCursor({ ...good, v: 2 }), null);
    assert.equal(parseScannerCursor({ ...good, at: '2026-11-19T10:00:00Z' }), null); // at without id
    assert.equal(parseScannerCursor({ ...good, at: 'x', id: 1 }), null);
    assert.equal(parseScannerCursor({ ...good, at: '2026-11-19T10:00:00Z', id: 0 }), null);
    assert.equal(parseScannerCursor({ ...good, snapshots: -1 }), null);
    assert.equal(parseScannerCursor({ ...good, events: { young_calm_ev: -1 } }), null);
    assert.equal(parseScannerCursor({ ...good, gaps: { young_calm_ev: { other: 1 } } }), null);
    assert.equal(parseScannerCursor({ ...good, gaps: { young_calm_ev: 'x' } }), null);
    assert.equal(parseScannerCursor({ ...good, caughtUpAt: 'nope' }), null);
  });

  it('keeps the keyset position of a cursor written before chore/slim-down (counters of removed presets dropped)', () => {
    const old = {
      ...JSON.parse(JSON.stringify(initialScannerCursor())),
      at: '2026-11-21T09:00:00.000001+00:00',
      id: 123,
      events: { momentum: 5, narrative_leader: 2, young_calm_ev: 3 },
      gaps: { young_3h: { top10_unknown: 9 }, young_frenzy_ev: { ratio_unknown: 1 } },
    };
    const c = parseScannerCursor(old);
    assert.ok(c);
    assert.equal(c.id, 123);
    assert.deepEqual(c.events, { young_calm_ev: 3 });
    assert.deepEqual(c.gaps, { young_frenzy_ev: { ratio_unknown: 1 } });
  });

  it('builds the keyset filter after (captured_at, id), µs kept', () => {
    assert.equal(
      snapshotKeyset({ at: '2026-11-19T10:00:00.123456+00:00', id: 77 }),
      'captured_at.gt."2026-11-19T10:00:00.123456+00:00",and(captured_at.eq."2026-11-19T10:00:00.123456+00:00",id.gt.77)',
    );
    assert.equal(snapshotKeyset({ at: '2026-11-19T10:00:00Z', id: 1.5 }), null);
  });
});

describe('completePrefix (complete 2-minute buckets only)', () => {
  it('keeps the last bucket of a full page for the next call', () => {
    const times = [T0, T0 + 1000, T0 + B, T0 + B + 5, T0 + 2 * B];
    assert.deepEqual(completePrefix(times, true, T0 + 100 * B), { count: 4, tail: false });
  });

  it('processes the tail bucket once it cannot grow any more', () => {
    const times = [T0, T0 + B + 10];
    const end = T0 + 2 * B; // end of the last bucket
    assert.deepEqual(completePrefix(times, false, end + BUCKET_GRACE_MS), { count: 2, tail: true });
    assert.deepEqual(completePrefix(times, false, end + BUCKET_GRACE_MS - 1), { count: 1, tail: true });
  });

  it('a full page made of one bucket is processed whole (never stalls)', () => {
    assert.deepEqual(completePrefix([T0, T0 + 1, T0 + 2], true, T0 + 3), { count: 3, tail: false });
  });

  it('an empty page is the tail unless full', () => {
    assert.deepEqual(completePrefix([], false, T0), { count: 0, tail: true });
    assert.deepEqual(completePrefix([T0 + 5], false, T0 + 10), { count: 0, tail: true });
  });
});

describe('run gating', () => {
  const now = Date.parse('2026-11-20T03:41:00Z');
  it('a queued run waits for the scanner to reach the tail', () => {
    assert.equal(scannerCaughtUp(null, now), false);
    assert.equal(scannerCaughtUp({ caughtUpAt: null }, now), false);
    assert.equal(scannerCaughtUp({ caughtUpAt: new Date(now - 60_000).toISOString() }, now), true);
    assert.equal(scannerCaughtUp({ caughtUpAt: new Date(now - CAUGHT_UP_TTL_MS - 1).toISOString() }, now), false);
    assert.equal(runMayStart({ caughtUpAt: null }, now - 60_000, now), false);
  });

  it('starts anyway after RUN_WAIT_MAX_MS', () => {
    assert.equal(runMayStart({ caughtUpAt: null }, now - RUN_WAIT_MAX_MS, now), true);
    assert.equal(runMayStart(null, Number.NaN, now), false);
  });
});

describe('tokenFactsFromRow', () => {
  it('maps the token row, first dex seen when valid', () => {
    const f = tokenFactsFromRow(
      {
        mint: MINT,
        pair_address: POOL,
        pair_created_at: '2026-11-19T00:00:00+00:00',
        narrative: 'GTA',
        mint_authority_disabled: true,
        freeze_authority_disabled: null,
      },
      'pumpfun',
    );
    assert.deepEqual(f, {
      mint: MINT,
      pool: POOL,
      pairCreatedAtMs: Date.parse('2026-11-19T00:00:00Z'),
      narrative: 'GTA',
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: null,
      firstDexSeen: 'pumpfun',
    });
    const g = tokenFactsFromRow({ mint: MINT, pair_address: 'bad', pair_created_at: null }, 'Pump<fun>');
    assert.equal(g?.pool, null);
    assert.equal(g?.pairCreatedAtMs, null);
    assert.equal(g && 'firstDexSeen' in g, false);
    assert.equal(tokenFactsFromRow({ mint: '<script>' }), null);
  });
});

describe('eventInsertRows', () => {
  it('drops (and counts) events without a valid pool, keeps scalar conditions', () => {
    const { rows, noPool } = eventInsertRows([
      event(),
      event({ pool: null, preset: 'young_frenzy_ev' }),
      event({ preset: 'young_frenzy_ev', conditions: { ok: true, nested: { a: 1 } as unknown as number, 'Bad Key': 1, n: Number.NaN } }),
      event({ price_at_event: 0 }),
    ]);
    assert.equal(noPool, 1);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].pool, POOL);
    assert.deepEqual(rows[1].conditions, { ok: true, n: null });
  });

  it('caps the conditions size', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 200; i++) big[`k${i}`] = 'x'.repeat(80);
    const { rows } = eventInsertRows([event({ conditions: big })]);
    assert.ok(JSON.stringify(rows[0].conditions).length < 4000);
  });
});

describe('accountScan', () => {
  it('counts inserted events per preset and data gaps', () => {
    const c = initialScannerCursor();
    accountScan(c, [{ preset: 'young_calm_ev' }, { preset: 'young_calm_ev' }, { preset: 'young_frenzy_ev' }, { preset: 'momentum' }], [
      { young_frenzy_ev: ['top10_unknown', 'change_1h_unknown'] },
      { young_frenzy_ev: ['top10_unknown'], young_calm_ev: ['safety_unknown'] },
      { momentum: ['safety_unknown'] } as never,
    ]);
    assert.deepEqual(c.events, { young_calm_ev: 2, young_frenzy_ev: 1 });
    assert.deepEqual(c.gaps, { young_frenzy_ev: { top10_unknown: 2, change_1h_unknown: 1 }, young_calm_ev: { safety_unknown: 1 } });
  });
});

describe('boundedState', () => {
  it('keeps a normal state as is and trims the oldest history of a huge one', async () => {
    const { boundedState, MAX_STATE_CHARS } = await import('./event-scanner');
    const small = { v: 1, hist: [[1, 2, 3, 4, 'pumpswap']] };
    assert.equal(boundedState(small), small);
    const hist = Array.from({ length: 2000 }, (_, i) => [i + 1, T0 + i * 1000, 0.00012345, 1234, 'pumpswap']);
    const big = boundedState({ v: 1, hist });
    assert.ok(JSON.stringify(big).length <= MAX_STATE_CHARS);
    assert.ok(big.hist.length > 0);
    assert.deepEqual(big.hist[big.hist.length - 1], hist[hist.length - 1]); // newest kept
  });
});
