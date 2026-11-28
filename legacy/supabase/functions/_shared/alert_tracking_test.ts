// « Suivi après alerte » (fix/alerts): alert_log rows, tracking batches, first hit, follow-up eligibility.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertLogRow,
  buildTrackingBatch,
  DEX_BATCH,
  FOLLOWUP_WINDOW_MS,
  followUpEligible,
  MAX_TRACKED_MINTS,
  type OpenPosition,
  parseOpenPositions,
  replayPosition,
  trackingSnapshotRow,
  trackPosition,
  TRACKING_WINDOW_MS,
} from './alert-tracking.ts';
import type { AlertSettings, AlertToken } from './alerts.ts';
import { fixedExitPlan } from './exit-plan.ts';
import type { TokenMetrics } from './types.ts';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const H = 3_600_000;
const MINTS = [
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
];
/** Deterministic valid base58 mints (32 bytes: 44 chars starting with a digit 1-9 then 'A'… are valid only if decoded length is 32). */
const genMints = (n: number): string[] => {
  // Real-world mints taken from the fixtures are limited; derive variants by replacing the last chars with valid base58.
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const base = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTD';
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) {
    out.push(base + alphabet[Math.floor(i / 58) % 58] + alphabet[i % 58] + 'v');
  }
  return out;
};

const pos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  id: 1,
  userId: 'u1',
  mint: MINTS[0],
  sentAt: NOW - H,
  entry: 1,
  target: 1.2,
  stop: 0.86,
  maxPrice: 1,
  minPrice: 1,
  firstHit: null,
  followupSentAt: null,
  ...over,
});

describe('alertLogRow', () => {
  const settings: AlertSettings = { quiet_start: 23, quiet_end: 7, max_per_hour: 4, stake_sol: 0.5 };
  const token = (over: Partial<AlertToken> = {}): AlertToken => ({
    mint: MINTS[0], symbol: 'RAI', dex_id: 'pumpswap', market_cap: 1e6, flags: [],
    mint_authority_disabled: true, freeze_authority_disabled: true, price_usd: 1, roundtrip_cost_pct: 2.5, ...over,
  });
  it('stores the ×2 / ×0.7 plan, the entry state, the stake and a 7-day window (no score / zone: archived)', () => {
    const plan = fixedExitPlan(1);
    assert.ok(plan);
    const r = alertLogRow('u1', 'n1', { ...token(), plan }, settings, NOW);
    assert.equal(r.kind, 'single');
    assert.equal(r.entry_price, 1);
    assert.equal(r.target_price, 2);
    assert.equal(r.stop_price, 0.7);
    assert.equal(r.rr, plan.rr);
    assert.ok(!('entry_score' in r) && !('entry_zone' in r));
    assert.equal(r.entry_roundtrip_pct, 2.5);
    assert.equal(r.stake_sol, 0.5);
    assert.equal(r.max_price, 1);
    assert.equal(r.min_price, 1);
    assert.equal(r.last_price, 1);
    assert.equal(r.last_price_at, new Date(NOW).toISOString());
    assert.equal(r.tracking_until, new Date(NOW + TRACKING_WINDOW_MS).toISOString());
  });
  it('bounds the round trip and falls back to the default stake', () => {
    const plan = fixedExitPlan(1);
    assert.ok(plan);
    const r = alertLogRow('u1', 'n1', { ...token({ roundtrip_cost_pct: 500 }), plan }, { ...settings, stake_sol: null }, NOW);
    assert.equal(r.entry_roundtrip_pct, null);
    assert.equal(r.stake_sol, 0.1);
  });
});

describe('parseOpenPositions', () => {
  it('validates rows one by one (numeric strings accepted)', () => {
    const rows = [
      {
        id: 7, user_id: 'u1', mint: MINTS[0], sent_at: new Date(NOW - H).toISOString(), entry_price: '1', target_price: '1.2',
        stop_price: 0.86, max_price: null, min_price: '0.9', first_hit: 'stop', followup_sent_at: null,
      },
      { id: 8, user_id: 'u1', mint: 'bad', sent_at: new Date(NOW).toISOString(), entry_price: 1, target_price: 1.2, stop_price: 0.8 },
      { id: 9, user_id: 'u1', mint: MINTS[1], sent_at: new Date(NOW).toISOString(), entry_price: null, target_price: 1.2, stop_price: 0.8 },
      { id: 10, user_id: 'u1', mint: MINTS[1], sent_at: new Date(NOW).toISOString(), entry_price: 1, target_price: 0.9, stop_price: 0.8 },
      { id: 1.5, user_id: 'u1', mint: MINTS[1], sent_at: new Date(NOW).toISOString(), entry_price: 1, target_price: 1.2, stop_price: 0.8 },
      'garbage',
    ];
    const out = parseOpenPositions(rows);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
      id: 7, userId: 'u1', mint: MINTS[0], sentAt: NOW - H, entry: 1, target: 1.2, stop: 0.86, maxPrice: null, minPrice: 0.9,
      firstHit: 'stop', followupSentAt: null,
    });
    assert.deepEqual(parseOpenPositions(null), []);
  });
});

