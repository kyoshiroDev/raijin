// Detection rows: scan features / token + snapshot columns / first-detection outcome rows (scan-tokens),
// backfill rows and label payloads (label-outcomes). Pure, no network, no zod.
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flagItem } from './final-score.ts';
import { narrativeRanks } from './features.ts';
import { labelOutcome } from './outcomes.ts';
import type { TokenMetrics, Candle } from './types.ts';
import { FEATURE_NAMES } from './x3-types.ts';
import {
  backfillRow,
  labelFailureUpdate,
  labelUpdate,
  outcomeRowFromScan,
  parseHistoryRows,
  parseQueueRow,
  scanFeatureInput,
  scanFeatures,
  snapshotExtras,
  x3TokenColumns,
} from './x3-rows.ts';

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const H = 3_600_000;

function metrics(over: Partial<TokenMetrics> = {}): TokenMetrics {
  return {
    mint: MINT,
    symbol: 'BAWSAQ',
    name: 'Vice City Bawsaq',
    pairAddress: PAIR,
    dexId: 'pumpswap',
    imageUrl: null,
    websiteUrl: null,
    xUrl: null,
    telegramUrl: null,
    priceUsd: 0.001,
    marketCap: 1_000_000,
    liquidityUsd: 80_000,
    volume24h: 240_000,
    volume1h: 20_000,
    change5m: 1,
    change1h: 5,
    change6h: 10,
    change24h: 40,
    buys1h: 300,
    sells1h: 100,
    buys24h: 3000,
    sells24h: 2000,
    pairCreatedAt: NOW - 10 * H,
    ageHours: 10,
    liquidityGeckoUsd: null,
    priceJupUsd: null,
    priceGeckoUsd: null,
    roundtripCostPct: 1.5,
    roundtripFeePct: null,
    buyImpactPct: null,
    lpLockedPct: 99,
    rugcheckScore: null,
    rugcheckDangers: [],
    ...over,
  };
}
const item = (over: Partial<TokenMetrics> = {}) => flagItem(metrics(over));
const ctx = (over: Partial<Parameters<typeof scanFeatureInput>[2]> = {}) => ({
  nowMs: NOW,
  history: new Map(),
  narratives: new Map(),
  market: { solChange24h: 1.73, scanVolume24h: 5_000_000 },
  rug: new Map(),
  ...over,
});

describe('parseHistoryRows (x3_snapshot_history rpc)', () => {
  it('validates rows and samples, sorts by time, accepts numeric strings', () => {
    const map = parseHistoryRows([
      {
        mint: MINT,
        samples: [
          { t: NOW - H, price: '0.002', holders: 110, volume_1h: '5', txns_1h: 7, dex: 'pumpswap' },
          { t: NOW - 3 * H, price: 0.001, holders: '100', volume_1h: null, txns_1h: null, dex: 'pumpfun' },
          { t: 'x', holders: 1 },
          { t: NOW - 2 * H, holders: -4, dex: '' },
          null,
        ],
      },
      { mint: '../evil', samples: [{ t: NOW, holders: 1 }] },
      { mint: BONK, samples: 'nope' },
      'junk',
    ]);
    assert.deepEqual([...map.keys()], [MINT]);
    const s = map.get(MINT) ?? [];
    assert.deepEqual(s.map((x) => x.t), [NOW - 3 * H, NOW - 2 * H, NOW - H]);
    assert.equal(s[0].holders, 100);
    assert.equal(s[1].holders, null);
    assert.equal(s[1].dex, null);
    assert.equal(s[2].price, 0.002);
    assert.equal(s[2].volume1h, 5);
    assert.equal(parseHistoryRows(null).size, 0);
  });
});

