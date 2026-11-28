// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  avgTradeSizeUsd, buildFeatureVector, FEATURE_CLAMPS, holderGrowth, migratedRecently, NARRATIVE_MAX_INPUT,
  NARRATIVE_RULES, narrativeOf, narrativeRanks, narrativeWords, volumeAccel,
  holderGrowthFromJup,
  migratedAtDetection,
} from './features.ts';
import { FEATURE_NAMES } from './x3-types.ts';

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const close = (a: number | null, b: number, eps = 1e-9) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} !≈ ${b}`);

describe('holderGrowth', () => {
  it('uses the snapshot closest to now − window', () => {
    const history = [
      { holders: 50, at: NOW - 2 * H },
      { holders: 100, at: NOW - 1 * H },
      { holders: 105, at: NOW - 0.5 * H },
    ];
    close(holderGrowth({ holders: 120, at: NOW }, history, 1), 0.2);
  });
  it('accepts ISO strings and snapshots within ±30 % of the window', () => {
    const history = [{ holders: 200, at: new Date(NOW - 7.5 * H).toISOString() }];
    close(holderGrowth({ holders: 300, at: new Date(NOW).toISOString() }, history, 6), 0.5);
  });
  it('returns null outside the tolerance', () => {
    assert.equal(holderGrowth({ holders: 120, at: NOW }, [{ holders: 100, at: NOW - 1.4 * H }], 1), null);
    assert.equal(holderGrowth({ holders: 120, at: NOW }, [{ holders: 100, at: NOW - 0.6 * H }], 1), null);
  });
  it('ignores future snapshots and returns null on missing or non-positive holders', () => {
    assert.equal(holderGrowth({ holders: 120, at: NOW }, [{ holders: 100, at: NOW + 1 * H }], 1), null);
    assert.equal(holderGrowth({ holders: 120, at: NOW }, [], 1), null);
    assert.equal(holderGrowth({ holders: 120, at: NOW }, [{ holders: 0, at: NOW - H }], 1), null);
    assert.equal(holderGrowth({ holders: 120, at: NOW }, [{ holders: null, at: NOW - H }], 1), null);
    assert.equal(holderGrowth({ holders: 0, at: NOW }, [{ holders: 100, at: NOW - H }], 1), null);
    assert.equal(holderGrowth({ holders: 120, at: 'not a date' }, [{ holders: 100, at: NOW - H }], 1), null);
  });
  it('breaks distance ties towards the older snapshot', () => {
    const history = [
      { holders: 100, at: NOW - 1.1 * H },
      { holders: 200, at: NOW - 0.9 * H },
    ];
    close(holderGrowth({ holders: 150, at: NOW }, history, 1), 0.5);
  });
});

describe('volumeAccel', () => {
  it('compares the last hour with the 24 h hourly average', () => {
    close(volumeAccel(10_000, 24_000), 10);
    close(volumeAccel(1_000, 24_000), 1);
    close(volumeAccel(0, 24_000), 0);
  });
  it('returns null when vol24h ≤ 0 or inputs are invalid', () => {
    assert.equal(volumeAccel(100, 0), null);
    assert.equal(volumeAccel(100, -5), null);
    assert.equal(volumeAccel(null, 100), null);
    assert.equal(volumeAccel(Number.NaN, 100), null);
    assert.equal(volumeAccel(-1, 100), null);
  });
});

describe('avgTradeSizeUsd', () => {
  it('divides the 1 h volume by the 1 h transactions', () => {
    close(avgTradeSizeUsd(5_000, 50), 100);
  });
  it('returns null when txns ≤ 0 or inputs are invalid', () => {
    assert.equal(avgTradeSizeUsd(5_000, 0), null);
    assert.equal(avgTradeSizeUsd(5_000, null), null);
    assert.equal(avgTradeSizeUsd(Number.POSITIVE_INFINITY, 3), null);
  });
});

describe('migratedRecently', () => {
  const hist = [{ dexId: 'pumpfun', at: NOW - 3 * H }];
  it('detects a pump.fun → PumpSwap / Raydium move within 24 h', () => {
    assert.equal(migratedRecently(hist, 'pumpswap', NOW), true);
    assert.equal(migratedRecently(hist, 'raydium', NOW), true);
    assert.equal(migratedRecently(hist, 'Raydium-CLMM', NOW), true);
    assert.equal(migratedRecently([{ dexId: 'pumpfun', at: new Date(NOW - 23 * H).toISOString() }], 'pumpswap', NOW), true);
  });
  it('is false when the pump.fun entry is older than 24 h, absent, or the current dex is something else', () => {
    assert.equal(migratedRecently([{ dexId: 'pumpfun', at: NOW - 25 * H }], 'pumpswap', NOW), false);
    assert.equal(migratedRecently([{ dexId: 'meteora', at: NOW - H }], 'pumpswap', NOW), false);
    assert.equal(migratedRecently(hist, 'pumpfun', NOW), false);
    assert.equal(migratedRecently(hist, 'meteora', NOW), false);
    assert.equal(migratedRecently([], 'raydium', NOW), false);
  });
});

describe('narrativeOf', () => {
  it('maps the documented keywords', () => {
    assert.equal(narrativeOf('Leonida Coin', 'LEO'), 'GTA');
    assert.equal(narrativeOf('Grand Theft Memes', 'GTM'), 'GTA');
    assert.equal(narrativeOf('Vice City', 'VICE'), 'GTA');
    assert.equal(narrativeOf('GTA6', 'G6'), 'GTA');
    assert.equal(narrativeOf('DeepSeek Agent', 'DSA'), 'AI');
    assert.equal(narrativeOf('Smart', 'AI'), 'AI');
    assert.equal(narrativeOf('BabyDoge', 'BDOGE'), 'DOG');
    assert.equal(narrativeOf('dogwifhat', 'WIF'), 'DOG');
    assert.equal(narrativeOf('Kitty Club', 'KC'), 'CAT');
    assert.equal(narrativeOf('Pepe Classic', 'PEPEC'), 'FROG');
    assert.equal(narrativeOf('MAGA Hat', 'HAT'), 'POLITICS');
  });
  it('applies priority order (first rule wins)', () => {
    assert.equal(narrativeOf('Trump Pepe', 'TPEPE'), 'POLITICS');
    assert.equal(narrativeOf('AI Doge', 'AID'), 'AI');
  });
  it('is case and diacritic insensitive, including fullwidth letters', () => {
    assert.equal(narrativeOf('LÉONIDA', 'X'), 'GTA');
    assert.equal(narrativeOf('ｐｅｐｅ', 'X'), 'FROG');
    assert.equal(narrativeOf('luciá', 'x'), 'GTA');
  });
  it('requires whole words for short keywords (no false positives)', () => {
    assert.equal(narrativeOf('Rain', 'RAIN'), null); // contains "ai"
    assert.equal(narrativeOf('Catalyst', 'CTL'), null); // contains "cat"
    assert.equal(narrativeOf('Melon', 'MLN'), null); // contains "elon"
    assert.equal(narrativeOf('Bitcoin', 'BTC'), null);
  });
  it('treats hostile text as data: regex metacharacters, bidi, huge input', () => {
    assert.equal(narrativeOf('.*(a+)+$[', '\\'), null);
    assert.equal(narrativeOf('\u202Epepe\u202C', '<script>'), 'FROG');
    const huge = 'x'.repeat(100_000) + ' pepe';
    assert.equal(narrativeOf(huge, ''), null); // capped before the keyword
    assert.ok(narrativeWords('a'.repeat(1000)).join('').length <= NARRATIVE_MAX_INPUT);
  });
  it('exports a table with unique narratives', () => {
    const names = NARRATIVE_RULES.map((r) => r.narrative);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(names, ['GTA', 'AI', 'POLITICS', 'DOG', 'CAT', 'FROG']);
  });
});

describe('narrativeRanks', () => {
  it('ranks by market cap inside each group, skips tokens without narrative and duplicates', () => {
    const ranks = narrativeRanks([
      { mint: 'a', name: 'Leonida', symbol: 'LEO', marketCap: 1_000_000 },
      { mint: 'b', name: 'Vice', symbol: 'VICE', marketCap: 5_000_000 },
      { mint: 'c', name: 'Jason', symbol: 'JSN', marketCap: null },
      { mint: 'd', name: 'Pepe', symbol: 'PEPE', marketCap: 10 },
      { mint: 'e', name: 'Random', symbol: 'RND', marketCap: 9e9 },
      { mint: 'b', name: 'Vice', symbol: 'VICE', marketCap: 1 },
    ]);
    assert.deepEqual(ranks.get('b'), { narrative: 'GTA', rank: 1, size: 3 });
    assert.deepEqual(ranks.get('a'), { narrative: 'GTA', rank: 2, size: 3 });
    assert.deepEqual(ranks.get('c'), { narrative: 'GTA', rank: 3, size: 3 });
    assert.deepEqual(ranks.get('d'), { narrative: 'FROG', rank: 1, size: 1 });
    assert.equal(ranks.has('e'), false);
  });
  it('breaks market cap ties by mint (deterministic)', () => {
    const ranks = narrativeRanks([
      { mint: 'z', name: 'pepe', symbol: 'P1', marketCap: 100 },
      { mint: 'y', name: 'frog', symbol: 'P2', marketCap: 100 },
    ]);
    assert.equal(ranks.get('y')?.rank, 1);
    assert.equal(ranks.get('z')?.rank, 2);
  });
});

describe('buildFeatureVector', () => {
  it('returns every feature, all null for an empty input', () => {
    const v = buildFeatureVector({});
    assert.deepEqual(Object.keys(v).sort(), [...FEATURE_NAMES].sort());
    for (const name of FEATURE_NAMES) assert.equal(v[name], null, name);
  });
  it('computes logs, ratios, one-hots and booleans', () => {
    const v = buildFeatureVector({
      score: 72, marketCap: 1_000_000, liquidityEffUsd: 100_000, roundtripCostPct: 2.5,
      zoneStatus: 'in', zoneSource: 'candles', change1h: 5, change6h: 12, change24h: 80,
      buys1h: 299, sells1h: 199, ageHours: 23, holderGrowth1h: 0.05, holderGrowth6h: 0.3,
      vol1h: 10_000, vol24h: 120_000, txns1h: 100, migratedRecently: true, narrative: { rank: 2, size: 5 },
      organicScore: 60, rugInsiders: false, rugCreatorBad: true, lpLockedPct: 100, solChange24h: -3,
      scanVolume24h: 50_000_000,
    });
    close(v.log_mc, Math.log1p(1_000_000));
    close(v.log_liq_eff, Math.log1p(100_000));
    close(v.liq_mc_ratio, 0.1);
    assert.equal(v.zone_in, 1);
    assert.equal(v.zone_wait, 0);
    assert.equal(v.zone_deep, 0);
    assert.equal(v.zone_broken, 0);
    assert.equal(v.zone_from_candles, 1);
    close(v.buy_sell_ratio_1h, 1.5);
    close(v.log_age_h, Math.log(24));
    close(v.volume_accel, 2);
    assert.equal(v.migrated_recently, 1);
    assert.equal(v.narrative_rank, 2);
    assert.equal(v.narrative_size, 5);
    close(v.log_avg_trade_usd, Math.log1p(100));
    assert.equal(v.rug_insiders, 0);
    assert.equal(v.rug_creator_bad, 1);
    close(v.log_scan_volume_24h, Math.log1p(50_000_000));
  });
  it("zone 'none' is all zeros, approx source is 0, no narrative group is 0 / 0", () => {
    const v = buildFeatureVector({ zoneStatus: 'none', zoneSource: 'approx', narrative: null });
    assert.deepEqual([v.zone_in, v.zone_wait, v.zone_deep, v.zone_broken, v.zone_from_candles], [0, 0, 0, 0, 0]);
    assert.equal(v.narrative_rank, 0);
    assert.equal(v.narrative_size, 0);
  });
  it('clamps absurd values and nulls non-finite ones', () => {
    const v = buildFeatureVector({
      change1h: 1e9, change24h: -500, liquidityEffUsd: 1e9, marketCap: 1, vol1h: 1e9, vol24h: 1,
      buys1h: 10_000, sells1h: 0, holderGrowth1h: 1e6, score: Number.NaN, ageHours: -3,
      roundtripCostPct: Number.POSITIVE_INFINITY,
    });
    assert.equal(v.change_1h, FEATURE_CLAMPS.change_1h[1]);
    assert.equal(v.change_24h, -100);
    assert.equal(v.liq_mc_ratio, 5);
    assert.equal(v.volume_accel, 50);
    assert.equal(v.buy_sell_ratio_1h, 20);
    assert.equal(v.holder_growth_1h, 10);
    assert.equal(v.score, null);
    assert.equal(v.log_age_h, null);
    assert.equal(v.roundtrip_cost_pct, null);
  });
});

describe('holderGrowthFromJup (feat/calm-sl-test)', () => {
  it('percent → fraction; unknown / ≤ −100 % → null', () => {
    assert.equal(holderGrowthFromJup(50), 0.5);
    assert.equal(holderGrowthFromJup(-5), -0.05);
    assert.equal(holderGrowthFromJup(0), 0);
    assert.equal(holderGrowthFromJup(-100), null);
    assert.equal(holderGrowthFromJup(undefined), null);
    assert.equal(holderGrowthFromJup(Number.NaN), null);
  });
});

describe('migratedAtDetection (feat/calm-sl-test)', () => {
  const NOWM = Date.UTC(2026, 10, 21, 12);
  const PUMP = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
  const OTHER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const base = { dexHistory: [] as { dexId: string; at: number }[], currentDexId: 'pumpswap', mint: PUMP, pairAgeHours: 3, nowMs: NOWM };
  it('current dex decides first: unknown → null, not PumpSwap / Raydium → false', () => {
    assert.equal(migratedAtDetection({ ...base, currentDexId: null }), null);
    assert.equal(migratedAtDetection({ ...base, currentDexId: '' }), null);
    assert.equal(migratedAtDetection({ ...base, currentDexId: 'pumpfun' }), false);
    assert.equal(migratedAtDetection({ ...base, currentDexId: 'meteora' }), false);
  });
  it('history with pumpfun in the last 24 h → true (original rule), whatever the mint', () => {
    const dexHistory = [{ dexId: 'pumpfun', at: NOWM - 2 * 3_600_000 }];
    assert.equal(migratedAtDetection({ ...base, mint: OTHER, dexHistory }), true);
    assert.equal(migratedAtDetection({ ...base, currentDexId: 'raydium', dexHistory }), true);
  });
  it('PumpSwap without history: pump.fun mint → pair age < 24 h; other mint → false', () => {
    assert.equal(migratedAtDetection(base), true);
    assert.equal(migratedAtDetection({ ...base, pairAgeHours: 23.99 }), true);
    assert.equal(migratedAtDetection({ ...base, pairAgeHours: 24 }), false);
    assert.equal(migratedAtDetection({ ...base, pairAgeHours: null }), null);
    assert.equal(migratedAtDetection({ ...base, mint: OTHER }), false);
  });
  it('Raydium: not a pump.fun mint → false; pump.fun mint → null without history, false with a history lacking pumpfun', () => {
    assert.equal(migratedAtDetection({ ...base, currentDexId: 'raydium', mint: OTHER }), false);
    assert.equal(migratedAtDetection({ ...base, currentDexId: 'raydium-clmm' }), null);
    assert.equal(migratedAtDetection({ ...base, currentDexId: 'raydium', dexHistory: [{ dexId: 'raydium', at: NOWM - 3_600_000 }] }), false);
  });
});