describe('buildTrackingBatch', () => {
  it('dedups mints (newest alert first) and only fetches those outside the kept set', () => {
    const positions = [
      pos({ id: 1, mint: MINTS[0], sentAt: NOW - 3 * H }),
      pos({ id: 2, mint: MINTS[1], sentAt: NOW - H }),
      pos({ id: 3, mint: MINTS[0], sentAt: NOW - 2 * H, userId: 'u2' }),
      pos({ id: 4, mint: MINTS[2], sentAt: NOW - 4 * H }),
    ];
    const b = buildTrackingBatch(positions, new Set([MINTS[1]]));
    assert.deepEqual(b.tracked, [MINTS[1], MINTS[0], MINTS[2]]);
    assert.deepEqual(b.toFetch, [MINTS[0], MINTS[2]]);
    assert.deepEqual(b.chunks, [[MINTS[0], MINTS[2]]]);
  });
  it('is bounded (100 mints) and split in DexScreener batches of 30', () => {
    const mints = genMints(130);
    const positions = mints.map((m, i) => pos({ id: i, mint: m, sentAt: NOW - i * 1000 }));
    const b = buildTrackingBatch(positions, new Set());
    assert.equal(b.tracked.length, MAX_TRACKED_MINTS);
    assert.deepEqual(b.tracked, mints.slice(0, 100), 'newest first');
    assert.deepEqual(b.chunks.map((c) => c.length), [30, 30, 30, 10]);
    assert.ok(b.chunks.every((c) => c.length <= DEX_BATCH));
  });
  it('nothing open → nothing to fetch', () => {
    assert.deepEqual(buildTrackingBatch([], new Set()), { tracked: [], toFetch: [], chunks: [] });
  });
});

describe('trackingSnapshotRow', () => {
  const m = { mint: MINTS[0], priceUsd: 0.5, marketCap: 1e6, liquidityUsd: 2e4, volume24h: 1e5, dexId: 'raydium' } as TokenMetrics;
  it('fresh DexScreener values, source tracking, no score / zone (archived columns)', () => {
    assert.deepEqual(trackingSnapshotRow(m, { symbol: 'RAI' }), {
      mint: MINTS[0], price_usd: 0.5, market_cap: 1e6, liquidity_usd: 2e4, volume_24h: 1e5, dex_id: 'raydium', source: 'tracking',
    });
  });
  it('no row without token row (FK) or price', () => {
    assert.equal(trackingSnapshotRow(m, undefined), null);
    assert.equal(trackingSnapshotRow({ ...m, priceUsd: 0 }, {}), null);
  });
});

describe('trackPosition — first hit', () => {
  it('updates max/min/last; no hit between stop and target', () => {
    const p = trackPosition(pos(), 1.1, NOW);
    assert.deepEqual(p, {
      id: 1, max_price: 1.1, min_price: 1, last_price: 1.1, last_price_at: new Date(NOW).toISOString(), first_hit: null,
      first_hit_at: null,
    });
  });
  it('target on price ≥ target, stop on price ≤ stop (inclusive)', () => {
    assert.equal(trackPosition(pos(), 1.2, NOW)?.first_hit, 'target');
    assert.equal(trackPosition(pos(), 0.86, NOW)?.first_hit, 'stop');
    assert.equal(trackPosition(pos(), 1.19, NOW)?.first_hit, null);
    assert.equal(trackPosition(pos(), 0.87, NOW)?.first_hit, null);
    assert.equal(trackPosition(pos(), 2, NOW)?.first_hit_at, new Date(NOW).toISOString());
  });
  it('first one wins: once set, a later opposite move never changes it', () => {
    assert.equal(trackPosition(pos({ firstHit: 'stop' }), 5, NOW)?.first_hit, null, 'patch carries no new hit');
    const stopFirst = replayPosition(pos(), [
      { price: 1.05, at: NOW },
      { price: 0.8, at: NOW + 2 * 60_000 },
      { price: 1.3, at: NOW + 4 * 60_000 },
    ]);
    assert.equal(stopFirst.firstHit, 'stop');
    assert.equal(stopFirst.maxPrice, 1.3);
    assert.equal(stopFirst.minPrice, 0.8);
    const targetFirst = replayPosition(pos(), [
      { price: 1.25, at: NOW },
      { price: 0.7, at: NOW + 2 * 60_000 },
    ]);
    assert.equal(targetFirst.firstHit, 'target');
  });
  it('2-min sampling can miss a wick: a sample path that never crosses leaves first_hit null', () => {
    const p = replayPosition(pos(), [{ price: 1.19, at: NOW }, { price: 0.87, at: NOW + 120_000 }]);
    assert.equal(p.firstHit, null);
  });
  it('unusable price → no patch', () => {
    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) assert.equal(trackPosition(pos(), price, NOW), null);
  });
});

describe('followUpEligible', () => {
  it('first hit set, no follow-up yet, alert sent < 48 h ago', () => {
    assert.equal(followUpEligible(pos({ firstHit: 'target' }), NOW), true);
    assert.equal(followUpEligible(pos({ firstHit: 'stop', sentAt: NOW - FOLLOWUP_WINDOW_MS + 1 }), NOW), true);
  });
  it('not eligible: no hit, already sent, 48 h passed, or sent in the future', () => {
    assert.equal(followUpEligible(pos(), NOW), false);
    assert.equal(followUpEligible(pos({ firstHit: 'target', followupSentAt: NOW - 1000 }), NOW), false);
    assert.equal(followUpEligible(pos({ firstHit: 'target', sentAt: NOW - FOLLOWUP_WINDOW_MS }), NOW), false);
    assert.equal(followUpEligible(pos({ firstHit: 'target', sentAt: NOW + 1000 }), NOW), false);
  });
});