describe('scan features', () => {
  it('maps the final scan item, audit, history, narrative, market and RugCheck flags', () => {
    const history = new Map([[MINT, [
      { t: NOW - 6 * H, price: null, holders: 50, volume1h: null, txns1h: null, dex: 'pumpfun' },
      { t: NOW - H, price: null, holders: 100, volume1h: null, txns1h: null, dex: 'pumpswap' },
    ]]]);
    const narratives = narrativeRanks([
      { mint: MINT, name: 'Vice City Bawsaq', symbol: 'BAWSAQ', marketCap: 1_000_000 },
      { mint: BONK, name: 'GTA VI', symbol: 'GTA6', marketCap: 5_000_000 },
    ]);
    const rug = new Map([[MINT, { insiders: true, creatorBad: false }]]);
    const s = item();
    const input = scanFeatureInput(s, { holderCount: 120, organicScore: 42 }, ctx({ history, narratives, rug }));
    assert.equal(input.score, null, 'the score /100 is gone: feature null');
    assert.equal(input.liquidityEffUsd, s.liquidity);
    assert.equal(input.zoneStatus, null, 'no zone any more');
    assert.equal(input.zoneSource, null);
    assert.ok(Math.abs((input.holderGrowth1h ?? 0) - 0.2) < 1e-12, 'now 120 vs 100 one hour ago');
    assert.ok(Math.abs((input.holderGrowth6h ?? 0) - 1.4) < 1e-12, 'now 120 vs 50 six hours ago');
    assert.equal(input.migratedRecently, true);
    assert.deepEqual(input.narrative, { narrative: 'GTA', rank: 2, size: 2 });
    assert.equal(input.txns1h, 400);
    assert.equal(input.vol1h, 20_000);
    assert.equal(input.organicScore, 42);
    assert.equal(input.rugInsiders, true);
    assert.equal(input.rugCreatorBad, false);
    assert.equal(input.solChange24h, 1.73);

    const f = scanFeatures(s, { holderCount: 120, organicScore: 42 }, ctx({ history, narratives, rug }));
    assert.deepEqual(Object.keys(f).sort(), [...FEATURE_NAMES].sort());
    assert.equal(f.migrated_recently, 1);
    assert.equal(f.narrative_rank, 2);
    assert.equal(f.rug_insiders, 1);
    assert.equal(f.zone_in, null);
    assert.equal(f.score, null);
    assert.equal(f.volume_accel, 2);
  });
  it('unknowns stay null: no audit, no history, no RugCheck; no narrative group → 0', () => {
    const f = scanFeatures(item({ name: 'Plain', symbol: 'PLN', dexId: '' }), undefined, ctx({ market: { solChange24h: null, scanVolume24h: null } }));
    assert.equal(f.holder_growth_1h, null);
    assert.equal(f.migrated_recently, null, 'dex unknown');
    assert.equal(f.organic_score, null);
    assert.equal(f.rug_insiders, null);
    assert.equal(f.sol_change_24h, null);
    assert.equal(f.narrative_rank, 0);
    assert.equal(f.narrative_size, 0);
  });
});

describe('scan features at a FIRST detection (feat/calm-sl-test: no history, no enrichment yet)', () => {
  it('holder growth from the Jupiter audit holderChange (percent → fraction), history still preferred', () => {
    const audit = { holderCount: 6, stats1h: { holderChange: 50 }, stats6h: { holderChange: 200 } };
    const f = scanFeatures(item(), audit, ctx());
    assert.equal(f.holder_growth_1h, 0.5);
    assert.equal(f.holder_growth_6h, 2);
    const history = new Map([[MINT, [{ t: NOW - H, price: null, holders: 3, volume1h: null, txns1h: null, dex: 'pumpswap' }]]]);
    assert.equal(scanFeatures(item(), audit, ctx({ history })).holder_growth_1h, 1, '6 vs 3 one hour ago wins');
    assert.equal(scanFeatures(item(), { stats1h: { holderChange: -100 } }, ctx()).holder_growth_1h, null, '−100 % impossible');
  });
  it('migrated_recently inferred without history: pump.fun mint on a PumpSwap pair < 24 h → 1, ≥ 24 h → 0, other dex → 0', () => {
    assert.ok(MINT.endsWith('pump'));
    assert.equal(scanFeatures(item({ ageHours: 3 }), undefined, ctx()).migrated_recently, 1);
    assert.equal(scanFeatures(item({ ageHours: 30 }), undefined, ctx()).migrated_recently, 0);
    assert.equal(scanFeatures(item({ dexId: 'meteora' }), undefined, ctx()).migrated_recently, 0);
    assert.equal(scanFeatures(item({ dexId: 'pumpfun' }), undefined, ctx()).migrated_recently, 0, 'still on the curve');
  });
  it('round trip / LP lock of the item (detection probe merged by index.ts) reach the features', () => {
    const f = scanFeatures(item({ roundtripCostPct: 2.25, lpLockedPct: 100 }), undefined, ctx());
    assert.equal(f.roundtrip_cost_pct, 2.25);
    assert.equal(f.lp_locked_pct, 100);
  });
});

