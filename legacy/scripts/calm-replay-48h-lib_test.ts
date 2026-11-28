// scripts/calm-replay-48h-lib.ts (feat/calm-sl-test). Pure, no network.
// Runs with `node --experimental-strip-types --test scripts/calm-replay-48h-lib_test.ts` (and deno test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type CandidateRow, parseCandidate, parsePricePoint, type PricePoint, replay, structureAt } from './calm-replay-48h-lib.ts';

const MIN = 60_000;
const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 21, 10, 0, 0);
const A = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const B = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const cand = (mint: string, at: number, over: Partial<CandidateRow> = {}): CandidateRow => ({
  mint,
  at,
  price: 1,
  marketCap: 500_000,
  liquidityUsd: 40_000,
  liquidityEff: 40_000,
  volume1h: 50_000,
  change1h: 20,
  buys1h: 100,
  sells1h: 100,
  mad: true,
  fad: true,
  top10: 15,
  insiders: false,
  roundtrip: 2,
  lp: 100,
  dexId: 'pumpswap',
  createdMs: T0 - 3 * H,
  creatorRugNow: false,
  ...over,
});
const pt = (mint: string, at: number, price: number, source: 'scan' | 'tracking' = 'scan'): PricePoint => ({ mint, at, price, source });

describe('parsers', () => {
  it('CLI rows → candidates / price points (numeric strings, t/f booleans), invalid dropped', () => {
    const c = parseCandidate({ mint: A, at: String(T0), price: '0.5', buys: '10', sells: 3, mad: 't', fad: 'false', dex: 'pumpswap', created_ms: T0 - H });
    assert.equal(c?.price, 0.5);
    assert.equal(c?.buys1h, 10);
    assert.equal(c?.mad, true);
    assert.equal(c?.fad, false);
    assert.equal(parseCandidate({ mint: 'bad', at: T0, price: 1 }), null);
    assert.equal(parseCandidate({ mint: A, at: T0, price: 0 }), null);
    assert.deepEqual(parsePricePoint({ mint: A, at: T0, price: 2, source: 'tracking' }), pt(A, T0, 2, 'tracking'));
    assert.equal(parsePricePoint({ mint: A, at: 'x', price: 2 }), null);
  });
});

describe('structureAt (reconstructed « Structure cassée »)', () => {
  it('a young pair far under its launch-time high is broken; a steady climb is not', () => {
    const created = T0 - 3 * H;
    const dump = [pt(A, created + MIN, 10), pt(A, T0 - 6 * MIN, 1.05)];
    assert.equal(structureAt(dump, T0, 1, 0, created).broken, true, 'launch 10 → 1: under the 0.786 retracement');
    const climb = [pt(A, created + MIN, 0.5), pt(A, T0 - 6 * MIN, 0.98)];
    const s = structureAt(climb, T0, 1, 20, created);
    assert.equal(s.broken, false);
    assert.equal(s.full, true, '5 min and launch points found');
    assert.equal(structureAt([], T0, 1, 20, created).full, false);
  });
});

describe('replay (phase-2 rules, one user)', () => {
  // A calm from T0 (scans every 2 min); B frenzy (change1h 200). Prices of A: 1 at the scans, then −35 % at T0 + 1 h.
  const scans = [0, 2, 4, 6].map((m) => T0 + m * MIN);
  const candidates = [
    ...scans.map((t) => cand(A, t)),
    ...scans.map((t) => cand(B, t, { change1h: 200 })),
  ];
  const prices = [
    pt(A, T0 - 3 * H + MIN, 0.6), pt(B, T0 - 3 * H + MIN, 0.6),
    ...scans.flatMap((t) => [pt(A, t, 1), pt(B, t, 1)]),
    pt(A, T0 + H, 0.65), pt(A, T0 + 2 * H, 0.55), pt(B, T0 + H, 2.1),
  ];
  const r = replay(candidates, prices, { fromMs: T0 - MIN, toMs: T0 + 3 * H, structure: true });
  const d = r.per_day['2026-11-21'];

  it('calm: no alert at first sight (persistence), ONE alert at the next scan, then blocked while the calm position runs', () => {
    assert.equal(d.calm.matched_tokens, 1);
    assert.equal(d.calm.match_scans, 4);
    assert.equal(d.calm.blocked_persistence, 1);
    assert.equal(d.calm.alerts_single, 1);
    assert.equal(d.calm.blocked_position_open, 2);
    assert.equal(d.calm_first_failure.ok, 4);
  });
  it('books: calm_sl30 stopped at −35 %, calm_sl40 stopped at −45 % later; frenzy_sl30 TP; no stacking', () => {
    assert.equal(d.books.calm_sl30.opened, 1, 'opened once, never stacked on later matches');
    assert.equal(d.books.calm_sl30.sl, 1);
    assert.equal(d.books.calm_sl40.opened, 1);
    assert.equal(d.books.calm_sl40.sl, 1);
    assert.equal(d.books.frenzy_sl30.opened, 1);
    assert.equal(d.books.frenzy_sl30.tp, 1);
    assert.ok(Math.abs(d.books.calm_sl30.pnl_sol_approx - -0.035) < 1e-9);
    assert.ok(Math.abs(d.books.frenzy_sl30.pnl_sol_approx - 0.11) < 1e-9);
    assert.equal(d.frenzy.matched_tokens, 1);
    assert.equal(r.totals.calm.alerted_tokens, 1);
  });
  it('a broken structure removes the calm match (counted), and nothing opens', () => {
    const dumpPrices = [pt(A, T0 - 3 * H + MIN, 10), ...scans.map((t) => pt(A, t, 1))];
    const rs = replay(scans.map((t) => cand(A, t)), dumpPrices, { fromMs: T0 - MIN, toMs: T0 + H, structure: true });
    const ds = rs.per_day['2026-11-21'];
    assert.equal(ds.calm.match_scans, 0);
    assert.equal(ds.calm.rejected_by_structure_scans, 4);
    assert.equal(ds.calm_first_failure.structure, 4);
    assert.equal(ds.books.calm_sl30.opened, 0);
    const off = replay(scans.map((t) => cand(A, t)), dumpPrices, { fromMs: T0 - MIN, toMs: T0 + H, structure: false });
    assert.equal(off.per_day['2026-11-21'].calm.match_scans, 4, 'phase-1 rules for comparison');
  });
  it('unknown ratio (columns absent before 20/11 17:08) → refused', () => {
    const ru = replay([cand(A, T0, { buys1h: null })], [pt(A, T0, 1)], { fromMs: T0 - MIN, toMs: T0 + H, structure: true });
    assert.equal(ru.per_day['2026-11-21'].calm_first_failure.ratio, 1);
    assert.equal(ru.per_day['2026-11-21'].coverage.ratio_known, 0);
  });
});