describe('scan-tokens columns', () => {
  it('x3TokenColumns: narrative and features only (model outputs and rr archived)', () => {
    const s = item();
    const f = scanFeatures(s, undefined, ctx());
    const c = x3TokenColumns(f, { narrative: 'GTA', rank: 1, size: 3 });
    assert.deepEqual(Object.keys(c).sort(), ['features', 'narrative', 'narrative_rank']);
    assert.equal(c.narrative, 'GTA');
    assert.equal(c.narrative_rank, 1);
    assert.equal(c.features, f);
    const none = x3TokenColumns(f, undefined);
    assert.equal(none.narrative, null);
    assert.equal(none.narrative_rank, null);
  });
  it('snapshotExtras: holders from the audit, 1 h volume/txns, dex, organic score bounded', () => {
    assert.deepEqual(snapshotExtras(item(), { holderCount: 1234.6, organicScore: 55 }), {
      holder_count: 1235,
      volume_1h: 20_000,
      txns_1h: 400,
      dex_id: 'pumpswap',
      organic_score: 55,
    });
    const e = snapshotExtras(item({ volume1h: undefined, dexId: '' }), { holderCount: -1, organicScore: 150 });
    assert.equal(e.holder_count, null);
    assert.equal(e.volume_1h, null);
    assert.equal(e.dex_id, null);
    assert.equal(e.organic_score, null);
  });
});

describe('outcomeRowFromScan (first detection)', () => {
  const s = item();
  const f = scanFeatures(s, undefined, ctx());
  it('entry = current price, scan features; no score / zone / model (archived)', () => {
    const r = outcomeRowFromScan(s, f, NOW);
    assert.ok(r);
    assert.equal(r.mint, MINT);
    assert.equal(r.pair_address, PAIR);
    assert.equal(r.source, 'scan');
    assert.equal(r.detected_at, new Date(NOW).toISOString());
    assert.equal(r.entry_price, 0.001);
    assert.equal(r.entry_mc, 1_000_000);
    assert.equal(r.entry_liq_eff, s.liquidity);
    assert.equal(r.entry_roundtrip_pct, 1.5);
    assert.equal(r.entry_score, null);
    assert.equal(r.entry_zone, null);
    assert.equal(r.entry_dex_id, 'pumpswap');
    assert.ok(!('p_x3' in r) && !('model_version' in r));
    assert.equal(outcomeRowFromScan(item({ dexId: 'Bad Dex!' }), f, NOW)?.entry_dex_id, null);
  });
  it('no row for an unusable price or address', () => {
    assert.equal(outcomeRowFromScan(item({ priceUsd: 0 }), f, NOW), null);
    assert.equal(outcomeRowFromScan(item({ pairAddress: 'x' }), f, NOW), null);
    assert.equal(outcomeRowFromScan(s, f, Number.NaN), null);
  });
});

describe('backfillRow (rattrapage from the first snapshot)', () => {
  const cand = {
    mint: MINT,
    pair_address: PAIR,
    pair_created_at: new Date(NOW - 30 * H).toISOString(),
    insiders_detected: false,
    creator_rug_history: true,
    captured_at: new Date(NOW - 26 * H).toISOString(),
    price_usd: '0.0012',
    market_cap: '1200000',
    liquidity_usd: 60000,
    volume_24h: '480000',
    score: 64,
    zone_status: 'wait',
    holder_count: null,
    volume_1h: null,
    txns_1h: null,
    organic_score: null,
  };
  it('entry = first snapshot price and time; rebuildable features only', () => {
    const r = backfillRow(cand, NOW);
    assert.ok(r);
    assert.equal(r.source, 'backfill');
    assert.equal(r.entry_dex_id, null);
    assert.equal(r.detected_at, cand.captured_at);
    assert.equal(r.entry_price, 0.0012);
    assert.equal(r.entry_mc, 1_200_000);
    assert.equal(r.entry_liq_eff, 60_000);
    assert.equal(r.entry_score, 64);
    assert.equal(r.entry_zone, 'wait');
    assert.equal(r.entry_roundtrip_pct, null);
    assert.ok(!('p_x3' in r) && !('model_version' in r));
    assert.equal(r.features.score, 64, 'old snapshots still carry their score: kept as history');
    assert.ok(Math.abs((r.features.log_mc ?? 0) - Math.log1p(1_200_000)) < 1e-9);
    assert.ok(Math.abs((r.features.log_age_h ?? 0) - Math.log1p(4)) < 1e-9, 'age at detection = 4 h');
    assert.equal(r.features.zone_wait, 1);
    assert.equal(r.features.zone_from_candles, null);
    assert.equal(r.features.rug_creator_bad, 1);
    assert.equal(r.features.rug_insiders, 0);
    for (const k of ['change_1h', 'holder_growth_1h', 'migrated_recently', 'narrative_rank', 'sol_change_24h', 'roundtrip_cost_pct'] as const) {
      assert.equal(r.features[k], null, k);
    }
    assert.deepEqual(Object.keys(r.features).sort(), [...FEATURE_NAMES].sort());
  });
  it('rejects unusable candidates', () => {
    assert.equal(backfillRow({ ...cand, price_usd: 0 }, NOW), null);
    assert.equal(backfillRow({ ...cand, price_usd: 'abc' }, NOW), null);
    assert.equal(backfillRow({ ...cand, mint: '<script>' }, NOW), null);
    assert.equal(backfillRow({ ...cand, captured_at: 'yesterday' }, NOW), null);
    assert.equal(backfillRow({ ...cand, captured_at: new Date(NOW + H).toISOString() }, NOW), null);
  });
  it('unknown zone / created_at after the snapshot → null features', () => {
    const r = backfillRow({ ...cand, zone_status: 'weird', pair_created_at: new Date(NOW).toISOString() }, NOW);
    assert.equal(r?.entry_zone, null);
    assert.equal(r?.features.zone_in, null);
    assert.equal(r?.features.log_age_h, null);
  });
});

describe('label-outcomes payloads', () => {
  const det = NOW - 10 * H;
  const detSec = det / 1000;
  it('parseQueueRow validates the pending row', () => {
    const q = parseQueueRow({ mint: MINT, pair_address: PAIR, detected_at: new Date(det).toISOString(), entry_price: '0.001', label_attempts: 2 });
    assert.deepEqual(q, { mint: MINT, pairAddress: PAIR, detectedAtMs: det, entryPrice: 0.001, attempts: 2 });
    assert.equal(parseQueueRow({ mint: MINT, pair_address: PAIR, detected_at: 'x', entry_price: 1 }), null);
    assert.equal(parseQueueRow({ mint: MINT, pair_address: PAIR, detected_at: new Date(det).toISOString(), entry_price: 0 }), null);
    assert.equal(parseQueueRow({ mint: 'x', pair_address: PAIR, detected_at: new Date(det).toISOString(), entry_price: 1 }), null);
    assert.equal(parseQueueRow(null), null);
  });
  it('×3 reached → final with every label (satisfies the « final » CHECK)', () => {
    const candles: Candle[] = [
      [detSec + 900, 0.001, 0.0015, 0.0009, 0.0014, 1],
      [detSec + 4 * 3600, 0.0014, 0.0031, 0.0013, 0.003, 1],
    ];
    const u = labelUpdate(labelOutcome(0.001, det, candles, NOW), 0, NOW);
    assert.equal(u.status, 'final');
    assert.equal(u.hit_x2, true);
    assert.equal(u.hit_x3, true);
    assert.equal(u.hit_x5, false);
    assert.equal(u.dd50_first, false);
    assert.equal(u.max_multiple_7d, 3.1);
    assert.equal(u.hours_to_x3, 4);
    assert.equal(u.observed_hours, 10);
    assert.equal(u.labelled_at, new Date(NOW).toISOString());
    assert.equal(u.label_error, null);
    assert.equal(u.label_attempts, 1);
    for (const k of ['hit_x2', 'hit_x3', 'hit_x5', 'dd50_first', 'max_multiple_7d', 'observed_hours', 'labelled_at'] as const) {
      assert.notEqual(u[k], null, k);
    }
  });
  it('−50 % first, not yet 7 days → pending with partial labels', () => {
    const candles: Candle[] = [[detSec + 900, 0.001, 0.0011, 0.0004, 0.0005, 1]];
    const u = labelUpdate(labelOutcome(0.001, det, candles, NOW), 4, NOW);
    assert.equal(u.status, 'pending');
    assert.equal(u.dd50_first, true);
    assert.equal(u.label_attempts, 5);
  });
  it('no candle after the detection → pending with an explanatory label_error', () => {
    const u = labelUpdate(labelOutcome(0.001, det, [], NOW), 0, NOW);
    assert.equal(u.status, 'pending');
    assert.equal(u.max_multiple_7d, 0);
    assert.equal(u.label_error, 'no candle after detection yet');
  });
  it('labelFailureUpdate: short sanitised error, rotates the queue, attempts capped', () => {
    const u = labelFailureUpdate('GeckoTerminal HTTP 500 \u202E<x>' + 'y'.repeat(500), 9_999, NOW);
    assert.equal(u.labelled_at, new Date(NOW).toISOString());
    assert.ok(u.label_error.length <= 200);
    assert.ok(!/[<>\u202E]/.test(u.label_error));
    assert.equal(u.label_attempts, 10_000);
    assert.equal(labelFailureUpdate(labelFailureUpdate('', 10_000, NOW).label_error, 10_000, NOW).label_attempts, 10_000);
    assert.equal(labelFailureUpdate('', 0, NOW).label_error, 'label failed');
  });
});
